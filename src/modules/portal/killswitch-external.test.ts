/**
 * Unit tests for the Sub-milestone 5.4b external-revocation seams
 * (STRATEGY.md §24.18). Both are NOT_WIRED today: they must return
 * { wired:false, ok:false } with a NOT_WIRED detail and never throw — so the
 * killswitch reply can be honest (no silent partial success).
 */
import { describe, expect, it } from 'vitest';

import {
  revokeOneCliAgentTokens,
  summarizeExternal,
  zeroPortkeyBudget,
  type ExternalRevocationResult,
} from './killswitch-external.js';

describe('killswitch external seams (NOT_WIRED)', () => {
  it('revokeOneCliAgentTokens returns NOT_WIRED, never throws', async () => {
    const r = await revokeOneCliAgentTokens(['career-pilot', 'career-pilot-sandbox']);
    expect(r.name).toBe('onecli');
    expect(r.wired).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('NOT_WIRED');
  });

  it('revokeOneCliAgentTokens tolerates an empty agent list', async () => {
    const r = await revokeOneCliAgentTokens([]);
    expect(r.wired).toBe(false);
    expect(r.detail).toContain('NOT_WIRED');
  });

  it('zeroPortkeyBudget returns NOT_WIRED, never throws', async () => {
    const r = await zeroPortkeyBudget();
    expect(r.name).toBe('portkey');
    expect(r.wired).toBe(false);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain('NOT_WIRED');
  });
});

describe('summarizeExternal', () => {
  it('reports NOT_WIRED steps as manual', () => {
    const results: ExternalRevocationResult[] = [
      { name: 'onecli', wired: false, ok: false, detail: 'x' },
      { name: 'portkey', wired: false, ok: false, detail: 'y' },
    ];
    const s = summarizeExternal(results);
    expect(s).toContain('onecli: NOT_WIRED');
    expect(s).toContain('portkey: NOT_WIRED');
    expect(s).toContain('manual rotation required');
  });

  it('reports a wired success vs a wired failure distinctly', () => {
    expect(summarizeExternal([{ name: 'onecli', wired: true, ok: true, detail: '' }])).toContain('onecli: revoked');
    expect(summarizeExternal([{ name: 'portkey', wired: true, ok: false, detail: '' }])).toContain(
      'portkey: FAILED',
    );
  });
});
