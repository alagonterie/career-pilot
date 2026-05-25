/**
 * scripts/sync-shared-skills.ts
 *
 * Copies skill source from groups/_shared-skills/ into both agent groups
 * (career-pilot/ and career-pilot-sandbox/). Same skill instructions, but
 * each group's container_configs.allowedTools determines which MCP tools
 * are available at runtime.
 *
 * Runs on host startup and after any commit touching groups/_shared-skills/.
 * Idempotent. See STRATEGY.md §4 "Skill code: shared between owner & sandbox".
 *
 * Phase 0 status: PLACEHOLDER. Implementation lands in Phase 2 when the
 * actual skill content is written.
 */
async function main() {
  throw new Error(
    'sync-shared-skills: not yet implemented. Phase 0 scaffolding only. Track in STRATEGY.md §V Phase 2.',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
