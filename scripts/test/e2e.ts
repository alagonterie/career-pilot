#!/usr/bin/env tsx
/**
 * scripts/test/e2e.ts — Layer 4 end-to-end orchestrator.
 *
 * Drives the full host + container + Ollama pipeline as a single command:
 * pre-flight, reset, host spawn, scripted chat turn(s), assertions,
 * teardown. Validates that a real container actually wakes up, the agent
 * actually replies, and the `<message to="...">` parsing actually
 * round-trips through the CLI socket. Designed to be the smoke test
 * gating Phase 1 → Phase 2.
 *
 * Usage:
 *   pnpm test:e2e [--flow=smoke|onboarding|add-application|research-company-discovery] [--keep-host] [--no-reset]
 *
 * Flags:
 *   --flow=smoke            Default. Single turn, asserts non-empty reply.
 *   --flow=onboarding       Fresh DB (no seeded profile), asserts the
 *                           first reply mentions "name".
 *   --flow=add-application  Seeded profile. Asks the agent to bookmark a
 *                           role; asserts the applications table grew.
 *                           Phase 1 DoD per STRATEGY.md §V.
 *   --flow=research-company-discovery
 *                           Seeded profile. Asks the agent to research a
 *                           company; asserts container logs show a Task
 *                           tool_use with subagent_type=research-company.
 *                           Gates Phase 2 per STRATEGY.md §24.1.
 *   --keep-host             Leave `pnpm dev` running after the test for
 *                           manual probing. Default tears down.
 *   --no-reset              Skip the state wipe — useful for re-running
 *                           against an existing populated DB.
 *
 * Pre-requisites this script CHECKS for and bails on if missing:
 *   - Ollama daemon up + qwen3-coder:30b loaded (delegates to
 *     scripts/test/check-ollama.ts)
 *   - Docker Desktop running (`docker ps`)
 *   - `.env` file present (we don't validate contents — just existence)
 *
 * Pre-requisites this script does NOT check (and will fail late if missing):
 *   - OneCLI initialized — container-runner refuses to spawn without it.
 *     Run `pnpm setup` interactively first OR invoke the `/init-onecli`
 *     skill. The first chat turn will surface a clear OneCLI gateway
 *     error if this isn't done.
 *
 * Exit codes:
 *   0 — all assertions passed
 *   1 — assertion failed
 *   2 — pre-flight failed (Ollama/Docker/.env missing)
 *   3 — orchestrator-internal error (host didn't start, chat process hung)
 */
import { execSync, spawn, type ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import Database from 'better-sqlite3';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');
// Bypass pnpm.cmd / tsx.cmd entirely on Windows -- spawn() cannot launch
// .cmd files without shell: true (EINVAL), and shell: true creates quoting
// hazards. Calling `node tsx/dist/cli.mjs <script>` is portable and direct.
const NODE_BIN = process.execPath;
const TSX_CLI = path.join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const runTsx = (script: string, args: string[] = []): [string, string[]] => [
  NODE_BIN,
  [TSX_CLI, script, ...args],
];

// Strip ANSI escape sequences from a string so substring matching against
// log lines is reliable regardless of TTY color settings.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

type Flow = 'smoke' | 'onboarding' | 'add-application' | 'research-company-discovery';
const FLOWS: ReadonlySet<Flow> = new Set([
  'smoke',
  'onboarding',
  'add-application',
  'research-company-discovery',
]);
const FLOWS_NEEDING_SEED: ReadonlySet<Flow> = new Set([
  'smoke',
  'add-application',
  'research-company-discovery',
]);

interface Args {
  flow: Flow;
  keepHost: boolean;
  noReset: boolean;
}

function parseArgs(argv: string[]): Args {
  let flow: Flow = 'smoke';
  for (const a of argv) {
    if (a.startsWith('--flow=')) {
      const v = a.slice('--flow='.length) as Flow;
      if (!FLOWS.has(v)) {
        console.error(`unknown flow: ${v} (expected one of: ${[...FLOWS].join('|')})`);
        process.exit(2);
      }
      flow = v;
    }
  }
  return {
    flow,
    keepHost: argv.includes('--keep-host'),
    noReset: argv.includes('--no-reset'),
  };
}

function header(s: string): void {
  console.log(`\n=== ${s} ===`);
}

function ok(s: string): void {
  console.log(`  ✓ ${s}`);
}

function fail(s: string): never {
  console.error(`  ✗ ${s}`);
  process.exit(1);
}

function preflight(): void {
  header('Pre-flight');

  // 1. Ollama. Delegate to check-ollama.ts — it has the model logic + clear
  // remediation messages already. Inherits stdio so the user sees the
  // diagnostic if it fails.
  try {
    const [cmd, args] = runTsx(path.join(REPO_ROOT, 'scripts', 'test', 'check-ollama.ts'));
    execSync(`"${cmd}" ${args.map((a) => `"${a}"`).join(' ')}`, {
      stdio: 'inherit',
      cwd: REPO_ROOT,
    });
  } catch {
    console.error('  ✗ Ollama pre-flight failed (see above). Fix and retry.');
    process.exit(2);
  }

  // 2. Docker. `docker ps` exits non-zero if the daemon isn't reachable.
  try {
    execSync('docker ps --format "{{.ID}}"', { stdio: 'pipe', cwd: REPO_ROOT });
    ok('Docker Desktop reachable');
  } catch {
    console.error('  ✗ Docker not reachable. Start Docker Desktop and retry.');
    process.exit(2);
  }

  // 3. .env exists. We don't validate contents — under OLLAMA_TEST_MODE=1
  // the container doesn't need real Anthropic/Portkey keys, just the
  // OneCLI gateway vars which the setup wizard fills in.
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) {
    console.error(`  ✗ .env not found at ${envPath}. Copy .env.example and fill in values.`);
    process.exit(2);
  }
  ok('.env present');
}

async function resetAndSetup(seedProfile: boolean): Promise<void> {
  header(`Reset + setup${seedProfile ? ' (with seeded profile)' : ''}`);
  const extra = ['--reset'];
  if (seedProfile) extra.push('--seed-profile');
  const [cmd, args] = runTsx(path.join(REPO_ROOT, 'scripts', 'test', 'setup-test.ts'), extra);
  const r = spawn(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT });
  const code = await waitForExit(r);
  if (code !== 0) {
    console.error(`  ✗ setup-test.ts exited ${code}`);
    process.exit(3);
  }
}

function waitForExit(p: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (p.exitCode !== null) return resolve(p.exitCode);
    p.once('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)));
  });
}

interface HostHandle {
  proc: ChildProcess;
  stdout: string;
  stderr: string;
}

async function startHost(): Promise<HostHandle> {
  header('Spawning host (pnpm dev, OLLAMA_TEST_MODE=1)');

  const [hostCmd, hostArgs] = runTsx(path.join(REPO_ROOT, 'src', 'index.ts'));
  const handle: HostHandle = {
    proc: spawn(hostCmd, hostArgs, {
      cwd: REPO_ROOT,
      env: { ...process.env, OLLAMA_TEST_MODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
    stdout: '',
    stderr: '',
  };

  handle.proc.stdout?.on('data', (c: Buffer) => {
    const text = c.toString('utf8');
    handle.stdout += text;
    process.stdout.write(`  [host] ${text}`);
  });
  handle.proc.stderr?.on('data', (c: Buffer) => {
    const text = c.toString('utf8');
    handle.stderr += text;
    process.stderr.write(`  [host:err] ${text}`);
  });

  // Wait for the readiness sentinel ("NanoClaw running" on stdout) or for
  // the host to die. 60s ceiling — host startup includes circuit-breaker
  // backoff, DB migrations, container-runtime init.
  const READY_TIMEOUT_MS = 60_000;
  const start = Date.now();
  while (Date.now() - start < READY_TIMEOUT_MS) {
    if (handle.proc.exitCode !== null) {
      console.error(`  ✗ host exited ${handle.proc.exitCode} before becoming ready`);
      process.exit(3);
    }
    if (stripAnsi(handle.stdout).includes('NanoClaw running')) {
      ok('host ready');
      return handle;
    }
    await sleep(200);
  }
  console.error(`  ✗ host did not become ready within ${READY_TIMEOUT_MS}ms`);
  await teardownHost(handle);
  process.exit(3);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function teardownHost(h: HostHandle): Promise<void> {
  header('Teardown');
  // Ask politely first. The shutdown handler tears down channel adapters
  // (unlinks the CLI socket), stops polls, then process.exit(0).
  if (h.proc.exitCode === null) {
    h.proc.kill('SIGTERM');
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && h.proc.exitCode === null) {
      await sleep(100);
    }
    if (h.proc.exitCode === null) {
      console.warn('  ! host did not exit on SIGTERM; sending SIGKILL');
      h.proc.kill('SIGKILL');
    } else {
      ok(`host exited (code=${h.proc.exitCode})`);
    }
  }

  // Best-effort: capture logs from any container we spawned, then rip it
  // down. Logs help diagnose why a chat turn timed out — without this,
  // `docker rm -f` discards the only record of what the agent was doing.
  try {
    const ids = execSync(
      'docker ps -a --filter "name=nanoclaw-v2-career-pilot" --format "{{.ID}}"',
      { stdio: 'pipe' },
    )
      .toString()
      .trim()
      .split('\n')
      .filter(Boolean);
    for (const id of ids) {
      try {
        const logs = execSync(`docker logs --tail 80 ${id} 2>&1`, { stdio: 'pipe' }).toString();
        if (logs.trim()) {
          console.log(`\n  --- docker logs ${id} (last 80 lines) ---`);
          console.log(
            logs
              .split('\n')
              .map((l) => `  ${l}`)
              .join('\n'),
          );
          console.log(`  --- end docker logs ${id} ---\n`);
        }
      } catch {
        // logs may be unavailable; carry on
      }
      try {
        execSync(`docker rm -f ${id}`, { stdio: 'ignore' });
        ok(`removed container ${id}`);
      } catch {
        // ignore — already gone
      }
    }
  } catch {
    // docker may have stopped; nothing to clean
  }
}

// 300s default: container pull + skill mounts + qwen3-coder:30b warm-up
// + first-token latency can chain into a 2-3 minute first turn even on
// a 3090.
async function chatTurn(text: string, timeoutMs = 300_000): Promise<string> {
  console.log(`  > ${text}`);
  const [cmd, args] = runTsx(path.join(REPO_ROOT, 'scripts', 'chat.ts'), [text]);
  const proc = spawn(cmd, args, {
    cwd: REPO_ROOT,
    // Bump chat.ts's own timeout to match (subtract 10s buffer so chat.ts
    // exits cleanly with its diagnostic before we kill it).
    env: { ...process.env, NCL_CHAT_TIMEOUT_MS: String(timeoutMs - 10_000) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let out = '';
  let err = '';
  proc.stdout?.on('data', (c: Buffer) => {
    out += c.toString('utf8');
  });
  proc.stderr?.on('data', (c: Buffer) => {
    err += c.toString('utf8');
  });

  const timeoutHandle: { id: NodeJS.Timeout | null } = { id: null };
  const timeoutPromise = new Promise<'timeout'>((resolve) => {
    timeoutHandle.id = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  const result = await Promise.race([waitForExit(proc), timeoutPromise]);
  if (timeoutHandle.id) clearTimeout(timeoutHandle.id);

  if (result === 'timeout') {
    proc.kill('SIGKILL');
    throw new Error(`chat turn exceeded ${timeoutMs}ms without exit`);
  }
  if (result !== 0) {
    throw new Error(`chat turn exited ${result}\nstderr:\n${err}`);
  }
  const reply = out.trim();
  console.log(`  < ${reply.split('\n').map((l) => `  ${l}`).join('\n').trimStart()}`);
  return reply;
}

async function runSmoke(): Promise<void> {
  header('Flow: smoke');
  const reply = await chatTurn('hi');
  if (reply.length === 0) fail('reply was empty');
  if (reply.includes('<message')) fail('reply contains raw <message> tags — host parsing did not strip them');
  if (reply.includes('<internal')) fail('reply contains <internal> scratchpad — output protocol violated');
  ok('reply is non-empty and properly unwrapped');
}

async function runOnboarding(): Promise<void> {
  header('Flow: onboarding');
  // Without a seeded profile, the persona's onboarding-mode branch should
  // open with a prompt for full_name. We don't assert exact wording (the
  // LLM, especially under Ollama, won't be byte-stable), only that the
  // reply mentions "name" — the persona is explicit about asking for
  // full_name first.
  const first = await chatTurn('hello');
  if (!/name/i.test(first)) {
    fail(`first onboarding turn did not mention "name". Got:\n${first}`);
  }
  ok('first onboarding turn prompts for name');
}

async function runResearchCompanyDiscovery(): Promise<void> {
  header('Flow: research-company-discovery');
  // Per STRATEGY.md §24.1: gate Phase 2 by proving GLM-4.7-Flash, through
  // the Ollama Anthropic shim, can emit a `Task` tool_use block with
  // `subagent_type: "research-company"` -- i.e., that the SDK's subagent
  // delegation primitive round-trips through the local-LLM stack at all.
  //
  // Fallback hierarchy if this fails (prescribed, not negotiable):
  //   1. Prompt-tune the orchestrator persona to make Task invocation
  //      more explicit.
  //   2. Route the orchestrator to real Anthropic via LLM_PROVIDER
  //      (§16.2). Spend money to preserve the architecture.
  //   3. Never: orchestrator handles research inline. The five-subagent
  //      foundation is load-bearing for Phase 2.2-2.5.
  //
  // This is the DISCOVERY flow -- minimal assertion. The full DoD flow
  // (`--flow=research-company`) lands after the prompt body is fleshed
  // out and adds output-schema + citation assertions on top of this.
  //
  // 10-min timeout because the full subagent chain (Task delegation +
  // subagent's own WebSearch/WebFetch loop) takes longer than a typical
  // single-turn flow. The default 5-min cliff is set for smoke and
  // add-application; delegation flows need more headroom.
  const reply = await chatTurn('research anthropic for me', 600_000);
  if (reply.length === 0) fail('reply was empty');

  // Load-bearing signal: the session JSONL holds the full tool_use shape,
  // including `subagent_type`. Docker logs only show the agent-runner's
  // final result string, not the in-flight tool calls -- so JSONL is the
  // right place to assert on delegation.
  const jsonl = findLatestSessionJsonl();
  if (!jsonl) fail('no session JSONL found under data/v2-sessions/');

  const taskCall = findTaskDelegation(jsonl, 'research-company');
  if (!taskCall) {
    // Dump all tool calls so the mode-of-failure is visible: did the
    // model attempt research inline (WebSearch/WebFetch), did it call
    // a different subagent, or did it not tool-call at all?
    const allCalls = listAllToolCalls(jsonl);
    console.error('  --- all tool_use calls in this session ---');
    if (allCalls.length === 0) {
      console.error('  (no tool calls at all -- model bailed without using tools)');
    } else {
      for (const c of allCalls) console.error(`  ${c}`);
    }
    console.error('  --- end ---');
    fail(
      'no Task tool_use with subagent_type=research-company in session JSONL. ' +
        'Per STRATEGY.md §24.1 fallback: try prompt-tuning the persona first, then LLM_PROVIDER.',
    );
  }
  ok(`Task delegation to research-company subagent (input: ${JSON.stringify(taskCall.input).slice(0, 120)}...)`);
}

function findLatestSessionJsonl(): string | null {
  const sessionsDir = path.join(REPO_ROOT, 'data', 'v2-sessions');
  if (!fs.existsSync(sessionsDir)) return null;
  let latest: { path: string; mtime: number } | null = null;
  const walk = (dir: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const mtime = fs.statSync(full).mtimeMs;
        if (!latest || mtime > latest.mtime) latest = { path: full, mtime };
      }
    }
  };
  walk(sessionsDir);
  return latest ? (latest as { path: string; mtime: number }).path : null;
}

interface ToolUseBlock {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
}

function findTaskDelegation(jsonlPath: string, subagentType: string): ToolUseBlock | null {
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
  for (const line of lines) {
    let e: { type?: string; message?: { content?: unknown[] } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as ToolUseBlock;
      if (b.type === 'tool_use' && b.name === 'Task' && b.input?.subagent_type === subagentType) {
        return b;
      }
    }
  }
  return null;
}

function listAllToolCalls(jsonlPath: string): string[] {
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n');
  const calls: string[] = [];
  for (const line of lines) {
    let e: { type?: string; message?: { content?: unknown[] } };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      continue;
    }
    if (e.type !== 'assistant' || !Array.isArray(e.message?.content)) continue;
    for (const block of e.message.content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as ToolUseBlock;
      if (b.type === 'tool_use') {
        calls.push(`${b.name} ← ${JSON.stringify(b.input).slice(0, 140)}`);
      }
    }
  }
  return calls;
}

async function runAddApplication(): Promise<void> {
  header('Flow: add-application');
  // Phase 1 DoD per STRATEGY.md §V: "I can say 'add an application for X'
  // and it writes to the DB and confirms."
  //
  // The prompt names a fictional company + role so any LLM that tool-calls
  // sensibly should land an `update_application` UPSERT. The DB assertion
  // is the load-bearing check; we don't pin the agent's exact wording.
  const reply = await chatTurn(
    'Add an application for Acme Corp — Senior Backend Engineer role. Just bookmark it for now.',
  );
  if (reply.length === 0) fail('reply was empty');

  // Give WAL a beat to surface the host-side commit. better-sqlite3 in WAL
  // mode does see committed-but-uncheckpointed rows on a read connection,
  // but the system-action round-trip can lag the chat reply by a tick.
  await sleep(500);

  const row = assertApplicationRow(/acme/i);
  ok(
    `applications row written: company_name="${row.company_name}", role_title="${row.role_title}", status="${row.status}"`,
  );
}

interface ApplicationRow {
  id: string;
  company_name: string;
  role_title: string;
  status: string;
  obfuscated_label: string;
}

function assertApplicationRow(companyPattern: RegExp): ApplicationRow {
  const dbPath = path.join(REPO_ROOT, 'data', 'v2.db');
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .prepare(
        'SELECT id, company_name, role_title, status, obfuscated_label FROM applications',
      )
      .all() as ApplicationRow[];
    if (rows.length === 0) {
      fail('applications table is empty — agent did not call update_application');
    }
    const match = rows.find((r) => companyPattern.test(r.company_name));
    if (!match) {
      fail(
        `no applications row matched ${companyPattern}. Found: ${rows
          .map((r) => `${r.company_name}/${r.role_title}`)
          .join(', ')}`,
      );
    }
    return match;
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  preflight();

  if (!args.noReset) {
    // FLOWS_NEEDING_SEED skips onboarding mode by pre-populating
    // candidate_profile; everything else starts with a blank profile.
    await resetAndSetup(FLOWS_NEEDING_SEED.has(args.flow));
  }

  const host = await startHost();
  let assertionsPassed = false;
  try {
    // SCALING: Adding flows here is cheap up to ~5. Past that, the if/else
    // chain becomes awkward, flows want shared multi-step helpers, and
    // reading e2e.ts top-to-bottom stops working as a mental model. The
    // refactor target is then:
    //   scripts/test/flows/<name>.ts  — each flow exports an `async run()`
    //   scripts/test/e2e.ts           — keeps preflight/host/teardown,
    //                                   maps flow name → import().
    // Not before. Premature abstraction has its own cost.
    if (args.flow === 'smoke') await runSmoke();
    else if (args.flow === 'onboarding') await runOnboarding();
    else if (args.flow === 'add-application') await runAddApplication();
    else await runResearchCompanyDiscovery();
    assertionsPassed = true;
  } catch (err) {
    console.error(`  ✗ ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (!args.keepHost) {
      await teardownHost(host);
    } else {
      console.log('\n  (host left running per --keep-host; kill it with Ctrl-C in its terminal)');
    }
  }

  if (!assertionsPassed) process.exit(1);
  console.log('\n✓ E2E passed');
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(3);
});
