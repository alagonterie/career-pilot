/**
 * Host-side proactive guardrails: quiet hours + the daily frequency cap
 * (STRATEGY.md §24.52). Pure window/time logic + the config read; the actual
 * gating lives in the killer-match branch of `check_trigger_eligibility`
 * (job-lead-actions.ts), which runs BEFORE the turn so a suppressed fire makes
 * zero model calls.
 *
 * `quiet_hours` is "HH:MM-HH:MM" interpreted in `quiet_hours_tz` (empty ⇒ the
 * system TIMEZONE). The window may wrap midnight (the default 22:00-07:00 does).
 * An empty or zero-length (start==end) window means "no quiet hours".
 */
import type Database from 'better-sqlite3';

import { TIMEZONE } from '../../config.js';
import { getConfig } from '../../get-config.js';

export interface ProactiveGateConfig {
  /** Raw "HH:MM-HH:MM" (may be empty/invalid ⇒ no quiet hours). */
  quietHours: string;
  /** Resolved IANA zone — the system TIMEZONE when the pref is empty. */
  quietHoursTz: string;
  /** Max proactive killer-match pushes per local day; 0 ⇒ disabled. */
  capPerDay: number;
}

export function readProactiveGateConfig(db: Database.Database): ProactiveGateConfig {
  const quietHours = getConfig<string>(db, 'quiet_hours') ?? '';
  const rawTz = (getConfig<string>(db, 'quiet_hours_tz') ?? '').trim();
  const capPerDay = getConfig<number>(db, 'telegram_proactive_frequency_cap_per_day') ?? 0;
  return {
    quietHours,
    quietHoursTz: rawTz || TIMEZONE,
    capPerDay: Number.isFinite(capPerDay) && capPerDay > 0 ? capPerDay : 0,
  };
}

/** Parse "HH:MM-HH:MM" → minutes-since-midnight bounds, or null if empty/invalid/zero-length. */
export function parseQuietHours(window: string): { startMin: number; endMin: number } | null {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(window ?? '');
  if (!m) return null;
  const sh = Number(m[1]);
  const sm = Number(m[2]);
  const eh = Number(m[3]);
  const em = Number(m[4]);
  if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (startMin === endMin) return null; // zero-length ⇒ disabled
  return { startMin, endMin };
}

/** Minutes since local midnight for `now` in `tz`. Falls back to TIMEZONE on an invalid zone. */
export function localMinutes(now: Date, tz: string): number {
  const fmt = (zone: string): Intl.DateTimeFormatPart[] =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = fmt(tz);
  } catch {
    parts = fmt(TIMEZONE);
  }
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24; // Intl can emit "24" at midnight
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hh * 60 + mm;
}

/** Is `now` inside the quiet-hours window (in `tz`)? Handles a window that wraps midnight. */
export function isWithinQuietHours(now: Date, window: string, tz: string): boolean {
  const parsed = parseQuietHours(window);
  if (!parsed) return false; // no/invalid window ⇒ never quiet
  const cur = localMinutes(now, tz);
  const { startMin, endMin } = parsed;
  if (startMin < endMin) return cur >= startMin && cur < endMin; // same-day window
  return cur >= startMin || cur < endMin; // wraps midnight (e.g. 22:00-07:00)
}

/** Is `tz` a usable IANA zone? Empty string is allowed (means "the system zone"). */
export function isValidTimezone(tz: string): boolean {
  if (!tz) return true;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The proactive-guardrail preferences the candidate may set via natural language (set_preference). */
export const PROACTIVE_PREF_KEYS = [
  'quiet_hours',
  'quiet_hours_tz',
  'telegram_proactive_frequency_cap_per_day',
] as const;
export type ProactivePrefKey = (typeof PROACTIVE_PREF_KEYS)[number];

/**
 * Validate + normalize a `set_preference` write. The agent supplies a key from
 * `PROACTIVE_PREF_KEYS` and a value parsed from the candidate's natural-language
 * request; the host stores the normalized string form (or rejects it). Reversible
 * and non-destructive — it only writes the `preferences` row.
 */
export function validateProactivePref(
  key: string,
  value: unknown,
): { ok: true; key: ProactivePrefKey; value: string } | { ok: false; message: string } {
  if (!(PROACTIVE_PREF_KEYS as readonly string[]).includes(key)) {
    return { ok: false, message: `key must be one of: ${PROACTIVE_PREF_KEYS.join(', ')}` };
  }
  const k = key as ProactivePrefKey;

  if (k === 'quiet_hours') {
    const s = String(value ?? '').trim();
    if (s !== '' && !parseQuietHours(s)) {
      return { ok: false, message: 'quiet_hours must be "HH:MM-HH:MM" (24-hour) or "" to disable' };
    }
    return { ok: true, key: k, value: s };
  }
  if (k === 'quiet_hours_tz') {
    const s = String(value ?? '').trim();
    if (!isValidTimezone(s)) {
      return {
        ok: false,
        message: 'quiet_hours_tz must be a valid IANA zone (e.g. America/Denver) or "" for the system zone',
      };
    }
    return { ok: true, key: k, value: s };
  }
  // telegram_proactive_frequency_cap_per_day
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(n) || n < 0) {
    return { ok: false, message: 'telegram_proactive_frequency_cap_per_day must be a non-negative integer (0 = off)' };
  }
  return { ok: true, key: k, value: String(n) };
}

/** UTC ISO of the most recent local midnight in `tz` — the cap's "today" boundary. */
export function startOfLocalDayUtcIso(now: Date, tz: string): string {
  // Whole-minute zone offsets (true for all modern IANA zones) mean the
  // current minute's seconds/ms are identical in UTC and local, so we can
  // walk back from `now` by the local minutes-since-midnight plus the
  // sub-minute remainder to land on local midnight.
  const minsSinceMidnight = localMinutes(now, tz);
  const subMinuteMs = now.getUTCSeconds() * 1000 + now.getUTCMilliseconds();
  return new Date(now.getTime() - (minsSinceMidnight * 60_000 + subMinuteMs)).toISOString();
}
