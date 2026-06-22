/**
 * src/modules/career-pilot/briefing-backstop.ts — the daily-briefing host
 * backstop (§24.134b).
 *
 * Box-observed gap: the 08:00 daily-briefing wake fired + completed, the
 * pipeline-scribe had written a non-empty attention[] (an `action_owed` item),
 * yet the orchestrator emitted NO owner-facing message — a silent skip against
 * its own persona rule ("attention[] non-empty → you still emit"). Same
 * fragility class as §24.78: a load-bearing behavior left to the model's
 * discretion, with no host backstop.
 *
 * Fix: after a daily-briefing wake completes with no owner-bound message but
 * the latest curator attention[] is non-empty, the HOST renders a minimal
 * digest from the structured attention[] and delivers it to the owner's
 * channel. Attention-only (owner choice §24.134b): no lead re-ranking — the
 * silent-skip cases are attention-driven, and a fallback path shouldn't spend
 * an LLM call. Owner-facing Telegram → real company names are fine; no
 * sanitizer runs.
 *
 * The owner-message check is a window heuristic chosen to NEVER double-message:
 *   - briefing emitted          → an owner message lands in the window → skip
 *   - briefing skipped, quiet   → no owner message → backstop fires (the fix)
 *   - briefing skipped, a coincident killer-match pinged → an owner message is
 *       in the window → skip (the owner already got pinged; an occasional miss
 *       of the attention digest, never a duplicate)
 *
 * Idempotency rides the session's host-owned `delivered` table: a synthetic
 * `briefing-backstop:<taskId>` marker is inserted once the task is handled
 * (delivered, stale, no-news, or already-covered), so every later host-sweep
 * tick short-circuits. Best-effort by construction: never throws; a transient
 * failure (no outbound yet, deliver error) defers without marking, so the next
 * tick retries.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { markDelivered } from '../../db/session-db.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

import { isOpsSession, mirrorOpsDeliveryToChat } from './ops-session.js';

const SERIES_ID = 'daily-briefing';
const DEFAULT_WINDOW_MIN = 10;
const DEFAULT_MAX_AGE_MIN = 120;
/** Cap rendered items so a pathological attention[] can't produce a wall of text. */
const MAX_RENDERED_ITEMS = 8;

/** One curator attention[] entry (a structural subset — every field optional/defensive). */
export interface AttentionItem {
  priority?: string;
  reason?: string;
  company?: string;
  action_hint?: string;
  application_id?: string;
}

/** Parse `attention_json` into the items worth surfacing. Never throws. */
export function parseAttention(json: string | null | undefined): AttentionItem[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is AttentionItem => !!x && typeof x === 'object');
  } catch {
    return [];
  }
}

/**
 * Render the owner-facing digest from attention[]. Plain text (no heavy
 * markdown) so it renders safely on any channel; owner-facing, so real names
 * stay. Mirrors the persona briefing's terse, headline-free shape.
 */
export function renderBackstopDigest(items: AttentionItem[]): string {
  const shown = items.slice(0, MAX_RENDERED_ITEMS);
  const n = items.length;
  const head = `${n} application${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} your attention:`;
  const blocks = shown.map((it) => {
    const who = it.company && it.company.trim() ? it.company.trim() : 'An application';
    const reason = it.reason && it.reason.trim() ? ` — ${it.reason.trim()}` : '';
    const hint = it.action_hint && it.action_hint.trim() ? `\n  ↳ ${it.action_hint.trim()}` : '';
    return `• ${who}${reason}${hint}`;
  });
  const overflow = n > shown.length ? [`…and ${n - shown.length} more.`] : [];
  return [head, '', ...blocks, ...overflow].join('\n');
}

export type BackstopDecision = 'deliver' | 'mark-skip' | 'defer';

/**
 * Pure decision: given the briefing's age, whether an owner message already
 * landed in the window, and how many attention items exist, decide whether to
 * deliver the backstop, mark-and-skip (never revisit this briefing), or defer
 * (transient — retry next tick).
 */
export function decideBackstop(args: {
  fireTimeMs: number;
  nowMs: number;
  maxAgeMs: number;
  outboundReady: boolean;
  hasOwnerMessageInWindow: boolean;
  attentionCount: number;
}): BackstopDecision {
  if (!Number.isFinite(args.fireTimeMs)) return 'mark-skip'; // unparseable fire time — don't loop on it
  if (args.nowMs - args.fireTimeMs > args.maxAgeMs) return 'mark-skip'; // stale: news too old to surprise with
  if (!args.outboundReady) return 'defer'; // can't verify yet — retry next tick
  if (args.hasOwnerMessageInWindow) return 'mark-skip'; // briefing (or a coincident push) already covered it
  if (args.attentionCount === 0) return 'mark-skip'; // genuinely no news — the silent skip was correct
  return 'deliver';
}

interface CompletedBriefing {
  id: string;
  process_after: string;
}

function findLatestCompletedBriefing(inDb: Database.Database): CompletedBriefing | undefined {
  return inDb
    .prepare(
      `SELECT id, process_after FROM messages_in
        WHERE series_id = ? AND kind = 'task' AND status = 'completed'
        ORDER BY process_after DESC LIMIT 1`,
    )
    .get(SERIES_ID) as CompletedBriefing | undefined;
}

function alreadyHandled(inDb: Database.Database, key: string): boolean {
  return inDb.prepare('SELECT 1 FROM delivered WHERE message_out_id = ? LIMIT 1').get(key) !== undefined;
}

/** Count owner-facing (non-system) outbound messages in [fireIso, fireIso+window]. */
function ownerMessagesInWindow(outDb: Database.Database, fireIso: string, windowMs: number): number {
  const upperIso = new Date(Date.parse(fireIso) + windowMs).toISOString();
  const row = outDb
    .prepare(
      `SELECT count(*) AS c FROM messages_out
        WHERE kind != 'system'
          AND datetime(timestamp) >= datetime(?)
          AND datetime(timestamp) <= datetime(?)`,
    )
    .get(fireIso, upperIso) as { c: number };
  return row.c;
}

function readLatestAttention(centralDb: Database.Database): AttentionItem[] {
  const row = centralDb
    .prepare('SELECT attention_json FROM pipeline_scribe_output ORDER BY run_at DESC LIMIT 1')
    .get() as { attention_json: string } | undefined;
  return parseAttention(row?.attention_json);
}

/**
 * Host-sweep hook (ops session only): deliver a deterministic digest when a
 * daily-briefing wake completed without surfacing the curator's non-empty
 * attention[]. Best-effort: never throws.
 */
export async function maybeDeliverBriefingBackstop(
  inDb: Database.Database,
  outDb: Database.Database | null,
  session: Session,
): Promise<void> {
  try {
    if (!isOpsSession(session)) return;
    const centralDb = getDb();
    if (!getConfig<boolean>(centralDb, 'daily_briefing_backstop_enabled', true)) return;

    const task = findLatestCompletedBriefing(inDb);
    if (!task) return;

    const key = `briefing-backstop:${task.id}`;
    if (alreadyHandled(inDb, key)) return;

    const windowMs =
      getConfig<number>(centralDb, 'daily_briefing_backstop_window_min') * 60_000 || DEFAULT_WINDOW_MIN * 60_000;
    const maxAgeMs =
      getConfig<number>(centralDb, 'daily_briefing_backstop_max_age_min') * 60_000 || DEFAULT_MAX_AGE_MIN * 60_000;
    const fireTimeMs = Date.parse(task.process_after);

    // Compute the owner-message signal only when fresh + outbound is open
    // (decideBackstop short-circuits the stale/defer cases before this matters).
    const outboundReady = outDb !== null;
    const hasOwnerMessageInWindow =
      outboundReady && Number.isFinite(fireTimeMs) && Date.now() - fireTimeMs <= maxAgeMs
        ? ownerMessagesInWindow(outDb!, task.process_after, windowMs) > 0
        : false;

    const attention = readLatestAttention(centralDb);
    const decision = decideBackstop({
      fireTimeMs,
      nowMs: Date.now(),
      maxAgeMs,
      outboundReady,
      hasOwnerMessageInWindow,
      attentionCount: attention.length,
    });

    if (decision === 'defer') return;
    if (decision === 'mark-skip') {
      markDelivered(inDb, key, null);
      return;
    }

    // decision === 'deliver'
    const mg = session.messaging_group_id ? getMessagingGroup(session.messaging_group_id) : undefined;
    if (!mg) {
      log.warn('briefing-backstop: ops session has no messaging group — cannot deliver', { sessionId: session.id });
      return; // misconfig; don't mark (rare — ops session is created bound to the owner group)
    }
    const adapter = getDeliveryAdapter();
    if (!adapter) return; // transient — retry next tick

    const digest = renderBackstopDigest(attention);
    const content = JSON.stringify({ markdown: digest });
    await adapter.deliver(mg.channel_type, mg.platform_id, null, 'text', content);

    // Mark handled ONLY after a successful send, so a throw above retries.
    markDelivered(inDb, key, null);
    // Mirror into the chat session so the owner's "tell me more about #1" reply
    // has its referent (the same §24.67 D2 contract real ops deliveries get).
    mirrorOpsDeliveryToChat(session, { id: key, kind: 'text', content: JSON.stringify({ text: digest }) });
    log.info('briefing-backstop: delivered fallback digest', {
      sessionId: session.id,
      taskId: task.id,
      items: attention.length,
    });
  } catch (err) {
    log.warn('briefing-backstop: failed', { sessionId: session.id, err });
  }
}
