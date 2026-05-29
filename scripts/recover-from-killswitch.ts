/**
 * scripts/recover-from-killswitch.ts — manual recovery from /killswitch.
 *
 * Sub-milestone 5.4b (STRATEGY.md §24.18; RECOVERY.md §3). Clears the killswitch
 * flag and returns the system to SHADOW mode (pause_state='active' +
 * live_mode=false) via the host's `clearKillswitch()` primitive — the same code
 * path a future automated recovery would use, kept in TS so it's testable.
 *
 * Deliberately a host-side script, NOT an agent-reachable action: re-enabling a
 * halted system must never sit in the agent's SDK context. Modeled on
 * scripts/resanitize-application.ts.
 *
 * What it does NOT do (manual, NOT_WIRED until deploy — see killswitch-external.ts):
 *   - re-issue OneCLI agent tokens
 *   - restore the Portkey AI-Provider budget
 *   - restart the host service
 * It prints those as remaining steps. live_mode stays false — the operator
 * re-enables live mode deliberately after observation.
 *
 * Usage:  pnpm exec tsx scripts/recover-from-killswitch.ts
 */
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { clearKillswitch } from '../src/modules/portal/kill-switch.js';
import { getSystemStatus } from '../src/modules/portal/system-modes.js';

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const before = getSystemStatus();
console.log(`Current state: pause_state=${before.pause_state}, live_mode=${before.live_mode}`);

clearKillswitch('operator:recover-script');

const after = getSystemStatus();
console.log(`Cleared. New state: pause_state=${after.pause_state}, live_mode=${after.live_mode} (shadow).`);
console.log('');
console.log('MANUAL steps still required (NOT_WIRED — see RECOVERY.md §3):');
console.log('  1. Rotate/re-issue the OneCLI agent tokens for career-pilot + career-pilot-sandbox.');
console.log('  2. Restore the Portkey AI-Provider budget to its configured value.');
console.log('  3. Restart the host service so containers re-spawn on the next message.');
console.log('');
console.log('System is in SHADOW mode. Re-enable live mode deliberately after observation.');
