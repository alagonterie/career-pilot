import { describe, expect, it } from 'vitest';

import { zeroLeadsExplainedByRejects } from './scrape-zero-leads.js';

describe('zeroLeadsExplainedByRejects (Tier-4 scrape flow)', () => {
  it('explains zero keepers when every hit was rejected and nothing was recorded', () => {
    expect(zeroLeadsExplainedByRejects({ searchRejectedTotal: 3, recordCalls: 0, recordRefusals: 0 })).toBe(true);
  });

  it('explains zero rows when every record call was a deliberate host refusal', () => {
    expect(zeroLeadsExplainedByRejects({ searchRejectedTotal: 3, recordCalls: 2, recordRefusals: 2 })).toBe(true);
  });

  it('does NOT excuse record calls that should have written rows (a broken writer)', () => {
    expect(zeroLeadsExplainedByRejects({ searchRejectedTotal: 3, recordCalls: 5, recordRefusals: 0 })).toBe(false);
    expect(zeroLeadsExplainedByRejects({ searchRejectedTotal: 3, recordCalls: 5, recordRefusals: 4 })).toBe(false);
  });

  it('never excuses anything without a rejected count', () => {
    expect(zeroLeadsExplainedByRejects({ searchRejectedTotal: 0, recordCalls: 0, recordRefusals: 0 })).toBe(false);
    expect(zeroLeadsExplainedByRejects({ searchRejectedTotal: 0, recordCalls: 2, recordRefusals: 2 })).toBe(false);
  });
});
