/**
 * Migration 132 — simulator_runs.client_ip (STRATEGY.md §24.70 / 9.4a).
 *
 * The simulator's per-IP daily abuse cap + global $-budget are enforced in the
 * backend (`checkSimulatorAllowed`), not a Worker Durable Object: the TanStack
 * Start server-entry cannot cleanly export a DO class (undocumented), and the
 * backend already holds the real per-run cost ledger (`total_cost_cents`) the
 * budget caps against — strong consistency + real spend beat an edge estimate.
 * This column records the CF-verified visitor IP (forwarded by the Worker BFF as
 * `x-cp-client-ip`, overwriting any client value) so the per-IP daily count is
 * queryable. Nullable — pre-9.4a rows + dev:mock runs carry none.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration132: Migration = {
  version: 132,
  name: 'career-pilot-simulator-client-ip',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE simulator_runs ADD COLUMN client_ip TEXT;`);
  },
};
