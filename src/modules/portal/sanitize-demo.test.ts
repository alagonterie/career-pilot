/**
 * Unit tests for the anonymization-demo builder (STRATEGY §24.33). Confirms the
 * demo runs the REAL pipeline over synthetic-only input and never leaks the
 * synthetic PII/company into the sanitized "after" pane.
 */
import { describe, expect, it } from 'vitest';

import { buildSanitizeDemo } from './sanitize-demo.js';

describe('buildSanitizeDemo', () => {
  it('runs the real pipeline over sample 0 — email/phone/$/URL + company all redacted', () => {
    const r = buildSanitizeDemo(0);
    expect(r.sample).toBe(0);
    expect(r.total).toBeGreaterThanOrEqual(3);

    // The raw "before" pane is the synthetic source, verbatim.
    expect(r.raw).toContain('sarah.briggs@globex.com');
    expect(r.raw).toMatch(/Globex/);

    // The sanitized "after" pane carries the real markers and leaks nothing.
    expect(r.sanitized).toContain('[EMAIL_REDACTED]');
    expect(r.sanitized).toContain('[PHONE_REDACTED]');
    expect(r.sanitized).toContain('[AMOUNT_REDACTED]');
    expect(r.sanitized).toContain('[REDACTED:saas-demo]');
    expect(r.sanitized).toContain('recruiter_id=[REDACTED]');
    // §24.134d: the AI judgment tier redacts the product codename.
    expect(r.sanitized).toContain('[AI_REDACTED]');
    expect(r.sanitized).not.toMatch(/Borealis/);
    expect(r.sanitized).not.toContain('sarah.briggs@globex.com');
    expect(r.sanitized).not.toMatch(/Globex/i);
    expect(r.redactions).toBeGreaterThanOrEqual(6);
  });

  it('redacts a synthetic SSN where a sample includes one', () => {
    const r = buildSanitizeDemo(2); // Hooli sample carries a synthetic SSN
    expect(r.sanitized).toContain('[SSN_REDACTED]');
    expect(r.sanitized).not.toMatch(/412-55-9087/);
  });

  it('clamps an out-of-range or non-finite index into [0, total)', () => {
    const total = buildSanitizeDemo(0).total;
    expect(buildSanitizeDemo(999).sample).toBe(total - 1);
    expect(buildSanitizeDemo(-5).sample).toBe(0);
    expect(buildSanitizeDemo(Number.NaN).sample).toBe(0);
    expect(buildSanitizeDemo(1.9).sample).toBe(1); // floored
  });

  it('never leaks the synthetic company name in any sample’s sanitized output', () => {
    const names = [/Globex/i, /Initech/i, /Hooli/i];
    const total = buildSanitizeDemo(0).total;
    for (let i = 0; i < total; i++) {
      expect(buildSanitizeDemo(i).sanitized).not.toMatch(names[i]);
    }
  });
});
