import { describe, expect, it } from 'vitest';

import { buildClaudeContainerEnv } from './claude.js';

describe('buildClaudeContainerEnv', () => {
  it('contributes nothing when no custom endpoint is configured', () => {
    expect(buildClaudeContainerEnv({})).toEqual({});
    expect(buildClaudeContainerEnv({ PORTKEY_PROVIDER_SLUG: 'anthropic-default' })).toEqual({});
  });

  it('sets the base URL + placeholder token, no headers, when only ANTHROPIC_BASE_URL is set', () => {
    expect(buildClaudeContainerEnv({ ANTHROPIC_BASE_URL: 'https://api.portkey.ai' })).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.portkey.ai',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
  });

  it('builds the Portkey routing headers (provider slug + config) when present', () => {
    const env = buildClaudeContainerEnv({
      ANTHROPIC_BASE_URL: 'https://api.portkey.ai',
      PORTKEY_AI_PROVIDER: 'anthropic-default',
      PORTKEY_CONFIG_ID: 'pc-career-dad06e',
    });
    expect(env.ANTHROPIC_BASE_URL).toBe('https://api.portkey.ai');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('placeholder');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe(
      'x-portkey-provider: @anthropic-default\nx-portkey-config: pc-career-dad06e',
    );
    // x-portkey-api-key is injected by OneCLI on the wire — never in container env.
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('x-portkey-api-key');
  });

  it('normalizes a slug that already carries a leading @ (no double @)', () => {
    const env = buildClaudeContainerEnv({
      ANTHROPIC_BASE_URL: 'https://api.portkey.ai',
      PORTKEY_AI_PROVIDER: '@anthropic-default',
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe('x-portkey-provider: @anthropic-default');
  });

  it('appends the §24.46 observability headers (trace id + metadata) from the spawn context', () => {
    const env = buildClaudeContainerEnv(
      { ANTHROPIC_BASE_URL: 'https://api.portkey.ai', PORTKEY_AI_PROVIDER: 'anthropic-default' },
      { sessionId: 'sess-abc', agentGroup: 'career-pilot', environment: 'dev' },
    );
    const lines = env.ANTHROPIC_CUSTOM_HEADERS.split('\n');
    expect(lines).toContain('x-portkey-provider: @anthropic-default');
    expect(lines).toContain('x-portkey-trace-id: sess-abc');
    const metaLine = lines.find((l) => l.startsWith('x-portkey-metadata: '));
    expect(metaLine).toBeDefined();
    expect(JSON.parse(metaLine!.replace('x-portkey-metadata: ', ''))).toEqual({
      environment: 'dev',
      agent_group: 'career-pilot',
      session_id: 'sess-abc',
    });
  });

  it('omits the observability headers when no context is given (existing behavior)', () => {
    const env = buildClaudeContainerEnv({
      ANTHROPIC_BASE_URL: 'https://api.portkey.ai',
      PORTKEY_AI_PROVIDER: 'anthropic-default',
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('x-portkey-trace-id');
    expect(env.ANTHROPIC_CUSTOM_HEADERS).not.toContain('x-portkey-metadata');
  });

  it('contributes nothing when no base URL is set, even with a context', () => {
    expect(buildClaudeContainerEnv({}, { sessionId: 'sess-abc', environment: 'dev' })).toEqual({});
  });

  it('forwards ENABLE_PROMPT_CACHING_1H from .env so the container default can be overridden (§24.49)', () => {
    expect(
      buildClaudeContainerEnv({ ANTHROPIC_BASE_URL: 'https://api.portkey.ai', ENABLE_PROMPT_CACHING_1H: '1' })
        .ENABLE_PROMPT_CACHING_1H,
    ).toBe('1');
    // an explicit off value rides through verbatim (disable without an image rebuild)
    expect(
      buildClaudeContainerEnv({ ANTHROPIC_BASE_URL: 'https://api.portkey.ai', ENABLE_PROMPT_CACHING_1H: '0' })
        .ENABLE_PROMPT_CACHING_1H,
    ).toBe('0');
  });

  it('omits ENABLE_PROMPT_CACHING_1H when .env does not set it (container default applies)', () => {
    expect(buildClaudeContainerEnv({ ANTHROPIC_BASE_URL: 'https://api.portkey.ai' })).not.toHaveProperty(
      'ENABLE_PROMPT_CACHING_1H',
    );
  });
});
