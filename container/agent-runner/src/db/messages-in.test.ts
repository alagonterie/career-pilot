/**
 * Regression tests for getPendingMessages' ack-filter-before-cap ordering
 * (fork deviation, STRATEGY.md §24.67).
 *
 * The §24.66 outage shape: with `LIMIT N` applied in SQL before the
 * processing_ack filter, ≥N stale-but-pending rows above an older due row
 * hide it from every prompt forever. The fix filters consumed rows first,
 * then caps to the newest N.
 */
import { beforeEach, describe, expect, test } from 'bun:test';

import { initTestSessionDb } from './connection.js';
import { getPendingMessages, markCompleted } from './messages-in.js';

let inbound: ReturnType<typeof initTestSessionDb>['inbound'];

beforeEach(() => {
  ({ inbound } = initTestSessionDb());
});

function insertPending(id: string, seq: number): void {
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, content)
       VALUES (?, ?, 'task', datetime('now'), 'pending', 1, '{"prompt":"[x]"}')`,
    )
    .run(id, seq);
}

describe('getPendingMessages — ack filter runs before the newest-N cap', () => {
  test('an old unacked row survives a pile of newer acked rows (the §24.66 starvation shape)', () => {
    insertPending('starved-task', 10);
    const ackedIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const id = `stale-${i}`;
      insertPending(id, 100 + i);
      ackedIds.push(id);
    }
    markCompleted(ackedIds);

    const visible = getPendingMessages();
    expect(visible.map((m) => m.id)).toContain('starved-task');
  });

  test('caps to the newest N unconsumed rows, oldest first', () => {
    for (let i = 0; i < 15; i++) insertPending(`m-${i}`, i);

    const visible = getPendingMessages();
    expect(visible).toHaveLength(10); // default maxMessagesPerPrompt
    // Newest 10 (seq 5..14), chronological order.
    expect(visible[0].id).toBe('m-5');
    expect(visible[visible.length - 1].id).toBe('m-14');
  });

  test('acked rows never re-enter the prompt', () => {
    insertPending('done', 1);
    insertPending('todo', 2);
    markCompleted(['done']);

    const visible = getPendingMessages();
    expect(visible.map((m) => m.id)).toEqual(['todo']);
  });
});
