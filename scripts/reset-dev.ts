/**
 * scripts/reset-dev.ts — reset career-pilot dev environment to clean state.
 *
 * Critical for testing the NanoClaw onboarding/bootstrap flow. SAFETY-GUARDED
 * against running in production. See STRATEGY.md §16.5 + RECOVERY.md §7.
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 1.
 *
 * What it will do (interactive — confirms each step):
 *   1. Kill all running career-pilot agent containers
 *   2. Stop the local host process (NanoClaw + frontend dev server)
 *   3. Wipe data/v2.dev.db and all session JSONLs under dev paths
 *   4. Clear OneCLI `career-pilot-dev` vault entries (NOT production namespace)
 *   5. Re-apply migrations on a fresh dev DB
 *   6. Preserve: dev Telegram bot pairing, .env, installed deps, container image
 *   7. Print "Ready — send /start to your dev bot to re-bootstrap"
 *
 * Recovery time: ~30 seconds. Full onboarding re-cycle via Telegram: ~5 min.
 */
async function main() {
  if (process.env.ENVIRONMENT === 'production') {
    throw new Error('reset-dev: refusing to run in production');
  }
  throw new Error(
    'reset-dev: not yet implemented. Phase 0 scaffolding only. Track in STRATEGY.md §V Phase 1.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
