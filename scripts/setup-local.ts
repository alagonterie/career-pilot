/**
 * scripts/setup-local.ts — career-pilot local dev setup.
 *
 * Idempotent, interactive, friction-free. Works on Windows (WSL2), macOS, Linux.
 * See STRATEGY.md §16.3 for the full step list. This is the entry point users
 * invoke as `pnpm setup` (after the dependency-installing portion of
 * NanoClaw's stock `bash nanoclaw.sh` has been run for the first time).
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 1.
 *
 * The 10 steps it will do:
 *   1. Refuse to run if ENVIRONMENT=production or hostname matches prod VM.
 *   2. Check prerequisites (node 20+, pnpm 10+, docker, gh, wrangler).
 *   3. pnpm install at root + in frontend/.
 *   4. Initialize OneCLI dev vault (`career-pilot-dev` namespace).
 *   5. Start / verify Ollama container; pull llama3.2 model if missing.
 *   6. Run NanoClaw setup (interactive Telegram pairing for dev bot if not paired).
 *   7. Apply DB migrations on data/v2.dev.db.
 *   8. Build agent container image (skipped if image exists and container/ unchanged).
 *   9. Seed defaults from config/defaults.json into preferences and system_modes.
 *  10. Print "Next steps" pointing the user at `pnpm dev` and the frontend dev cmd.
 */
async function main() {
  throw new Error(
    'setup-local: not yet implemented. Phase 0 scaffolding only. Track in STRATEGY.md §V Phase 1.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
