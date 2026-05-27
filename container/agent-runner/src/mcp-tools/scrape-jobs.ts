/**
 * scrape-jobs MCP tools (Phase 2.5).
 *
 * Five tools wired through the container → host system-action contract
 * (see ../career-pilot/action.ts + src/modules/career-pilot/
 * job-lead-actions.ts):
 *
 *   Subagent (scrape-jobs):
 *     - fetch_source            — host-side aggregated ATS poll
 *     - record_job_lead         — UPSERT to job_leads (host computes
 *                                 fingerprint + rules_score)
 *
 *   Orchestrator:
 *     - query_job_leads         — typed-args SELECT
 *     - update_job_lead_status  — funnel transition
 *     - discover_ats_board      — careers-page → ATS provider+token
 *
 * Kept in a separate file from career-pilot.ts (Phase 1 tools) so the
 * Phase 2.5 split stays readable. Both files self-register via
 * registerTools() at module scope.
 */
import { sendAction } from '../career-pilot/action.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string, structured?: Record<string, unknown>) {
  const base = { content: [{ type: 'text' as const, text }] };
  return structured ? { ...base, structuredContent: structured } : base;
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function actionErr(action: string, error: { code: string; message: string }) {
  return err(`${action} failed (${error.code}): ${error.message}`);
}

// ── fetch_source ───────────────────────────────────────────────────────────

export const fetchSource: McpToolDefinition = {
  tool: {
    name: 'fetch_source',
    description:
      'Fetch normalized job postings from public ATS APIs (Greenhouse + Lever in v1.0). Host-side action — reads the curated seed list at `groups/career-pilot/data/ats-targets.json`, filters by priority and/or company, fetches each matching board via its public API, normalizes the responses, and returns `{ postings, boards_scanned, postings_total }`. Aggregates across boards so you make 1-2 calls per scrape run rather than 30-50. Honors per-source crawl-delay + caches responses 1h with ETag conditional GET. Pass `priority` for a broad scan (default Tier-A targets), or `company` for a single-company scan. Read-only — does NOT write to job_leads (call record_job_lead per posting you decide to keep).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        priority: {
          type: 'string',
          enum: ['A', 'B', 'C'],
          description: 'Filter targets to one priority tier. Defaults to "A" if neither priority nor company is given. Use "A" for a broad scan of high-signal targets; "B"/"C" only when explicitly broadening.',
        },
        company: {
          type: 'string',
          description: 'Filter targets to a single company name (exact match, case-insensitive). Use for the "find roles at <company>" trigger.',
        },
        since: {
          type: 'string',
          description: 'ISO 8601 timestamp. Filter out postings whose source_posted_at is earlier than this. Optional — most runs leave this unset to see everything.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 500,
          description: 'Max postings to return across all boards (default 200, cap 500). Stops adding once cap reached.',
        },
      },
    },
    // Diagnostic: leaving readOnlyHint OFF for v1.0. Setting it true
    // empirically correlates with "MCP error -32603: attempt to write
    // a readonly database" errors on every fetch_source / query_job_leads
    // call (runs 8-9, 2026-05-27); record_progress (which lacks the hint)
    // never errored. Suspected SDK-side tool-result cache writes a
    // SQLite file under a readonly mount when the hint is set. Revisit
    // when isolating: parser-side <Agent> XML recovery for GLM follow-up.
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const priority = args.priority as string | undefined;
    const company = args.company as string | undefined;
    if (!priority && !company) {
      // Default broad scan: priority A
      args.priority = 'A';
    }
    const res = await sendAction<{ postings: unknown[]; boards_scanned: number; postings_total: number; note?: string }>(
      'career_pilot.fetch_source',
      {
        priority: args.priority ?? null,
        company: args.company ?? null,
        since: args.since ?? null,
        limit: args.limit ?? null,
      },
    );
    if (!res.ok) return actionErr('fetch_source', res.error);
    const { postings, boards_scanned, postings_total, note } = res.data;
    const noteSuffix = note ? ` (${note})` : '';
    return ok(`fetch_source: ${postings_total} postings across ${boards_scanned} boards${noteSuffix}.`, { postings, boards_scanned, postings_total });
  },
};

// ── record_job_lead ────────────────────────────────────────────────────────

export const recordJobLead: McpToolDefinition = {
  tool: {
    name: 'record_job_lead',
    description:
      "UPSERT a single job lead into the `job_leads` table. The host computes `content_fingerprint` (64-bit SimHash) and `rules_score` (0-100 deterministic score against the candidate profile) before insert — you don't compute these. Within-source dedup is automatic via UNIQUE (source, source_job_id) with ON CONFLICT DO UPDATE: re-recording the same posting advances last_seen_at + refreshes title/comp/description without disturbing id, status, or application_id. Returns `{ id, inserted_or_updated, rules_score, content_fingerprint }`. Pass payload fields essentially unchanged from what fetch_source returned — do NOT enrich, infer, or fabricate fields the source didn't provide.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['greenhouse', 'lever'], description: 'ATS source identifier — must match a value from fetch_source.' },
        source_board_token: { type: 'string', description: 'The ATS-specific board token (Greenhouse board_token, Lever site).' },
        source_job_id: { type: 'string', description: 'Source-assigned stable job id. Required — UNIQUE key with source.' },
        source_url: { type: 'string', description: 'Canonical URL of the posting on the source.' },
        apply_url: { type: 'string', description: 'Apply URL if separate from source_url.' },
        title: { type: 'string', description: 'Role title.' },
        company: { type: 'string', description: 'Company name. Must match the seed list entry that produced this posting.' },
        company_domain: { type: 'string' },
        location_raw: { type: 'string' },
        is_remote: { type: 'boolean' },
        workplace_type: { type: 'string', enum: ['remote', 'hybrid', 'onsite'] },
        remote_region: { type: 'string', enum: ['US', 'EU', 'GLOBAL'] },
        employment_type: { type: 'string', enum: ['full-time', 'contract', 'intern'] },
        comp_min_usd: { type: 'integer' },
        comp_max_usd: { type: 'integer' },
        comp_currency: { type: 'string' },
        comp_period: { type: 'string', enum: ['year', 'hour', 'month'] },
        has_equity: { type: 'boolean' },
        description_html: { type: 'string' },
        description_text: { type: 'string' },
        source_posted_at: { type: 'string', description: 'ISO 8601 timestamp of when the source published the posting.' },
        raw_payload: { type: 'object', description: 'Source-specific extra fields. Stored as JSON for re-parsing.' },
      },
      required: ['source', 'source_job_id', 'source_url', 'title', 'company'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const source = args.source as string;
    const source_job_id = args.source_job_id as string;
    const title = args.title as string;
    const company = args.company as string;
    if (!source || !source_job_id || !title || !company) {
      return err('source, source_job_id, title, and company are required');
    }
    const res = await sendAction<{ id: string; inserted_or_updated: string; rules_score: number; content_fingerprint: string }>(
      'career_pilot.record_job_lead',
      args,
    );
    if (!res.ok) return actionErr('record_job_lead', res.error);
    return ok(
      `job_lead ${res.data.inserted_or_updated}: ${title} @ ${company} (id ${res.data.id}, score ${res.data.rules_score})`,
      res.data,
    );
  },
};

// ── query_job_leads ────────────────────────────────────────────────────────

export const queryJobLeads: McpToolDefinition = {
  tool: {
    name: 'query_job_leads',
    description:
      'SELECT from `job_leads` with typed filters. Returns `{ leads, total }` where leads is an array ordered by `order_by` DESC (default rules_score then first_seen_at). Closed leads (closed_at IS NOT NULL) are excluded automatically. Use this to answer candidate questions about the pool ("any new AI roles?", "show me Stripe leads", "what\'s in my pool from this week?"). Read-only.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: ['new', 'reviewed', 'queued', 'applied', 'rejected', 'archived'],
          description: 'Filter to one funnel status. Omit for any non-closed status.',
        },
        source: { type: 'string', enum: ['greenhouse', 'lever'], description: 'Filter to one source.' },
        min_rules_score: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Only return leads with rules_score >= this. Use ~50 for "decent fit", ~70 for "strong fit".',
        },
        since: {
          type: 'string',
          description: 'ISO 8601. Only return leads with first_seen_at >= since. Use for "what came in this week".',
        },
        company: { type: 'string', description: 'Exact company match (case-insensitive). Use for "show me Stripe leads".' },
        not_yet_llm_scored: {
          type: 'boolean',
          description: 'Only return leads where llm_score IS NULL. Useful for Phase 3 daily-briefing pre-rank.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description: 'Max rows to return (default 20, cap 100). For broad surfacing use 5-10; for follow-up queries 20-50.',
        },
        order_by: {
          type: 'string',
          enum: ['rules_score', 'first_seen_at', 'last_seen_at'],
          description: 'Sort key DESC (default rules_score). Use first_seen_at for "newest first".',
        },
      },
    },
    // See fetch_source — readOnlyHint correlates with -32603 readonly DB errors.
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const res = await sendAction<{ leads: Array<Record<string, unknown>>; total: number }>(
      'career_pilot.query_job_leads',
      {
        status: args.status ?? null,
        source: args.source ?? null,
        min_rules_score: args.min_rules_score ?? null,
        since: args.since ?? null,
        company: args.company ?? null,
        not_yet_llm_scored: args.not_yet_llm_scored ?? null,
        limit: args.limit ?? null,
        order_by: args.order_by ?? null,
      },
    );
    if (!res.ok) return actionErr('query_job_leads', res.error);
    const { leads, total } = res.data;
    if (leads.length === 0) {
      return ok(`No leads matched (0 of ${total} total).`, res.data);
    }
    const summary = leads
      .slice(0, 10)
      .map((l) => `- ${l.company} — ${l.title} · ${l.rules_score} · ${l.source}`)
      .join('\n');
    return ok(`${leads.length} of ${total} leads:\n${summary}`, res.data);
  },
};

// ── update_job_lead_status ─────────────────────────────────────────────────

export const updateJobLeadStatus: McpToolDefinition = {
  tool: {
    name: 'update_job_lead_status',
    description:
      'Transition a job_lead through the funnel: "new" (default on insert) → "reviewed" (candidate considered it) → "queued" (intent to apply) → "applied" (application submitted, usually paired with creating an `applications` row) → "rejected" (post-application outcome) | "archived" (soft-delete, candidate not interested). "archived" also sets closed_at — the lead drops out of normal query_job_leads results. Funnel transitions only; does NOT delete.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'The job_leads.id.' },
        status: {
          type: 'string',
          enum: ['new', 'reviewed', 'queued', 'applied', 'rejected', 'archived'],
        },
        reason: {
          type: 'string',
          description: 'Optional one-line reason (stored in closed_reason for archived, otherwise discarded). E.g. "candidate not interested", "below comp floor", "applied to similar role earlier".',
        },
      },
      required: ['id', 'status'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const id = args.id as string;
    const status = args.status as string;
    if (!id || !status) return err('id and status are required');
    const res = await sendAction<{ id: string; from: string; to: string }>('career_pilot.update_job_lead_status', {
      id,
      status,
      reason: args.reason ?? null,
    });
    if (!res.ok) return actionErr('update_job_lead_status', res.error);
    return ok(`job_lead ${id}: ${res.data.from} → ${res.data.to}`, res.data);
  },
};

// ── discover_ats_board ─────────────────────────────────────────────────────

export const discoverAtsBoard: McpToolDefinition = {
  tool: {
    name: 'discover_ats_board',
    description:
      "Given a company's careers page URL, fetch it and detect whether they use Greenhouse or Lever as their ATS. Returns `{ ats: 'greenhouse'|'lever'|null, token: string|null, confidence: 'high'|'none' }`. Useful when the candidate wants to add a new target company to the scraping list — call this to grab the board token, then update `ats-targets.json` (a separate step, not in this tool). Read-only — does NOT modify the seed list.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        careers_url: {
          type: 'string',
          description: 'Full http(s) URL to the company\'s careers/jobs page (e.g., "https://www.anthropic.com/careers").',
        },
      },
      required: ['careers_url'],
    },
    // See fetch_source — readOnlyHint correlates with -32603 readonly DB errors.
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const careers_url = args.careers_url as string;
    if (!careers_url) return err('careers_url is required');
    const res = await sendAction<{ ats: string | null; token: string | null; confidence: string; http_status?: number; error?: string }>(
      'career_pilot.discover_ats_board',
      { careers_url },
    );
    if (!res.ok) return actionErr('discover_ats_board', res.error);
    const { ats, token, confidence } = res.data;
    if (ats && token) {
      return ok(`Detected: ${ats} board token "${token}" (confidence ${confidence}).`, res.data);
    }
    return ok(`No ATS detected at ${careers_url}.`, res.data);
  },
};

registerTools([fetchSource, recordJobLead, queryJobLeads, updateJobLeadStatus, discoverAtsBoard]);
