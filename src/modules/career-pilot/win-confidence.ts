/**
 * src/modules/career-pilot/win-confidence.ts — LLM-assessed win confidence.
 *
 * `win_confidence` (0–100, "how likely this becomes an offer") is the one funnel
 * field that's a judgment, not data — so it's set with *intelligence*: a
 * host-side Portkey (Haiku) call reads each active application's stage + the
 * recruiter's actual email signals (classifications + subjects) and rates it.
 * Closed applications (REJECTED/WITHDRAWN) are 0 by definition (no LLM). Routes
 * through Portkey exactly like the sim's prose adapter — a host fetch with the
 * AI-Provider slug in the model field — so the spend lands in Portkey's
 * observability.
 *
 * Best-effort: with no PORTKEY_API_KEY, under PORTKEY_BYPASS, with no active
 * applications, or on any failure, scores are left unchanged (the board renders
 * `win_confidence` as "—"). Never throws.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { upsertPublicFunnelView } from '../portal/public-funnel-view.js';

const HAIKU_MODEL = 'claude-haiku-4-5';

/** True when a host-side Portkey call is possible (key present, not bypassed). */
function portkeyConfigured(): boolean {
  return !!process.env.PORTKEY_API_KEY && process.env.PORTKEY_BYPASS !== 'true';
}

export interface WinConfidenceResult {
  /** Active applications the LLM scored. */
  scored: number;
  /** Closed applications zeroed deterministically (no LLM). */
  closed: number;
}

async function callHaikuJson(prompt: string): Promise<string> {
  const base = process.env.PORTKEY_BASE_URL || 'https://api.portkey.ai/v1';
  const provider = process.env.PORTKEY_AI_PROVIDER || 'anthropic-default';
  const res = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-portkey-api-key': process.env.PORTKEY_API_KEY as string },
    body: JSON.stringify({
      model: `@${provider}/${HAIKU_MODEL}`,
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`portkey HTTP ${res.status}`);
  const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('portkey: no content in completion');
  return text;
}

/** Pull the first JSON object out of a completion (tolerates a code fence / prose). */
function extractJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('no JSON object in completion');
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
}

/**
 * Score `applications.win_confidence` with intelligence + refresh the board.
 * Closed apps → 0; active apps → an LLM rating from their recruiter signals.
 */
export async function scoreWinConfidence(db: Database.Database): Promise<WinConfidenceResult> {
  // 1. Closed applications are 0 by definition — deterministic, no LLM.
  let closed = 0;
  try {
    const closedRows = db
      .prepare(
        "SELECT id FROM applications WHERE upper(status) IN ('REJECTED','WITHDRAWN') AND (win_confidence IS NULL OR win_confidence <> 0)",
      )
      .all() as Array<{ id: string }>;
    for (const r of closedRows) {
      db.prepare('UPDATE applications SET win_confidence = 0 WHERE id = ?').run(r.id);
      upsertPublicFunnelView(db, r.id);
      closed++;
    }
  } catch (err) {
    log.error('scoreWinConfidence: zeroing closed applications failed', { err });
  }

  // 2. Active applications → an LLM rating.
  const active = db
    .prepare(
      "SELECT id, company_name, role_title, status FROM applications WHERE upper(status) NOT IN ('REJECTED','WITHDRAWN')",
    )
    .all() as Array<{ id: string; company_name: string; role_title: string | null; status: string }>;
  if (active.length === 0 || !portkeyConfigured()) return { scored: 0, closed };

  // The recruiter signals per application (classification + subject), in order.
  const evidence = new Map<string, string[]>();
  const evRows = db
    .prepare(
      `SELECT linked_application_id AS app_id, classification, subject
         FROM email_events
        WHERE linked_application_id IS NOT NULL
        ORDER BY received_at ASC`,
    )
    .all() as Array<{ app_id: string; classification: string; subject: string | null }>;
  for (const e of evRows) {
    const list = evidence.get(e.app_id) ?? [];
    list.push(e.subject ? `${e.classification} ("${e.subject}")` : e.classification);
    evidence.set(e.app_id, list);
  }

  const lines = active.map((a) => {
    const sig = (evidence.get(a.id) ?? []).join(', ') || 'no recruiter emails yet';
    return `- id "${a.id}": ${a.role_title ?? 'a role'} at ${a.company_name}, stage ${a.status}. Recruiter signals: ${sig}.`;
  });
  const prompt = [
    'You rate how likely each job application is to result in an OFFER, as an integer 0–100.',
    "Weigh the stage reached and the recruiter's signals — enthusiasm, momentum, specificity. An application already at the OFFER stage is ~95–100; early or quiet ones are lower.",
    'Return ONLY a JSON object mapping each id to its integer score. No prose, no code fence.',
    '',
    'Applications:',
    ...lines,
  ].join('\n');

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(await callHaikuJson(prompt));
  } catch (err) {
    log.warn('scoreWinConfidence: LLM scoring failed, leaving scores unchanged', { err });
    return { scored: 0, closed };
  }

  let scored = 0;
  for (const a of active) {
    const raw = parsed[a.id];
    const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
    if (!Number.isFinite(n)) continue;
    const clamped = Math.max(0, Math.min(100, Math.round(n)));
    try {
      db.prepare('UPDATE applications SET win_confidence = ? WHERE id = ?').run(clamped, a.id);
      upsertPublicFunnelView(db, a.id);
      scored++;
    } catch (err) {
      log.error('scoreWinConfidence: update failed', { id: a.id, err });
    }
  }
  log.info('scoreWinConfidence: scored', { scored, closed });
  return { scored, closed };
}
