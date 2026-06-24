/**
 * scripts/relabel-application.ts — operator escape hatch to re-categorize an
 * application's public company handle. Complements resanitize-application.ts.
 *
 * `obfuscated_label` is immutable through the MCP `update_application` handler,
 * so an app that landed with the wrong handle — e.g. a quick "I applied to X"
 * add that fell back to `misc-<letter>` because the agent omitted
 * `jd_analyzed.role_category` — is corrected here. This sets the new label (and,
 * with `--category`, `jd_analyzed.role_category` so future re-derives agree),
 * re-sanitizes the `public_audit_trail`, refreshes the public pipeline
 * read-model, and re-scores win-confidence so the board reflects the change
 * immediately rather than waiting for the next pipeline-scribe pass.
 *
 * Deliberately a host-side operator script (like resanitize-application.ts), NOT
 * an MCP tool — rewriting the public surface must never sit in the agent's SDK
 * context. Safe to run while the host is up; opens its own connection.
 *
 * Usage:
 *   pnpm exec tsx scripts/relabel-application.ts --id <id> --label <new-label> [--category <industry>]
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { scoreWinConfidence } from '../src/modules/career-pilot/win-confidence.js';
import { resanitizeApplicationAuditTrail } from '../src/modules/portal/public-audit.js';
import { upsertPublicPipelineView } from '../src/modules/portal/public-pipeline-view.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = arg('id');
const label = arg('label');
const category = arg('category');
if (!id || !label) {
  console.error(
    'usage: pnpm exec tsx scripts/relabel-application.ts --id <id> --label <new-label> [--category <industry>]',
  );
  process.exit(1);
}

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const existing = db.prepare('SELECT id, obfuscated_label FROM applications WHERE id = ?').get(id) as
  | { id: string; obfuscated_label: string }
  | undefined;
if (!existing) {
  console.error(`No application with id "${id}".`);
  process.exit(1);
}
const taken = db.prepare('SELECT id FROM applications WHERE obfuscated_label = ? AND id <> ?').get(label, id) as
  | { id: string }
  | undefined;
if (taken) {
  console.error(`Label "${label}" is already used by ${taken.id} — pick a free one.`);
  process.exit(1);
}

if (category) {
  db.prepare('UPDATE applications SET obfuscated_label = ?, jd_analyzed = ? WHERE id = ?').run(
    label,
    JSON.stringify({ role_category: category }),
    id,
  );
} else {
  db.prepare('UPDATE applications SET obfuscated_label = ? WHERE id = ?').run(label, id);
}
console.log(`Relabeled ${id}: ${existing.obfuscated_label} -> ${label}${category ? ` (role_category=${category})` : ''}`);

const res = await resanitizeApplicationAuditTrail(db, id);
console.log(`Re-sanitized audit trail: rewrote ${res.rewritten}, deleted ${res.deleted}.`);
upsertPublicPipelineView(db, id);
console.log('Refreshed the public pipeline read-model.');
const wc = await scoreWinConfidence(db);
console.log(`Re-scored win-confidence: ${wc.scored} active, ${wc.closed} closed.`);
