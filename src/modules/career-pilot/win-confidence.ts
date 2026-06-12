/**
 * src/modules/career-pilot/win-confidence.ts — LLM-assessed win confidence.
 *
 * `win_confidence` (0–100, "how likely this becomes an offer") is the one funnel
 * field that's a judgment, not data — so it's set with *intelligence*: a
 * host-side Portkey (Haiku) call blends two factors — FIT (the candidate's
 * profile vs what the role asks for, the prior, knowable from day one) and
 * MOMENTUM (the stage reached + the recruiter's email signals, the evidence that
 * updates the prior) — and returns a score + a one-sentence rationale citing
 * both. Closed applications (REJECTED/WITHDRAWN) are 0 by definition (no LLM). Routes
 * through Portkey exactly like the sim's prose adapter — a host fetch with the
 * AI-Provider slug in the model field — so the spend lands in Portkey's
 * observability.
 *
 * Best-effort: with no PORTKEY_API_KEY, under PORTKEY_BYPASS, with no active
 * applications, or on any failure, scores are left unchanged (the board renders
 * `win_confidence` as "—"). Never throws. The Portkey call goes through the
 * shared host helper (src/llm-fetch.ts, §24.68 D5), which records a
 * request_telemetry row on both outcomes.
 */
import type Database from 'better-sqlite3';

import { callPortkeyChat, portkeyConfigured } from '../../llm-fetch.js';
import { log } from '../../log.js';
import { upsertPublicFunnelView } from '../portal/public-funnel-view.js';

import { readCandidateProfile } from './render-persona.js';

const HAIKU_MODEL = 'claude-haiku-4-5';

export interface WinConfidenceResult {
  /** Active applications the LLM scored. */
  scored: number;
  /** Closed applications zeroed deterministically (no LLM). */
  closed: number;
}

async function callHaikuJson(prompt: string, traceId?: string): Promise<string> {
  const result = await callPortkeyChat({
    surface: 'win-confidence',
    messages: [{ role: 'user', content: prompt }],
    maxTokens: 1000,
    model: HAIKU_MODEL,
    traceId,
  });
  return result.text;
}

/** A compact summary of the candidate (the "fit" side) for the scoring prompt. */
function candidateProfileLines(): string[] {
  const p = readCandidateProfile();
  if (!p) return [];
  const arr = (raw: string | null): string[] => {
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as unknown;
      return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    } catch {
      return [];
    }
  };
  const lines: string[] = [];
  const roles = arr(p.target_roles);
  const skills = arr(p.skills);
  if (roles.length) lines.push(`- Target roles: ${roles.join(', ')}`);
  if (skills.length) lines.push(`- Key skills: ${skills.join(', ')}`);
  if (p.comp_floor != null) lines.push(`- Comp floor: $${p.comp_floor}`);
  const background = (p.master_resume || p.bio || '').replace(/\s+/g, ' ').trim();
  if (background) lines.push(`- Background: ${background.slice(0, 500)}`);
  return lines;
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
        "SELECT id FROM applications WHERE upper(status) IN ('REJECTED','WITHDRAWN') AND (win_confidence IS NULL OR win_confidence <> 0 OR win_confidence_rationale IS NULL)",
      )
      .all() as Array<{ id: string }>;
    for (const r of closedRows) {
      db.prepare(
        "UPDATE applications SET win_confidence = 0, win_confidence_rationale = 'Application closed — no longer active.' WHERE id = ?",
      ).run(r.id);
      upsertPublicFunnelView(db, r.id);
      closed++;
    }
  } catch (err) {
    log.error('scoreWinConfidence: zeroing closed applications failed', { err });
  }

  // 2. Active applications → an LLM rating that blends fit + momentum.
  const active = db
    .prepare(
      "SELECT id, company_name, role_title, jd_text, status FROM applications WHERE upper(status) NOT IN ('REJECTED','WITHDRAWN')",
    )
    .all() as Array<{
    id: string;
    company_name: string;
    role_title: string | null;
    jd_text: string | null;
    status: string;
  }>;
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
    const jd = a.jd_text ? a.jd_text.replace(/\s+/g, ' ').trim().slice(0, 300) : 'role details unavailable';
    return `- id "${a.id}": role "${a.role_title ?? 'unknown'}". The role asks: ${jd}. Funnel: stage ${a.status}, recruiter signals: ${sig}.`;
  });
  const profile = candidateProfileLines();
  const prompt = [
    ...(profile.length ? ['Candidate profile (for fit):', ...profile, ''] : []),
    'Rate each application’s likelihood of an OFFER (0–100) by combining TWO factors:',
    '1. FIT — how well the candidate’s profile matches what the role asks for (the prior, knowable from day one).',
    '2. MOMENTUM — the stage reached + recruiter signals (the evidence that updates the prior).',
    'A strong-fit application early in the funnel can still be moderate; a weak-fit one late in the funnel is buoyed by its momentum. An offer in hand is ~95–100; a quiet early application is low.',
    'Return ONLY a JSON object mapping each id to {"score": <integer 0–100>, "reason": "<one sentence (~160 chars) citing BOTH the fit and the momentum. Do NOT name the company or any person.>"}.',
    'No prose outside the JSON object, no code fence.',
    '',
    'Applications:',
    ...lines,
  ].join('\n');

  let parsed: Record<string, unknown>;
  try {
    parsed = extractJsonObject(await callHaikuJson(prompt, `win-confidence-${Date.now()}`));
  } catch (err) {
    log.warn('scoreWinConfidence: LLM scoring failed, leaving scores unchanged', { err });
    return { scored: 0, closed };
  }

  let scored = 0;
  for (const a of active) {
    const entry = parsed[a.id];
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as { score?: unknown; reason?: unknown };
    const n = typeof e.score === 'number' ? e.score : typeof e.score === 'string' ? Number(e.score) : NaN;
    if (!Number.isFinite(n)) continue;
    const clamped = Math.max(0, Math.min(100, Math.round(n)));
    const reason = typeof e.reason === 'string' && e.reason.trim().length > 0 ? e.reason.trim().slice(0, 240) : null;
    try {
      db.prepare('UPDATE applications SET win_confidence = ?, win_confidence_rationale = ? WHERE id = ?').run(
        clamped,
        reason,
        a.id,
      );
      upsertPublicFunnelView(db, a.id);
      scored++;
    } catch (err) {
      log.error('scoreWinConfidence: update failed', { id: a.id, err });
    }
  }
  log.info('scoreWinConfidence: scored', { scored, closed });
  return { scored, closed };
}
