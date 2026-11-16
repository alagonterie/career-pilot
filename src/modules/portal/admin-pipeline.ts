/**
 * src/modules/portal/admin-pipeline.ts — the owner's read-only Pipeline tab
 * (STRATEGY.md §24.138, §24.204).
 *
 * One GET, no writer: stage changes stay the pipeline-scribe's and the agent's,
 * so there is deliberately no `applyAdminPipelineWrite` and no admin POST route
 * for the pipeline.
 *
 * OWNER view: real company names, titles, the private win-confidence rationale
 * and unsanitized learnings. Nothing here may be reused by a public route — the
 * public `/pipeline` page reads `public_pipeline_view`'s sanitized copy instead.
 *
 * Every join is one query per request (a per-request map keyed by application),
 * never one query per row. Each join degrades on its own: a missing table or a
 * bad JSON column yields that field's empty value, never a 500.
 */
import type Database from 'better-sqlite3';

import { hasTable } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { readLatestScribeState, type LatestScribeState } from '../career-pilot/pipeline-scribe-state.js';

const MS_PER_DAY = 86_400_000;

/** Read-size caps (the tab polls every 20 s): the newest N per application. */
export const ADMIN_PIPELINE_TIMELINE_CAP = 50;
export const ADMIN_PIPELINE_LEARNINGS_CAP = 20;

export type ScribePriority = 'same_day' | 'action_owed' | 'fyi';
const PRIORITY_ORDER: readonly ScribePriority[] = ['same_day', 'action_owed', 'fyi'];

/**
 * Pipeline stage → the key of `pipeline_scribe_ghosting_thresholds_days` that
 * applies to it. A fixed mapping, not a tunable: bookmarked / offer / rejected /
 * withdrawn have no threshold and are never tinted.
 */
export const GHOSTING_STAGE_MAP: Readonly<Record<string, string>> = Object.freeze({
  applied: 'applied',
  screening: 'screen',
  tech: 'onsite',
  final: 'onsite',
});

export interface PipelineTimelineEvent {
  id: string;
  ts: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  source: string;
  summary: string | null;
}

export interface PipelineNarrative {
  current_state: string;
  last_event_at: string | null;
  timeline_excerpt: string[];
}

export interface PipelineAttentionItem {
  priority: ScribePriority;
  reason: string;
  hint: string | null;
}

export interface PipelineSuggestion {
  action: string;
  rationale: string;
  evidence_msg_id: string | null;
}

export interface PipelineLastEmail {
  at: string;
  subject: string | null;
  from_addr: string | null;
  classification: string;
  thread_id: string;
  thread_url: string;
}

export interface PipelineLearning {
  id: string;
  kind: string;
  created_at: string;
  published: boolean;
  text: string;
}

export interface PipelineKit {
  round: string;
  interview_type: string;
  title: string;
  drive_url: string;
  status: 'active' | 'archived';
  interview_at: string | null;
  created_at: string;
}

export interface PipelineTailoredResume {
  id: string;
  lead_id: string;
  created_at: string;
  bio_outcome: string | null;
  sent: boolean;
}

export interface AdminPipelineRow {
  application_id: string;
  company_name: string | null;
  obfuscated_label: string | null;
  role_title: string | null;
  status: string;
  stage: string;
  applied_at: string | null;
  last_activity_at: string | null;
  win_confidence: number | null;
  stage_entered_at: string | null;
  days_in_stage: number | null;
  ghosting_threshold_days: number | null;
  ghosting: boolean;
  win_confidence_rationale: string | null;
  lead_ids: string[];
  posting_url: string | null;
  sent_resume_id: string | null;
  timeline: PipelineTimelineEvent[];
  narrative: PipelineNarrative | null;
  suggestions: PipelineSuggestion[];
  attention: PipelineAttentionItem[];
  attention_top: ScribePriority | null;
  last_email: PipelineLastEmail | null;
  learnings: PipelineLearning[];
  kits: PipelineKit[];
  active_kit_url: string | null;
  tailored_resumes: PipelineTailoredResume[];
}

export interface AdminPipeline {
  applications: AdminPipelineRow[];
  stageCounts: Record<string, number>;
  ghostingThresholdsDays: Record<string, number>;
  ghostingStageMap: Record<string, string>;
  scribe: {
    run_at: string;
    attention_unlinked: (PipelineAttentionItem & { company: string | null })[];
  } | null;
}

// ── small helpers ─────────────────────────────────────────────────────────────

/** Run one join; on any failure log and return the empty value for that field. */
function safely<T>(label: string, fallback: T, fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    log.warn('admin pipeline join degraded', { join: label, err });
    return fallback;
  }
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function groupBy<T>(rows: T[], key: (r: T) => string | null): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    if (k === null) continue;
    const list = out.get(k);
    if (list) list.push(r);
    else out.set(k, [r]);
  }
  return out;
}

function daysSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((now - t) / MS_PER_DAY));
}

function readGhostingThresholds(db: Database.Database): Record<string, number> {
  const raw = safely<unknown>('ghosting_thresholds', {}, () =>
    getConfig<unknown>(db, 'pipeline_scribe_ghosting_thresholds_days'),
  );
  const out: Record<string, number> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
  }
  return out;
}

/** `payload.summary ?? payload.note ?? null`; payload is JSON text. */
function eventSummary(payload: string | null): string | null {
  if (!payload) return null;
  try {
    const p: unknown = JSON.parse(payload);
    if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
    const o = p as Record<string, unknown>;
    return str(o.summary) ?? str(o.note);
  } catch {
    return null;
  }
}

/** A learning's reflections JSON → its string values joined ' · ' (raw text if not JSON). */
function learningText(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object') {
      return Object.values(parsed as Record<string, unknown>)
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .join(' · ');
    }
    return raw;
  } catch {
    return raw;
  }
}

function toPriority(v: unknown): ScribePriority {
  // The persist path does not validate priority; anything outside the three
  // documented values is shown at the lowest level rather than hidden.
  return PRIORITY_ORDER.includes(v as ScribePriority) ? (v as ScribePriority) : 'fyi';
}

function toAttentionItem(a: Record<string, unknown>): PipelineAttentionItem {
  return {
    priority: toPriority(a.priority),
    reason: typeof a.reason === 'string' ? a.reason : '',
    hint: str(a.action_hint),
  };
}

function byPriority<T extends { priority: ScribePriority }>(items: T[]): T[] {
  // Array.prototype.sort is stable, so the scribe's own order holds within a level.
  return [...items].sort((x, y) => PRIORITY_ORDER.indexOf(x.priority) - PRIORITY_ORDER.indexOf(y.priority));
}

function threadUrl(threadId: string, gmailAccount: string | null): string {
  const auth = gmailAccount ? `?authuser=${encodeURIComponent(gmailAccount)}` : '';
  return `https://mail.google.com/mail/${auth}#all/${encodeURIComponent(threadId)}`;
}

// ── the read ──────────────────────────────────────────────────────────────────

interface BaseRow {
  application_id: string;
  company_name: string | null;
  obfuscated_label: string | null;
  role_title: string | null;
  status: string;
  stage: string;
  applied_at: string | null;
  last_activity_at: string | null;
  win_confidence: number | null;
  stage_entered_at: string | null;
  win_confidence_rationale: string | null;
  job_url: string | null;
  sent_resume_id: string | null;
}

interface LeadRow {
  id: string;
  application_id: string;
  apply_url: string | null;
  source_url: string | null;
}

interface EventRow {
  id: string;
  application_id: string;
  ts: string;
  kind: string;
  from_status: string | null;
  to_status: string | null;
  source: string;
  payload: string | null;
}

interface EmailRow {
  at: string;
  subject: string | null;
  from_addr: string | null;
  classification: string;
  thread_id: string;
  /** The application this email counts for (its own link, or its lead's). */
  app_id: string;
}

interface LearningRow {
  id: string;
  application_id: string;
  kind: string;
  created_at: string;
  reflection_published: number | null;
  reflections: string;
}

interface KitRow extends PipelineKit {
  application_id: string;
}

interface ResumeRow {
  id: string;
  lead_id: string;
  created_at: string;
  bio_outcome: string | null;
}

/** The application ids the view lists — every per-request join is scoped to them. */
const VIEW_IDS = 'SELECT application_id FROM public_pipeline_view';

/**
 * The owner pipeline view: the pipeline read-model joined to `applications` for
 * the REAL company name, plus (§24.204) the stage clock, the private rationale,
 * the event timeline, the scribe's latest narrative / attention / suggestions,
 * the newest mail, learnings, kits and the linked lead's tailored résumés.
 * Empty on an un-migrated DB.
 */
export function buildAdminPipeline(db: Database.Database, opts: { now?: Date } = {}): AdminPipeline {
  const now = (opts.now ?? new Date()).getTime();
  const ghostingThresholdsDays = readGhostingThresholds(db);
  const ghostingStageMap = { ...GHOSTING_STAGE_MAP };
  if (!hasTable(db, 'public_pipeline_view')) {
    return { applications: [], stageCounts: {}, ghostingThresholdsDays, ghostingStageMap, scribe: null };
  }

  const base = db
    .prepare(
      `SELECT v.application_id, a.company_name, a.obfuscated_label,
              COALESCE(a.role_title, v.role_title) AS role_title, v.status, v.stage,
              v.applied_at, v.last_activity_at, v.win_confidence, v.stage_entered_at,
              a.win_confidence_rationale, a.job_url, a.sent_resume_id
         FROM public_pipeline_view v
         LEFT JOIN applications a ON a.id = v.application_id
        ORDER BY v.last_activity_at DESC, v.applied_at DESC`,
    )
    .all() as BaseRow[];

  // Linked leads, newest first per application.
  const leads = safely<LeadRow[]>('job_leads', [], () =>
    hasTable(db, 'job_leads')
      ? (db
          .prepare(
            `SELECT id, application_id, apply_url, source_url FROM job_leads
              WHERE application_id IN (${VIEW_IDS})
              ORDER BY first_seen_at DESC, rowid DESC`,
          )
          .all() as LeadRow[])
      : [],
  );
  const leadsByApp = groupBy(leads, (l) => l.application_id);

  const eventsByApp = groupBy(
    safely<EventRow[]>('pipeline_events', [], () =>
      hasTable(db, 'pipeline_events')
        ? (db
            .prepare(
              // The newest ADMIN_PIPELINE_TIMELINE_CAP events per application,
              // served oldest first.
              `SELECT id, application_id, ts, kind, from_status, to_status, source, payload FROM (
                 SELECT id, application_id, ts, kind, from_status, to_status, source, payload, rowid AS rid,
                        ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY ts DESC, rowid DESC) AS rn
                   FROM pipeline_events WHERE application_id IN (${VIEW_IDS}))
                WHERE rn <= ?
                ORDER BY ts ASC, rid ASC`,
            )
            .all(ADMIN_PIPELINE_TIMELINE_CAP) as EventRow[])
        : [],
    ),
    (e) => e.application_id,
  );

  const learningsByApp = groupBy(
    safely<LearningRow[]>('learnings', [], () =>
      hasTable(db, 'learnings')
        ? (db
            .prepare(
              `SELECT id, application_id, kind, created_at, reflection_published, reflections FROM (
                 SELECT id, application_id, kind, created_at, reflection_published, reflections, rowid AS rid,
                        ROW_NUMBER() OVER (PARTITION BY application_id ORDER BY created_at DESC, rowid DESC) AS rn
                   FROM learnings WHERE application_id IN (${VIEW_IDS}))
                WHERE rn <= ?
                ORDER BY created_at DESC, rid DESC`,
            )
            .all(ADMIN_PIPELINE_LEARNINGS_CAP) as LearningRow[])
        : [],
    ),
    (l) => l.application_id,
  );

  const kitsByApp = groupBy(
    safely<KitRow[]>('interview_kits', [], () =>
      hasTable(db, 'interview_kits')
        ? (db
            .prepare(
              `SELECT application_id, round, interview_type, title, drive_url, status, interview_at, created_at
                 FROM interview_kits WHERE application_id IN (${VIEW_IDS})
                ORDER BY created_at DESC, rowid DESC`,
            )
            .all() as KitRow[])
        : [],
    ),
    (k) => k.application_id,
  );

  const resumesByLead = groupBy(
    safely<ResumeRow[]>('tailored_resumes', [], () =>
      hasTable(db, 'tailored_resumes') && hasTable(db, 'job_leads')
        ? (db
            .prepare(
              `SELECT id, lead_id, created_at, bio_outcome FROM tailored_resumes
                WHERE status = 'ready'
                  AND lead_id IN (SELECT id FROM job_leads WHERE application_id IN (${VIEW_IDS}))
                ORDER BY created_at DESC, rowid DESC`,
            )
            .all() as ResumeRow[])
        : [],
    ),
    (r) => r.lead_id,
  );

  const gmailAccount = safely<string | null>('candidate_profile', null, () =>
    hasTable(db, 'candidate_profile')
      ? str(
          (
            db.prepare('SELECT gmail_account FROM candidate_profile WHERE id = 1').get() as
              | { gmail_account: string | null }
              | undefined
          )?.gmail_account,
        )
      : null,
  );

  // Newest email per application, by its own link or by a linked lead's —
  // chosen in SQL, so one row per application is read however much mail there is.
  const lastEmailByApp = new Map<string, PipelineLastEmail>();
  for (const e of safely<EmailRow[]>('email_events', [], () =>
    hasTable(db, 'email_events') && hasTable(db, 'job_leads')
      ? (db
          .prepare(
            `SELECT at, subject, from_addr, classification, thread_id, app_id FROM (
               SELECT m.*, ROW_NUMBER() OVER (PARTITION BY m.app_id ORDER BY m.at DESC, m.rid DESC) AS rn FROM (
                 SELECT COALESCE(e.received_at, e.classified_at) AS at, e.subject, e.from_addr, e.classification,
                        e.thread_id, e.rowid AS rid, e.linked_application_id AS app_id
                   FROM email_events e
                  WHERE e.linked_application_id IN (${VIEW_IDS})
                 UNION
                 SELECT COALESCE(e.received_at, e.classified_at) AS at, e.subject, e.from_addr, e.classification,
                        e.thread_id, e.rowid AS rid, l.application_id AS app_id
                   FROM email_events e JOIN job_leads l ON l.id = e.linked_job_lead_id
                  WHERE l.application_id IN (${VIEW_IDS})
               ) m
             ) WHERE rn = 1`,
          )
          .all() as EmailRow[])
      : [],
  )) {
    if (lastEmailByApp.has(e.app_id)) continue;
    lastEmailByApp.set(e.app_id, {
      at: e.at,
      subject: e.subject,
      from_addr: e.from_addr,
      classification: e.classification,
      thread_id: e.thread_id,
      thread_url: threadUrl(e.thread_id, gmailAccount),
    });
  }

  const scribeState = safely<LatestScribeState | null>('pipeline_scribe_output', null, () => readLatestScribeState(db));
  const viewIds = new Set(base.map((r) => r.application_id));
  const narrativeByApp = new Map<string, PipelineNarrative>();
  const attentionByApp = new Map<string, PipelineAttentionItem[]>();
  const attentionUnlinked: (PipelineAttentionItem & { company: string | null })[] = [];
  if (scribeState) {
    for (const n of scribeState.narratives) {
      const appId = str(n.application_id);
      if (!appId || narrativeByApp.has(appId)) continue;
      narrativeByApp.set(appId, {
        current_state: typeof n.current_state === 'string' ? n.current_state : '',
        last_event_at: str(n.last_event_at),
        timeline_excerpt: Array.isArray(n.timeline_excerpt)
          ? n.timeline_excerpt.map((x) => (typeof x === 'string' ? x : JSON.stringify(x)))
          : [],
      });
    }
    for (const a of scribeState.attention) {
      const appId = str(a.application_id);
      if (appId && viewIds.has(appId)) {
        const list = attentionByApp.get(appId) ?? [];
        list.push(toAttentionItem(a));
        attentionByApp.set(appId, list);
      } else {
        // No application, or one the table does not list: shown above the table
        // so it is never silently lost.
        attentionUnlinked.push({ ...toAttentionItem(a), company: str(a.company) });
      }
    }
  }
  const suggestionItems = (scribeState?.suggestions ?? []).filter(
    (x): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x),
  );

  const applications: AdminPipelineRow[] = base.map((r) => {
    const appLeads = leadsByApp.get(r.application_id) ?? [];
    const leadIds = appLeads.map((l) => l.id);
    const newestLead = appLeads[0];
    const days = daysSince(r.stage_entered_at, now);
    const key = GHOSTING_STAGE_MAP[r.stage];
    const threshold = key !== undefined && key in ghostingThresholdsDays ? ghostingThresholdsDays[key] : null;
    const attention = byPriority(attentionByApp.get(r.application_id) ?? []);
    const targets = new Set([r.application_id, ...leadIds]);
    const kits = (kitsByApp.get(r.application_id) ?? []).map(
      ({ application_id: _app, ...k }): PipelineKit => ({
        ...k,
        status: k.status === 'archived' ? 'archived' : 'active',
      }),
    );
    const tailored = leadIds
      .flatMap((id) => resumesByLead.get(id) ?? [])
      .sort((x, y) => (x.created_at < y.created_at ? 1 : x.created_at > y.created_at ? -1 : 0))
      .map((t) => ({ ...t, sent: t.id === r.sent_resume_id }));

    return {
      application_id: r.application_id,
      company_name: r.company_name,
      obfuscated_label: r.obfuscated_label,
      role_title: r.role_title,
      status: r.status,
      stage: r.stage,
      applied_at: r.applied_at,
      last_activity_at: r.last_activity_at,
      win_confidence: r.win_confidence,
      stage_entered_at: r.stage_entered_at,
      days_in_stage: days,
      ghosting_threshold_days: threshold,
      ghosting: days !== null && threshold !== null && days >= threshold,
      win_confidence_rationale: r.win_confidence_rationale,
      lead_ids: leadIds,
      posting_url: (newestLead ? (newestLead.apply_url ?? newestLead.source_url) : null) ?? r.job_url ?? null,
      sent_resume_id: r.sent_resume_id,
      timeline: (eventsByApp.get(r.application_id) ?? []).map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        from_status: e.from_status,
        to_status: e.to_status,
        source: e.source,
        summary: eventSummary(e.payload),
      })),
      narrative: narrativeByApp.get(r.application_id) ?? null,
      suggestions: suggestionItems
        .filter((s) => typeof s.target_id === 'string' && targets.has(s.target_id))
        .map((s) => ({
          action: typeof s.action === 'string' ? s.action : '',
          rationale: typeof s.rationale === 'string' ? s.rationale : '',
          evidence_msg_id: str(s.evidence_msg_id),
        })),
      attention,
      attention_top: attention[0]?.priority ?? null,
      last_email: lastEmailByApp.get(r.application_id) ?? null,
      learnings: (learningsByApp.get(r.application_id) ?? []).map((l) => ({
        id: l.id,
        kind: l.kind,
        created_at: l.created_at,
        published: l.reflection_published === 1,
        text: learningText(l.reflections),
      })),
      kits,
      active_kit_url: kits.find((k) => k.status === 'active')?.drive_url ?? null,
      tailored_resumes: tailored,
    };
  });

  const stageCounts: Record<string, number> = {};
  for (const r of applications) stageCounts[r.stage] = (stageCounts[r.stage] ?? 0) + 1;
  return {
    applications,
    stageCounts,
    ghostingThresholdsDays,
    ghostingStageMap,
    scribe: scribeState ? { run_at: scribeState.run_at, attention_unlinked: byPriority(attentionUnlinked) } : null,
  };
}
