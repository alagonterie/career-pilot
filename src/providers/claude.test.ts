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
});
