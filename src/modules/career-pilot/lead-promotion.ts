/**
 * src/modules/career-pilot/lead-promotion.ts — deterministic lead → application
 * promotion (STRATEGY.md §24.175).
 *
 * `job_leads` is the orchestrator's world-model of discovered roles. When one of
 * those roles becomes a real application, we link the two (`job_leads.application_id`)
 * and flip the lead to `applied` — closing the loop the stale-close sweep already
 * assumes (`AND application_id IS NULL` skips promoted leads).
 *
 * The "applied" signal is a STATUS TRANSITION, not row creation: applications start
 * `BOOKMARKED` and only later reach a submitted stage. This runs from
 * `reactToStatusTransitions` (the same reactor interview-kit auto-gen rides), so it
 * fires for both the agent/candidate path (`update_application`) and the email path
 * (`application_confirmation` → `applyPipelineFromEmailEvents`). Host-side,
 * deterministic, no LLM, idempotent (one lead per application), never throws.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';

import type { StatusTransition } from './interview-kit-trigger.js';

/** Application statuses that mean the candidate actually applied — everything past
 * `BOOKMARKED`. Entry into any of these promotes the originating lead (a later
 * stage still implies an application was submitted). */
const SUBMITTED_STATUSES = new Set(['APPLIED', 'SCREENING', 'TECH_SCREEN', 'FINAL', 'OFFER', 'REJECTED']);

export interface LeadPromotion {
  leadId: string;
  via: 'url' | 'company_title';
}

interface AppRow {
  company_name: string | null;
  role_title: string | null;
  job_url: string | null;
}
interface LeadRow {
  id: string;
  source_url: string | null;
  apply_url: string | null;
  company: string | null;
  title: string | null;
  rules_score: number | null;
}

function normUrl(u: string | null | undefined): string | null {
  if (!u) return null;
  const t = u.trim().toLowerCase().replace(/\/+$/, '');
  return t === '' ? null : t;
}

/** Lowercase + collapse whitespace. */
function normText(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase().replace(/\s+/g, ' ');
  return t === '' ? null : t;
}

/** normText + strip trailing corporate suffix/punctuation ("Acme, Inc." → "acme"). */
function normCompany(s: string | null | undefined): string | null {
  const t = normText(s);
  if (!t) return null;
  const stripped = t
    .replace(/[.,]/g, '')
    .replace(/\s+(inc|llc|ltd|corp|co|company|gmbh)$/, '')
    .trim();
  return stripped === '' ? t : stripped;
}

/** Highest rules_score wins; null scores sort last. Deterministic tie-break. */
function pickBest(rows: LeadRow[]): LeadRow | null {
  if (rows.length === 0) return null;
  return [...rows].sort((a, b) => (b.rules_score ?? -1) - (a.rules_score ?? -1))[0];
}

function matchLead(app: AppRow, candidates: LeadRow[]): LeadPromotion | null {
  // 1) Exact URL: the agent applied to a lead in the pool (same posting URL).
  const appUrl = normUrl(app.job_url);
  if (appUrl) {
    const urlMatches = candidates.filter((c) => normUrl(c.source_url) === appUrl || normUrl(c.apply_url) === appUrl);
    const best = pickBest(urlMatches);
    if (best) return { leadId: best.id, via: 'url' };
  }
  // 2) Fallback: normalized company + title both equal.
  const appCo = normCompany(app.company_name);
  const appTitle = normText(app.role_title);
  if (appCo && appTitle) {
    const ctMatches = candidates.filter((c) => normCompany(c.company) === appCo && normText(c.title) === appTitle);
    const best = pickBest(ctMatches);
    if (best) return { leadId: best.id, via: 'company_title' };
  }
  return null;
}

/**
 * Link + flip the lead that an application came from when that application enters a
 * submitted stage. No-op for non-submitted transitions, when the app already
 * promoted a lead, or when nothing matches. Returns the promotion or null.
 */
export function promoteLeadOnApplied(db: Database.Database, change: StatusTransition): LeadPromotion | null {
  try {
    if (!SUBMITTED_STATUSES.has(String(change.to).toUpperCase())) return null;

    // One lead per application: a prior transition already promoted it.
    const already = db.prepare('SELECT id FROM job_leads WHERE application_id = ? LIMIT 1').get(change.application_id);
    if (already) return null;

    const app = db
      .prepare('SELECT company_name, role_title, job_url FROM applications WHERE id = ?')
      .get(change.application_id) as AppRow | undefined;
    if (!app) return null;

    const candidates = db
      .prepare(
        `SELECT id, source_url, apply_url, company, title, rules_score
           FROM job_leads
          WHERE closed_at IS NULL AND application_id IS NULL AND status != 'applied'`,
      )
      .all() as LeadRow[];
    if (candidates.length === 0) return null;

    const match = matchLead(app, candidates);
    if (!match) return null;

    const now = new Date().toISOString();
    db.prepare(
      `UPDATE job_leads SET application_id = @appId, status = 'applied', status_changed_at = @now WHERE id = @id`,
    ).run({ id: match.leadId, appId: change.application_id, now });

    log.info('job_lead promoted to applied on application transition', {
      leadId: match.leadId,
      applicationId: change.application_id,
      via: match.via,
      to: change.to,
    });
    return match;
  } catch (err) {
    log.error('promoteLeadOnApplied failed', {
      change,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export interface BackfillResult {
  scanned: number;
  promotions: Array<{ applicationId: string; leadId: string; via: LeadPromotion['via'] }>;
}

/**
 * One-time backfill (§24.175): link leads for applications that ALREADY reached a
 * submitted stage before the live promotion hook existed (the hook fires on the
 * transition, which those apps are past). Reuses the exact runtime path
 * (`promoteLeadOnApplied`), oldest application first so earlier applications claim
 * leads first. Idempotent + safe to re-run (already-linked apps and already-linked
 * leads are skipped). The caller controls commit vs. dry-run — wrap in a
 * transaction and roll back to preview without writing.
 */
export function backfillLeadPromotions(db: Database.Database): BackfillResult {
  const apps = db
    .prepare(
      `SELECT id, status FROM applications
        WHERE upper(status) IN ('APPLIED', 'SCREENING', 'TECH_SCREEN', 'FINAL', 'OFFER', 'REJECTED')
        ORDER BY applied_at ASC, created_at ASC`,
    )
    .all() as Array<{ id: string; status: string }>;

  const promotions: BackfillResult['promotions'] = [];
  for (const a of apps) {
    const match = promoteLeadOnApplied(db, { application_id: a.id, to: a.status });
    if (match) promotions.push({ applicationId: a.id, leadId: match.leadId, via: match.via });
  }
  return { scanned: apps.length, promotions };
}
