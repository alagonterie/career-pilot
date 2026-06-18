/**
 * Upgrade-marker CLI (STRATEGY.md §24.126). Sanctioned upgrade paths stamp the
 * marker on success; humans/agents run it manually to clear the boot tripwire
 * after a deliberate update.
 *
 *   pnpm exec tsx scripts/upgrade-state.ts set [via]   # stamp current code version
 *   pnpm exec tsx scripts/upgrade-state.ts get          # print the marker (or "none")
 *
 * `set` always stamps the running code version (the `via` arg is metadata only,
 * default "manual"); the deploy bootstrap calls `set bootstrap`.
 */
import { getCodeVersion, readUpgradeState, writeUpgradeState } from '../src/upgrade-state.js';

const cmd = process.argv[2];

if (cmd === 'set') {
  const via = process.argv[3] || 'manual';
  const state = writeUpgradeState(via);
  console.log(`Stamped upgrade marker: ${JSON.stringify(state)}`);
} else if (cmd === 'get') {
  const state = readUpgradeState();
  console.log(state ? JSON.stringify(state, null, 2) : `none (running code version ${getCodeVersion()})`);
} else {
  console.error('Usage: tsx scripts/upgrade-state.ts <set [via] | get>');
  process.exit(1);
}
