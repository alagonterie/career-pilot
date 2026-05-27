/**
 * Source adapters for Greenhouse + Lever ATS public APIs.
 *
 * Host-side modules. Each adapter implements `SourceAdapter` from
 * `../types.ts` — `list(token)` fetches all postings for one board and
 * returns normalized `JobLeadPayload[]`.
 *
 * Polite-fetch is centralized here: per-source crawl-delay, 1h in-process
 * response cache, ETag conditional GET. No per-adapter reinvention.
 *
 * **Phase 2.5 v1.0 scope:** Greenhouse + Lever only. Ashby + YC WaaS + HN +
 * LinkedIn-guest land in v1.1+.
 *
 * Spec: STRATEGY.md §24.5 + .specs/research/PHASE_2_5_JOB_BOARDS.md §Q1.
 */
import { log } from '../log.js';
import type { JobLeadPayload, SourceAdapter, Source } from './types.js';

const GREENHOUSE_BASE = 'https://boards-api.greenhouse.io/v1/boards';
const LEVER_BASE = 'https://api.lever.co/v0/postings';
// HTTP header values must be ASCII / ByteString. Any non-Latin-1
// character (em dash, smart quotes, etc.) causes node fetch to throw
// "Cannot convert argument to a ByteString". Keep this pure ASCII.
const USER_AGENT = 'career-pilot/0.1 (+https://github.com/janedoe/career-pilot - personal job-search agent, contact: janedoe@gmail.com)';
const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const CRAWL_DELAY_MS_LEVER = 1_000; // honor robots.txt Crawl-delay: 1
const CRAWL_DELAY_MS_GREENHOUSE = 0; // no crawl-delay declared

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

const responseCache = new Map<string, CacheEntry>();
const lastFetchPerHost = new Map<string, number>();

function cacheKey(source: Source, token: string): string {
  return `${source}:${token}`;
}

async function politeFetch(url: string, host: string, crawlDelayMs: number, etag?: string): Promise<Response> {
  const lastFetch = lastFetchPerHost.get(host) ?? 0;
  const elapsed = Date.now() - lastFetch;
  if (elapsed < crawlDelayMs) {
    await new Promise((r) => setTimeout(r, crawlDelayMs - elapsed));
  }
  lastFetchPerHost.set(host, Date.now());

  const headers: Record<string, string> = {
    'User-Agent': USER_AGENT,
    Accept: 'application/json',
  };
  if (etag) headers['If-None-Match'] = etag;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

// ── Greenhouse ─────────────────────────────────────────────────────────────

interface GreenhouseJob {
  id: number;
  internal_job_id?: number;
  title: string;
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
  async list(token: string): Promise<JobLeadPayload[]> {
    const key = cacheKey('greenhouse', token);
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.postings;
    }

    const url = `${GREENHOUSE_BASE}/${encodeURIComponent(token)}/jobs?content=true`;
    try {
      const res = await politeFetch(url, 'boards-api.greenhouse.io', CRAWL_DELAY_MS_GREENHOUSE, cached?.etag);
      if (res.status === 304 && cached) {
        cached.cachedAt = Date.now();
        return cached.postings;
      }
      if (!res.ok) {
        log.warn('greenhouse list non-ok', { token, status: res.status });
        return [];
      }
      const etag = res.headers.get('etag') ?? undefined;
      const body = (await res.json()) as GreenhouseListResponse;
      const postings = (body.jobs ?? []).map((j) => normalizeGreenhouse(j, token));
      responseCache.set(key, { postings, etag, cachedAt: Date.now() });
      return postings;
    } catch (err) {
      log.warn('greenhouse list failed', { token, err: err instanceof Error ? err.message : String(err) });
      return [];
    }
  },
};

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
    company: '', // filled by the action handler from the targets entry
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
    source_posted_at: j.updated_at ?? null,
    raw_payload: { greenhouse_id: j.id, internal_job_id: j.internal_job_id ?? null, departments: j.departments ?? [], offices: j.offices ?? [] },
  };
}

// ── Lever ──────────────────────────────────────────────────────────────────

interface LeverJob {
  id: string;
  text: string;
  hostedUrl: string;
  applyUrl: string;
  categories?: { location?: string; commitment?: string; department?: string; level?: string; team?: string; allLocations?: string[] };
  createdAt?: number; // epoch ms
  description?: string; // HTML
  descriptionPlain?: string;
  workplaceType?: 'on-site' | 'remote' | 'hybrid';
  country?: string;
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}

export const leverAdapter: SourceAdapter = {
  source: 'lever',
  async list(token: string): Promise<JobLeadPayload[]> {
    const key = cacheKey('lever', token);
    const cached = responseCache.get(key);
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return cached.postings;
    }

    const url = `${LEVER_BASE}/${encodeURIComponent(token)}?mode=json`;
    try {
      const res = await politeFetch(url, 'api.lever.co', CRAWL_DELAY_MS_LEVER, cached?.etag);
      if (res.status === 304 && cached) {
        cached.cachedAt = Date.now();
        return cached.postings;
      }
      if (!res.ok) {
        log.warn('lever list non-ok', { token, status: res.status });
        return [];
      }
      const etag = res.headers.get('etag') ?? undefined;
      const body = (await res.json()) as LeverJob[];
      const postings = (Array.isArray(body) ? body : []).map((j) => normalizeLever(j, token));
      responseCache.set(key, { postings, etag, cachedAt: Date.now() });
      return postings;
    } catch (err) {
      log.warn('lever list failed', { token, err: err instanceof Error ? err.message : String(err) });
      return [];
    }
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
    company: '', // filled by the action handler from the targets entry
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
    source_posted_at: j.createdAt ? new Date(j.createdAt).toISOString() : null,
    raw_payload: {
      categories: j.categories ?? {},
      level: j.categories?.level ?? null,
      team: j.categories?.team ?? null,
    },
  };
}

// ── Shared helpers ─────────────────────────────────────────────────────────

const ADAPTERS: Record<Source, SourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
};

export function getAdapter(source: Source): SourceAdapter {
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
): { is_remote: boolean | null; remote_region: 'US' | 'EU' | 'GLOBAL' | null; workplace_type: 'remote' | 'hybrid' | 'onsite' | null } {
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
export const _testing = { stripHtmlEntities, inferRemote, inferRemoteRegion, normalizeGreenhouse, normalizeLever };

/** Clear the response cache. Exported for tests. */
export function _clearCache(): void {
  responseCache.clear();
  lastFetchPerHost.clear();
}
