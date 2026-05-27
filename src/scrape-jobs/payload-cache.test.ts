import { beforeEach, describe, expect, test, vi } from 'vitest';

import * as cache from './payload-cache.js';
import type { JobLeadPayload } from './types.js';

function makePayload(source_job_id: string, title = 'Senior Backend Engineer'): JobLeadPayload {
  return {
    source: 'greenhouse',
    source_board_token: 'acme',
    source_job_id,
    source_url: `https://example.com/${source_job_id}`,
    title,
    company: 'Acme',
  };
}

describe('payload-cache', () => {
  beforeEach(() => {
    cache.clear();
  });

  test('set then get returns the payload', () => {
    const p = makePayload('job-1');
    cache.set(p.source, p.source_job_id, p);
    expect(cache.get(p.source, p.source_job_id)).toBe(p);
  });

  test('get returns undefined for unknown key', () => {
    expect(cache.get('greenhouse', 'never-stored')).toBeUndefined();
  });

  test('different sources with same job id are independent', () => {
    const a = makePayload('shared-id', 'Greenhouse role');
    const b = { ...makePayload('shared-id', 'Lever role'), source: 'lever' as const };
    cache.set(a.source, a.source_job_id, a);
    cache.set(b.source, b.source_job_id, b);
    expect(cache.get('greenhouse', 'shared-id')?.title).toBe('Greenhouse role');
    expect(cache.get('lever', 'shared-id')?.title).toBe('Lever role');
  });

  test('set overwrites prior value for same key', () => {
    cache.set('greenhouse', 'job-1', makePayload('job-1', 'v1'));
    cache.set('greenhouse', 'job-1', makePayload('job-1', 'v2'));
    expect(cache.get('greenhouse', 'job-1')?.title).toBe('v2');
  });

  test('entries past TTL are evicted on read', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      cache.set('greenhouse', 'job-1', makePayload('job-1'));
      expect(cache.get('greenhouse', 'job-1')).toBeDefined();
      // Advance 61 minutes — past the 1h TTL.
      vi.setSystemTime(new Date('2026-01-01T01:01:00Z'));
      expect(cache.get('greenhouse', 'job-1')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('size counts non-expired entries only', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      cache.set('greenhouse', 'job-1', makePayload('job-1'));
      cache.set('greenhouse', 'job-2', makePayload('job-2'));
      expect(cache.size()).toBe(2);
      vi.setSystemTime(new Date('2026-01-01T01:01:00Z'));
      expect(cache.size()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  test('clear removes all entries', () => {
    cache.set('greenhouse', 'job-1', makePayload('job-1'));
    cache.set('lever', 'job-2', makePayload('job-2'));
    cache.clear();
    expect(cache.get('greenhouse', 'job-1')).toBeUndefined();
    expect(cache.get('lever', 'job-2')).toBeUndefined();
    expect(cache.size()).toBe(0);
  });
});
