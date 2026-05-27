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
      "Fetch normalized job postings from public ATS APIs (Greenhouse + Lever in v1.0). Returns `{ summaries, boards_scanned, postings_total }` — each summary is a lightweight per-posting object with `{ source, source_job_id, title, company, location_raw?, workplace_type?, snippet }`, where snippet is a ~120-char excerpt of the description. The full payload is stashed host-side (1h TTL) keyed by (source, source_job_id); when you decide to keep a posting, call `record_job_lead({ source, source_job_id })` and the host looks up the full payload automatically. You do NOT pass full posting data through record_job_lead. Pass `priority` for a broad scan (default Tier-A targets), or `company` for a single-company scan. Read-only — does NOT write to job_leads.",
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
          maximum: 300,
          description: 'Max summaries to return across all boards (default 150, cap 300). Distributed across boards via perBoardCap = ceil(limit / target_count), floor 3. Default depth chosen so per-board cap (~12 per board at 12 priority-A boards) sees past the freshest-batch sales/GTM skew that Greenhouse returns on updated_at DESC ordering.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const priority = args.priority as string | undefined;
    const company = args.company as string | undefined;
    if (!priority && !company) {
      // Default broad scan: priority A
      args.priority = 'A';
    }
    const res = await sendAction<{ summaries: unknown[]; boards_scanned: number; postings_total: number; note?: string }>(
      'career_pilot.fetch_source',
      {
        priority: args.priority ?? null,
        company: args.company ?? null,
        since: args.since ?? null,
        limit: args.limit ?? null,
      },
    );
    if (!res.ok) return actionErr('fetch_source', res.error);
    const { summaries, boards_scanned, postings_total, note } = res.data;
    const noteSuffix = note ? ` (${note})` : '';
    return ok(`fetch_source: ${postings_total} summaries across ${boards_scanned} boards${noteSuffix}.`, { summaries, boards_scanned, postings_total });
  },
};

// ── record_job_lead ────────────────────────────────────────────────────────

export const recordJobLead: McpToolDefinition = {
  tool: {
    name: 'record_job_lead',
    description:
      "UPSERT a single job lead into the `job_leads` table. Pass only `(source, source_job_id)` from a summary that `fetch_source` returned this session — the host looks up the full payload from its 1h cache and computes `content_fingerprint` (64-bit SimHash) + `rules_score` (0-100 deterministic score against the candidate profile) before insert. Within-source dedup is automatic via UNIQUE (source, source_job_id) with ON CONFLICT DO UPDATE. Returns `{ id, inserted_or_updated, rules_score, content_fingerprint }`. NEVER invent source_job_ids — if you pass one that wasn't returned by fetch_source in this session, the call fails with NOT_IN_CACHE.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: { type: 'string', enum: ['greenhouse', 'lever'], description: 'ATS source identifier — must match a value returned by fetch_source.' },
        source_job_id: { type: 'string', description: 'Source-assigned stable job id, taken verbatim from a fetch_source summary.' },
      },
      required: ['source', 'source_job_id'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const source = args.source as string;
    const source_job_id = args.source_job_id as string;
    if (!source || !source_job_id) {
      return err('source and source_job_id are required');
    }
    const res = await sendAction<{ id: string; inserted_or_updated: string; rules_score: number; content_fingerprint: string }>(
      'career_pilot.record_job_lead',
      { source, source_job_id },
    );
    if (!res.ok) return actionErr('record_job_lead', res.error);
    return ok(
      `job_lead ${res.data.inserted_or_updated}: ${source}::${source_job_id} (id ${res.data.id}, score ${res.data.rules_score})`,
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
    annotations: { readOnlyHint: true },
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
    annotations: { readOnlyHint: true },
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
