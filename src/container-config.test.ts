/**
 * Pure-function tests for `configFromDb` — verifies the
 * ContainerConfigRow → ContainerConfig transformation, especially the
 * Phase 2.3 `disallowed_tools` JSON-column parsing.
 *
 * `materializeContainerJson` itself isn't unit-tested here because it
 * touches the filesystem + DB; the round-trip is covered by the
 * agent-runner's config.ts (which reads back what we write).
 */
import { describe, expect, it } from 'vitest';

import { configFromDb } from './container-config.js';
import type { AgentGroup, ContainerConfigRow } from './types.js';

function row(overrides: Partial<ContainerConfigRow> = {}): ContainerConfigRow {
  return {
    agent_group_id: 'ag-1',
    provider: null,
    model: null,
    effort: null,
    image_tag: null,
    assistant_name: null,
    max_messages_per_prompt: null,
    skills: '"all"',
    mcp_servers: '{}',
    packages_apt: '[]',
    packages_npm: '[]',
    additional_mounts: '[]',
    cli_scope: 'group',
    disallowed_tools: '[]',
    updated_at: '2026-05-27T00:00:00Z',
    ...overrides,
  };
}

const TEST_GROUP: AgentGroup = {
  id: 'ag-1',
  name: 'Test',
  folder: 'test',
  agent_provider: null,
  created_at: '2026-05-27T00:00:00Z',
};

describe('configFromDb — disallowedTools', () => {
  it('returns undefined when the column is an empty array (the default)', () => {
    const cfg = configFromDb(row({ disallowed_tools: '[]' }), TEST_GROUP);
    expect(cfg.disallowedTools).toBeUndefined();
  });

  it('parses a populated disallowed_tools array', () => {
    const cfg = configFromDb(
      row({ disallowed_tools: '["mcp__nanoclaw__create_gmail_draft","Bash"]' }),
      TEST_GROUP,
    );
    expect(cfg.disallowedTools).toEqual(['mcp__nanoclaw__create_gmail_draft', 'Bash']);
  });

  it('returns undefined when the column has malformed JSON', () => {
    const cfg = configFromDb(row({ disallowed_tools: 'not json [' }), TEST_GROUP);
    expect(cfg.disallowedTools).toBeUndefined();
  });

  it('returns undefined when the JSON parses to a non-array', () => {
    const cfg = configFromDb(row({ disallowed_tools: '{"foo":"bar"}' }), TEST_GROUP);
    expect(cfg.disallowedTools).toBeUndefined();
  });

  it('filters non-string entries from the array', () => {
    const cfg = configFromDb(
      row({ disallowed_tools: '["mcp__nanoclaw__x", 42, null, "mcp__nanoclaw__y"]' }),
      TEST_GROUP,
    );
    expect(cfg.disallowedTools).toEqual(['mcp__nanoclaw__x', 'mcp__nanoclaw__y']);
  });

  it('returns undefined when filtering leaves an empty array', () => {
    const cfg = configFromDb(row({ disallowed_tools: '[42, null, true]' }), TEST_GROUP);
    expect(cfg.disallowedTools).toBeUndefined();
  });
});
