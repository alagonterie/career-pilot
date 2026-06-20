/**
 * Register the public sandbox agent group + portal channel wiring.
 *
 * Sub-milestone 5.5a (STRATEGY.md §24.19). Idempotent — safe to re-run and
 * safe to call from scripts/test/setup-test.ts. Creates:
 *
 *   1. agent_groups row     folder='career-pilot-sandbox' (+ filesystem;
 *                           the committed CLAUDE.local.md persona is preserved)
 *   2. container_configs     disallowed_tools = every private career_pilot MCP
 *                           tool (Layer 1 of the §24.19 two-layer isolation;
 *                           Layer 2 is the host-side owner gate in
 *                           src/modules/career-pilot/index.ts)
 *   3. messaging_groups row  channel_type='portal', platform_id='sandbox',
 *                           unknown_sender_policy='public' (anonymous visitors)
 *   4. wiring               engage_mode='pattern'/'.', sender_scope='all',
 *                           session_mode='per-thread' (fresh session per run)
 *
 * The public abuse caps (Turnstile / DO per-IP+global $-cap / sandbox Portkey
 * budget) are deploy-phase and NOT_WIRED here; the simulator endpoint stays
 * internal until they land (see startSimulatorRun's checkSimulatorAllowed).
 *
 * Usage: pnpm exec tsx scripts/init-sandbox-group.ts
 */
import path from 'path';
import { fileURLToPath } from 'url';

import { SANDBOX_PLATFORM_ID } from '../src/channels/portal/adapter.js';
import { DATA_DIR } from '../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import { ensureContainerConfig, updateContainerConfigJson } from '../src/db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { initGroupFilesystem } from '../src/group-init.js';
import type { AgentGroup } from '../src/types.js';

export const SANDBOX_FOLDER = 'career-pilot-sandbox';
const SANDBOX_AGENT_NAME = 'Career Pilot (Sandbox)';

/**
 * The sandbox tool lockdown: the dangerous built-in tools (Bash/Write/Edit) plus
 * the private career_pilot MCP tools (SDK `mcp__<server>__<name>` form, server =
 * 'nanoclaw'). Removing them from the sandbox SDK context is Layer 1 of the
 * §24.19 isolation.
 *
 * For the PRIVATE MCP tools the list is best-effort — Layer 2 (the host-side
 * owner gate on every career_pilot action) is the robust catch-all, so a private
 * tool added later without updating this list is still unreachable.
 *
 * The BUILT-IN removals (Bash/Write/Edit) have NO Layer-2 equivalent, so they
 * MUST stay here (§24.141 S2-0). They gave a prompt-injected public visitor
 * arbitrary in-container code execution + a live path to the GCP metadata SA
 * token (a `curl` can set the required `Metadata-Flavor: Google` header that
 * WebFetch cannot). The simulator needs only WebSearch/WebFetch/Read to research
 * + draft text. Bare names are load-bearing under `bypassPermissions` (where
 * `allowedTools` is ignored — `disallowedTools` removes from context entirely).
 */
export const SANDBOX_DISALLOWED_TOOLS = [
  // Built-in tools that enable arbitrary code / filesystem writes (§24.141 S2-0).
  'Bash',
  'Write',
  'Edit',
  // career-pilot.ts
  'mcp__nanoclaw__update_profile_field',
  'mcp__nanoclaw__update_application',
  'mcp__nanoclaw__record_funnel_event',
  'mcp__nanoclaw__get_application',
  'mcp__nanoclaw__list_applications',
  'mcp__nanoclaw__record_progress',
  'mcp__nanoclaw__create_gmail_draft',
  // scrape-jobs.ts
  'mcp__nanoclaw__fetch_source',
  'mcp__nanoclaw__record_job_lead',
  'mcp__nanoclaw__query_job_leads',
  'mcp__nanoclaw__update_job_lead_status',
  'mcp__nanoclaw__discover_ats_board',
  'mcp__nanoclaw__rank_leads',
  'mcp__nanoclaw__query_killer_matches',
  'mcp__nanoclaw__close_stale_leads',
  // funnel-curator.ts
  'mcp__nanoclaw__query_gmail_delta',
  'mcp__nanoclaw__query_calendar_delta',
  'mcp__nanoclaw__persist_funnel_state',
  'mcp__nanoclaw__read_funnel_state',
  'mcp__nanoclaw__read_email_events',
];

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create-or-reconcile the sandbox group + portal wiring. Returns the agent
 * group. Assumes the DB connection is already initialized (getDb() works).
 */
export function ensureSandboxGroup(): AgentGroup {
  const now = new Date().toISOString();

  // 1. Agent group + filesystem (preserves the committed CLAUDE.local.md).
  let ag = getAgentGroupByFolder(SANDBOX_FOLDER);
  if (!ag) {
    createAgentGroup({
      id: generateId('ag'),
      name: SANDBOX_AGENT_NAME,
      folder: SANDBOX_FOLDER,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(SANDBOX_FOLDER)!;
  }
  initGroupFilesystem(ag);

  // 2. Container config — Layer 1 isolation. Always reconcile the disallow
  //    list so re-runs pick up additions to SANDBOX_DISALLOWED_TOOLS.
  ensureContainerConfig(ag.id);
  updateContainerConfigJson(ag.id, 'disallowed_tools', SANDBOX_DISALLOWED_TOOLS);

  // 3. Messaging group — public (anonymous visitors admitted by the access gate).
  let mg = getMessagingGroupByPlatform('portal', SANDBOX_PLATFORM_ID);
  if (!mg) {
    createMessagingGroup({
      id: generateId('mg'),
      channel_type: 'portal',
      platform_id: SANDBOX_PLATFORM_ID,
      name: 'Recruiter Simulator',
      is_group: 1,
      unknown_sender_policy: 'public',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform('portal', SANDBOX_PLATFORM_ID)!;
  }

  // 4. Wiring — always engage, any sender, fresh per-thread session per run.
  if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      priority: 0,
      created_at: now,
    });
  }

  return ag;
}

function main(): void {
  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db); // idempotent
  const ag = ensureSandboxGroup();
  console.log('Sandbox group ready.');
  console.log(`  agent:   ${ag.name} [${ag.id}] @ groups/${SANDBOX_FOLDER}`);
  console.log(`  channel: portal ${SANDBOX_PLATFORM_ID} (unknown_sender_policy=public, per-thread)`);
  console.log(
    `  isolation: ${SANDBOX_DISALLOWED_TOOLS.length} tools disallowed (Bash/Write/Edit + private MCP, Layer 1) + host owner gate (Layer 2)`,
  );
}

// Run as a script only (not when imported by setup-test.ts).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
