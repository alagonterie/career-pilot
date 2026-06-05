/**
 * getConfig(db, key, fallback?) — the host-side four-tier config reader.
 *
 * Precedence (STRATEGY.md §20): env (UPPER_SNAKE of the key) > `preferences`
 * table (`data/v2.db`) > `config/defaults.json` > the optional `fallback` arg.
 *
 * `config/defaults.json` is the canonical source of BOTH the default value and
 * each key's *type*. The `.env` and `preferences`-table tiers store everything
 * as strings; this helper coerces a string override to match the native type of
 * the defaults.json value (boolean, number, string, array, object). That keeps
 * call sites free of hardcoded fallbacks — they name a key, and the default
 * lives in defaults.json (the zero-magic-numbers rule, CLAUDE.md §5).
 *
 * Scope: the `preferences` tier only. `system_modes` (LIVE_MODE, pause_state,
 * killswitch) is hot-reloaded the same way but read via its own dedicated
 * accessors, not this helper. Container-side config is separate
 * (container/agent-runner/src/config.ts returns a static RunnerConfig).
 */
import fs from 'fs';
import path from 'path';

import type Database from 'better-sqlite3';

const DEFAULTS_PATH = path.join(process.cwd(), 'config', 'defaults.json');

interface DefaultsFile {
  preferences?: Record<string, unknown>;
}

let defaultsCache: DefaultsFile | null = null;

function loadDefaults(): DefaultsFile {
  if (defaultsCache) return defaultsCache;
  try {
    defaultsCache = JSON.parse(fs.readFileSync(DEFAULTS_PATH, 'utf8')) as DefaultsFile;
  } catch {
    // No defaults file (or malformed) — every read then relies on the fallback arg.
    defaultsCache = {};
  }
  return defaultsCache;
}

/**
 * Test seam: drop the cached defaults.json so a test that points process.cwd()
 * at a fixture (or rewrites the file) sees the new contents on the next read.
 */
export function _resetDefaultsCache(): void {
  defaultsCache = null;
}

function lookupDefault(key: string): unknown {
  const prefs = loadDefaults().preferences;
  return prefs && key in prefs ? prefs[key] : undefined;
}

/**
 * The canonical default (the `config/defaults.json` value) for a key, ignoring
 * any env/preferences override — `undefined` if the key isn't in defaults.json.
 * Used by the dev inspector to show each knob's default + drive "reset to
 * default" (which deletes the preferences override so the value falls back here).
 */
export function getConfigDefault(key: string): unknown {
  return lookupDefault(key);
}

/** Read the raw (string) preferences-table value for a key, if present. */
function readPreference(db: Database.Database, key: string): string | undefined {
  try {
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined;
    return row && row.value != null ? row.value : undefined;
  } catch {
    // preferences table absent (e.g. a bare test DB) — treat as no override.
    return undefined;
  }
}

/** Coerce a string override to the native type of `sample` (a defaults.json value or the fallback). */
function coerce<T>(raw: string, sample: unknown): T {
  if (typeof sample === 'boolean') {
    return (raw === 'true' || raw === '1') as unknown as T;
  }
  if (typeof sample === 'number') {
    const n = Number(raw);
    return (Number.isFinite(n) ? n : sample) as unknown as T;
  }
  if (sample !== null && typeof sample === 'object') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return sample as T;
    }
  }
  return raw as unknown as T;
}

/**
 * Resolve a tunable across the config tiers.
 *
 * @param db        central DB handle (for the `preferences` tier)
 * @param key       lower_snake_case preferences key (also the defaults.json key)
 * @param fallback  last-resort value when the key is absent from both the table
 *                  and defaults.json; also the type sample in that case
 */
export function getConfig<T = unknown>(db: Database.Database, key: string, fallback?: T): T {
  const def = lookupDefault(key);
  const sample = def !== undefined ? def : fallback;

  const envRaw = process.env[key.toUpperCase()];
  const raw = envRaw != null && envRaw !== '' ? envRaw : readPreference(db, key);

  if (raw != null) {
    // A string override exists (env or table). Coerce to the known type when we
    // have one; otherwise hand back the raw string.
    return sample !== undefined ? coerce<T>(raw, sample) : (raw as unknown as T);
  }
  return (def !== undefined ? def : fallback) as T;
}
