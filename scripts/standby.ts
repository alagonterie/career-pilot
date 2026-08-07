/**
 * scripts/standby.ts — the box-side standby steps (STRATEGY.md §24.189).
 *
 * Run by `.github/workflows/standby.yml` over IAP SSH, on either side of the VM
 * stop/start. Deliberately a host-side script, never an agent-reachable action:
 * taking the system down and bringing it back must not sit in the agent's SDK
 * context (same rule as scripts/recover-from-killswitch.ts).
 *
 *   enter  — halt the host so nothing is mid-flight when the VM stops. Kills
 *            running containers and blocks new spawns; recurrence chains stop
 *            advancing (they defer, they don't drop).
 *   exit   — roll overdue proactive rows forward to their next occurrence, THEN
 *            resume. Order matters: resuming first would let the sweep fire the
 *            whole overdue pile in the seconds before we could reschedule it.
 *
 * Usage:  pnpm exec tsx scripts/standby.ts <enter|exit>
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../src/config.js';
import { initDb } from '../src/db/connection.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { getActiveSessions } from '../src/db/sessions.js';
import { openInboundDb } from '../src/db/session-db.js';
import { prepareResume } from '../src/modules/career-pilot/standby.js';
import { executeControlCommand } from '../src/modules/portal/kill-switch.js';
import { getSystemStatus } from '../src/modules/portal/system-modes.js';
import { inboundDbPath } from '../src/session-manager.js';

const op = process.argv[2];
if (op !== 'enter' && op !== 'exit') {
  console.error('usage: pnpm exec tsx scripts/standby.ts <enter|exit>');
  process.exit(2);
}

const db = initDb(path.join(DATA_DIR, 'v2.db'));
runMigrations(db);

const before = getSystemStatus();
console.log(`Current state: pause_state=${before.pause_state}, live_mode=${before.live_mode}`);

if (op === 'enter') {
  // /halt (not /pause): standby stops the VM, so leaving reactive wakes enabled
  // would just mean containers spawning into a machine about to power off.
  const out = executeControlCommand('/halt', 'standby: entering', 'standby');
  console.log(`Halted. Killed ${out.killed} running container(s); pause_state=${out.state}.`);
  console.log('Safe to stop the VM.');
} else {
  if (before.pause_state === 'killswitch') {
    // The killswitch is deliberately manual-recovery-only (RECOVERY.md §3); a
    // standby resume must not quietly clear it.
    console.error('REFUSING: pause_state=killswitch. Recover with scripts/recover-from-killswitch.ts first.');
    process.exit(1);
  }

  // Scheduled work lives in the PER-SESSION inbound DBs, not the central v2.db —
  // so the roll-forward sweeps every active session's queue.
  const totals = { rescheduled: 0, oneShotsLeft: 0, unparseable: 0 };
  for (const session of getActiveSessions()) {
    const inPath = inboundDbPath(session.agent_group_id, session.id);
    if (!fs.existsSync(inPath)) continue;
    const inDb = openInboundDb(inPath);
    try {
      const prep = await prepareResume(inDb);
      totals.rescheduled += prep.rescheduled;
      totals.oneShotsLeft += prep.oneShotsLeft;
      totals.unparseable += prep.unparseable;
    } finally {
      inDb.close();
    }
  }
  console.log(
    `Resume hygiene: ${totals.rescheduled} recurring row(s) rolled forward` +
      `, ${totals.oneShotsLeft} overdue one-shot(s) left as-is` +
      `, ${totals.unparseable} unparseable.`,
  );

  const out = executeControlCommand('/resume', null, 'standby');
  console.log(`Resumed. pause_state=${out.state}.`);
}

const after = getSystemStatus();
console.log(`New state: pause_state=${after.pause_state}, live_mode=${after.live_mode}`);
