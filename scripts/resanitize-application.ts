/**
 * scripts/resanitize-application.ts — operator escape hatch for §24.11.
 *
 * Retroactively re-sanitizes an application's public_audit_trail rows from
 * the canonical funnel_events truth. The host's handleUpdateApplication
 * hook already does this automatically when the agent changes an
 * application's obfuscation policy — this script is for the cases the hook
 * can't see:
 *
 *   - a direct SQL edit of applications.public_state / obfuscated_label /
 *     company_name / company_aliases (the hook only fires from the MCP
 *     update_application path);
 *   - obfuscated_label changes, which update_application refuses to apply
 *     (the column is immutable through that handler);
 *   - operator wants to force a re-mirror after a sanitizer-rule change.
 *
 * Deliberately a host-side script, NOT an MCP tool: the rewrite-the-public-
 * audit-trail capability must never sit in the agent's SDK context (even
 * undocumented, it would be invokable by hallucination or, in the sandbox,
 * prompt-injection). That would undercut the integrity the Phase 4
 * sanitization layer exists to protect. Modeled on
 * scripts/delete-cli-agent.ts.
 *
 * Usage:
 *   pnpm exec tsx scripts/resanitize-application.ts --id <application-id>
 *
 * Safe to run while the host is up — it opens its own connection; SQLite's
 * busy_timeout covers brief write contention. Prints { rewritten, deleted }.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { resanitizeApplicationAuditTrail } from '../src/modules/portal/public-audit.js';

function parseArgs(): { id: string } {
  const argv = process.argv.slice(2);
  let id = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--id' && argv[i + 1]) id = argv[++i];
    else if (argv[i].startsWith('--id=')) id = argv[i].slice('--id='.length);
  }
  if (!id) {
    console.error('usage: pnpm exec tsx scripts/resanitize-application.ts --id <application-id>');
    process.exit(1);
  }
  return { id };
}

const { id } = parseArgs();

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const app = db.prepare('SELECT id, public_state, obfuscated_label FROM applications WHERE id = ?').get(id) as
  | { id: string; public_state: string; obfuscated_label: string }
  | undefined;
if (!app) {
  console.error(`No application with id "${id}" — nothing to resanitize.`);
  process.exit(1);
}

const result = resanitizeApplicationAuditTrail(db, id);
console.log(
  `Resanitized application ${id} (public_state=${app.public_state}, label=${app.obfuscated_label}): ` +
    `rewrote ${result.rewritten} row(s), deleted ${result.deleted} stale row(s).`,
);
