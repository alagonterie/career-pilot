/**
 * scripts/cleanup-onecli-agents.ts — prune stale OneCLI agents from e2e runs.
 *
 * Each `pnpm test:e2e` run with `--reset` creates a fresh agent group in
 * data/v2.db (id `ag-<ms>-<6char>`) and a matching OneCLI agent so the
 * vault knows where to inject credentials. The reset wipes v2.db but
 * leaves the OneCLI agent behind — so the OneCLI vault accumulates one
 * stale "Career Pilot" agent per e2e run. After dozens of runs the list
 * gets noisy and OAuth scope assignments drift away from any live group.
 *
 * This script reconciles the two surfaces:
 *   1. List OneCLI agents named "Career Pilot" (or matching the
 *      ag-<digits>-<6char> identifier shape — defensive against rename).
 *   2. Cross-reference against agent_groups.id in data/v2.db.
 *   3. Any OneCLI agent whose identifier is NOT present in the central
 *      DB is stale — print it (dry-run default) or delete it (`--apply`).
 *   4. Default agents and any agent with isDefault=true are never touched.
 *
 * Usage:
 *   pnpm exec tsx scripts/cleanup-onecli-agents.ts            # dry-run, lists what would be deleted
 *   pnpm exec tsx scripts/cleanup-onecli-agents.ts --apply    # deletes for real
 *   pnpm exec tsx scripts/cleanup-onecli-agents.ts --keep-latest=2 [--apply]
 *                                                             # additionally keep the N most-recently-created stale agents
 *                                                             # (useful when iterating — preserves the previous run for diffing)
 *
 * Exit codes:
 *   0 — completed (whether anything was deleted or not)
 *   1 — usage / unexpected argument
 *   2 — OneCLI not reachable or the agent list returned a non-JSON shape
 */
import { execSync } from 'child_process';
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR } from '../src/config.js';

interface OneCliAgent {
  id: string;
  name: string;
  identifier: string;
  isDefault: boolean;
  createdAt: string;
}

interface Args {
  apply: boolean;
  keepLatest: number;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const args: Args = { apply: false, keepLatest: 0 };
  for (const a of argv) {
    if (a === '--apply') args.apply = true;
    else if (a.startsWith('--keep-latest=')) {
      const n = parseInt(a.slice('--keep-latest='.length), 10);
      if (!Number.isFinite(n) || n < 0) {
        console.error(`invalid --keep-latest value: ${a}`);
        process.exit(1);
      }
      args.keepLatest = n;
    } else {
      console.error(`unknown argument: ${a}`);
      console.error('usage: pnpm exec tsx scripts/cleanup-onecli-agents.ts [--apply] [--keep-latest=N]');
      process.exit(1);
    }
  }
  return args;
}

function listAgents(): OneCliAgent[] {
  let raw: string;
  try {
    raw = execSync('onecli agents list', { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (err) {
    console.error('failed to invoke `onecli agents list` — is the OneCLI gateway running?');
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    console.error('onecli agents list returned non-JSON output:');
    console.error(raw);
    process.exit(2);
  }
  const data = (parsed as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    console.error('onecli agents list response had no `data` array; raw:');
    console.error(raw);
    process.exit(2);
  }
  return data as OneCliAgent[];
}

function liveAgentGroupIds(): Set<string> {
  const dbPath = path.join(DATA_DIR, 'v2.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT id FROM agent_groups').all() as Array<{ id: string }>;
    return new Set(rows.map((r) => r.id));
  } finally {
    db.close();
  }
}

// Catches both the explicit name match and the identifier-shape match,
// in case someone renames a Career Pilot agent in the OneCLI UI.
const AG_ID_SHAPE = /^ag-\d{10,}-[a-z0-9]{6}$/;
function isCareerPilotAgent(a: OneCliAgent): boolean {
  return a.name === 'Career Pilot' || AG_ID_SHAPE.test(a.identifier);
}

const args = parseArgs();
const allAgents = listAgents();
const live = liveAgentGroupIds();

const candidates = allAgents.filter(
  (a) => !a.isDefault && isCareerPilotAgent(a) && !live.has(a.identifier),
);

if (candidates.length === 0) {
  console.log('No stale Career Pilot agents found in OneCLI vault.');
  console.log(`  (${allAgents.length} OneCLI agents total; ${live.size} live agent_groups in v2.db)`);
  process.exit(0);
}

// Sort oldest-first so --keep-latest preserves the N newest.
candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
const keep = args.keepLatest > 0 ? candidates.slice(-args.keepLatest) : [];
const toDelete = candidates.filter((a) => !keep.includes(a));

console.log(`Found ${candidates.length} stale Career Pilot agent(s):`);
for (const a of candidates) {
  const note = keep.includes(a) ? '  KEEP (covered by --keep-latest)' : '';
  console.log(`  ${a.createdAt}  ${a.identifier}  id=${a.id}${note}`);
}

if (toDelete.length === 0) {
  console.log('\nNothing to delete after applying --keep-latest.');
  process.exit(0);
}

if (!args.apply) {
  console.log(`\nDry run — would delete ${toDelete.length} agent(s). Re-run with --apply to execute.`);
  process.exit(0);
}

console.log(`\nDeleting ${toDelete.length} agent(s)...`);
let deleted = 0;
let failed = 0;
for (const a of toDelete) {
  try {
    execSync(`onecli agents delete --id ${a.id}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    console.log(`  ✓ ${a.id} (${a.identifier})`);
    deleted++;
  } catch (err) {
    console.error(`  ✗ ${a.id} (${a.identifier}): ${err instanceof Error ? err.message : String(err)}`);
    failed++;
  }
}

console.log(`\nDone. Deleted ${deleted}, failed ${failed}.`);
process.exit(failed > 0 ? 1 : 0);
