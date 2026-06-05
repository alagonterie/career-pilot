import { describe, expect, it } from 'vitest';

import { assertSelfOnly, canonicalizeGmail, isSelfTarget } from './allow-list.js';

const DEV = 'alagonterie.career.dev@gmail.com';

describe('recruiter-sim allow-list', () => {
  it('canonicalizes Gmail: strips +tag, lowercases, drops dots in the local part', () => {
    expect(canonicalizeGmail('Alagonterie.Career.Dev+acme@gmail.com')).toBe('alagonteriecareerdev@gmail.com');
    expect(canonicalizeGmail('alagonteriecareerdev@gmail.com')).toBe('alagonteriecareerdev@gmail.com');
    expect(canonicalizeGmail('a.b@googlemail.com')).toBe('ab@googlemail.com');
  });

  it('keeps dots for non-Gmail domains', () => {
    expect(canonicalizeGmail('first.last@example.com')).toBe('first.last@example.com');
  });

  it('treats +tag and dot variants of the dev account as self', () => {
    expect(isSelfTarget(DEV, DEV)).toBe(true);
    expect(isSelfTarget('alagonterie.career.dev+acme01@gmail.com', DEV)).toBe(true);
    expect(isSelfTarget('alagonteriecareerdev@gmail.com', DEV)).toBe(true);
  });

  it('rejects any other recipient', () => {
    expect(isSelfTarget('recruiter@meridianlabs.example', DEV)).toBe(false);
    expect(isSelfTarget('someoneelse@gmail.com', DEV)).toBe(false);
  });

  it('assertSelfOnly throws for a non-self target and is silent for self', () => {
    expect(() => assertSelfOnly('recruiter@acme.example', DEV)).toThrow(/self-only allow-list/);
    expect(() => assertSelfOnly('alagonterie.career.dev+x@gmail.com', DEV)).not.toThrow();
  });
});
