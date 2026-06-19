/**
 * Seed targets reader.
 *
 * Reads + validates `groups/career-pilot/data/ats-targets.json`. Returns
 * the parsed entries filtered by priority and/or company. Host-side.
 *
 * The seed file IS the candidate's target-employer surface for v1.0 —
 * curated, version-controlled, ~30-50 entries to start.
 *
 * Spec: STRATEGY.md §24.5 what-lands #4.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { log } from '../../../log.js';
import type { TargetEntry, Source, SourcePriority } from './types.js';

const TARGETS_FILE_PATH = join(process.cwd(), 'groups', 'career-pilot', 'data', 'ats-targets.json');

let cached: { entries: TargetEntry[]; loadedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 1000; // 1 min — the file rarely changes but we don't want stale across multi-hour processes

export function loadTargets(): TargetEntry[] {
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL_MS) {
    return cached.entries;
  }
  try {
    const raw = readFileSync(TARGETS_FILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      log.warn('ats-targets.json is not an array', { path: TARGETS_FILE_PATH });
      return [];
    }
    const entries: TargetEntry[] = [];
    for (const item of parsed) {
      if (!isValidEntry(item)) {
        log.warn('ats-targets.json skipped invalid entry', { item });
        continue;
      }
      entries.push(item);
    }
    cached = { entries, loadedAt: Date.now() };
    return entries;
  } catch (err) {
    log.warn('ats-targets.json failed to load', {
      path: TARGETS_FILE_PATH,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export function filterTargets(args: { priority?: SourcePriority; company?: string }): TargetEntry[] {
  const all = loadTargets();
  return all.filter((t) => {
    if (args.priority && t.priority !== args.priority) return false;
    if (args.company && t.company.toLowerCase() !== args.company.toLowerCase()) return false;
    return true;
  });
}

function isValidEntry(item: unknown): item is TargetEntry {
  if (!item || typeof item !== 'object') return false;
  const e = item as Record<string, unknown>;
  if (typeof e.company !== 'string' || !e.company) return false;
  if (e.source !== 'greenhouse' && e.source !== 'lever') return false;
  if (typeof e.token !== 'string' || !e.token) return false;
  if (e.priority !== 'A' && e.priority !== 'B' && e.priority !== 'C') return false;
  return true;
}

/** Clear cache. Exported for tests. */
export function _clearTargetsCache(): void {
  cached = null;
}

/** Re-export common types for adapter consumers. */
export type { TargetEntry, Source, SourcePriority };
