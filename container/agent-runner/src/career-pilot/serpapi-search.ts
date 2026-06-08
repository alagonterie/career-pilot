/**
 * SerpApi `google_jobs` search — the PRIMARY job-lead source (STRATEGY §24.50).
 *
 * Container-side, mirroring the `rank-leads.ts` pattern: the MCP tool body
 * fetches an external API directly, leaning on the OneCLI-gated outbound path
 * NanoClaw injects (`HTTPS_PROXY` + cert). OneCLI is registered with the SerpApi
 * key as a **query-param** injection (`--param-name api_key --host-pattern
 * serpapi.com`), so this code builds the URL **without** the key and OneCLI
 * appends `&api_key=<real>` on the wire — the container never holds it.
 *
 * NOT an LLM call → this does NOT route through Portkey (that's the
 * `ANTHROPIC_BASE_URL` path the SDK + `rank_leads` use). A plain HTTPS fetch to
 * `serpapi.com`, credential-injected by OneCLI.
 *
 * The host stays system-of-record: `searchGoogleJobs` returns normalized
 * `JobLeadPayload`s; the `search_jobs` tool forwards them to the host
 * `stash_job_payloads` action (stashes in the same payload-cache `fetch_source`
 * uses), then `record_job_lead` re-hydrates + computes fingerprint + rules_score
 * — all unchanged.
 *
 * Field shapes here were verified against a live `google_jobs` response
 * (2026-06-08), not docs. Pure helpers (`parseRelativePostedAt`,
 * `parseSalaryString`, `normalizeGoogleJob`) are exported for unit tests.
 */

const SERPAPI_BASE = 'https://serpapi.com/search';
const RESULTS_PER_PAGE = 10; // google_jobs returns up to 10/page
const MAX_PAGES = 3; // quota guard — each page is one SerpApi search against the 250/mo free tier
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 30;
const FETCH_TIMEOUT_MS = 20_000;
const DESCRIPTION_TEXT_CAP = 2000; // matches the host adapters' cap (src/scrape-jobs/sources.ts)

/** Normalized payload — mirrors the host `JobLeadPayload` (src/scrape-jobs/types.ts).
 *  The container is a separate dep tree, so the shape is duplicated here; the
 *  contract is the JSON the host `stash_job_payloads` / `record_job_lead`
 *  actions parse. */
export interface GoogleJobPayload {
  source: 'google_jobs';
  source_board_token: null;
  source_job_id: string;
  source_url: string;
  apply_url: string | null;
  title: string;
  company: string;
  company_domain: null;
  location_raw: string | null;
  is_remote: boolean | null;
  workplace_type: 'remote' | 'hybrid' | 'onsite' | null;
  remote_region: 'US' | 'EU' | 'GLOBAL' | null;
  employment_type: 'full-time' | 'contract' | 'intern' | null;
  comp_min_usd: number | null;
  comp_max_usd: number | null;
  comp_currency: string | null;
  comp_period: 'year' | 'hour' | 'month' | null;
  description_html: null;
  description_text: string | null;
  source_posted_at: string | null; // ISO 8601
  raw_payload: Record<string, unknown>;
}

export interface SerpApiAppplyOption {
  title?: string;
  link?: string;
}

export interface SerpApiDetectedExtensions {
  posted_at?: string;
  salary?: string;
  schedule_type?: string;
  work_from_home?: boolean;
  qualifications?: string;
}

export interface SerpApiJob {
  title?: string;
  company_name?: string;
  location?: string;
  via?: string;
  share_link?: string;
  source_link?: string;
  description?: string;
  extensions?: string[];
  detected_extensions?: SerpApiDetectedExtensions;
  apply_options?: SerpApiAppplyOption[];
  job_id?: string;
}

export interface SearchGoogleJobsArgs {
  query: string;
  location?: string | null;
  remote?: boolean | null;
  limit?: number | null;
}

export class SearchJobsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SearchJobsError';
    this.code = code;
  }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

const REL_UNIT_MS: Record<string, number> = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_592_000_000, // 30d
  year: 31_536_000_000, // 365d
};

/**
 * Convert SerpApi's RELATIVE `detected_extensions.posted_at` ("6 days ago",
 * "2 hours ago", "30+ days ago", "today", "yesterday") into an absolute ISO
 * timestamp. The killer-match recency gate compares `source_posted_at` against
 * an absolute cutoff, so this conversion is load-bearing — Greenhouse/Lever give
 * absolute times, google_jobs does not. Returns null when absent/unparseable
 * (the field is often missing entirely — that's expected, scoring treats
 * unknown recency as "now").
 */
export function parseRelativePostedAt(rel: string | null | undefined, now: Date = new Date()): string | null {
  if (!rel || typeof rel !== 'string') return null;
  const s = rel.trim().toLowerCase();
  if (!s) return null;
  if (/^(just posted|just now|today|posted today|active today)$/.test(s)) {
    return now.toISOString();
  }
  if (/^yesterday$/.test(s)) {
    return new Date(now.getTime() - REL_UNIT_MS.day).toISOString();
  }
  // "6 days ago", "30+ days ago", "2 hours ago", "3 weeks ago", "1 month ago"
  const m = /(\d+)\s*\+?\s*(minute|hour|day|week|month|year)s?\s*ago/.exec(s);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = REL_UNIT_MS[m[2]];
    if (Number.isFinite(n) && unit) {
      return new Date(now.getTime() - n * unit).toISOString();
    }
  }
  return null;
}

/**
 * Parse SerpApi's salary STRING ("180K–240K a year", "$50.00 an hour",
 * "$200,000 a year", "From $120K a year") into { comp_min_usd, comp_max_usd,
 * comp_period }. Handles K/M suffixes, en-dash/em-dash/hyphen ranges, commas,
 * and the cadence words.
 *
 * Values are stored RAW (not annualized) with the source cadence in
 * `comp_period`, matching the existing Greenhouse/Lever adapters (which store
 * `salaryRange.min` + `interval` as-is). Period-aware comparison is a known
 * pool-wide v1 limitation, not specific to this source.
 */
export function parseSalaryString(salary: string | null | undefined): {
  comp_min_usd: number | null;
  comp_max_usd: number | null;
  comp_period: 'year' | 'hour' | 'month' | null;
} {
  const empty = { comp_min_usd: null, comp_max_usd: null, comp_period: null as 'year' | 'hour' | 'month' | null };
  if (!salary || typeof salary !== 'string') return empty;
  const s = salary.toLowerCase();

  let comp_period: 'year' | 'hour' | 'month' | null = null;
  if (/\b(an?\s*hour|per\s*hour|hourly|\/\s*hr|\/\s*hour)\b/.test(s)) comp_period = 'hour';
  else if (/\b(a\s*month|per\s*month|monthly|\/\s*mo)\b/.test(s)) comp_period = 'month';
  else if (/\b(a\s*year|per\s*year|annually|annual|yearly|\/\s*yr)\b/.test(s)) comp_period = 'year';

  const nums: number[] = [];
  const re = /(\d[\d,]*(?:\.\d+)?)\s*([km])?/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(salary)) !== null) {
    const base = parseFloat(match[1].replace(/,/g, ''));
    if (!Number.isFinite(base)) continue;
    const suffix = match[2]?.toLowerCase();
    const value = suffix === 'k' ? base * 1_000 : suffix === 'm' ? base * 1_000_000 : base;
    nums.push(Math.round(value));
    if (nums.length >= 2) break; // min + max is all we need
  }
  if (nums.length === 0) return { ...empty, comp_period };

  const comp_min_usd = nums[0];
  const comp_max_usd = nums.length > 1 ? nums[1] : nums[0];
  return { comp_min_usd, comp_max_usd, comp_period };
}

function truncate(text: string | null | undefined, cap: number): string | null {
  if (text == null) return null;
  const t = text.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length <= cap ? t : t.slice(0, cap) + '…';
}

const EMPLOYMENT_MAP: Record<string, 'full-time' | 'contract' | 'intern'> = {
  'full-time': 'full-time',
  'full time': 'full-time',
  contractor: 'contract',
  contract: 'contract',
  internship: 'intern',
  intern: 'intern',
};

/** Normalize one SerpApi `jobs_results[i]` into a GoogleJobPayload. */
export function normalizeGoogleJob(job: SerpApiJob, now: Date = new Date()): GoogleJobPayload | null {
  const job_id = job.job_id;
  const title = job.title;
  if (!job_id || !title) return null; // can't dedup or judge without these

  const source_url = job.source_link || job.share_link || job.apply_options?.[0]?.link || '';
  if (!source_url) return null; // record_job_lead requires a non-null source_url

  const detected = job.detected_extensions ?? {};
  const location_raw = job.location ?? null;
  const extBlob = `${location_raw ?? ''} ${(job.extensions ?? []).join(' ')}`.toLowerCase();

  // Remote/workplace: Google only flags `work_from_home: true` for remote.
  // Otherwise look for explicit remote/anywhere wording; never guess "onsite".
  const remoteSignal = detected.work_from_home === true || /\b(remote|work from home|anywhere)\b/.test(extBlob);
  const is_remote = remoteSignal ? true : null;
  const workplace_type: 'remote' | 'hybrid' | 'onsite' | null = remoteSignal ? 'remote' : null;
  let remote_region: 'US' | 'EU' | 'GLOBAL' | null = null;
  if (remoteSignal) {
    if (/\b(anywhere|worldwide|global)\b/.test(extBlob)) remote_region = 'GLOBAL';
    else if (/\b(eu|europe|emea|united kingdom|uk)\b/.test(extBlob)) remote_region = 'EU';
    else remote_region = 'US'; // gl=us search context; default the common case
  }

  const schedule = detected.schedule_type?.toLowerCase() ?? '';
  const employment_type = EMPLOYMENT_MAP[schedule] ?? null;

  const { comp_min_usd, comp_max_usd, comp_period } = parseSalaryString(detected.salary);

  return {
    source: 'google_jobs',
    source_board_token: null,
    source_job_id: job_id,
    source_url,
    apply_url: job.apply_options?.[0]?.link ?? source_url,
    title,
    company: job.company_name ?? '',
    company_domain: null,
    location_raw,
    is_remote,
    workplace_type,
    remote_region,
    employment_type,
    comp_min_usd,
    comp_max_usd,
    comp_currency: comp_min_usd != null ? 'USD' : null,
    comp_period,
    description_html: null,
    description_text: truncate(job.description, DESCRIPTION_TEXT_CAP),
    source_posted_at: parseRelativePostedAt(detected.posted_at, now),
    raw_payload: {
      via: job.via ?? null,
      apply_options: job.apply_options ?? [],
      extensions: job.extensions ?? [],
      source_link: job.source_link ?? null,
      share_link: job.share_link ?? null,
      schedule_type: detected.schedule_type ?? null,
      qualifications: detected.qualifications ?? null,
    },
  };
}

// ── fetch ────────────────────────────────────────────────────────────────────

interface SerpApiResponse {
  error?: string;
  jobs_results?: SerpApiJob[];
  serpapi_pagination?: { next_page_token?: string };
}

function buildSearchUrl(args: { query: string; location?: string | null; remote?: boolean | null }): string {
  const params = new URLSearchParams({ engine: 'google_jobs', q: args.query, hl: 'en', gl: 'us' });
  // Remote intent: Google for Jobs honors "remote" in the query text. SerpApi's
  // `ltype`/`chips` remote filters are deprecated by Google, so we steer via q.
  if (args.remote && !/\bremote\b/i.test(args.query)) {
    params.set('q', `${args.query} remote`);
  }
  if (args.location) params.set('location', args.location);
  // NOTE: api_key is intentionally absent — OneCLI injects it as a query param
  // on the wire (host-pattern serpapi.com, --param-name api_key).
  return `${SERPAPI_BASE}?${params.toString()}`;
}

async function fetchPage(url: string): Promise<SerpApiResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
  } catch (err) {
    throw new SearchJobsError('NETWORK', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timeout);
  }

  // !ok ⇒ treat as "provider unavailable" so the agent falls back to ATS:
  //   401/403 = missing/invalid key (no OneCLI secret registered),
  //   429 = rate-limited / quota exhausted, 5xx = SerpApi down.
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new SearchJobsError('HTTP', `${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`);
  }

  let data: SerpApiResponse;
  try {
    data = (await res.json()) as SerpApiResponse;
  } catch (err) {
    throw new SearchJobsError('PARSE', err instanceof Error ? err.message : String(err));
  }
  return data;
}

/**
 * Run a google_jobs search and return normalized payloads. Paginates up to
 * `limit` results (cap 30 = 3 SerpApi searches) via `next_page_token`. A
 * `200 + {error}` body (e.g. "Google hasn't returned any results") is treated
 * as an empty result set, NOT unavailable — the search succeeded, it just found
 * nothing. Throws `SearchJobsError` only for genuine unavailability (HTTP
 * error / network / parse), which the caller maps to the ATS fallback.
 */
export async function searchGoogleJobs(args: SearchGoogleJobsArgs): Promise<GoogleJobPayload[]> {
  const query = (args.query ?? '').trim();
  if (!query) throw new SearchJobsError('BAD_ARGS', 'query is required');
  const limit = Math.min(MAX_LIMIT, Math.max(1, args.limit && args.limit > 0 ? Math.floor(args.limit) : DEFAULT_LIMIT));
  const maxPages = Math.min(MAX_PAGES, Math.ceil(limit / RESULTS_PER_PAGE));
  const now = new Date();

  const out: GoogleJobPayload[] = [];
  const seen = new Set<string>();
  let url: string | null = buildSearchUrl(args);

  for (let page = 0; page < maxPages && url; page += 1) {
    const data: SerpApiResponse = await fetchPage(url);
    if (data.error) break; // 200 + error ⇒ no results for this query; stop cleanly
    const jobs = data.jobs_results ?? [];
    for (const job of jobs) {
      const payload = normalizeGoogleJob(job, now);
      if (!payload) continue;
      if (seen.has(payload.source_job_id)) continue; // within-run dedup
      seen.add(payload.source_job_id);
      out.push(payload);
      if (out.length >= limit) return out;
    }
    const token = data.serpapi_pagination?.next_page_token;
    url = token ? `${buildSearchUrl(args)}&next_page_token=${encodeURIComponent(token)}` : null;
  }
  return out;
}
