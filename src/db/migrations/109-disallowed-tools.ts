/**
 * Migration 109 — `container_configs.disallowed_tools` column.
 *
 * Per-group SDK-level tool removal. Adds a JSON-array TEXT column
 * holding tool names (in `mcp__<server>__<name>` form or SDK built-in
 * names) that should be removed from the agent's context via the
 * Agent SDK's `disallowedTools` option. Layered with the static
 * `SDK_DISALLOWED_TOOLS` list at provider construction time
 * (see container/agent-runner/src/providers/claude.ts).
 *
 * Default empty array — existing groups continue to behave as before.
 * The career-pilot-sandbox group's container_configs row gets the
 * `mcp__nanoclaw__create_gmail_draft` entry seeded by an init script
 * (see scripts/test/setup-test.ts) — sandbox visitors can't even see
 * the tool in their SDK context.
 *
 * Phase 2.3 task #86. The host-side group-folder check in
 * handleCreateGmailDraft stays as a defense-in-depth layer; SDK-level
 * removal is the primary mechanism, the action-handler refusal is the
 * backup.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration109: Migration = {
  version: 109,
  name: 'container-configs-disallowed-tools',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN disallowed_tools TEXT NOT NULL DEFAULT '[]'").run();
  },
};
