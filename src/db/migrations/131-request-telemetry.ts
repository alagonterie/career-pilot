/**
 * Migration 131 — request_telemetry + health_alert_state (STRATEGY.md §24.68).
 *
 * `request_telemetry`: one row per outbound API request at every choke point our
 * own code owns — success AND failure (the §24.66 Gmail-401 streak existed only
 * in rotating log lines). Integration-agnostic: `provider`/`surface` identify the
 * callee and call site; the LLM columns (model/tokens/cost) are nullable for
 * non-LLM rows. Private — never a public surface (public_audit_trail stays the
 * curated showcase). cost is microUSD: cost_cents floors sub-cent Haiku calls
 * to 0 (a typical prose call ≈ 950 µUSD).
 *
 * `health_alert_state`: the proactive health alert's dedupe ledger — one row per
 * finding id; an alert fires when a critical finding has no row or a cleared one
 * (re-occurrence re-alerts). Persisted so restarts don't re-alert.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration131: Migration = {
  version: 131,
  name: 'career-pilot-request-telemetry',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE request_telemetry (
        id                    TEXT PRIMARY KEY,
        ts                    TEXT NOT NULL,            -- ISO 8601 UTC
        provider              TEXT NOT NULL,            -- 'portkey' | 'gmail' | 'calendar' | 'drive' | 'serpapi' | 'greenhouse' | 'lever' | ...
        surface               TEXT NOT NULL,            -- call-site slug ('recruiter-sim-prose', 'agent-turn', ...)
        traffic_class         TEXT NOT NULL CHECK (traffic_class IN ('ops','chat','sandbox','host')),
        session_id            TEXT,                     -- NULL for host-issued requests
        model                 TEXT,
        input_tokens          INTEGER,
        output_tokens         INTEGER,
        cache_read_tokens     INTEGER,
        cache_creation_tokens INTEGER,
        cost_microusd         INTEGER,
        latency_ms            INTEGER NOT NULL,
        status_code           INTEGER,                  -- NULL on network/exec failure
        ok                    INTEGER NOT NULL DEFAULT 0,
        error                 TEXT,                     -- truncated message; NULL when ok
        trace_id              TEXT,
        details_json          TEXT
      );

      CREATE INDEX idx_request_telemetry_ts          ON request_telemetry(ts DESC);
      CREATE INDEX idx_request_telemetry_provider_ok ON request_telemetry(provider, ok, ts);
      CREATE INDEX idx_request_telemetry_class_ts    ON request_telemetry(traffic_class, ts);
      CREATE INDEX idx_request_telemetry_surface_ts  ON request_telemetry(surface, ts);

      CREATE TABLE health_alert_state (
        finding_id       TEXT PRIMARY KEY,
        severity         TEXT NOT NULL,
        first_alerted_at TEXT NOT NULL,
        last_seen_at     TEXT NOT NULL,
        cleared_at       TEXT                           -- set when the finding disappears; re-appearance re-alerts
      );
    `);
  },
};
