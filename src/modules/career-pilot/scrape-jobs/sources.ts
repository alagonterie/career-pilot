/**
 * Source adapters for the public job-board APIs of Greenhouse, Lever and Ashby.
 *
 * Host-side modules. Each adapter implements `SourceAdapter` from
 * `./types.ts` — `list(token)` fetches every posting on one board and returns a
 * `SourceListResult`: `{ok, absent, postings}`, so a caller can tell a board that
 * answered from one that is gone (404/410) from a failed fetch (§24.201 D6b).
 *
 * Polite-fetch is centralized here: per-host crawl-delay, a 1h in-process
 * response cache bounded by `ats_response_cache_max_entries` (oldest-used entry
 * evicted first), ETag conditional GET, explicit `Accept-Encoding: gzip`. No
 * per-adapter reinvention — every adapter goes through `listBoard`.
 *
 * Spec: STRATEGY.md §24.5, §24.201 D6 + .specs/research/PHASE_2_5_JOB_BOARDS.md §Q1.
 */
import { getDb } from '../../../db/connection.js';
import { getConfig, getConfigDefault } from '../../../get-config.js';
import { log } from '../../../log.js';
import { recordRequestTelemetry } from '../../../request-telemetry.js';
import type { AtsSource, JobLeadPayload, SourceAdapter, SourceListResult } from './types.js';

const GREENHOUSE_BASE = 'https://boards-api.greenhouse.io/v1/boards';
const LEVER_BASE = 'https://api.lever.co/v0/postings';
const ASHBY_BASE = 'https://api.ashbyhq.com/posting-api/job-board';
// Identify the scraper to job boards (etiquette). Personal contact details are
// NEVER committed — the real UA (with a contact for scraping politeness) is
// injected at deploy time via the JOB_SCRAPER_USER_AGENT env var (a GitHub
// var/secret → .env, sourced into the environment); the committed default
// carries no personal data.
// HTTP header values must be ASCII / ByteString. Any non-Latin-1 character (em
// dash, smart quotes, etc.) makes node fetch throw "Cannot convert argument to
// a ByteString" — keep both the default AND any injected override pure ASCII.
const USER_AGENT =
  process.env.JOB_SCRAPER_USER_AGENT ||
  'career-pilot/0.1 (automated job-search agent; +https://github.com/example/career-pilot)';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CRAWL_DELAY_MS_LEVER = 1_000; // honor robots.txt Crawl-delay: 1
const CRAWL_DELAY_MS_GREENHOUSE = 0; // no crawl-delay declared
const CRAWL_DELAY_MS_ASHBY = 1_000; // none declared; stay polite on a shared API host

/** Fallback when neither the preferences tier nor defaults.json can be read. */
const CACHE_MAX_ENTRIES_FALLBACK = 250;

/**
 * Description fields are truncated to bound the in-memory payload-cache
 * footprint and the DB row size. The fingerprint + rules-score functions
 * read up to 2000 chars, so capping at 2000 captures everything they
 * actually consume without wasted bytes.
 *
 * Before issue #2's fix, the subagent received full payloads inline,
 * so this cap was set aggressively low (800 → 200KB total) to fit
 * under the SDK's inline tool-result cap. Now fetch_source returns
 * lightweight summaries instead (~150 bytes each); the full payload
 * lives in the host-side payload-cache and never crosses the inline-cap
 * boundary. So we can safely lift the cap back to what scoring uses.
 */
const DESCRIPTION_TEXT_CAP = 2000;
const DESCRIPTION_HTML_CAP = 0; // strip entirely; we keep description_text only

interface CacheEntry {
  postings: JobLeadPayload[];
  etag?: string;
  cachedAt: number;
}

function truncateDescription(text: string | null, cap: number): string | null {
  if (text == null) return null;
  if (cap === 0) return null;
  if (text.length <= cap) return text;
  return text.slice(0, cap) + '...';
}

// A Map iterates in insertion order; every read or write re-inserts its key, so
// the first key is always the least recently used one — the one evicted.
const responseCache = new Map<string, CacheEntry>();
const lastFetchPerHost = new Map<string, number>();

function cacheKey(source: AtsSource, token: string): string {
  return `${source}:${token}`;
}

/** `ats_response_cache_max_entries`, read per write so an owner change applies live. */
function cacheMaxEntries(): number {
  let n: number | undefined;
  try {
    n = getConfig<number>(getDb(), 'ats_response_cache_max_entries');
  } catch {
    // No DB in this process (a script / bare test) — use the shipped default.
    n = getConfigDefault('ats_response_cache_max_entries') as number | undefined;
  }
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.floor(n) : CACHE_MAX_ENTRIES_FALLBACK;
}

function cacheTouch(key: string, entry: CacheEntry): void {
  responseCache.delete(key);
  responseCache.set(key, entry);
}

function cachePut(key: string, entry: CacheEntry): void {
  cacheTouch(key, entry);
  const max = cacheMaxEntries();
  while (responseCache.size > max) {
    const oldest = responseCache.keys().next().value;
    if (oldest === undefined) break;
    responseCache.delete(oldest);
  }
}

/**
 * `provider` tags the request_telemetry row (§24.68): one row per real board
 * fetch — 2xx AND 304 count as ok, non-ok carries the status, a network throw
 * records then rethrows (the adapters' catches keep their existing behavior).
 * In-process cache hits never reach here, so they record nothing. Latency
 * excludes the crawl-delay sleep (it measures the exchange, not our politeness).
 */
async function politeFetch(
  url: string,
  host: string,
  crawlDelayMs: number,
  provider: AtsSource,
  etag?: string,
): Promise<Response> {
  const lastFetch = lastFetchPerHost.get(host) ?? 0;
  const elapsed = Date.now() - lastFetch;
  if (elapsed < crawlDelayMs) {
    await new Promise((r) => setTimeout(r, crawlDelayMs - elapsed));
  }
  lastFetchPerHost.set(host, Date.now());

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
    // Full boards are large JSON documents; ask for compression explicitly
    // (§24.201 D6f). fetch decodes a gzip body transparently.
    'Accept-Encoding': 'gzip',
  };
  if (etag) headers['If-None-Match'] = etag;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const t0 = Date.now();
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    // A 404/410 means the board token points at a board that no longer exists
    // (the company renamed its board or moved ATS) — an expected, fail-soft
    // config-drift condition the scan skips, NOT a fetch/provider failure. Count
    // it as ok so a stale seed token can't inflate the provider error rate (the
    // /architecture "Job search API" node) or trip a failure-streak health
    // finding (§24.184). Real transient failures (403/429/5xx, network timeout)
    // stay ok:false. The adapter reports it to its caller as `absent`.
    const boardAbsent = res.status === 404 || res.status === 410;
    const ok = res.ok || res.status === 304 || boardAbsent;
    recordRequestTelemetry({
      provider,
      surface: 'scrape-board',
      trafficClass: 'host',
      ok,
      latencyMs: Date.now() - t0,
      statusCode: res.status,
      error: ok ? null : `HTTP ${res.status} ${res.statusText}`,
    });
    return res;
  } catch (err) {
    recordRequestTelemetry({
      provider,
      surface: 'scrape-board',
      trafficClass: 'host',
      ok: false,
      latencyMs: Date.now() - t0,
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The one fetch-and-normalize path every adapter shares: cache, conditional GET,
 * the ok / absent / failed classification, and the parse. `parse` turns the JSON
 * body into payloads; it may throw on a malformed body (reported as a failure).
 */
async function listBoard(
  source: AtsSource,
  token: string,
  url: string,
  host: string,
  crawlDelayMs: number,
  parse: (body: unknown) => JobLeadPayload[],
): Promise<SourceListResult> {
  const key = cacheKey(source, token);
  const cached = responseCache.get(key);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    cacheTouch(key, cached);
    return { ok: true, absent: false, postings: cached.postings, status: null };
  }

  try {
    const res = await politeFetch(url, host, crawlDelayMs, source, cached?.etag);
    if (res.status === 304 && cached) {
      cached.cachedAt = Date.now();
      cacheTouch(key, cached);
      return { ok: true, absent: false, postings: cached.postings, status: 304 };
    }
    if (res.status === 404 || res.status === 410) {
      log.warn(`${source} board absent`, { token, status: res.status });
      responseCache.delete(key);
      return { ok: false, absent: true, postings: [], status: res.status, error: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      log.warn(`${source} list non-ok`, { token, status: res.status });
      return { ok: false, absent: false, postings: [], status: res.status, error: `HTTP ${res.status}` };
    }
    const etag = res.headers.get('etag') ?? undefined;
    const postings = parse(await res.json());
    cachePut(key, { postings, etag, cachedAt: Date.now() });
    return { ok: true, absent: false, postings, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`${source} list failed`, { token, err: message });
    return { ok: false, absent: false, postings: [], status: null, error: message };
  }
}

// ── Greenhouse ─────────────────────────────────────────────────────────────

interface GreenhouseJob {
  id: number;
  internal_job_id?: number;
  title: string;
  /** When the posting first went live. The list endpoint returns it alongside
   *  `updated_at`, which moves on every edit of an old requisition. */
  first_published?: string | null;
  updated_at?: string;
  requisition_id?: string | null;
  location?: { name: string };
  absolute_url: string;
  content?: string; // HTML; present when content=true
  departments?: Array<{ name: string }>;
  offices?: Array<{ name: string }>;
  pay_input_ranges?: Array<{ min_cents?: number; max_cents?: number; currency_type?: string; pay_period?: string }>;
}

interface GreenhouseListResponse {
  jobs: GreenhouseJob[];
  meta?: { total?: number };
}

export const greenhouseAdapter: SourceAdapter = {
  source: 'greenhouse',
  list(token: string): Promise<SourceListResult> {
    const url = `${GREENHOUSE_BASE}/${encodeURIComponent(token)}/jobs?content=true`;
    return listBoard('greenhouse', token, url, 'boards-api.greenhouse.io', CRAWL_DELAY_MS_GREENHOUSE, (body) =>
      ((body as GreenhouseListResponse).jobs ?? []).map((j) => normalizeGreenhouse(j, token)),
    );
  },
};

/**
 * Canonicalize an adapter timestamp to UTC `…Z` ISO-8601, or null when absent or
 * unparseable. Greenhouse dates carry the board's local offset
 * (`2026-11-16T05:00:00-05:00`) and Ashby's carry `+00:00`; killer-match and the
 * age gates compare `source_posted_at` as TEXT against a `toISOString()` cutoff,
 * so a stored offset would shift the window by the offset (5–8h on US boards).
 */
export function toUtcIso(v: unknown): string | null {
  if (v == null || v === '') return null;
  const ms = typeof v === 'number' ? v : typeof v === 'string' ? Date.parse(v) : NaN;
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function normalizeGreenhouse(j: GreenhouseJob, board_token: string): JobLeadPayload {
  const pay = j.pay_input_ranges?.[0];
  const comp_min_usd = pay?.min_cents ? Math.floor(pay.min_cents / 100) : null;
  const comp_max_usd = pay?.max_cents ? Math.floor(pay.max_cents / 100) : null;
  const fullHtml = j.content ?? null;
  const fullText = fullHtml ? stripHtmlEntities(fullHtml) : null;
  const description_html = truncateDescription(fullHtml, DESCRIPTION_HTML_CAP);
  const description_text = truncateDescription(fullText, DESCRIPTION_TEXT_CAP);
  const location_raw = j.location?.name ?? null;
  const { is_remote, remote_region, workplace_type } = inferRemote(location_raw, description_text);

  // Greenhouse doesn't expose company name on the job — the board owner
  // IS the company. The caller (host action) passes the company name
  // alongside the token; we leave it blank here and let the caller fill.
  return {
    source: 'greenhouse',
    source_board_token: board_token,
    source_job_id: String(j.id),
    source_url: j.absolute_url,
    apply_url: j.absolute_url,
    title: j.title,
    company: '', // filled by the caller from the watchlist row
    location_raw,
    is_remote,
    workplace_type,
    remote_region,
    comp_min_usd,
    comp_max_usd,
    comp_currency: pay?.currency_type ?? 'USD',
    comp_period: pay?.pay_period === 'year' ? 'year' : pay?.pay_period === 'hour' ? 'hour' : null,
    description_html,
    description_text,
    // §24.201 D6a: the publish date, not the last edit — an edited old
    // requisition must not look fresh to the age gate or to killer-match.
    source_posted_at: toUtcIso(j.first_published) ?? toUtcIso(j.updated_at),
    raw_payload: {
      greenhouse_id: j.id,
      internal_job_id: j.internal_job_id ?? null,
      updated_at: j.updated_at ?? null,
      departments: j.departments ?? [],
      offices: j.offices ?? [],
    },
  };
}

// ── Lever ──────────────────────────────────────────────────────────────────

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  categories?: {
    location?: string;
    commitment?: string;
    department?: string;
    level?: string;
    team?: string;
    allLocations?: string[];
  };
  createdAt?: number; // epoch ms
  description?: string; // HTML
  descriptionPlain?: string;
  workplaceType?: 'on-site' | 'remote' | 'hybrid';
  country?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export const leverAdapter: SourceAdapter = {
  source: 'lever',
  list(token: string): Promise<SourceListResult> {
    const url = `${LEVER_BASE}/${encodeURIComponent(token)}?mode=json`;
    return listBoard('lever', token, url, 'api.lever.co', CRAWL_DELAY_MS_LEVER, (body) =>
      (Array.isArray(body) ? (body as LeverJob[]) : []).map((j) => normalizeLever(j, token)),
    );
  },
};

function normalizeLever(j: LeverJob, site: string): JobLeadPayload {
  const workplaceMap: Record<string, 'remote' | 'hybrid' | 'onsite' | null> = {
    remote: 'remote',
    hybrid: 'hybrid',
    'on-site': 'onsite',
  };
  const workplace_type = (j.workplaceType ? workplaceMap[j.workplaceType] : null) ?? null;
  const is_remote = workplace_type === 'remote' ? true : workplace_type === 'onsite' ? false : null;
  const fullHtml = j.description ?? null;
  const fullText = j.descriptionPlain ?? (fullHtml ? stripHtmlEntities(fullHtml) : null);
  const description_html = truncateDescription(fullHtml, DESCRIPTION_HTML_CAP);
  const description_text = truncateDescription(fullText, DESCRIPTION_TEXT_CAP);
  const location_raw = j.categories?.location ?? null;
  const remote_region = inferRemoteRegion(location_raw, description_text, j.country ?? null);
  const employmentMap: Record<string, 'full-time' | 'contract' | 'intern' | null> = {
    'full-time': 'full-time',
    contract: 'contract',
    intern: 'intern',
    internship: 'intern',
  };
  const commitment = j.categories?.commitment?.toLowerCase() ?? '';
  const employment_type = employmentMap[commitment] ?? null;

  return {
    source: 'lever',
    source_board_token: site,
    source_job_id: j.id,
    source_url: j.hostedUrl,
    apply_url: j.applyUrl,
    title: j.text,
    company: '', // filled by the caller from the watchlist row
    location_raw,
    is_remote,
    workplace_type,
    remote_region,
    employment_type,
    comp_min_usd: j.salaryRange?.min ?? null,
    comp_max_usd: j.salaryRange?.max ?? null,
    comp_currency: j.salaryRange?.currency ?? 'USD',
    comp_period: j.salaryRange?.interval === 'year' ? 'year' : j.salaryRange?.interval === 'hour' ? 'hour' : null,
    description_html,
    description_text,
    source_posted_at: j.createdAt ? toUtcIso(j.createdAt) : null,
    raw_payload: {
      categories: j.categories ?? {},
      level: j.categories?.level ?? null,
      team: j.categories?.team ?? null,
    },
  };
}

// ── Ashby ──────────────────────────────────────────────────────────────────

interface AshbyCompensationComponent {
  compensationType?: string; // 'Salary' | 'EquityPercentage' | 'EquityCashValue' | 'Bonus' | ...
  interval?: string; // '1 YEAR' | '1 HOUR' | '1 MONTH' | ...
  currencyCode?: string | null;
  minValue?: number | null;
  maxValue?: number | null;
}

interface AshbyJob {
  id: string;
  title: string;
  department?: string | null;
  team?: string | null;
  employmentType?: string | null; // 'FullTime' | 'PartTime' | 'Intern' | 'Contract' | 'Temporary'
  location?: string | null;
  secondaryLocations?: Array<{ location?: string | null }> | null;
  /** 'Remote' | 'Hybrid' | 'OnSite'. The ONLY field read for remote-ness:
   *  `isRemote` is also true for hybrid postings, so it is never consulted. */
  workplaceType?: string | null;
  isRemote?: boolean | null;
  isListed?: boolean;
  publishedAt?: string | null;
  jobUrl: string;
  applyUrl?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  address?: { postalAddress?: { addressCountry?: string | null } | null } | null;
  compensation?: {
    compensationTierSummary?: string | null;
    summaryComponents?: AshbyCompensationComponent[] | null;
  } | null;
}

interface AshbyListResponse {
  jobs?: AshbyJob[];
}

export const ashbyAdapter: SourceAdapter = {
  source: 'ashby',
  list(token: string): Promise<SourceListResult> {
    const url = `${ASHBY_BASE}/${encodeURIComponent(token)}?includeCompensation=true`;
    return listBoard('ashby', token, url, 'api.ashbyhq.com', CRAWL_DELAY_MS_ASHBY, (body) =>
      ((body as AshbyListResponse).jobs ?? [])
        // An unlisted posting is reachable only by direct link — the employer
        // has not published it, so it is not a lead.
        .filter((j) => j.isListed !== false)
        .map((j) => normalizeAshby(j, token)),
    );
  },
};

function normalizeAshby(j: AshbyJob, board: string): JobLeadPayload {
  const workplaceMap: Record<string, 'remote' | 'hybrid' | 'onsite'> = {
    remote: 'remote',
    hybrid: 'hybrid',
    onsite: 'onsite',
  };
  const fullHtml = j.descriptionHtml ?? null;
  const fullText = j.descriptionPlain ?? (fullHtml ? stripHtmlEntities(fullHtml) : null);
  const description_html = truncateDescription(fullHtml, DESCRIPTION_HTML_CAP);
  const description_text = truncateDescription(fullText, DESCRIPTION_TEXT_CAP);
  const location_raw = j.location ?? null;
  const country = j.address?.postalAddress?.addressCountry ?? null;

  const declared = j.workplaceType ? workplaceMap[j.workplaceType.toLowerCase().replace(/[^a-z]/g, '')] : undefined;
  let workplace_type: 'remote' | 'hybrid' | 'onsite' | null;
  let is_remote: boolean | null;
  let remote_region: 'US' | 'EU' | 'GLOBAL' | null;
  if (declared) {
    workplace_type = declared;
    is_remote = declared === 'remote';
    remote_region = declared === 'remote' ? inferRemoteRegion(location_raw, description_text, country) : null;
  } else {
    // No declared workplace type: read the location string only (never isRemote).
    ({ is_remote, remote_region, workplace_type } = inferRemote(location_raw, null));
  }

  const employmentMap: Record<string, 'full-time' | 'contract' | 'intern'> = {
    fulltime: 'full-time',
    contract: 'contract',
    intern: 'intern',
  };
  const employment_type = j.employmentType ? (employmentMap[j.employmentType.toLowerCase()] ?? null) : null;

  const components = j.compensation?.summaryComponents ?? [];
  const salary = components.find((c) => c.compensationType === 'Salary');
  const interval = (salary?.interval ?? '').toUpperCase();
  const comp_period = interval.endsWith('YEAR')
    ? 'year'
    : interval.endsWith('HOUR')
      ? 'hour'
      : interval.endsWith('MONTH')
        ? 'month'
        : null;
  const has_equity = components.some((c) => (c.compensationType ?? '').startsWith('Equity')) ? true : null;

  const secondary = (j.secondaryLocations ?? [])
    .map((s) => s?.location)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);

  return {
    source: 'ashby',
    source_board_token: board,
    source_job_id: j.id,
    source_url: j.jobUrl,
    apply_url: j.applyUrl ?? j.jobUrl,
    title: j.title,
    company: '', // filled by the caller from the watchlist row
    location_raw,
    is_remote,
    workplace_type,
    remote_region,
    employment_type,
    comp_min_usd: salary?.minValue != null ? Math.floor(salary.minValue) : null,
    comp_max_usd: salary?.maxValue != null ? Math.floor(salary.maxValue) : null,
    comp_currency: salary?.currencyCode ?? 'USD',
    comp_period,
    has_equity,
    description_html,
    description_text,
    source_posted_at: toUtcIso(j.publishedAt),
    raw_payload: {
      ashby_id: j.id,
      department: j.department ?? null,
      team: j.team ?? null,
      workplace_type: j.workplaceType ?? null,
      employment_type: j.employmentType ?? null,
      secondary_locations: secondary,
      compensation_summary: j.compensation?.compensationTierSummary ?? null,
    },
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const ADAPTERS: Record<AtsSource, SourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
};

export function getAdapter(source: AtsSource): SourceAdapter {
  return ADAPTERS[source];
}

/**
 * Strip HTML tags + decode common entities. Conservative: we don't need
 * full HTML parsing, just the readable text for fingerprinting + keyword
 * matching. Anything more rigorous would pull in a dependency we don't
 * need.
 */
function stripHtmlEntities(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Infer remote-ness from a location string + description when the source
 * doesn't expose it as a first-class field (Greenhouse is the main
 * offender — it puts "Remote" / "San Francisco" / "Remote - US" all in
 * `location.name`).
 */
function inferRemote(
  location: string | null,
  description: string | null,
): {
  is_remote: boolean | null;
  remote_region: 'US' | 'EU' | 'GLOBAL' | null;
  workplace_type: 'remote' | 'hybrid' | 'onsite' | null;
} {
  if (!location && !description) return { is_remote: null, remote_region: null, workplace_type: null };
  const loc = (location ?? '').toLowerCase();
  const desc = (description ?? '').slice(0, 500).toLowerCase();
  const hay = `${loc} ${desc}`;

  if (hay.includes('hybrid')) {
    return { is_remote: false, remote_region: null, workplace_type: 'hybrid' };
  }

  const remoteSignal = /\bremote\b/.test(hay);
  if (remoteSignal) {
    return {
      is_remote: true,
      remote_region: inferRemoteRegion(location, description, null),
      workplace_type: 'remote',
    };
  }

  // Has a city/state pattern — assume onsite.
  if (location && /[a-z]/i.test(location)) {
    return { is_remote: false, remote_region: null, workplace_type: 'onsite' };
  }
  return { is_remote: null, remote_region: null, workplace_type: null };
}

function inferRemoteRegion(
  location: string | null,
  description: string | null,
  country: string | null,
): 'US' | 'EU' | 'GLOBAL' | null {
  const hay = `${location ?? ''} ${(description ?? '').slice(0, 500)} ${country ?? ''}`.toLowerCase();
  if (/\b(us|usa|united states|u\.s\.|us-only|us only)\b/.test(hay)) return 'US';
  if (/\b(eu|europe|emea|uk|united kingdom|eu only)\b/.test(hay)) return 'EU';
  if (/\b(global|worldwide|anywhere)\b/.test(hay)) return 'GLOBAL';
  return null;
}

/** Exported for testing. */
export const _testing = {
  stripHtmlEntities,
  inferRemote,
  inferRemoteRegion,
  normalizeGreenhouse,
  normalizeLever,
  normalizeAshby,
  cacheSize: (): number => responseCache.size,
  cacheHas: (source: AtsSource, token: string): boolean => responseCache.has(cacheKey(source, token)),
};

/** Clear the response cache. Exported for tests. */
export function _clearCache(): void {
  responseCache.clear();
  lastFetchPerHost.clear();
}
