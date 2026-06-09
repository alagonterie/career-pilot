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
 * Usage (provide exactly one selector):
 *   pnpm exec tsx scripts/resanitize-application.ts --id <application-id>
 *   pnpm exec tsx scripts/resanitize-application.ts --company "<company name>"
 *   pnpm exec tsx scripts/resanitize-application.ts --label <obfuscated_label>
 *
 * --company / --label exist so you don't need the internal application id to
 * hand. --company is case-insensitive and may match more than one row (same
 * company, multiple roles) — when it does, the script lists the candidates
 * and asks you to re-run with --id. --label and --id are unique.
 *
 * Safe to run while the host is up — it opens its own connection; SQLite's
 * busy_timeout covers brief write contention. Prints { rewritten, deleted }.
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { resanitizeApplicationAuditTrail } from '../src/modules/portal/public-audit.js';

const SELECTORS = ['id', 'company', 'label'] as const;
type Selector = (typeof SELECTORS)[number];

const USAGE =
  'usage: pnpm exec tsx scripts/resanitize-application.ts (--id <id> | --company "<name>" | --label <obfuscated_label>)';

function parseArgs(): { by: Selector; value: string } {
  const argv = process.argv.slice(2);
  const flags: Partial<Record<Selector, string>> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    for (const key of SELECTORS) {
      if (a === `--${key}` && argv[i + 1]) {
        flags[key] = argv[++i];
        break;
      }
      if (a.startsWith(`--${key}=`)) {
        flags[key] = a.slice(`--${key}=`.length);
        break;
      }
    }
  }
  const provided = SELECTORS.filter((k) => flags[k]);
  if (provided.length !== 1) {
    console.error(USAGE);
    if (provided.length > 1) {
      console.error(`  provide exactly one selector; got: ${provided.join(', ')}`);
    }
    process.exit(1);
  }
  const by = provided[0];
  return { by, value: flags[by] as string };
}

interface AppRow {
  id: string;
  company_name: string;
  public_state: string;
  obfuscated_label: string;
}

const sel = parseArgs();

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const where =
  sel.by === 'id'
    ? 'id = ?'
    : sel.by === 'label'
      ? 'obfuscated_label = ?'
      : 'lower(company_name) = lower(?)';
const candidates = db
  .prepare(`SELECT id, company_name, public_state, obfuscated_label FROM applications WHERE ${where}`)
  .all(sel.value) as AppRow[];

if (candidates.length === 0) {
  console.error(`No application matched --${sel.by} "${sel.value}" — nothing to resanitize.`);
  process.exit(1);
}
if (candidates.length > 1) {
  // Only --company can realistically be ambiguous (one company, several
  // roles). Surface the candidates and ask for the unique --id.
  console.error(`Ambiguous: ${candidates.length} applications matched --${sel.by} "${sel.value}". Re-run with --id:`);
  for (const c of candidates) {
    console.error(
      `  --id ${c.id}  (company="${c.company_name}", label=${c.obfuscated_label}, public_state=${c.public_state})`,
    );
  }
  process.exit(1);
}

const app = candidates[0];
const result = await resanitizeApplicationAuditTrail(db, app.id);
console.log(
  `Resanitized application ${app.id} (company="${app.company_name}", public_state=${app.public_state}, ` +
    `label=${app.obfuscated_label}): rewrote ${result.rewritten} row(s), deleted ${result.deleted} stale row(s).`,
);
