/**
 * Gmail delta resolution: which messages are new since the last sweep, and when
 * the sweep must fall back to a full sync.
 *
 * The invariant under test: an unusable stored pointer — missing, malformed,
 * expired (404) or rejected by Gmail (400) — degrades to the bounded full sync
 * and a re-seeded pointer. It must never fail the sweep outright.
 */
import { describe, expect, it } from 'bun:test';

import { describeApplicationWrite } from './career-pilot.js';
import { GmailApiError, resolveGmailDelta, sendableHistoryId } from './pipeline-scribe.js';

type Handler = (path: string) => unknown;

/** A fetchJson double that records every path and routes by Gmail endpoint. */
function fakeGmail(handlers: { history?: Handler; messages?: Handler; profile?: Handler }) {
  const calls: string[] = [];
  const fetchJson = async <T>(path: string): Promise<T> => {
    calls.push(path);
    if (path.includes('/history?')) {
      if (!handlers.history) throw new Error('history.list not expected');
      return handlers.history(path) as T;
    }
    if (path.includes('/messages?')) return (handlers.messages?.(path) ?? { messages: [] }) as T;
    if (path.endsWith('/profile')) return (handlers.profile?.(path) ?? { historyId: '90000' }) as T;
    throw new Error(`unexpected path ${path}`);
  };
  return { calls, fetchJson };
}

const BASE = { lookbackDays: 30, fullSyncInboxOnly: true };

describe('sendableHistoryId', () => {
  it('accepts only a decimal string', () => {
    expect(sendableHistoryId('29613')).toBe('29613');
    for (const bad of ['"29613"', 'null', 'undefined', '', 'h-123', ' 29613', null, undefined, 29613]) {
      expect(sendableHistoryId(bad)).toBeNull();
    }
  });
});

describe('resolveGmailDelta', () => {
  it('uses the delta path for a valid pointer and de-duplicates message ids', async () => {
    const gmail = fakeGmail({
      history: () => ({
        historyId: '29700',
        history: [
          { id: '1', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] },
          { id: '2', messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }], messages: [{ id: 'm2', threadId: 't2' }] },
        ],
      }),
    });
    const res = await resolveGmailDelta({ ...BASE, priorHistoryId: '29613', fetchJson: gmail.fetchJson });

    expect(res).toEqual({ messageIds: ['m1', 'm2'], newHistoryId: '29700', fullSyncPerformed: false });
    expect(gmail.calls).toHaveLength(1);
    expect(gmail.calls[0]).toContain('startHistoryId=29613');
  });

  it('falls back to a full sync when Gmail REJECTS the pointer with a 400', async () => {
    const gmail = fakeGmail({
      history: () => {
        throw new GmailApiError(400, "400 Bad Request — Invalid value at 'start_history_id' (TYPE_UINT64)");
      },
      messages: () => ({ messages: [{ id: 'm9', threadId: 't9' }] }),
      profile: () => ({ historyId: '31000' }),
    });
    const res = await resolveGmailDelta({ ...BASE, priorHistoryId: '29613', fetchJson: gmail.fetchJson });

    expect(res).toEqual({ messageIds: ['m9'], newHistoryId: '31000', fullSyncPerformed: true });
  });

  it('falls back to a full sync when the pointer has expired (404)', async () => {
    const gmail = fakeGmail({
      history: () => {
        throw new GmailApiError(404, 'history_id expired (404)');
      },
      profile: () => ({ historyId: '31000' }),
    });
    const res = await resolveGmailDelta({ ...BASE, priorHistoryId: '29613', fetchJson: gmail.fetchJson });

    expect(res.fullSyncPerformed).toBe(true);
    expect(res.newHistoryId).toBe('31000');
  });

  it('never sends a malformed pointer — it full-syncs instead', async () => {
    for (const bad of ['"29613"', 'null', 'h-123', null]) {
      const gmail = fakeGmail({ profile: () => ({ historyId: '31000' }) }); // history handler absent → would throw
      const res = await resolveGmailDelta({ ...BASE, priorHistoryId: bad, fetchJson: gmail.fetchJson });

      expect(res.fullSyncPerformed).toBe(true);
      expect(res.newHistoryId).toBe('31000');
      expect(gmail.calls.some((c) => c.includes('/history?'))).toBe(false);
    }
  });

  it('scopes the full sync to the inbox unless told otherwise', async () => {
    const inbox = fakeGmail({});
    await resolveGmailDelta({ ...BASE, priorHistoryId: null, fetchJson: inbox.fetchJson });
    expect(decodeURIComponent(inbox.calls[0])).toContain('in:inbox');

    const all = fakeGmail({});
    await resolveGmailDelta({ ...BASE, fullSyncInboxOnly: false, priorHistoryId: null, fetchJson: all.fetchJson });
    expect(decodeURIComponent(all.calls[0])).not.toContain('in:inbox');
  });

  it('still surfaces failures that are not about the pointer', async () => {
    const gmail = fakeGmail({
      history: () => {
        throw new GmailApiError(401, '401 Unauthorized');
      },
    });
    await expect(
      resolveGmailDelta({ ...BASE, priorHistoryId: '29613', fetchJson: gmail.fetchJson }),
    ).rejects.toThrow('401');
  });
});

describe('describeApplicationWrite', () => {
  it('names the patch fields the host did not write', () => {
    expect(describeApplicationWrite('app-1', { created: false, obfuscated_label: 'ai-a', ignored_fields: [] })).toBe(
      'Application updated: app-1 (label: ai-a)',
    );
    const text = describeApplicationWrite('app-1', {
      created: false,
      obfuscated_label: 'ai-a',
      ignored_fields: ['win_confidence_rationale'],
    });
    expect(text).toContain('NOT written');
    expect(text).toContain('win_confidence_rationale');
  });

  it('tolerates a host that omits ignored_fields', () => {
    expect(describeApplicationWrite('app-2', { created: true, obfuscated_label: null })).toBe(
      'Application created: app-2',
    );
  });
});
