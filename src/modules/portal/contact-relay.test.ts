/**
 * Unit tests for the Sub-milestone 5.6 contact relay (STRATEGY.md §24.22):
 * validation, the pure notification builder, and the resolve→deliver path to
 * the owner's wired channel(s) via the delivery adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
} from '../../db/messaging-groups.js';
import { runMigrations } from '../../db/migrations/index.js';
import { setDeliveryAdapter } from '../../delivery.js';

import { buildContactNotification, relayContactSubmission } from './contact-relay.js';

const deliverMock = vi.fn(
  async (
    _channelType: string,
    _platformId: string,
    _threadId: string | null,
    _kind: string,
    _content: string,
  ): Promise<string | undefined> => undefined,
);

beforeEach(() => {
  closeDb();
  const db = initTestDb();
  runMigrations(db);
  vi.clearAllMocks();
  setDeliveryAdapter({ deliver: deliverMock });
});

afterEach(() => closeDb());

function seedOwnerWithChannel(): void {
  const now = '2026-05-29T00:00:00Z';
  createAgentGroup({ id: 'ag-owner', name: 'Career Pilot', folder: 'career-pilot', agent_provider: null, created_at: now });
  createMessagingGroup({
    id: 'mg-tg',
    channel_type: 'telegram',
    platform_id: 'telegram:owner',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-tg',
    agent_group_id: 'ag-owner',
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
}

describe('buildContactNotification', () => {
  it('includes name/email/message; company + role only when present', () => {
    const full = buildContactNotification({
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme',
      role: 'EM',
      message: 'Loved the simulator.',
    });
    expect(full).toContain('Jane Doe <jane@example.com>');
    expect(full).toContain('Company: Acme');
    expect(full).toContain('Role: EM');
    expect(full).toContain('Loved the simulator.');

    const minimal = buildContactNotification({
      name: 'Jane',
      email: 'jane@example.com',
      company: null,
      role: null,
      message: 'hi',
    });
    expect(minimal).not.toContain('Company:');
    expect(minimal).not.toContain('Role:');
  });
});

describe('relayContactSubmission', () => {
  it('rejects missing name/email/message with BAD_ARGS and does not deliver', async () => {
    expect((await relayContactSubmission({ email: 'a@b.co', message: 'x' })).error?.code).toBe('BAD_ARGS');
    expect((await relayContactSubmission({ name: 'A', message: 'x' })).error?.code).toBe('BAD_ARGS');
    expect((await relayContactSubmission({ name: 'A', email: 'a@b.co' })).error?.code).toBe('BAD_ARGS');
    expect(deliverMock).not.toHaveBeenCalled();
  });

  it('UNAVAILABLE when the owner group is absent', async () => {
    const r = await relayContactSubmission({ name: 'A', email: 'a@b.co', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
  });

  it('UNAVAILABLE when the owner group has no wired channel', async () => {
    createAgentGroup({ id: 'ag-owner', name: 'CP', folder: 'career-pilot', agent_provider: null, created_at: '2026-05-29T00:00:00Z' });
    const r = await relayContactSubmission({ name: 'A', email: 'a@b.co', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
  });

  it('delivers the formatted submission to the wired channel and returns ok', async () => {
    seedOwnerWithChannel();
    const r = await relayContactSubmission({
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme',
      message: 'Please reach out.',
    });
    expect(r.ok).toBe(true);
    expect(r.delivered).toBe(1);
    expect(deliverMock).toHaveBeenCalledTimes(1);
    const [channelType, platformId, threadId, kind, content] = deliverMock.mock.calls[0];
    expect(channelType).toBe('telegram');
    expect(platformId).toBe('telegram:owner');
    expect(threadId).toBeNull();
    expect(kind).toBe('chat');
    const parsed = JSON.parse(content as string) as { text: string };
    expect(parsed.text).toContain('jane@example.com'); // verbatim — never PII-redacted
    expect(parsed.text).toContain('Please reach out.');
  });

  it('returns ok:false when every channel delivery throws', async () => {
    seedOwnerWithChannel();
    deliverMock.mockRejectedValueOnce(new Error('telegram down'));
    const r = await relayContactSubmission({ name: 'A', email: 'a@b.co', message: 'hi' });
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
  });
});
