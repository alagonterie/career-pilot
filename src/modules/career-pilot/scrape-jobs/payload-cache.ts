/**
 * Host-side in-process TTL cache for full JobLeadPayloads.
 *
 * The `fetch_source` action returns lightweight `PostingSummary`s to the
 * subagent (the SDK's subagent-side inline tool-result cap is too tight
 * to pass full payloads). `record_job_lead` accepts `(source, source_job_id)`
 * only and looks up the full payload here.
 *
 * Lifecycle:
 *   - `fetch_source` populates the cache for every posting it returns.
 *   - `record_job_lead` reads (and does NOT evict — leads can be recorded
 *     in any order, and re-record after dedup conflict is fine).
 *   - Entries auto-expire after TTL_MS via lazy eviction on read.
 *
 * Memory: each payload is ~1-2KB (description_text capped, no html). At
 * ~60 postings per scrape × a few scrapes/hour, the cache stays well
 * under 1MB. No background sweep needed for v1.0.
 *
 * Spec: STRATEGY.md §24.5 issue #2.
 */
import type { JobLeadPayload, Source } from './types.js';

/** 1 hour. Long enough that a "fetch then record" workflow doesn't race
 *  the TTL; short enough that stale payloads don't pile up if the host
 *  runs for days without restart. */
const TTL_MS = 60 * 60 * 1000;

interface Entry {
  payload: JobLeadPayload;
  expiresAt: number;
}

const cache = new Map<string, Entry>();

function key(source: Source, sourceJobId: string): string {
  return `${source}::${sourceJobId}`;
}

export function set(source: Source, sourceJobId: string, payload: JobLeadPayload): void {
  cache.set(key(source, sourceJobId), { payload, expiresAt: Date.now() + TTL_MS });
}

export function get(source: Source, sourceJobId: string): JobLeadPayload | undefined {
  const k = key(source, sourceJobId);
  const entry = cache.get(k);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(k);
    return undefined;
  }
  return entry.payload;
}

/** For tests + the `--reset` path. */
export function clear(): void {
  cache.clear();
}

/** For diagnostics — count of non-expired entries. */
export function size(): number {
  const now = Date.now();
  let n = 0;
  for (const entry of cache.values()) {
    if (entry.expiresAt >= now) n += 1;
  }
  return n;
}
