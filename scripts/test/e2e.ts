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
 *   pnpm test:e2e [--flow=smoke|onboarding] [--keep-host] [--no-reset]
 *
 * Flags:
 *   --flow=smoke         Default. Single turn, asserts non-empty reply.
 *   --flow=onboarding    Multi-turn onboarding sequence (uses fresh DB,
 *                        no seeded profile).
 *   --keep-host          Leave `pnpm dev` running after the test for
 *                        manual probing. Default tears down.
 *   --no-reset           Skip the state wipe — useful for re-running
 *                        against an existing populated DB.
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

interface Args {
  flow: 'smoke' | 'onboarding';
  keepHost: boolean;
  noReset: boolean;
}

function parseArgs(argv: string[]): Args {
  let flow: Args['flow'] = 'smoke';
  for (const a of argv) {
    if (a === '--flow=smoke') flow = 'smoke';
    else if (a === '--flow=onboarding') flow = 'onboarding';
    else if (a.startsWith('--flow=')) {
      console.error(`unknown flow: ${a.slice('--flow='.length)} (expected smoke|onboarding)`);
      process.exit(2);
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

  // Best-effort: rip down any container we spawned. Match by name prefix.
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

async function chatTurn(text: string, timeoutMs = 180_000): Promise<string> {
  console.log(`  > ${text}`);
  const [cmd, args] = runTsx(path.join(REPO_ROOT, 'scripts', 'chat.ts'), [text]);
  const proc = spawn(cmd, args, {
    cwd: REPO_ROOT,
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  preflight();

  if (!args.noReset) {
    // smoke flow uses a seeded profile so the persona is in normal mode;
    // onboarding flow needs a blank profile so the persona enters
    // onboarding mode on first turn.
    await resetAndSetup(args.flow === 'smoke');
  }

  const host = await startHost();
  let assertionsPassed = false;
  try {
    if (args.flow === 'smoke') await runSmoke();
    else await runOnboarding();
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
