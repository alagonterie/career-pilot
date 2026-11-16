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
 *     - update_job_lead_status  — pipeline transition
 *     - discover_ats_board      — board link → watchlist (no page fetch)
 *
 * Kept in a separate file from career-pilot.ts (Phase 1 tools) so the
 * Phase 2.5 split stays readable. Both files self-register via
 * registerTools() at module scope.
 */
import { sendAction } from '../career-pilot/action.js';
import {
  rankLeads as runRankLeads,
  computeBriefHash,
  RankLeadsError,
  type JobLeadForRanking,
  type RankedLead,
} from '../career-pilot/rank-leads.js';
import { searchGoogleJobs, SearchJobsError, type PageReservation } from '../career-pilot/serpapi-search.js';
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
      'Fetch normalized job postings from the public ATS APIs (Greenhouse, Lever, Ashby) of the employer boards on the watchlist. Returns `{ summaries, boards_scanned, postings_total }` — each summary is a lightweight per-posting object with `{ source, source_job_id, title, company, location_raw?, workplace_type?, snippet }`, where snippet is a ~120-char excerpt of the description. The full payload is stashed host-side (1h TTL) keyed by (source, source_job_id); when you decide to keep a posting, call `record_job_lead({ source, source_job_id })` and the host looks up the full payload automatically. You do NOT pass full posting data through record_job_lead. The host already sweeps every watched board on its own schedule and adds new matches itself, so a generic refresh does not need this tool; it is the tool for company-scoped requests (`company`), or a `priority` tier scan when explicitly asked. Read-only — does NOT write to job_leads.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        priority: {
          type: 'string',
          enum: ['A', 'B', 'C'],
          description:
            'Filter targets to one priority tier. Defaults to "A" if neither priority nor company is given. Use "A" for a broad scan of high-signal targets; "B"/"C" only when explicitly broadening.',
        },
        company: {
          type: 'string',
          description:
            'Filter targets to a single company name (exact match, case-insensitive). Use for the "find roles at <company>" trigger.',
        },
        since: {
          type: 'string',
          description:
            'ISO 8601 timestamp. Filter out postings whose source_posted_at is earlier than this. Optional — most runs leave this unset to see everything.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 300,
          description:
            'Max summaries to return across all boards (default 150, cap 300). Distributed across boards via perBoardCap = ceil(limit / target_count), floor 3. Default depth chosen so per-board cap (~12 per board at 12 priority-A boards) sees past the freshest-batch sales/GTM skew that Greenhouse returns on updated_at DESC ordering.',
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
    const res = await sendAction<{
      summaries: unknown[];
      boards_scanned: number;
      postings_total: number;
      note?: string;
    }>('career_pilot.fetch_source', {
      priority: args.priority ?? null,
      company: args.company ?? null,
      since: args.since ?? null,
      limit: args.limit ?? null,
    });
    if (!res.ok) return actionErr('fetch_source', res.error);
    const { summaries, boards_scanned, postings_total, note } = res.data;
    const noteSuffix = note ? ` (${note})` : '';
    return ok(`fetch_source: ${postings_total} summaries across ${boards_scanned} boards${noteSuffix}.`, {
      summaries,
      boards_scanned,
      postings_total,
    });
  },
};

// ── search_jobs (§24.50) ─────────────────────────────────────────────────────

export const searchJobs: McpToolDefinition = {
  tool: {
    name: 'search_jobs',
    description:
      "Search SUPPLEMENT (the host sweeps the watched employer boards on its own schedule; this reaches in-house career sites no board API covers). ONE focused query per run. Search Google for Jobs (via SerpApi) with a natural-language `query` + optional `location`/`remote`. Returns `{ summaries, total, provider: 'google_jobs', rejected, rejected_total }` — each summary is `{ source, source_job_id, title, company, location_raw?, workplace_type?, apply_link_kind, snippet }`, the same shape fetch_source returns. `rejected` counts hits the host refused before you saw them, by reason (`link_kind`: no direct apply link; `tombstone`: the owner removed that posting; `title_blocklist`: a title the owner excluded) — those are not in `summaries` and cannot be recorded. Google aggregates LinkedIn/Indeed/company sites and dedupes across them, so results match what a human sees searching by hand. The full payload is stashed host-side (1h TTL) keyed by (source, source_job_id); to keep a posting call `record_job_lead({ source: 'google_jobs', source_job_id })`. If search is unavailable (the day's or the period's search budget is spent, rate-limited, not configured, down) the result is `{ unavailable: true, reason }` — do not retry search this run. Each ~10 results spends one page of a capped search quota the host reserves before fetching; do not paginate. Read-only — does NOT write to job_leads.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description:
            'Natural-language search, e.g. "senior backend engineer" or "staff ML engineer Anthropic". Build it from the candidate\'s target_roles + skills + this run\'s brief. For a company-scoped watch ("what\'s new at X"), include the company name in the query.',
        },
        location: {
          type: 'string',
          description:
            'Search origin, e.g. "United States" or "New York, NY". Optional — omit for a nationwide search.',
        },
        remote: {
          type: 'boolean',
          description:
            'When true, biases toward remote roles (appends "remote" to the query if absent). Use when the candidate prefers remote.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 30,
          description:
            'Max postings to return (default 10, cap 30). Each ~10 results = one page reserved from the capped search quota; leave at the default.',
        },
      },
      required: ['query'],
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const query = args.query as string | undefined;
    if (!query || typeof query !== 'string' || !query.trim()) {
      return err('query is required (non-empty string)');
    }
    let payloads;
    try {
      payloads = await searchGoogleJobs(
        {
          query,
          location: (args.location as string | undefined) ?? null,
          remote: (args.remote as boolean | undefined) ?? null,
          limit: (args.limit as number | undefined) ?? null,
        },
        { reservePage: reserveSearchPage },
      );
    } catch (e) {
      return searchUnavailable(e);
    }
    if (payloads.length === 0) {
      return ok(
        `search_jobs: 0 results for "${query}". SerpApi was reachable; the query returned nothing — try a broader query or fetch_source.`,
        { summaries: [], total: 0, provider: 'google_jobs' },
      );
    }
    // Forward payloads to the host stash action (same payload-cache fetch_source
    // uses); record_job_lead re-hydrates from it. Host stays system-of-record.
    const res = await sendAction<StashResult>('career_pilot.stash_job_payloads', { payloads });
    if (!res.ok) return actionErr('search_jobs', res.error);
    return formatSearchJobsResult(query, res.data);
  },
};

/** The host stash's answer. `rejected` counts payloads the host's insert guard
 *  refused BEFORE caching them (by reason) — they are not in `summaries` and
 *  cannot be recorded. Older hosts omit it. */
export interface StashResult {
  summaries: unknown[];
  stashed: number;
  skipped: number;
  rejected?: Record<string, number>;
  rejected_total?: number;
}

/**
 * Shape search_jobs' result from the stash answer. Passes the host's rejected
 * counts through, so a run that keeps nothing can say WHY (every hit was a
 * repost without a direct apply link, a posting the owner removed, a blocked
 * title) instead of looking like an empty search. The text carries the count in
 * a stable form (`rejected N before caching`) the Tier-4 e2e flow reads.
 */
export function formatSearchJobsResult(query: string, data: StashResult) {
  const { summaries } = data;
  const rejected = data.rejected ?? {};
  const rejectedTotal = data.rejected_total ?? Object.values(rejected).reduce((a, b) => a + b, 0);
  const why = Object.entries(rejected)
    .map(([reason, n]) => `${reason} ${n}`)
    .join(', ');
  const rejectedNote = rejectedTotal > 0 ? `; rejected ${rejectedTotal} before caching (${why})` : '';
  return ok(`search_jobs: ${summaries.length} postings for "${query}" (google_jobs)${rejectedNote}.`, {
    summaries,
    total: summaries.length,
    provider: 'google_jobs',
    rejected,
    rejected_total: rejectedTotal,
  });
}

/** The host's reservation answer (`career_pilot.reserve_search_quota`). */
interface ReserveQuotaResult {
  granted: boolean;
  reason?: string;
  message?: string;
}

/**
 * Reserve ONE result page from the host's search quota before fetching it. Any
 * failure to get a yes (host refusal, error frame, timeout) is a refusal — the
 * spend gate fails closed.
 */
export async function reserveSearchPage(): Promise<PageReservation> {
  const res = await sendAction<ReserveQuotaResult>('career_pilot.reserve_search_quota', { pages: 1 });
  if (!res.ok) return { granted: false, message: `quota check failed (${res.error.code}): ${res.error.message}` };
  return { granted: res.data.granted === true, reason: res.data.reason, message: res.data.message };
}

/** search_jobs' `unavailable` answer for any search failure, quota refusal included. */
export function searchUnavailable(e: unknown) {
  const reason = e instanceof SearchJobsError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
  return ok(`search_jobs unavailable (${reason}). Do not retry search this run.`, {
    unavailable: true,
    reason,
  });
}

// ── record_job_lead ────────────────────────────────────────────────────────

export const recordJobLead: McpToolDefinition = {
  tool: {
    name: 'record_job_lead',
    description:
      "UPSERT a single job lead into the `job_leads` table. Pass only `(source, source_job_id)` from a summary that `fetch_source` returned this session — the host looks up the full payload from its 1h cache and computes `content_fingerprint` (64-bit SimHash) + `rules_score` (0-100 deterministic score against the candidate profile) before insert. Within-source dedup is automatic via UNIQUE (source, source_job_id) with ON CONFLICT DO UPDATE. Returns `{ recorded: true, id, inserted_or_updated, rules_score, content_fingerprint }`, or `{ recorded: false, reason }` when the host refuses the posting (the owner removed it or blocked its title) — that is final, not an error: drop the lead and do not retry. NEVER invent source_job_ids — if you pass one that wasn't returned by fetch_source in this session, the call fails with NOT_IN_CACHE.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        source: {
          type: 'string',
          enum: ['greenhouse', 'lever', 'ashby', 'google_jobs'],
          description:
            'Source identifier — must match a value returned by search_jobs (google_jobs) or fetch_source (greenhouse/lever/ashby).',
        },
        source_job_id: {
          type: 'string',
          description: 'Source-assigned stable job id, taken verbatim from a fetch_source summary.',
        },
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
    const res = await sendAction<RecordJobLeadResult>('career_pilot.record_job_lead', { source, source_job_id });
    if (!res.ok) return actionErr('record_job_lead', res.error);
    return formatRecordJobLeadResult(source, source_job_id, res.data);
  },
};

/** The host's record answer: a row, or a deliberate non-error refusal. */
export type RecordJobLeadResult =
  | { recorded?: true; id: string; inserted_or_updated: string; rules_score: number; content_fingerprint: string }
  | { recorded: false; reason: string; detail?: string };

/** A refusal is NOT an error: the host's guard decided (removed earlier by the
 *  owner, blocked title) — the subagent must drop the lead, not retry it. */
export function formatRecordJobLeadResult(source: string, source_job_id: string, data: RecordJobLeadResult) {
  if (data.recorded === false) {
    return ok(
      `job_lead not recorded: ${source}::${source_job_id} was refused (${data.reason}${data.detail ? `: ${data.detail}` : ''}). This is final — drop it, do not retry.`,
      data as unknown as Record<string, unknown>,
    );
  }
  return ok(
    `job_lead ${data.inserted_or_updated}: ${source}::${source_job_id} (id ${data.id}, score ${data.rules_score})`,
    data as unknown as Record<string, unknown>,
  );
}

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
          description: 'Filter to one pipeline status. Omit for any non-closed status.',
        },
        source: {
          type: 'string',
          enum: ['greenhouse', 'lever', 'ashby', 'google_jobs'],
          description: 'Filter to one source.',
        },
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
        company: {
          type: 'string',
          description: 'Exact company match (case-insensitive). Use for "show me Stripe leads".',
        },
        not_yet_llm_scored: {
          type: 'boolean',
          description: 'Only return leads where llm_score IS NULL. Useful for Phase 3 daily-briefing pre-rank.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 100,
          description:
            'Max rows to return (default 20, cap 100). For broad surfacing use 5-10; for follow-up queries 20-50.',
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
      'Transition a job_lead through the pipeline: "new" (default on insert) → "reviewed" (candidate considered it) → "queued" (intent to apply) → "applied" (application submitted, usually paired with creating an `applications` row) → "rejected" (post-application outcome) | "archived" (soft-delete, candidate not interested). "archived" also sets closed_at — the lead drops out of normal query_job_leads results. Pipeline transitions only; does NOT delete.',
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
          description:
            'Optional one-line reason (stored in closed_reason for archived, otherwise discarded). E.g. "candidate not interested", "below comp floor", "applied to similar role earlier".',
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
      "Add a company to the employer-board watchlist from a Greenhouse / Lever / Ashby board link (e.g. https://job-boards.greenhouse.io/<board>, https://jobs.lever.co/<board>, https://jobs.ashbyhq.com/<board>, or a posting URL on one of them). The host does NOT open careers pages: if you only have a company's careers page, read it yourself (WebFetch) and pass the board link you find there. Verifies the board through that ATS's public API and adds it to the watchlist — from then on the scheduled board sweep and `fetch_source` cover it, with no file edit. Returns `{ ats: 'greenhouse'|'lever'|'ashby'|null, token, confidence: 'high'|'none', verified, added, already_listed?, watchlist_id?, company?, tier?, state?, blocked_by_owner?, postings_on_board?, reason? }`. `already_listed: true` means it was already watched (a retired board that answers again is made active). `blocked_by_owner: true` means the candidate paused this company's board — it stays paused; tell the candidate rather than retrying. `verified: false` means the board did not answer — nothing was added. `reason: 'not_a_board_link'` means the URL is not a link on one of those three ATSs — find the board link on the page, or the company uses another system and there is nothing to add. Use when the candidate asks to watch / track / add a company.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        careers_url: {
          type: 'string',
          description:
            'A Greenhouse / Lever / Ashby board or posting URL (e.g., "https://jobs.ashbyhq.com/acme"). Not a careers page: the host never fetches a page.',
        },
        company: {
          type: 'string',
          description:
            'The company name to show on its leads (e.g., "Acme"). Pass it whenever you know it; without it the board token is used as the name.',
        },
        tier: {
          type: 'string',
          enum: ['A', 'B', 'C'],
          description: 'Priority tier for `fetch_source` scans (A = top targets). Defaults to B.',
        },
      },
      required: ['careers_url'],
    },
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const careers_url = args.careers_url as string;
    if (!careers_url) return err('careers_url is required');
    const res = await sendAction<{
      ats: string | null;
      token: string | null;
      confidence: string;
      verified?: boolean;
      added?: boolean;
      already_listed?: boolean;
      company?: string;
      reason?: string;
      blocked_by_owner?: boolean;
      error?: string;
    }>('career_pilot.discover_ats_board', { careers_url, company: args.company ?? null, tier: args.tier ?? null });
    if (!res.ok) return actionErr('discover_ats_board', res.error);
    const { ats, token, verified, added, already_listed, company, reason, blocked_by_owner } = res.data;
    if (ats && token && verified && blocked_by_owner) {
      return ok(
        `${company ?? token} (${ats} board "${token}") is on the watchlist but PAUSED by the candidate — it stays paused. Tell the candidate; do not retry.`,
        res.data,
      );
    }
    if (ats && token && verified) {
      const what = added ? 'Added to the watchlist' : already_listed ? 'Already on the watchlist' : 'Verified';
      return ok(`${what}: ${company ?? token} (${ats} board "${token}").`, res.data);
    }
    if (ats && token) {
      return ok(
        `Found ${ats} board "${token}" but it did not verify (${reason ?? 'no answer'}) — nothing added.`,
        res.data,
      );
    }
    if (reason === 'not_a_board_link') {
      return ok(
        `${careers_url} is not a Greenhouse / Lever / Ashby board link — nothing added. Read the careers page yourself and pass the board link it points to; if there is none, the company uses another system.`,
        res.data,
      );
    }
    return ok(`No supported ATS board detected at ${careers_url} — nothing added.`, res.data);
  },
};

// ── rank_leads ─────────────────────────────────────────────────────────────

export const rankLeads: McpToolDefinition = {
  tool: {
    name: 'rank_leads',
    description:
      "LLM-rank a list of job_leads against the candidate's current brief. Returns `{ leads: [{ id, llm_score: 0-100, rank: 1..N }], total, brief_hash }` sorted by score DESC. Calls Haiku 4.5 via Portkey; ~$0.05 per 20-lead batch. Writes `llm_score` + `llm_scored_at` + `llm_scored_brief_hash` back to job_leads for audit + cache invalidation. Idempotent for the same (lead_id, brief) tuple — re-call to refresh scores against an updated brief. Use this in the daily-briefing flow after `query_job_leads` returns a candidate pool; sort and surface from this tool's output, not from rules_score alone. Max 50 leads per call.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        lead_ids: {
          type: 'array',
          items: { type: 'string' },
          minItems: 1,
          maxItems: 50,
          description:
            'job_lead ids to score (from `query_job_leads`). Capped at 50 per call to keep Haiku cost predictable.',
        },
        brief: {
          type: 'string',
          minLength: 20,
          description:
            "Candidate brief — what's currently target-aligned. Build from `candidate_profile` (target_roles, skills, comp_floor, location_pref) and any current emphasis the candidate has signaled this session. 20-char minimum so the scorer has something to weigh.",
        },
      },
      required: ['lead_ids', 'brief'],
    },
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const lead_ids = args.lead_ids as string[] | undefined;
    const brief = args.brief as string | undefined;
    if (!Array.isArray(lead_ids) || lead_ids.length === 0) {
      return err('lead_ids is required and must be a non-empty array');
    }
    if (lead_ids.length > 50) {
      return err('lead_ids capped at 50 per call');
    }
    if (!brief || typeof brief !== 'string' || brief.trim().length < 20) {
      return err('brief is required (min 20 chars)');
    }

    // Step 1: fetch lead summaries from host. Container can't read the
    // central DB directly — system-action round-trip per the standard
    // career_pilot.* contract.
    const summariesRes = await sendAction<{ leads: JobLeadForRanking[] }>(
      'career_pilot.get_lead_summaries_for_ranking',
      { lead_ids },
    );
    if (!summariesRes.ok) return actionErr('rank_leads', summariesRes.error);
    const summaries = summariesRes.data.leads;
    if (summaries.length === 0) {
      return err('no live job_leads matched the provided ids');
    }

    // Step 2: call Haiku via OneCLI gateway. The container has
    // HTTPS_PROXY + ANTHROPIC_BASE_URL injected by container-runner's
    // OneCLI applyContainerConfig — outbound fetch to api.anthropic.com
    // routes through the proxy and the Anthropic credential is injected
    // on the wire. Same path the SDK uses for the orchestrator's own
    // model calls.
    let scored: RankedLead[];
    try {
      scored = await runRankLeads(summaries, brief);
    } catch (e) {
      const code = e instanceof RankLeadsError ? e.code : 'INTERNAL';
      const msg = e instanceof Error ? e.message : String(e);
      return actionErr('rank_leads', { code, message: msg });
    }

    // Step 3: persist scores back via host action so the per-lead audit
    // trail (llm_score, llm_scored_at, llm_scored_brief_hash) lands in
    // job_leads. Persona's silent-skip path doesn't reach here — by the
    // time we have `scored`, we already have at least one valid score.
    const briefHash = computeBriefHash(brief);
    const writeRes = await sendAction<{ updated: number }>('career_pilot.write_llm_scores', {
      scored_leads: scored,
      brief_hash: briefHash,
    });
    if (!writeRes.ok) return actionErr('rank_leads', writeRes.error);

    const total = scored.length;
    return ok(`Ranked ${total} lead${total === 1 ? '' : 's'}.`, {
      leads: scored,
      total,
      brief_hash: briefHash,
    });
  },
};

// ── query_killer_matches ──────────────────────────────────────────────────

interface KillerMatchLead {
  id: string;
  title: string;
  company: string;
  source: string;
  source_url: string;
  apply_url: string | null;
  rules_score: number;
  source_posted_at: string;
  first_seen_at: string;
  rules_score_reasons: unknown;
}

export const queryKillerMatches: McpToolDefinition = {
  tool: {
    name: 'query_killer_matches',
    description:
      "Atomically claims and returns recent high-score job_leads that meet the killer-match criteria (rules_score above the configured floor, source_posted_at inside the recency window, source in the allow-list, not already pushed, not closed). Returns `{ leads, total }` — each lead carries `{ id, title, company, source, source_url, apply_url, rules_score, source_posted_at, first_seen_at, rules_score_reasons }`. Calling this tool COMMITS to pushing: the matched leads are marked killer_match_pushed_at = now() in the same transaction as the SELECT, so a second call returns an empty list. Use this exclusively in the killer-match scheduled handler — do NOT call it from a user-initiated turn (it'd silently burn lead IDs). Empty result means either no eligible leads or the source allow-list is empty.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: false },
  },
  async handler() {
    const res = await sendAction<{ leads: KillerMatchLead[]; total: number; reason?: string }>(
      'career_pilot.claim_killer_matches',
      {},
    );
    if (!res.ok) return actionErr('query_killer_matches', res.error);
    const { leads, total, reason } = res.data;
    const suffix = reason ? ` (${reason})` : '';
    return ok(`query_killer_matches: ${total} lead${total === 1 ? '' : 's'} claimed${suffix}.`, {
      leads,
      total,
      ...(reason ? { reason } : {}),
    });
  },
};

// ── close_stale_leads (§24.8) ──────────────────────────────────────────────

export const closeStaleLeads: McpToolDefinition = {
  tool: {
    name: 'close_stale_leads',
    description:
      'Periodic sweep: closes job_leads whose last_seen_at is older than the configured threshold (default 14 days). Returns `{ closed_count, threshold_days, cutoff }`. Promoted leads (those with application_id set) are excluded so application history is preserved. Already-closed leads are untouched. This is housekeeping — the persona should call it on the scheduled trigger and emit only an <internal> audit; no <message> block. Threshold + cadence are configurable via the `close_detection_*` preferences.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: false },
  },
  async handler() {
    const res = await sendAction<{ closed_count: number; threshold_days: number; cutoff: string }>(
      'career_pilot.close_stale_leads',
      {},
    );
    if (!res.ok) return actionErr('close_stale_leads', res.error);
    const { closed_count, threshold_days, cutoff } = res.data;
    return ok(
      `close_stale_leads: ${closed_count} lead${closed_count === 1 ? '' : 's'} closed (threshold ${threshold_days}d, cutoff ${cutoff}).`,
      res.data,
    );
  },
};

registerTools([
  searchJobs,
  fetchSource,
  recordJobLead,
  queryJobLeads,
  updateJobLeadStatus,
  discoverAtsBoard,
  rankLeads,
  queryKillerMatches,
  closeStaleLeads,
]);
