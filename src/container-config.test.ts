/**
 * Pure-function tests for `configFromDb` — verifies the
 * ContainerConfigRow → ContainerConfig transformation, especially the
 * Phase 2.3 `disallowed_tools` JSON-column parsing.
 *
 * `materializeContainerJson` itself isn't unit-tested here because it
 * touches the filesystem + DB; the round-trip is covered by the
 * agent-runner's config.ts (which reads back what we write).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyOrchestratorModel, configFromDb, type ContainerConfig } from './container-config.js';
import { closeDb, getDb, initTestDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { writePreference } from './modules/portal/knob-registry.js';
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
    const cfg = configFromDb(row({ disallowed_tools: '["mcp__nanoclaw__create_gmail_draft","Bash"]' }), TEST_GROUP);
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

describe('applyOrchestratorModel (§24.163 — pin the orchestrator from the group knob)', () => {
  function baseConfig(): ContainerConfig {
    return { mcpServers: {}, packages: { apt: [], npm: [] }, additionalMounts: [], skills: 'all' };
  }
  function group(folder: string): AgentGroup {
    return { id: 'ag-1', name: 'g', folder, agent_provider: null, created_at: '2026-05-27T00:00:00Z' };
  }

  beforeEach(() => {
    initTestDb();
    runMigrations(getDb());
  });
  afterEach(() => closeDb());

  it('owner group: pins config.model to owner_orchestrator_model (default Sonnet) + the aliases', () => {
    const cfg = baseConfig();
    applyOrchestratorModel(cfg, group('career-pilot'), getDb());
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5'); // internal summarize stays cheap
    expect(cfg.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6'); // backstop → orchestrator
    expect(cfg.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-sonnet-4-6'); // backstop → orchestrator (no surprise Opus)
  });

  it('honors an owner_orchestrator_model override (crank to Opus) without touching the Haiku internal', () => {
    writePreference(getDb(), 'owner_orchestrator_model', 'claude-opus-4-8');
    const cfg = baseConfig();
    applyOrchestratorModel(cfg, group('career-pilot'), getDb());
    expect(cfg.model).toBe('claude-opus-4-8');
    expect(cfg.env?.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('claude-opus-4-8');
    expect(cfg.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5');
  });

  it('sandbox group: pins config.model to sandbox_orchestrator_model (default Sonnet)', () => {
    const cfg = baseConfig();
    applyOrchestratorModel(cfg, group('career-pilot-sandbox'), getDb());
    expect(cfg.model).toBe('claude-sonnet-4-6');
    expect(cfg.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('claude-sonnet-4-6');
  });

  it('non-career-pilot group: no-op (leaves the DB-configured model untouched)', () => {
    const cfg = baseConfig();
    applyOrchestratorModel(cfg, group('some-other-group'), getDb());
    expect(cfg.model).toBeUndefined();
    expect(cfg.env).toBeUndefined();
  });

  it('preserves any pre-existing env', () => {
    const cfg = baseConfig();
    cfg.env = { FOO: 'bar' };
    applyOrchestratorModel(cfg, group('career-pilot'), getDb());
    expect(cfg.env?.FOO).toBe('bar');
    expect(cfg.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('claude-haiku-4-5');
  });
});
