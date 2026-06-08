/**
 * Tests for getConfig — the host-side four-tier config reader (STRATEGY.md §20).
 *
 * Precedence asserted: env > preferences table > config/defaults.json > fallback,
 * plus type coercion of string overrides to the defaults.json native type.
 *
 * Uses an in-memory DB for the preferences tier and the real config/defaults.json
 * (cwd = repo root under vitest) for the defaults tier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { _resetDefaultsCache, getConfig } from './get-config.js';

let db: Database.Database;

function setPref(key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(
    key,
    value,
    '2026-05-29T00:00:00Z',
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);');
  _resetDefaultsCache();
});

afterEach(() => {
  db.close();
  // Clear any env overrides a test set so they don't leak across cases.
  for (const k of [
    'KILLER_MATCH_MIN_RULES_SCORE',
    'KILLER_MATCH_ENABLED',
    'KILLER_MATCH_CRON',
    'KILLER_MATCH_SOURCE_ALLOW_LIST',
    'CP_TEST_UNKNOWN_KEY',
  ]) {
    delete process.env[k];
  }
});

describe('getConfig — defaults.json tier', () => {
  it('returns the typed defaults.json value when no override exists', () => {
    // defaults.json: killer_match_min_rules_score = 90 (number)
    const v = getConfig<number>(db, 'killer_match_min_rules_score');
    expect(v).toBe(90);
    expect(typeof v).toBe('number');
  });

  it('returns booleans as booleans', () => {
    // defaults.json: killer_match_enabled = true
    expect(getConfig<boolean>(db, 'killer_match_enabled')).toBe(true);
  });

  it('returns strings as strings', () => {
    // defaults.json: killer_match_cron = "*/30 7-22 * * *"
    expect(getConfig<string>(db, 'killer_match_cron')).toBe('*/30 7-22 * * *');
  });

  it('returns arrays as arrays', () => {
    // defaults.json: killer_match_source_allow_list = ["greenhouse","lever","google_jobs"]
    expect(getConfig<string[]>(db, 'killer_match_source_allow_list')).toEqual(['greenhouse', 'lever', 'google_jobs']);
  });

  it('returns nested objects as objects', () => {
    // defaults.json: funnel_curator_ghosting_thresholds_days = { applied:21, screen:10, onsite:7 }
    expect(getConfig<Record<string, number>>(db, 'funnel_curator_ghosting_thresholds_days')).toEqual({
      applied: 21,
      screen: 10,
      onsite: 7,
    });
  });
});

describe('getConfig — preferences table tier', () => {
  it('overrides defaults.json and coerces a string to number', () => {
    setPref('killer_match_min_rules_score', '75');
    const v = getConfig<number>(db, 'killer_match_min_rules_score');
    expect(v).toBe(75);
    expect(typeof v).toBe('number');
  });

  it('coerces a string to boolean', () => {
    setPref('killer_match_enabled', 'false');
    expect(getConfig<boolean>(db, 'killer_match_enabled')).toBe(false);
    setPref('killer_match_enabled', '1');
    expect(getConfig<boolean>(db, 'killer_match_enabled')).toBe(true);
  });

  it('JSON-parses an array override', () => {
    setPref('killer_match_source_allow_list', '["greenhouse"]');
    expect(getConfig<string[]>(db, 'killer_match_source_allow_list')).toEqual(['greenhouse']);
  });

  it('falls back to the defaults.json value when a numeric override is non-finite', () => {
    setPref('killer_match_min_rules_score', 'not-a-number');
    expect(getConfig<number>(db, 'killer_match_min_rules_score')).toBe(90);
  });

  it('falls back to the defaults.json value when a JSON override is malformed', () => {
    setPref('killer_match_source_allow_list', 'not json');
    expect(getConfig<string[]>(db, 'killer_match_source_allow_list')).toEqual(['greenhouse', 'lever', 'google_jobs']);
  });
});

describe('getConfig — env tier', () => {
  it('wins over both the table and defaults.json', () => {
    setPref('killer_match_min_rules_score', '75');
    process.env.KILLER_MATCH_MIN_RULES_SCORE = '50';
    expect(getConfig<number>(db, 'killer_match_min_rules_score')).toBe(50);
  });

  it('coerces env string to the defaults.json type', () => {
    process.env.KILLER_MATCH_ENABLED = 'false';
    expect(getConfig<boolean>(db, 'killer_match_enabled')).toBe(false);
  });
});

describe('getConfig — fallback tier', () => {
  it('returns the fallback when the key is absent from table and defaults.json', () => {
    expect(getConfig(db, 'cp_test_unknown_key', 42)).toBe(42);
  });

  it('coerces a table override to the fallback type when defaults.json lacks the key', () => {
    setPref('cp_test_unknown_key', '7');
    expect(getConfig(db, 'cp_test_unknown_key', 42)).toBe(7);
  });

  it('returns undefined when no value and no fallback exist', () => {
    expect(getConfig(db, 'cp_test_unknown_key')).toBeUndefined();
  });
});
