#!/usr/bin/env tsx
/**
 * scripts/health-check.ts — the on-box health CLI (STRATEGY.md §24.68).
 *
 * One command replaces the schema archaeology: every §24.66-class failure
 * shape (stale due pending rows, dead recurrence chains, orphan responses,
 * outbound backlog, auth-failure streaks, stale surfaces) plus a LIVE Gmail
 * token / OneCLI gateway probe. Each non-ok finding prints a concrete
 * `next_step` — the report IS the runbook.
 *
 * Usage:
 *   pnpm health              human-readable report
 *   pnpm health --json       machine-readable (for Claude sessions / tooling)
 *   pnpm health --no-live    skip the live Gmail/gateway probe
 *
 * Exit codes: 0 = no criticals; 2 = at least one critical finding.
 *
 * Read-only stance: opens the existing central DB, never runs migrations
 * (a missing request_telemetry table degrades to a warn finding).
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { exitCodeForReport, runHealthChecks, type HealthFinding } from '../src/modules/career-pilot/health.js';

const SEVERITY_ICON: Record<HealthFinding['severity'], string> = { ok: '✓', warn: '⚠', critical: '✗' };
const SEVERITY_RANK: Record<HealthFinding['severity'], number> = { critical: 0, warn: 1, ok: 2 };

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const asJson = args.has('--json');
  const skipLiveProbes = args.has('--no-live');

  initDb(path.join(DATA_DIR, 'v2.db'));
  const report = await runHealthChecks({ skipLiveProbes });

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    const sorted = [...report.findings].sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
    console.log(`career-pilot health — ${report.ranAt}${skipLiveProbes ? ' (live probes skipped)' : ''}\n`);
    for (const f of sorted) {
      console.log(`${SEVERITY_ICON[f.severity]} [${f.severity.toUpperCase()}] ${f.title}`);
      if (f.detail) console.log(`    ${f.detail}`);
      if (f.next_step) console.log(`    → ${f.next_step}`);
    }
    const criticals = report.findings.filter((f) => f.severity === 'critical').length;
    const warns = report.findings.filter((f) => f.severity === 'warn').length;
    console.log(`\n${criticals} critical, ${warns} warning(s).`);
  }

  process.exit(exitCodeForReport(report));
}

void main();
