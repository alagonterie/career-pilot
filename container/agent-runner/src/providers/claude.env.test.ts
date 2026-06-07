import { describe, it, expect } from 'bun:test';

import { buildProviderSubprocessEnv } from './claude.js';

// §24.49: the env handed to the Claude Code subprocess must default the 1-hour
// prompt cache ON (so the ~55K static preamble stays warm across cron fires),
// while still letting the forwarded box .env value override it.
describe('buildProviderSubprocessEnv', () => {
  it('defaults the 1h prompt cache ON when nothing overrides it', () => {
    expect(buildProviderSubprocessEnv().ENABLE_PROMPT_CACHING_1H).toBe('1');
    expect(buildProviderSubprocessEnv({}).ENABLE_PROMPT_CACHING_1H).toBe('1');
  });

  it('lets the container env override the 1h cache flag (e.g. =0 to disable)', () => {
    expect(buildProviderSubprocessEnv({ ENABLE_PROMPT_CACHING_1H: '0' }).ENABLE_PROMPT_CACHING_1H).toBe('0');
  });

  // §24.49e Lever 4 (hypothesis): default the nonessential-traffic kill switch ON
  // (candidate for suppressing the per-spawn conversation-summarization call),
  // override-able for the box A/B.
  it('defaults CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC ON, override-able', () => {
    const key = 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC';
    expect(buildProviderSubprocessEnv()[key]).toBe('1');
    expect(buildProviderSubprocessEnv({ [key]: '0' })[key]).toBe('0');
  });

  it('always carries the auto-compact window (the constant wins over the spread)', () => {
    expect(buildProviderSubprocessEnv().CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBeDefined();
    // a stray value in the passed env does not clobber the host-tuned window
    expect(
      buildProviderSubprocessEnv({ CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1' }).CLAUDE_CODE_AUTO_COMPACT_WINDOW,
    ).not.toBe('1');
  });

  it('passes through unrelated env vars unchanged', () => {
    expect(buildProviderSubprocessEnv({ ANTHROPIC_BASE_URL: 'https://api.portkey.ai' }).ANTHROPIC_BASE_URL).toBe(
      'https://api.portkey.ai',
    );
  });
});
