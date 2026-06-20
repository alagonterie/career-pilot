/**
 * src/modules/portal/contact-relay.ts — POST /api/contact handler.
 *
 * Relays a recruiter's contact-form submission (PORTAL §5.7) to the owner's
 * channel. One-way — "no conversation" (PORTAL §8). In prod the Cloudflare
 * Worker Turnstile-verifies + rate-limits (per-IP) and forwards the verified
 * body here over the Tunnel; in dev it's posted directly.
 *
 * Delivery is channel-agnostic: resolve the channel(s) wired to the
 * `career-pilot` agent group and push through the host delivery adapter (the
 * same host-initiated path the §24.18 killswitch uses) — Telegram in prod, the
 * CLI in dev, no container spawn.
 *
 * NO public sanitizer (corrects the Phase-0 placeholder): the submission goes
 * to the owner's PRIVATE channel and its whole value is the recruiter's name +
 * email + message; redacting would defeat it. Delivered verbatim (length-capped).
 *
 * §24.121 — the submission is ALSO persisted to `contact_submissions` so the
 * orchestrator can recall it (the owner-only `read_contacts` tool). Because
 * persistence is a new junk-row vector, the relay carries host-side
 * defense-in-depth behind the §24.70 edge (per-IP RL + Turnstile): a kill switch
 * (`contact_relay_enabled`), dedup of an identical already-delivered submission,
 * a global per-window flood cap, and bounded retention. The relay spends no money
 * (pure delivery, no LLM/container), so a junk flood only risks owner-Telegram
 * spam + DB rows — both bounded here.
 *
 * See STRATEGY.md §24.22 + §24.121 + PORTAL.md §5.7.
 */
import { createHash } from 'node:crypto';

import type Database from 'better-sqlite3';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

const OWNER_FOLDER = 'career-pilot';
const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_COMPANY = 200;
const MAX_ROLE = 200;
const MAX_SOURCE = 80;
const DEFAULT_MESSAGE_MAX = 4000;

export interface ContactInput {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  role?: unknown;
  /** The portal surface the visitor converted from (the connective rail's `?from`) — context only. */
  source?: unknown;
  message?: unknown;
}

export interface ContactResult {
  ok: boolean;
  delivered?: number;
  /** True when an identical, already-delivered submission was suppressed (§24.121). */
  deduped?: boolean;
  error?: { code: 'BAD_ARGS' | 'UNAVAILABLE'; message: string };
}

function field(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

/** getConfig with a try/catch fallback — a config glitch must never break the relay. */
function cfgNum(db: Database.Database, key: string, fallback: number): number {
  try {
    const v = getConfig<number>(db, key, fallback);
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function cfgBool(db: Database.Database, key: string, fallback: boolean): boolean {
  try {
    return getConfig<boolean>(db, key, fallback) !== false;
  } catch {
    return fallback;
  }
}

/**
 * Neutralize Markdown link syntax in visitor-supplied text (§24.141 S3-1). The
 * notification is delivered with `parse_mode=Markdown`, and the outbound
 * sanitizer balances delimiters but PRESERVES `[text](url)` — so a crafted field
 * could inject a DISGUISED clickable link (arbitrary visible text → arbitrary
 * target) into the owner's private channel. Breaking the `](` adjacency makes it
 * render as literal text; a bare URL still shows as itself (no deception).
 * Applied ONLY to the delivered message — the persisted submission keeps the raw
 * value for accurate `read_contacts` recall.
 */
function deLinkify(s: string): string {
  return s.replace(/]\(/g, '] (');
}

/** Pure: format the owner-facing notification from a validated submission. */
export function buildContactNotification(c: {
  name: string;
  email: string;
  company: string | null;
  role: string | null;
  source?: string | null;
  message: string;
}): string {
  const lines = ['📬 New contact via the portal', '', `From: ${deLinkify(c.name)} <${deLinkify(c.email)}>`];
  if (c.company) lines.push(`Company: ${deLinkify(c.company)}`);
  if (c.role) lines.push(`Role: ${deLinkify(c.role)}`);
  if (c.source) lines.push(`Came from: ${deLinkify(c.source)}`);
  lines.push('', deLinkify(c.message));
  return lines.join('\n');
}

/** A stable fingerprint of the submission's content for dedup (§24.121). */
export function contactFingerprint(c: {
  email: string;
  company: string | null;
  role: string | null;
  message: string;
}): string {
  const norm = `${c.email}\n${c.company ?? ''}\n${c.role ?? ''}\n${c.message}`.toLowerCase().trim();
  return createHash('sha256').update(norm).digest('hex');
}

function isoSecondsAgo(seconds: number): string {
  return new Date(Date.now() - seconds * 1000).toISOString();
}

/** True iff an identical submission was already DELIVERED within the window — keyed
 *  on `delivered=1` so a failed-delivery retry still goes through (§24.121). */
function isRecentDuplicate(db: Database.Database, fingerprint: string, windowSec: number): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM contact_submissions
         WHERE fingerprint = ? AND delivered = 1 AND created_at > ? LIMIT 1`,
    )
    .get(fingerprint, isoSecondsAgo(windowSec));
  return row != null;
}

/** Count contacts persisted within the window — the global flood-cap gauge (§24.121). */
function contactsInWindow(db: Database.Database, windowSec: number): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM contact_submissions WHERE created_at > ?`)
    .get(isoSecondsAgo(windowSec)) as { n: number };
  return row.n;
}

/** Persist a submission and prune to the newest `retentionMax` (§24.121). Best-effort. */
function persistContact(
  db: Database.Database,
  c: {
    name: string;
    email: string;
    company: string | null;
    role: string | null;
    source: string | null;
    message: string;
    fingerprint: string;
    delivered: boolean;
  },
  retentionMax: number,
): void {
  const id = `contact-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO contact_submissions
       (id, name, email, company, role, source, message, fingerprint, delivered, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    c.name,
    c.email,
    c.company,
    c.role,
    c.source,
    c.message,
    c.fingerprint,
    c.delivered ? 1 : 0,
    new Date().toISOString(),
  );
  if (retentionMax > 0) {
    db.prepare(
      `DELETE FROM contact_submissions
         WHERE id NOT IN (
           SELECT id FROM contact_submissions ORDER BY created_at DESC, rowid DESC LIMIT ?
         )`,
    ).run(retentionMax);
  }
}

/**
 * Relay a contact submission to the owner's wired channel(s). Validates,
 * formats, delivers verbatim, and persists for recall. Returns ok iff ≥1
 * delivery succeeded (or the submission was a benign duplicate) so the visitor is
 * only told "Sent" when it actually reached the owner. Never throws.
 */
export async function relayContactSubmission(input: ContactInput): Promise<ContactResult> {
  const db = getDb();

  // Kill switch (§24.121) — the emergency off-switch for a contact-spam event.
  if (!cfgBool(db, 'contact_relay_enabled', true)) {
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'Contact relay is not available right now.' } };
  }

  const name = field(input.name, MAX_NAME);
  const email = field(input.email, MAX_EMAIL);
  const message = field(input.message, cfgNum(db, 'contact_message_max_chars', DEFAULT_MESSAGE_MAX));

  if (!name || !email || !message) {
    return { ok: false, error: { code: 'BAD_ARGS', message: 'name, email, and message are required.' } };
  }
  const company = field(input.company, MAX_COMPANY);
  const role = field(input.role, MAX_ROLE);
  const source = field(input.source, MAX_SOURCE);
  const fingerprint = contactFingerprint({ email, company, role, message });

  // The abuse backstops (§24.121) are best-effort — a DB hiccup fails OPEN (the
  // relay still delivers); persistence wraps its own try/catch below.
  try {
    const dedupWindow = cfgNum(db, 'contact_dedup_window_sec', 300);
    if (dedupWindow > 0 && isRecentDuplicate(db, fingerprint, dedupWindow)) {
      log.info('Contact relay: duplicate suppressed', { company });
      return { ok: true, delivered: 0, deduped: true };
    }
    const windowSec = cfgNum(db, 'contact_relay_window_sec', 60);
    const maxPerWindow = cfgNum(db, 'contact_relay_max_per_window', 30);
    if (maxPerWindow > 0 && windowSec > 0 && contactsInWindow(db, windowSec) >= maxPerWindow) {
      log.warn('Contact relay: flood cap hit — submission refused', { windowSec, maxPerWindow });
      return {
        ok: false,
        error: { code: 'UNAVAILABLE', message: 'Too many contact submissions right now — try again shortly.' },
      };
    }
  } catch (err) {
    log.warn('contact relay: backstop check failed (fail-open)', { err });
  }

  const text = buildContactNotification({ name, email, company, role, source, message });

  let delivered = 0;
  const ag = getAgentGroupByFolder(OWNER_FOLDER);
  const channels = ag ? getMessagingGroupsByAgentGroup(ag.id) : [];
  const adapter = getDeliveryAdapter();
  if (!ag || !adapter || channels.length === 0) {
    log.error('contact relay: no channel/adapter to relay to', {
      hasGroup: !!ag,
      channels: channels.length,
      hasAdapter: !!adapter,
    });
  } else {
    for (const mg of channels) {
      try {
        await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat', JSON.stringify({ text }));
        delivered++;
      } catch (err) {
        log.warn('contact relay: delivery to a channel failed', { channelType: mg.channel_type, err });
      }
    }
  }

  // Persist for recall (§24.121) — ALWAYS (so `read_contacts` surfaces it even on
  // a delivery hiccup), best-effort: a persist/prune failure never changes the
  // delivery result the visitor sees.
  try {
    persistContact(
      db,
      { name, email, company, role, source, message, fingerprint, delivered: delivered > 0 },
      cfgNum(db, 'contact_retention_max', 500),
    );
  } catch (err) {
    log.warn('contact relay: persist failed (delivery unaffected)', { err });
  }

  if (delivered === 0) {
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'Contact relay could not reach a channel.' } };
  }
  log.info('Contact relayed to owner', { delivered, company });
  return { ok: true, delivered };
}
