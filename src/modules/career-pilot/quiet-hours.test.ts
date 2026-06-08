import { describe, expect, it } from 'vitest';

import {
  isValidTimezone,
  isWithinQuietHours,
  localMinutes,
  parseQuietHours,
  startOfLocalDayUtcIso,
  validateProactivePref,
} from './quiet-hours.js';

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

describe('isValidTimezone', () => {
  it('accepts valid IANA zones and empty (system zone)', () => {
    expect(isValidTimezone('America/Denver')).toBe(true);
    expect(isValidTimezone('UTC')).toBe(true);
    expect(isValidTimezone('')).toBe(true);
  });

  it('rejects garbage zones', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false);
    expect(isValidTimezone('Denver')).toBe(false);
  });
});

describe('validateProactivePref', () => {
  it('rejects an unknown key', () => {
    const r = validateProactivePref('live_mode', 'true');
    expect(r.ok).toBe(false);
  });

  it('quiet_hours: accepts a valid window and "" (disable), rejects garbage', () => {
    expect(validateProactivePref('quiet_hours', '23:00-08:00')).toEqual({
      ok: true,
      key: 'quiet_hours',
      value: '23:00-08:00',
    });
    expect(validateProactivePref('quiet_hours', '')).toEqual({ ok: true, key: 'quiet_hours', value: '' });
    expect(validateProactivePref('quiet_hours', 'whenever').ok).toBe(false);
  });

  it('quiet_hours_tz: accepts a valid zone and "", rejects garbage', () => {
    expect(validateProactivePref('quiet_hours_tz', 'America/Denver')).toEqual({
      ok: true,
      key: 'quiet_hours_tz',
      value: 'America/Denver',
    });
    expect(validateProactivePref('quiet_hours_tz', '')).toEqual({ ok: true, key: 'quiet_hours_tz', value: '' });
    expect(validateProactivePref('quiet_hours_tz', 'Mars/Olympus').ok).toBe(false);
  });

  it('cap: accepts a non-negative integer (string or number), rejects negatives/fractions', () => {
    expect(validateProactivePref('telegram_proactive_frequency_cap_per_day', '5')).toEqual({
      ok: true,
      key: 'telegram_proactive_frequency_cap_per_day',
      value: '5',
    });
    expect(validateProactivePref('telegram_proactive_frequency_cap_per_day', 0)).toEqual({
      ok: true,
      key: 'telegram_proactive_frequency_cap_per_day',
      value: '0',
    });
    expect(validateProactivePref('telegram_proactive_frequency_cap_per_day', '-1').ok).toBe(false);
    expect(validateProactivePref('telegram_proactive_frequency_cap_per_day', '2.5').ok).toBe(false);
  });
});
