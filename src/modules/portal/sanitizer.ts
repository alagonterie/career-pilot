/**
 * src/modules/portal/sanitizer.ts — Sub-milestone 4.1 sanitization pipeline.
 *
 * Pass 1: deterministic regex (emails, phones, SSN-like, monetary, URL
 *         query-param PII).
 * Pass 2: company name + alias replacement. Loads `applications` WHERE
 *         `public_state != 'public'`, replaces each row's name + aliases
 *         with `[REDACTED:<obfuscated_label>]` (word-boundary, case-insensitive).
 * Pass 3: no-op stub. Will land in Sub-milestone 4.2 after the
 *         architectural choice flagged in STRATEGY.md §24.10 out-of-scope.
 *
 * Synchronous + no throws. Every code path returns a string. Regex compile
 * failures (defensive — `escapeRegex` should prevent these) log and continue.
 */
import type Database from 'better-sqlite3';

import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

export interface SanitizeOpts {
  application_id?: string;
  db?: Database.Database;
}

// ── Pass 1 patterns ───────────────────────────────────────────────────────

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// NA-style phone. (?<!\d) / (?!\d) prevent matching inside longer digit runs
// like year-month-day "2026-05-28" or "20260528".
const PHONE_NA_RE = /(?<!\d)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g;
const PHONE_INTL_RE = /(?<!\d)\+\d{1,3}[\s.-]?\d{7,}(?!\d)/g;
// Monetary: order matters — most specific first so K/M suffix wins over
// the plain-dollar fallback. `$220k`, `$1.5M`, `$220,000`, `$220` all
// redact; bare `100k` (no `$`) and a lone `$` do not.
const MONEY_K_M_RE = /\$\d+(?:\.\d+)?[kKmM]\b/g;
const MONEY_COMMA_RE = /\$\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g;
const MONEY_PLAIN_RE = /\$\d+(?:\.\d{2})?/g;

const URL_QUERY_PII_KEYS = ['email', 'recruiter_id', 'applicant_id'];

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripUrlQueryPii(text: string): string {
  return text.replace(/https?:\/\/\S+\?\S+/g, (url) => {
    const qIdx = url.indexOf('?');
    if (qIdx === -1) return url;
    const base = url.slice(0, qIdx);
    const query = url.slice(qIdx + 1);
    const params = query.split('&').map((kv) => {
      const eq = kv.indexOf('=');
      if (eq === -1) return kv;
      const key = kv.slice(0, eq);
      if (URL_QUERY_PII_KEYS.includes(key.toLowerCase())) {
        return `${key}=[REDACTED]`;
      }
      return kv;
    });
    return `${base}?${params.join('&')}`;
  });
}

export function applyPass1(text: string): string {
  let t = text;
  // SSN before phone — SSN's 3-2-4 shape is more specific than phone's
  // 3-3-4, but defensive ordering avoids any future regex tweaks colliding.
  t = t.replace(SSN_RE, '[SSN_REDACTED]');
  t = t.replace(EMAIL_RE, '[EMAIL_REDACTED]');
  t = t.replace(MONEY_K_M_RE, '[AMOUNT_REDACTED]');
  t = t.replace(MONEY_COMMA_RE, '[AMOUNT_REDACTED]');
  t = t.replace(MONEY_PLAIN_RE, '[AMOUNT_REDACTED]');
  t = t.replace(PHONE_NA_RE, '[PHONE_REDACTED]');
  t = t.replace(PHONE_INTL_RE, '[PHONE_REDACTED]');
  t = stripUrlQueryPii(t);
  return t;
}

// ── Pass 2: company name + alias replacement ──────────────────────────────

interface ApplicationForRedaction {
  id: string;
  company_name: string;
  company_aliases: string | null;
  obfuscated_label: string;
  public_state: string;
}

export function applyPass2(text: string, db: Database.Database): string {
  let apps: ApplicationForRedaction[];
  try {
    apps = db
      .prepare(
        `SELECT id, company_name, company_aliases, obfuscated_label, public_state
           FROM applications
          WHERE public_state != 'public'`,
      )
      .all() as ApplicationForRedaction[];
  } catch (err) {
    log.error('sanitize Pass 2: failed to load applications', { err });
    return text;
  }

  let t = text;
  for (const app of apps) {
    if (!app.obfuscated_label) continue;
    const aliases: string[] = [app.company_name];
    if (app.company_aliases) {
      try {
        const parsed = JSON.parse(app.company_aliases);
        if (Array.isArray(parsed)) {
          for (const a of parsed) {
            if (typeof a === 'string') aliases.push(a);
          }
        }
      } catch {
        // Malformed company_aliases JSON — skip the parsed list, still
        // do company_name replacement.
      }
    }
    const unique = [...new Set(aliases.filter((s) => s && s.length > 0))];
    for (const alias of unique) {
      try {
        // (?<!\w) / (?!\w) lookarounds instead of \b — \b requires a
        // word↔non-word transition, which fails when the alias starts or
        // ends with a non-word char (e.g., "Microsoft (Bing)"). The
        // lookarounds work uniformly.
        const re = new RegExp(`(?<!\\w)${escapeRegex(alias)}(?!\\w)`, 'gi');
        t = t.replace(re, `[REDACTED:${app.obfuscated_label}]`);
      } catch (err) {
        log.warn('sanitize Pass 2: regex compile failed', { alias, err });
      }
    }
  }
  return t;
}

// ── Pass 3 stub ───────────────────────────────────────────────────────────

/**
 * No-op stub. Sub-milestone 4.2 will replace this with a Haiku LLM review
 * (or whichever architectural option from §24.10 we pick — Pass 3 can't
 * run host-side since OneCLI's credential injection only covers container
 * env).
 */
export function applyPass3(text: string, _opts: SanitizeOpts): string {
  return text;
}

// ── Public entry point ────────────────────────────────────────────────────

export function sanitize(raw: string, opts: SanitizeOpts = {}): string {
  const db = opts.db ?? getDb();
  let t = applyPass1(raw);
  t = applyPass2(t, db);
  t = applyPass3(t, opts);
  return t;
}
