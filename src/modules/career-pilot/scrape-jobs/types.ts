/**
 * Shared types for scrape-jobs.
 *
 * `JobLeadPayload` is the normalized shape that source adapters return
 * and that `record_job_lead` accepts. Source adapters translate
 * source-specific JSON (Greenhouse / Lever / ...) into this shape; host-
 * side `record_job_lead` accepts payloads in this shape and computes
 * `content_fingerprint` + `rules_score` before inserting.
 *
 * The schema mirrors the `job_leads` table (STRATEGY.md §3) minus the
 * host-computed columns (id, content_fingerprint, fingerprint_cluster_id,
 * first_seen_at, last_seen_at, rules_score, rules_score_reasons,
 * llm_score*, status, status_changed_at).
 */

export type Source = 'greenhouse' | 'lever' | 'ashby' | 'google_jobs';

/**
 * Token-based ATS sources (the fallback poller). `google_jobs` is query-based,
 * not token-based, so it is NOT an `AtsSource` — it has no board token and no
 * host-side `SourceAdapter`. Use `AtsSource` for the seed-list / adapter path,
 * `Source` for everything that records into `job_leads`.
 */
export type AtsSource = 'greenhouse' | 'lever' | 'ashby';

/** Every token-based ATS the host has an adapter for — the ONE runtime list the
 * watchlist validator, the source allow-lists and the adapter registry share. */
export const ATS_SOURCES: readonly AtsSource[] = ['greenhouse', 'lever', 'ashby'];

export function isAtsSource(v: unknown): v is AtsSource {
  return typeof v === 'string' && (ATS_SOURCES as readonly string[]).includes(v);
}

export type SourcePriority = 'A' | 'B' | 'C';

/**
 * One board to scan: an `active` row of the `ats_watchlist` table (§24.200 D7),
 * projected to the shape `fetch_source` has always consumed. (It is also the
 * shape of one entry in `groups/career-pilot/data/ats-targets.json`, which is
 * now read only by the boot-time seed.)
 *
 * `token` is the ATS-specific board identifier — `board_token` for
 * Greenhouse, `site` for Lever, the job-board name for Ashby. `priority` is the
 * watchlist row's `tier`.
 */
export interface TargetEntry {
  company: string;
  source: AtsSource;
  token: string;
  priority: SourcePriority;
  notes?: string;
}

/**
 * Normalized job posting payload passed from source adapters to
 * `record_job_lead`. Optional fields are NULL when the source doesn't
 * provide the data — adapters MUST NOT infer or fabricate missing fields.
 */
export interface JobLeadPayload {
  source: Source;
  source_board_token: string | null; // NULL for non-ATS sources (e.g. google_jobs)
  source_job_id: string;
  source_url: string;
  apply_url?: string | null;
  /** How direct `apply_url` is (§24.190): 'company' (the employer's own site),
   *  'ats' (a known applicant-tracking system), 'aggregator' (only a reposter's
   *  link was available — which ALSO means `company` is unverified), or
   *  'unknown'. Adapters that always link directly (greenhouse/lever) may omit it
   *  and the writer defaults them to 'ats'. */
  apply_link_kind?: 'company' | 'ats' | 'aggregator' | 'unknown' | null;

  title: string;
  company: string;
  company_domain?: string | null;
  location_raw?: string | null;
  is_remote?: boolean | null;
  workplace_type?: 'remote' | 'hybrid' | 'onsite' | null;
  remote_region?: 'US' | 'EU' | 'GLOBAL' | null;
  employment_type?: 'full-time' | 'contract' | 'intern' | null;

  comp_min_usd?: number | null;
  comp_max_usd?: number | null;
  comp_currency?: string | null;
  comp_period?: 'year' | 'hour' | 'month' | null;
  has_equity?: boolean | null;

  description_html?: string | null;
  description_text?: string | null;

  source_posted_at?: string | null; // ISO 8601

  raw_payload?: Record<string, unknown>;
}

/**
 * Common interface that each source adapter implements. Host-side; not
 * exposed to the container.
 *
 * `list` fetches all postings for one board and returns them already
 * normalized. Per-source caching + crawl-delay live inside the adapter
 * (not the caller's concern).
 */
export interface SourceAdapter {
  source: AtsSource;
  list(token: string): Promise<SourceListResult>;
}

/**
 * What one board fetch says (§24.200 D6b). Success, an empty board, a missing
 * board and a failure used to all come back as `[]`; the sweep's close-on-absence
 * needs to tell them apart:
 *   - `ok: true`  — the board answered (200, 304, or a fresh cache hit). `postings`
 *                   is the WHOLE board; an id missing from it is genuinely gone.
 *   - `absent: true` (ok false) — 404/410: the token names no board (renamed /
 *                   moved ATS). Closes nothing; feeds the watchlist retire counter.
 *   - both false  — a transient failure (403/429/5xx, network, bad JSON). Closes
 *                   nothing. `error` says what happened.
 */
export interface SourceListResult {
  ok: boolean;
  absent: boolean;
  postings: JobLeadPayload[];
  /** HTTP status of the real fetch; null for a cache hit or a network throw. */
  status?: number | null;
  /** Short reason when `ok` is false. */
  error?: string | null;
}

/**
 * Minimal per-posting summary returned by `fetch_source` to the subagent.
 *
 * The subagent uses these to judge "engineering or not" without needing
 * the full description payload. After deciding to keep a posting, the
 * subagent calls `record_job_lead({ source, source_job_id })` — the
 * host looks up the full JobLeadPayload from the in-process TTL cache
 * (see src/scrape-jobs/payload-cache.ts) and writes the full row.
 *
 * Rationale: the SDK's subagent-side inline tool-result cap (~50-60KB)
 * is tighter than the orchestrator's. Returning full payloads spilled
 * to file, which the subagent couldn't access (no Read tool in its
 * palette by design). Summaries are ~150-250 bytes each → 60 summaries
 * ≈ 9-15KB, well under cap. STRATEGY.md §24.5 issue #2.
 */
export interface PostingSummary {
  source: Source;
  source_job_id: string;
  title: string;
  company: string;
  location_raw?: string | null;
  workplace_type?: 'remote' | 'hybrid' | 'onsite' | null;
  /** How direct the apply link is, resolved as the writer stores it (§24.200 D1). */
  apply_link_kind?: 'company' | 'ats' | 'aggregator' | 'unknown' | null;
  /** ~120-char excerpt of description_text. Empty string if the source
   *  provided no description. */
  snippet: string;
}
