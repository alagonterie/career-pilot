import { describe, expect, it } from 'vitest';

import { buildCalendarBody, buildInsertBody, buildRawMessage, encodeMimeHeader, toBase64Url } from './inject.js';

function decodeBase64Url(s: string): string {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

describe('recruiter-sim inject builders', () => {
  it('toBase64Url is URL-safe and round-trips', () => {
    const encoded = toBase64Url('hello — world?>>');
    expect(encoded).not.toMatch(/[+/]/);
    expect(decodeBase64Url(encoded)).toBe('hello — world?>>');
  });

  it('encodeMimeHeader passes ASCII through and RFC2047-encodes non-ASCII', () => {
    expect(encodeMimeHeader('Plain ASCII subject')).toBe('Plain ASCII subject');
    const encoded = encodeMimeHeader('We received your application — Backend Engineer');
    expect(encoded).toMatch(/^=\?UTF-8\?B\?.+\?=$/);
  });

  it('buildRawMessage emits a valid new-thread message (no reply headers)', () => {
    const raw = buildRawMessage({
      fromName: 'Meridian Labs Talent',
      fromAddress: 'talent@meridianlabs.example',
      to: 'janedoe.career.dev@gmail.com',
      subject: 'We received your application — Backend Engineer',
      dateMs: Date.UTC(2026, 4, 31, 19, 11, 2),
      messageId: '<sim-abc@recruiter-sim.invalid>',
      inReplyTo: null,
      body: 'Thanks for applying — we will be in touch.',
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('From: Meridian Labs Talent <talent@meridianlabs.example>'); // ASCII → not encoded
    expect(decoded).toContain('To: janedoe.career.dev@gmail.com');
    expect(decoded).toContain('Subject: =?UTF-8?B?'); // subject has an em dash → encoded
    expect(decoded).toContain('Message-ID: <sim-abc@recruiter-sim.invalid>');
    expect(decoded).toContain('Thanks for applying — we will be in touch.'); // em dash preserved in body
    expect(decoded).not.toContain('In-Reply-To:');
  });

  it('buildRawMessage threads a reply via In-Reply-To + References', () => {
    const raw = buildRawMessage({
      fromName: 'Talent',
      fromAddress: 'talent@acme.example',
      to: 'dev@gmail.com',
      subject: 'Re: next step',
      dateMs: 0,
      messageId: '<sim-2@recruiter-sim.invalid>',
      inReplyTo: '<sim-1@recruiter-sim.invalid>',
      body: 'reply body',
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('In-Reply-To: <sim-1@recruiter-sim.invalid>');
    expect(decoded).toContain('References: <sim-1@recruiter-sim.invalid>');
  });

  it('buildInsertBody always lands in INBOX/UNREAD and threads only when given', () => {
    expect(buildInsertBody('RAW', null)).toEqual({ raw: 'RAW', labelIds: ['INBOX', 'UNREAD'] });
    expect(buildInsertBody('RAW', 't123')).toEqual({ raw: 'RAW', labelIds: ['INBOX', 'UNREAD'], threadId: 't123' });
  });

  it('buildCalendarBody sets a future window with the dev account as attendee', () => {
    const start = Date.UTC(2026, 5, 10, 15, 0, 0);
    const body = buildCalendarBody(
      { summary: 'Meridian — interview', startMs: start, durationMin: 45 },
      'dev@gmail.com',
    );
    expect(body).toMatchObject({
      summary: 'Meridian — interview',
      attendees: [{ email: 'dev@gmail.com' }],
    });
    const s = body.start as { dateTime: string };
    const e = body.end as { dateTime: string };
    expect(new Date(e.dateTime).getTime() - new Date(s.dateTime).getTime()).toBe(45 * 60_000);
  });
});
