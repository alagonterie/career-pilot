#!/usr/bin/env tsx
/**
 * scripts/test/setup-test.ts — non-interactive test environment setup.
 *
 * Brings up just enough state for the E2E test orchestrator to drive a
 * real container spawn through the CLI channel. Mirrors what
 * `scripts/init-cli-agent.ts` does for the upstream "first agent" flow,
 * but with fixed values + a clean reset step so consecutive test runs
 * start from identical state.
 *
 * Usage:
 *   pnpm exec tsx scripts/test/setup-test.ts [--reset] [--seed-profile]
 *
 * Flags:
 *   --reset         Wipe data/v2.db + data/v2-sessions/ before init.
 *                   Default is incremental (re-applies missing rows only).
 *   --seed-profile  Pre-populate candidate_profile so tests can skip the
 *                   onboarding flow. Without it, the agent starts in
 *                   onboarding mode on the first turn.
 *
 * Prerequisites (this script does NOT install them):
 *   - OneCLI initialized — `pnpm setup` interactive wizard handles this.
 *     Without it, container spawn fails (the container-runner refuses).
 *   - Docker Desktop running — required for the container spawn that the
 *     E2E orchestrator triggers after setup completes.
 *
 * Sets up:
 *   1. Reset state if --reset (data/v2.db, sessions dir, container kills)
 *   2. Init central DB + run migrations
 *   3. Synthetic cli:local user (matches init-cli-agent.ts convention)
 *   4. career-pilot agent group + filesystem (CLAUDE.local.md, etc.)
 *   5. cli/local messaging group + wiring to career-pilot agent group
 *      (so `pnpm chat` lands in the right session)
 *   6. Optionally: seeded candidate_profile row
 *
 * Idempotent. Running twice is a no-op (or just re-seeds the profile).
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../../src/config.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../src/db/agent-groups.js';
import { closeDb, getDb, initDb } from '../../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../src/db/messaging-groups.js';
import { runMigrations } from '../../src/db/migrations/index.js';
import { initGroupFilesystem } from '../../src/group-init.js';
import { upsertUser } from '../../src/modules/permissions/db/users.js';
import { ensureSandboxGroup, SANDBOX_FOLDER } from '../init-sandbox-group.js';
import type { AgentGroup, MessagingGroup } from '../../src/types.js';

const CLI_CHANNEL = 'cli';
const CLI_PLATFORM_ID = 'local';
const CLI_USER_ID = `${CLI_CHANNEL}:${CLI_PLATFORM_ID}`;
const FOLDER = 'career-pilot';
const AGENT_NAME = 'Career Pilot';
const DISPLAY_NAME = 'Test Operator';

interface Args {
  reset: boolean;
  seedProfile: boolean;
}

function parseArgs(argv: string[]): Args {
  return {
    reset: argv.includes('--reset'),
    seedProfile: argv.includes('--seed-profile'),
  };
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resetState(): void {
  // Kill any nanoclaw-v2-career-pilot containers (best-effort; ignore errors
  // — they might not exist, and we don't want a missing docker binary or
  // empty result to halt the setup).
  try {
    execSync('docker ps --filter "name=nanoclaw-v2-career-pilot" --format "{{.ID}}"', {
      stdio: 'pipe',
    })
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean)
      .forEach((id) => {
        try {
          execSync(`docker rm -f ${id}`, { stdio: 'ignore' });
          console.log(`  killed container ${id}`);
        } catch {
          /* already gone */
        }
      });
  } catch {
    /* docker not running or no containers — fine */
  }

  const dbPath = path.join(DATA_DIR, 'v2.db');
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const p = `${dbPath}${suffix}`;
    if (fs.existsSync(p)) {
      try {
        fs.unlinkSync(p);
        console.log(`  removed ${path.relative(process.cwd(), p)}`);
      } catch (err) {
        console.warn(`  could not remove ${p}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  const sessionsDir = path.join(DATA_DIR, 'v2-sessions');
  if (fs.existsSync(sessionsDir)) {
    try {
      fs.rmSync(sessionsDir, { recursive: true, force: true });
      console.log(`  removed data/v2-sessions/`);
    } catch (err) {
      console.warn(
        `  could not remove sessions dir: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Reset the circuit breaker so the next host start doesn't add backoff
  // from prior failed attempts. In a test loop these are not real crashes —
  // they're iterative debugging.
  const cbPath = path.join(DATA_DIR, 'circuit-breaker.json');
  if (fs.existsSync(cbPath)) {
    try {
      fs.unlinkSync(cbPath);
      console.log('  removed data/circuit-breaker.json');
    } catch (err) {
      console.warn(
        `  could not remove circuit-breaker.json: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  console.log('  reset complete');
}

function ensureAgentGroup(): AgentGroup {
  const now = new Date().toISOString();
  const existing = getAgentGroupByFolder(FOLDER);
  if (existing) {
    console.log(`  agent group exists: ${existing.id} (${FOLDER})`);
    return existing;
  }
  const id = genId('ag');
  createAgentGroup({ id, name: AGENT_NAME, folder: FOLDER, agent_provider: null, created_at: now });
  const ag = getAgentGroupByFolder(FOLDER)!;
  console.log(`  created agent group: ${ag.id} (${FOLDER})`);
  return ag;
}

function ensureCliWiring(ag: AgentGroup): void {
  const now = new Date().toISOString();
  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform(CLI_CHANNEL, CLI_PLATFORM_ID);
  if (!mg) {
    mg = {
      id: genId('mg'),
      channel_type: CLI_CHANNEL,
      platform_id: CLI_PLATFORM_ID,
      name: 'Local CLI (test)',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: now,
    };
    createMessagingGroup(mg);
    console.log(`  created CLI messaging group: ${mg.id}`);
  }

  if (!getMessagingGroupAgentByPair(mg.id, ag.id)) {
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: 'pattern',
      engage_pattern: '.', // engage on every CLI message
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    console.log(`  wired cli:${CLI_PLATFORM_ID} -> ${FOLDER}`);
  }
}

function seedCandidateProfile(): void {
  const now = new Date().toISOString();
  const db = getDb();

  // Skip if a profile row already exists — let the operator decide whether
  // to wipe via --reset rather than silently overwriting their state.
  const existing = db.prepare('SELECT id FROM candidate_profile WHERE id = 1').get();
  if (existing) {
    console.log('  candidate_profile row exists; skipping (use --reset to start fresh)');
    return;
  }

  // Seeded profile is intentionally a believable senior generalist
  // engineer — broad enough that the scrape-jobs subagent finds at least
  // one matching role across live Greenhouse + Lever boards on most days.
  // Architecturally, the production strict pre-record judgment stays
  // unchanged; widening the test profile is the e2e-determinism
  // remediation called out in STRATEGY.md §24.5 issue #3 option (a).
  db.prepare(
    `INSERT INTO candidate_profile (
       id, full_name, display_name, bio, target_roles, location_pref, comp_floor,
       master_resume, skills, github_url, linkedin_url, gmail_account, updated_at
     ) VALUES (
       1, 'Test Candidate', 'Test', 'Senior engineer for E2E test scenarios.',
       '["Staff Backend Engineer", "Senior Backend Engineer", "Platform Engineer", "Senior Software Engineer", "Software Engineer", "Staff Engineer", "Engineering Manager"]',
       '{"remote": true, "hybrid_cities": ["NYC", "San Francisco", "New York"]}',
       180000,
       '## Experience\n\n- Built things',
       '["Go", "Rust", "Python", "TypeScript", "Java", "PostgreSQL", "Kubernetes", "Docker", "AWS", "Distributed Systems", "API"]',
       'https://github.com/test', 'https://linkedin.com/in/test',
       'test-candidate@example.com',
       @now
     )`,
  ).run({ now });
  console.log('  seeded candidate_profile (id=1, full_name="Test Candidate")');
}

async function main(): Promise<void> {
  if (process.env.ENVIRONMENT === 'production') {
    console.error('setup-test: refusing to run in production');
    process.exit(2);
  }

  const args = parseArgs(process.argv.slice(2));

  if (args.reset) {
    console.log('Reset:');
    resetState();
  }

  console.log('Setup:');
  const dbPath = path.join(DATA_DIR, 'v2.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = initDb(dbPath);
  runMigrations(db);

  upsertUser({
    id: CLI_USER_ID,
    kind: CLI_CHANNEL,
    display_name: DISPLAY_NAME,
    created_at: new Date().toISOString(),
  });

  const ag = ensureAgentGroup();
  initGroupFilesystem(ag);
  ensureCliWiring(ag);

  // Public sandbox group + portal channel wiring (Sub-milestone 5.5a) so the
  // simulator path is exercisable in e2e. Idempotent.
  const sandbox = ensureSandboxGroup();
  console.log(`  sandbox group ready: ${sandbox.id} (${SANDBOX_FOLDER}) + portal/sandbox wiring`);

  if (args.seedProfile) {
    seedCandidateProfile();
  }

  closeDb();

  console.log('');
  console.log('Ready. Next:');
  console.log('  1. Start the host:    pnpm dev');
  console.log('  2. Send a message:    pnpm chat "hey"');
  console.log('  3. Or run the E2E:    pnpm test:e2e   (once available)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
