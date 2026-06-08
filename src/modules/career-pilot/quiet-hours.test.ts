import { describe, expect, it } from 'vitest';

import { isWithinQuietHours, localMinutes, parseQuietHours, startOfLocalDayUtcIso } from './quiet-hours.js';

// America/Denver in June is MDT (UTC-6), so a UTC instant minus 6h is local.

describe('parseQuietHours', () => {
  it('parses HH:MM-HH:MM into minutes-since-midnight', () => {
    expect(parseQuietHours('22:00-07:00')).toEqual({ startMin: 1320, endMin: 420 });
    expect(parseQuietHours(' 9:30 - 17:05 ')).toEqual({ startMin: 570, endMin: 1025 });
  });

  it('returns null for empty / invalid / out-of-range / zero-length', () => {
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours('nope')).toBeNull();
    expect(parseQuietHours('25:00-07:00')).toBeNull();
    expect(parseQuietHours('08:00-08:00')).toBeNull(); // zero-length ⇒ disabled
  });
});

describe('localMinutes', () => {
  it('computes minutes since local midnight in the given zone', () => {
    expect(localMinutes(new Date('2026-06-15T08:30:00Z'), 'America/Denver')).toBe(2 * 60 + 30); // 02:30 MDT
    expect(localMinutes(new Date('2026-06-15T08:30:00Z'), 'UTC')).toBe(8 * 60 + 30);
  });

  it('falls back to a valid zone on a bad tz (never throws)', () => {
    expect(() => localMinutes(new Date('2026-06-15T08:30:00Z'), 'Not/AZone')).not.toThrow();
  });
});

describe('isWithinQuietHours', () => {
  const tz = 'America/Denver';

  it('wrap-around window (22:00-07:00): inside overnight, outside midday', () => {
    expect(isWithinQuietHours(new Date('2026-06-15T08:00:00Z'), '22:00-07:00', tz)).toBe(true); // 02:00 MDT
    expect(isWithinQuietHours(new Date('2026-06-15T19:00:00Z'), '22:00-07:00', tz)).toBe(false); // 13:00 MDT
  });

  it('treats the start as inclusive and the end as exclusive', () => {
    expect(isWithinQuietHours(new Date('2026-06-15T04:00:00Z'), '22:00-07:00', tz)).toBe(true); // 22:00 MDT (start)
    expect(isWithinQuietHours(new Date('2026-06-15T13:00:00Z'), '22:00-07:00', tz)).toBe(false); // 07:00 MDT (end)
  });

  it('same-day window (09:00-17:00)', () => {
    expect(isWithinQuietHours(new Date('2026-06-15T18:00:00Z'), '09:00-17:00', tz)).toBe(true); // 12:00 MDT
    expect(isWithinQuietHours(new Date('2026-06-15T08:00:00Z'), '09:00-17:00', tz)).toBe(false); // 02:00 MDT
  });

  it('empty / zero-length window ⇒ never quiet', () => {
    expect(isWithinQuietHours(new Date('2026-06-15T08:00:00Z'), '', tz)).toBe(false);
    expect(isWithinQuietHours(new Date('2026-06-15T08:00:00Z'), '08:00-08:00', tz)).toBe(false);
  });
});

describe('startOfLocalDayUtcIso', () => {
  it('returns the UTC instant of the most recent local midnight', () => {
    // 02:30:45.123 MDT on 2026-06-15 → local midnight = 2026-06-15T06:00:00Z (MDT 00:00 = UTC 06:00).
    expect(startOfLocalDayUtcIso(new Date('2026-06-15T08:30:45.123Z'), 'America/Denver')).toBe(
      '2026-06-15T06:00:00.000Z',
    );
  });

  it('UTC zone ⇒ midnight is the same date 00:00Z', () => {
    expect(startOfLocalDayUtcIso(new Date('2026-06-15T08:30:45.123Z'), 'UTC')).toBe('2026-06-15T00:00:00.000Z');
  });
});
