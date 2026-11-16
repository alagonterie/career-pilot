/**
 * §24.203 D5/D6 — the runtime prompt contract for admin actions, checked
 * statically (the behaviour itself is live-verified; see the VERIFICATION.md
 * files). The shared draft-outreach subagent has ONE explicit no-recipient
 * trigger, both callers emit it, and none of the touched runtime artifacts
 * carries a spec reference.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

const root = process.cwd();
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

const DRAFT = 'groups/_shared-subagents/draft-outreach.md';
const OWNER = 'groups/career-pilot/.claude-host-fragments/persona.md';
const SANDBOX = 'groups/career-pilot-sandbox/.claude-host-fragments/persona.md';
const TOOLS = 'container/agent-runner/src/mcp-tools/admin-actions.ts';

describe('admin-action runtime prompts', () => {
  it('draft-outreach triggers no-recipient mode only on the explicit block and still refuses on absence', () => {
    const s = read(DRAFT);
    expect(s).toContain('`## Recipient: none`');
    expect(s).toMatch(/mere absence of a recipient\s+is NOT the no-recipient mode/);
    expect(s).toMatch(/## Cannot proceed —\s+no recipient provided/);
  });

  it('both callers emit the block', () => {
    expect(read(OWNER)).toMatch(/^\s+## Recipient: none$/m);
    expect(read(SANDBOX)).toMatch(/^\s+## Recipient: none$/m);
  });

  it('the owner handler is silent, reads through get_admin_action, completes, and never drafts in Gmail', () => {
    const s = read(OWNER);
    const start = s.indexOf('### Admin-action (`[scheduled trigger: admin-action] action_id=…`)');
    expect(start).toBeGreaterThan(-1);
    const section = s.slice(start, s.indexOf('### Unknown trigger kinds', start));
    expect(section).toContain('mcp__nanoclaw__get_admin_action');
    expect(section).toContain('mcp__nanoclaw__complete_admin_action');
    expect(section).toMatch(/SILENT/);
    expect(section).toMatch(/Do NOT call create_gmail_draft/);
    expect(section).toMatch(/expired: true/);
  });

  it('carries no spec references', () => {
    // The owner persona's pre-existing "Hard reference" footer names the spec
    // folder; the check there covers the admin-action handler + recipient text.
    const owner = read(OWNER);
    const handler = owner.slice(owner.indexOf('### Admin-action ('), owner.indexOf('### Unknown trigger kinds'));
    const recipient = owner.slice(
      owner.indexOf('### Recipient extraction'),
      owner.indexOf('### Interview event extraction'),
    );
    for (const [name, s] of [
      [DRAFT, read(DRAFT)],
      [SANDBOX, read(SANDBOX)],
      [TOOLS, read(TOOLS)],
      [`${OWNER} (admin-action handler)`, handler],
      [`${OWNER} (recipient extraction)`, recipient],
    ] as const) {
      expect(s.length, name).toBeGreaterThan(0);
      expect(s, name).not.toMatch(/§/);
      expect(s, name).not.toMatch(/STRATEGY/);
      expect(s, name).not.toMatch(/\.specs/);
    }
  });
});
