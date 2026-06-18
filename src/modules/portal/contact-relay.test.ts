/**
 * Unit tests for the Sub-milestone 5.6 contact relay (STRATEGY.md §24.22):
 * validation, the pure notification builder, and the resolve→deliver path to
 * the owner's wired channel(s) via the delivery adapter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAgentGroup } from '../../db/agent-groups.js';
import { closeDb, getDb, initTestDb } from '../../db/connection.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
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
  createAgentGroup({
    id: 'ag-owner',
    name: 'Career Pilot',
    folder: 'career-pilot',
    agent_provider: null,
    created_at: now,
  });
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

/** Override a preferences-tier knob for a test (getConfig coerces the string). */
function setPref(key: string, value: string): void {
  getDb()
    .prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)')
    .run(key, value, '2026-06-18T00:00:00Z');
}

function countContacts(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM contact_submissions').get() as { n: number }).n;
}

const VALID = { name: 'Sam Recruiter', email: 'sam@acme.example', message: 'We are hiring — let’s talk.' };

describe('buildContactNotification', () => {
  it('includes name/email/message; company + role + source only when present', () => {
    const full = buildContactNotification({
      name: 'Jane Doe',
      email: 'jane@example.com',
      company: 'Acme',
      role: 'EM',
      source: 'live',
      message: 'Loved the simulator.',
    });
    expect(full).toContain('Jane Doe <jane@example.com>');
    expect(full).toContain('Company: Acme');
    expect(full).toContain('Role: EM');
    expect(full).toContain('Came from: live');
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
    expect(minimal).not.toContain('Came from:');
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
    createAgentGroup({
      id: 'ag-owner',
      name: 'CP',
      folder: 'career-pilot',
      agent_provider: null,
      created_at: '2026-05-29T00:00:00Z',
    });
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

describe('relayContactSubmission — §24.121 persistence + abuse backstops', () => {
  it('persists a delivered submission for recall', async () => {
    seedOwnerWithChannel();
    const r = await relayContactSubmission(VALID);
    expect(r.ok).toBe(true);
    expect(countContacts()).toBe(1);
    const row = getDb().prepare('SELECT * FROM contact_submissions').get() as {
      email: string;
      delivered: number;
      fingerprint: string;
    };
    expect(row.email).toBe('sam@acme.example');
    expect(row.delivered).toBe(1);
    expect(row.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('suppresses an identical resend within the dedup window (no re-notify, no dup row)', async () => {
    seedOwnerWithChannel();
    const first = await relayContactSubmission(VALID);
    expect(first.delivered).toBe(1);
    const second = await relayContactSubmission(VALID);
    expect(second.ok).toBe(true);
    expect(second.deduped).toBe(true);
    expect(second.delivered).toBe(0);
    expect(deliverMock).toHaveBeenCalledTimes(1); // owner notified once, not twice
    expect(countContacts()).toBe(1); // the duplicate was not persisted
  });

  it('refuses over the global flood cap for the window', async () => {
    seedOwnerWithChannel();
    setPref('contact_relay_max_per_window', '1');
    expect((await relayContactSubmission(VALID)).ok).toBe(true);
    // A DISTINCT submission (so dedup doesn't catch it) trips the cap (1 already in window).
    const over = await relayContactSubmission({ ...VALID, email: 'other@acme.example', message: 'different' });
    expect(over.ok).toBe(false);
    expect(over.error?.code).toBe('UNAVAILABLE');
    expect(deliverMock).toHaveBeenCalledTimes(1);
  });

  it('prunes to the bounded retention max', async () => {
    seedOwnerWithChannel();
    setPref('contact_retention_max', '1');
    await relayContactSubmission(VALID);
    await relayContactSubmission({ ...VALID, email: 'two@acme.example', message: 'second distinct message' });
    expect(countContacts()).toBe(1); // only the newest kept
  });

  it('kill switch off → UNAVAILABLE, nothing delivered or persisted', async () => {
    seedOwnerWithChannel();
    setPref('contact_relay_enabled', 'false');
    const r = await relayContactSubmission(VALID);
    expect(r.ok).toBe(false);
    expect(r.error?.code).toBe('UNAVAILABLE');
    expect(deliverMock).not.toHaveBeenCalled();
    expect(countContacts()).toBe(0);
  });
});
