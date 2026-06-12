import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
import { migration013 } from './013-approval-render-metadata.js';
import { migration014 } from './014-container-configs.js';
import { migration015 } from './015-cli-scope.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';
// --- career-pilot migrations (100-107) ---
import { migration100 } from './100-applications.js';
import { migration101 } from './101-funnel-events.js';
import { migration102 } from './102-public-audit-trail.js';
import { migration103 } from './103-learnings.js';
import { migration104 } from './104-preferences.js';
import { migration105 } from './105-candidate-profile.js';
import { migration106 } from './106-system-modes.js';
import { migration107 } from './107-simulator-runs.js';
import { migration108 } from './108-gmail-account-outreach-prefs.js';
import { migration109 } from './109-disallowed-tools.js';
import { migration110 } from './110-job-leads.js';
import { migration120 } from './120-job-leads-killer-match.js';
import { migration121 } from './121-funnel-curator.js';
import { migration122 } from './122-audit-source-fe.js';
import { migration123 } from './123-audit-seq.js';
import { migration124 } from './124-public-funnel-view.js';
import { migration125 } from './125-funnel-events-proactive.js';
import { migration126 } from './126-win-confidence-rationale.js';
import { migration127 } from './127-interview-kits.js';
import { migration128 } from './128-simulator-trace.js';
import { migration129 } from './129-cache-read-pct.js';
import { migration130 } from './130-kit-public-surfacing.js';
import { migration131 } from './131-request-telemetry.js';

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  moduleApprovalsPendingApprovals,
  moduleAgentToAgentDestinations,
  moduleApprovalsTitleOptions,
  migration008,
  migration009,
  migration010,
  migration011,
  migration012,
  migration013,
  migration014,
  migration015,
  // --- career-pilot migrations (100-107) ---
  migration100,
  migration101,
  migration102,
  migration103,
  migration104,
  migration105,
  migration106,
  migration107,
  migration108,
  migration109,
  migration110,
  migration120,
  migration121,
  migration122,
  migration123,
  migration124,
  migration125,
  migration126,
  migration127,
  migration128,
  migration129,
  migration130,
  migration131,
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name    TEXT NOT NULL,
      applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);

  // Uniqueness is keyed on `name`, not `version`. This lets module
  // migrations (added later by install skills) pick arbitrary version
  // numbers without coordinating across modules. `version` stays on
  // the Migration object as an ordering hint within the barrel array;
  // the stored `version` column is auto-assigned at insert time as an
  // applied-order number.
  const applied = new Set<string>(
    (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name),
  );
  const pending = migrations.filter((m) => !applied.has(m.name));
  if (pending.length === 0) return;

  log.info('Running migrations', { count: pending.length });

  for (const m of pending) {
    db.transaction(() => {
      m.up(db);
      const next = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number })
        .v;
      db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
        next,
        m.name,
        new Date().toISOString(),
      );
    })();
    log.info('Migration applied', { name: m.name });
  }
}
