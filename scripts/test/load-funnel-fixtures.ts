/**
 * Test fixture loader for the funnel-curator subsystem (Phase 3.2 §24.9).
 *
 * Reads JSON/JSONL fixtures from `tests/fixtures/gmail/` and
 * `tests/fixtures/calendar/`, normalizes their relative-date markers
 * against a test-clock `now`, and returns the parsed shapes that the
 * host actions `gmail_query_delta` and `calendar_query_delta` would
 * return from a real Google API call.
 *
 * Fixture format (Gmail):
 *   { "id", "threadId", "labels"[], "from", "to", "subject",
 *     "received": "<ISO string>" | { "relative": { hours?, days?, minutes? } },
 *     "body" }
 *
 * Fixture format (Calendar):
 *   { "id", "calendarId", "summary",
 *     "start": "<ISO>" | { "relative": {...} }, "end": same,
 *     "organizer", "attendees": [{ "email", "responseStatus" }],
 *     "meetLink" }
 *
 * Files with `.json` extension contain a single message/event.
 * Files with `.jsonl` extension contain one per line (whitespace lines skipped).
 */
import fs from 'node:fs';
import path from 'node:path';

import type {
  ParsedCalendarAttendee,
  ParsedCalendarEvent,
  ParsedGmailMessage,
} from '../../src/modules/career-pilot/funnel-types.js';

interface RelativeDate {
  relative: {
    hours?: number;
    days?: number;
    minutes?: number;
  };
}

type FixtureDate = string | RelativeDate;

interface GmailFixtureMessage {
  id: string;
  threadId: string;
  labels?: string[];
  from: string;
  to: string;
  subject: string;
  received: FixtureDate;
  body: string;
}

interface CalendarFixtureEvent {
  id: string;
  calendarId: string;
  summary: string;
  start: FixtureDate;
  end: FixtureDate;
  organizer?: string | null;
  attendees?: Array<{ email: string; responseStatus: string }>;
  meetLink?: string | null;
}

const FIXTURES_ROOT = path.resolve(process.cwd(), 'tests', 'fixtures');

function resolveDate(input: FixtureDate, now: Date): string {
  if (typeof input === 'string') return input;
  const r = input.relative;
  const ms =
    (r.hours ?? 0) * 3_600_000 +
    (r.days ?? 0) * 86_400_000 +
    (r.minutes ?? 0) * 60_000;
  return new Date(now.getTime() + ms).toISOString();
}

function readJsonOrJsonl<T>(filePath: string): T[] {
  const raw = fs.readFileSync(filePath, 'utf8');
  if (filePath.endsWith('.jsonl')) {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as T);
  }
  return [JSON.parse(raw) as T];
}

function resolveFixturePath(kind: 'gmail' | 'calendar', name: string): string {
  const dir = path.join(FIXTURES_ROOT, kind);
  const jsonPath = path.join(dir, `${name}.json`);
  const jsonlPath = path.join(dir, `${name}.jsonl`);
  if (fs.existsSync(jsonPath)) return jsonPath;
  if (fs.existsSync(jsonlPath)) return jsonlPath;
  throw new Error(`fixture not found: ${kind}/${name} (looked for .json and .jsonl in ${dir})`);
}

const VALID_RESPONSE_STATUSES = new Set([
  'accepted',
  'declined',
  'tentative',
  'needsAction',
]);

export function loadGmailFixture(name: string, now: Date = new Date()): ParsedGmailMessage[] {
  const filePath = resolveFixturePath('gmail', name);
  const raw = readJsonOrJsonl<GmailFixtureMessage>(filePath);
  return raw.map((m) => ({
    id: m.id,
    thread_id: m.threadId,
    labels: m.labels ?? [],
    from_addr: m.from,
    to_addr: m.to,
    subject: m.subject,
    received_at: resolveDate(m.received, now),
    body_text: m.body,
  }));
}

export function loadCalendarFixture(name: string, now: Date = new Date()): ParsedCalendarEvent[] {
  const filePath = resolveFixturePath('calendar', name);
  const raw = readJsonOrJsonl<CalendarFixtureEvent>(filePath);
  return raw.map((e) => ({
    id: e.id,
    calendar_id: e.calendarId,
    summary: e.summary,
    start_at: resolveDate(e.start, now),
    end_at: resolveDate(e.end, now),
    organizer: e.organizer ?? null,
    attendees: (e.attendees ?? []).map((a): ParsedCalendarAttendee => {
      if (!VALID_RESPONSE_STATUSES.has(a.responseStatus)) {
        throw new Error(`invalid responseStatus in calendar fixture ${name}: ${a.responseStatus}`);
      }
      return {
        email: a.email,
        response_status: a.responseStatus as ParsedCalendarAttendee['response_status'],
      };
    }),
    meet_link: e.meetLink ?? null,
  }));
}
