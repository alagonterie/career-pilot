/**
 * Unit tests for the funnel fixture loader (Phase 3.2 §24.9 component 2).
 *
 * Verifies relative-date resolution, single-vs-jsonl handling, error paths,
 * and shape conformance to the parsed Gmail/Calendar types the host
 * actions will return.
 */
import { describe, expect, it } from 'vitest';

import { loadCalendarFixture, loadGmailFixture } from './load-funnel-fixtures.js';

const TEST_NOW = new Date('2026-05-28T12:00:00.000Z');

describe('loadGmailFixture', () => {
  it('loads a single-message .json fixture and resolves relative dates against now', () => {
    const msgs = loadGmailFixture('acme-applied-confirmation', TEST_NOW);
    expect(msgs).toHaveLength(1);
    const m = msgs[0];
    expect(m.id).toBe('msg-acme-confirm-001');
    expect(m.thread_id).toBe('thread-acme-confirm');
    expect(m.labels).toEqual(['INBOX', 'CATEGORY_UPDATES']);
    expect(m.from_addr).toBe('no-reply@greenhouse.example');
    expect(m.subject).toContain('Acme');
    // relative: hours: -2 → 10:00 UTC the same day
    expect(m.received_at).toBe('2026-05-28T10:00:00.000Z');
    expect(m.body_text).toContain('Thanks for applying');
  });

  it('loads a multi-message .jsonl fixture as an ordered array', () => {
    const msgs = loadGmailFixture('acme-pipeline-multi', TEST_NOW);
    expect(msgs).toHaveLength(4);
    expect(msgs.map((m) => m.id)).toEqual([
      'msg-acme-pl-1',
      'msg-acme-pl-2',
      'msg-acme-pl-3',
      'msg-acme-pl-4',
    ]);
    // all 4 share the same thread
    expect(new Set(msgs.map((m) => m.thread_id)).size).toBe(1);
  });

  it('resolves day-granularity relative dates correctly', () => {
    const msgs = loadGmailFixture('beta-applied-then-silent', TEST_NOW);
    expect(msgs).toHaveLength(2);
    // -22 days from 2026-05-28T12:00:00Z → 2026-05-06T12:00:00Z
    expect(msgs[0].received_at).toBe('2026-05-06T12:00:00.000Z');
    expect(msgs[1].received_at).toBe('2026-05-07T12:00:00.000Z');
  });

  it('classifies a promotional newsletter fixture preserving CATEGORY_PROMOTIONS', () => {
    const msgs = loadGmailFixture('noise-newsletter', TEST_NOW);
    expect(msgs[0].labels).toContain('CATEGORY_PROMOTIONS');
  });

  it('throws a clear error for a missing fixture', () => {
    expect(() => loadGmailFixture('does-not-exist', TEST_NOW)).toThrowError(/fixture not found/i);
  });
});

describe('loadCalendarFixture', () => {
  it('loads a calendar event with attendees + meet link and resolves future-relative dates', () => {
    const events = loadCalendarFixture('acme-onsite-tomorrow', TEST_NOW);
    expect(events).toHaveLength(1);
    const e = events[0];
    expect(e.id).toBe('evt-acme-onsite');
    expect(e.calendar_id).toBe('primary');
    expect(e.summary).toContain('Acme onsite');
    // +26h from 12:00 → 14:00 next day
    expect(e.start_at).toBe('2026-05-29T14:00:00.000Z');
    expect(e.end_at).toBe('2026-05-29T18:00:00.000Z');
    expect(e.organizer).toBe('recruiting@acme.example');
    expect(e.attendees).toHaveLength(3);
    expect(e.attendees.every((a) => a.response_status === 'accepted')).toBe(true);
    expect(e.meet_link).toContain('meet.google.example');
  });

  it('throws a clear error for a missing fixture', () => {
    expect(() => loadCalendarFixture('does-not-exist', TEST_NOW)).toThrowError(/fixture not found/i);
  });
});

describe('date resolution corner cases', () => {
  it('uses the passed test-now consistently across all messages in a JSONL', () => {
    const msgs = loadGmailFixture('acme-pipeline-multi', TEST_NOW);
    const intervals = msgs.map((m) => new Date(m.received_at).getTime());
    // Each message is at -14, -12, -7, -2 days respectively; deltas are
    // consistent regardless of test-now value, so verify ordering + spacing.
    expect(intervals[1] - intervals[0]).toBe(2 * 86_400_000); // -12 - -14 = +2d
    expect(intervals[2] - intervals[1]).toBe(5 * 86_400_000); // -7 - -12 = +5d
    expect(intervals[3] - intervals[2]).toBe(5 * 86_400_000); // -2 - -7 = +5d
  });
});
