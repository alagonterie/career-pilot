/**
 * Guards the sandbox tool lockdown (§24.141 S2-0). The public sandbox must never
 * expose Bash/Write/Edit — they gave a prompt-injected visitor arbitrary
 * in-container code execution + a live path to the GCP metadata SA token. Unlike
 * the private MCP tools, these built-ins have NO host-side Layer-2 catch-all, so
 * a regression here re-opens the hole silently. This test is the trip-wire.
 */
import { describe, expect, it } from 'vitest';

import { SANDBOX_DISALLOWED_TOOLS } from './init-sandbox-group.js';

describe('SANDBOX_DISALLOWED_TOOLS — the sandbox tool lockdown (§24.141 S2-0)', () => {
  it('disallows the dangerous built-ins (no Layer-2 equivalent — must be listed)', () => {
    for (const tool of ['Bash', 'Write', 'Edit']) {
      expect(SANDBOX_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('still disallows the private career_pilot MCP writers + readers (Layer 1)', () => {
    for (const tool of [
      'mcp__nanoclaw__create_gmail_draft',
      'mcp__nanoclaw__update_application',
      'mcp__nanoclaw__record_job_lead',
      'mcp__nanoclaw__persist_funnel_state',
    ]) {
      expect(SANDBOX_DISALLOWED_TOOLS).toContain(tool);
    }
  });

  it('leaves the tools the simulator legitimately needs OUT of the disallow list', () => {
    // The sandbox researches + drafts text; it must keep WebSearch/WebFetch/Read.
    for (const tool of ['WebSearch', 'WebFetch', 'Read']) {
      expect(SANDBOX_DISALLOWED_TOOLS).not.toContain(tool);
    }
  });
});
