import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { MODULE_FRAGMENT_GATED_TOOLS, moduleFragmentDisabledByPalette } from './claude-md-compose.js';
import { OWNER_DISALLOWED_TOOLS } from './modules/career-pilot/owner-disallowed-tools.js';

// §24.49e: the composer skips a built-in module fragment when EVERY MCP tool it
// documents is in the group's disallowed_tools — the fragment would be dead
// instructional text (the agent can't call anything it describes). This trims
// the owner's composed CLAUDE.md and compounds with the §24.49d palette trim.

describe('moduleFragmentDisabledByPalette', () => {
  it('skips the agents fragment when create_agent is disallowed', () => {
    expect(moduleFragmentDisabledByPalette('agents', new Set(['mcp__nanoclaw__create_agent']))).toBe(true);
  });

  it('skips self-mod only when BOTH its tools are disallowed', () => {
    const both = new Set(['mcp__nanoclaw__install_packages', 'mcp__nanoclaw__add_mcp_server']);
    expect(moduleFragmentDisabledByPalette('self-mod', both)).toBe(true);
    // Partial disallow leaves a reachable tool ⇒ the fragment stays.
    expect(moduleFragmentDisabledByPalette('self-mod', new Set(['mcp__nanoclaw__install_packages']))).toBe(false);
  });

  it('keeps non-gated modules regardless of the disallow set', () => {
    const set = new Set(['mcp__nanoclaw__create_agent', 'Monitor', 'TeamCreate']);
    for (const m of ['core', 'scheduling', 'interactive', 'cli']) {
      expect(moduleFragmentDisabledByPalette(m, set)).toBe(false);
    }
  });

  it('keeps every gated fragment for a group with an empty disallow set', () => {
    const empty = new Set<string>();
    expect(moduleFragmentDisabledByPalette('agents', empty)).toBe(false);
    expect(moduleFragmentDisabledByPalette('self-mod', empty)).toBe(false);
  });

  // The load-bearing tie to reality: the actual owner palette (§24.49d) must
  // make BOTH targeted fragments dead — that's the cut this lever ships. If a
  // future edit re-allows one of those tools, this fails, forcing a conscious
  // decision about the fragment reappearing.
  it('the owner palette disables exactly the agents + self-mod fragments', () => {
    const owner = new Set(OWNER_DISALLOWED_TOOLS);
    expect(moduleFragmentDisabledByPalette('agents', owner)).toBe(true);
    expect(moduleFragmentDisabledByPalette('self-mod', owner)).toBe(true);
  });

  // Guard against the map naming a phantom module: every gated key must have a
  // real `<module>.instructions.md` source, or the skip can never fire.
  it('every gated module names a real instructions source', () => {
    const dir = path.join(process.cwd(), 'container', 'agent-runner', 'src', 'mcp-tools');
    for (const moduleName of Object.keys(MODULE_FRAGMENT_GATED_TOOLS)) {
      expect(fs.existsSync(path.join(dir, `${moduleName}.instructions.md`))).toBe(true);
    }
  });
});
