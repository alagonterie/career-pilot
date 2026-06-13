/**
 * funnel-curator MCP tools (Phase 3.2 §24.9).
 *
 * Five tools wired through the container → host system-action contract
 * (see ../career-pilot/action.ts + src/modules/career-pilot/
 * funnel-actions.ts):
 *
 *   funnel-curator subagent palette (read inputs, write output):
 *     - query_gmail_delta       — fetch new Gmail messages since last sync
 *     - query_calendar_delta    — fetch new Calendar events since last sync
 *     - persist_funnel_state    — single transactional write of the
 *                                 curator's run output
 *
 *   Shared with orchestrator (on-demand persona reads):
 *     - read_funnel_state       — return latest curator output (cached)
 *     - read_email_events       — filtered query against email_events
 *
 * Kept separate from scrape-jobs.ts (Phase 2.5) and career-pilot.ts
 * (Phase 1) so the per-sub-milestone split stays readable.
 */
import { sendAction } from '../career-pilot/action.js';
import { reportRequestTelemetry } from '../career-pilot/telemetry.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function ok(text: string, structured?: Record<string, unknown>) {
  const base = { content: [{ type: 'text' as const, text }] };
  return structured ? { ...base, structuredContent: structured } : base;
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function actionErr(action: string, error: { code: string; message: string }) {
  return err(`${action} failed (${error.code}): ${error.message}`);
}

// ── Gmail / Calendar real-API helpers ──────────────────────────────────────
//
// All real-mode HTTPS calls route through the OneCLI gateway via the
// HTTPS_PROXY env set in container-config.ts. OneCLI matches the
// gmail.googleapis.com / www.googleapis.com host-patterns against the
// connected OAuth apps and injects `Authorization: Bearer <token>` on
// egress — the tool code never sees the raw token.
//
// `x-onecli-placeholder: 1` is a deliberate marker header. OneCLI's
// proactive injection mode (default for OAuth apps) doesn't require any
// stand-in header on the outbound request, but including a marker makes
// the intercept easier to spot in `docker logs onecli` when debugging.

const DEFAULT_LOOKBACK_DAYS = 30;

interface GmailHistoryResponse {
  historyId?: string;
  history?: Array<{
    id: string;
    messages?: Array<{ id: string; threadId: string }>;
    messagesAdded?: Array<{ message: { id: string; threadId: string } }>;
  }>;
}

interface GmailMessagesListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
  resultSizeEstimate?: number;
}

interface GmailProfileResponse {
  emailAddress?: string;
  historyId?: string;
  messagesTotal?: number;
}

interface GmailMessageHeader {
  name: string;
  value: string;
}

interface GmailMessagePayload {
  headers?: GmailMessageHeader[];
  mimeType?: string;
  body?: { size?: number; data?: string };
  parts?: GmailMessagePayload[];
}

interface GmailMessageFull {
  id: string;
  threadId: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: GmailMessagePayload;
}

interface ParsedGmailMessage {
  id: string;
  thread_id: string;
  labels: string[];
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at: string;
  body_text: string;
}

async function gmailFetch<T>(path: string): Promise<T> {
  const t0 = Date.now();
  const tel = (ok: boolean, statusCode: number | null, error?: string): void => {
    void reportRequestTelemetry({
      provider: 'gmail',
      surface: 'funnel-curator-gmail',
      ok,
      latencyMs: Date.now() - t0,
      statusCode,
      error: error ?? null,
    });
  };
  let res: Response;
  try {
    res = await fetch(`https://gmail.googleapis.com${path}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'x-onecli-placeholder': '1',
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    tel(false, null, message);
    throw new GmailApiError(0, message);
  }
  if (res.status === 404) {
    tel(false, 404, 'history_id expired (404)');
    throw new GmailApiError(404, 'history_id expired (404)');
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const message = `${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`;
    tel(false, res.status, message);
    throw new GmailApiError(res.status, message);
  }
  tel(true, res.status);
  return (await res.json()) as T;
}

class GmailApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function base64UrlDecode(s: string): string {
  // Gmail returns base64url-encoded body content; convert to standard base64
  // and decode. Bun/Node's Buffer handles base64 natively.
  const std = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4);
  try {
    return Buffer.from(padded, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function findTextPart(payload: GmailMessagePayload | undefined): string {
  // Walk a Gmail payload tree looking for text/plain content. Falls back to
  // text/html (stripped) only if no plain alternative exists.
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return base64UrlDecode(payload.body.data);
  }
  if (Array.isArray(payload.parts)) {
    // Prefer text/plain at any depth.
    for (const part of payload.parts) {
      const found = findTextPart(part);
      if (found) return found;
    }
  }
  // Last resort: text/html with naive tag strip.
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return base64UrlDecode(payload.body.data)
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return '';
}

function header(payload: GmailMessagePayload | undefined, name: string): string {
  const h = payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase());
  return h?.value ?? '';
}

function parseGmailMessage(msg: GmailMessageFull): ParsedGmailMessage {
  const receivedAt = msg.internalDate
    ? new Date(parseInt(msg.internalDate, 10)).toISOString()
    : header(msg.payload, 'Date') || new Date().toISOString();
  return {
    id: msg.id,
    thread_id: msg.threadId,
    labels: msg.labelIds ?? [],
    from_addr: header(msg.payload, 'From'),
    to_addr: header(msg.payload, 'To'),
    subject: header(msg.payload, 'Subject'),
    received_at: receivedAt,
    body_text: findTextPart(msg.payload),
  };
}

function gmailDateFromLookback(days: number): string {
  // Gmail query syntax: after:YYYY/MM/DD (local day boundary, not ISO).
  const d = new Date(Date.now() - days * 86_400_000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}/${m}/${day}`;
}

interface CalendarEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface CalendarEventOrganizer {
  email?: string;
  displayName?: string;
}

interface CalendarEventAttendee {
  email: string;
  responseStatus?: string;
  displayName?: string;
}

interface CalendarEvent {
  id?: string;
  summary?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  organizer?: CalendarEventOrganizer;
  attendees?: CalendarEventAttendee[];
  hangoutLink?: string;
  conferenceData?: { entryPoints?: Array<{ entryPointType?: string; uri?: string }> };
}

interface CalendarEventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

interface ParsedCalendarAttendee {
  email: string;
  response_status: 'accepted' | 'declined' | 'tentative' | 'needsAction';
}

interface ParsedCalendarEvent {
  id: string;
  calendar_id: string;
  summary: string;
  start_at: string;
  end_at: string;
  organizer: string | null;
  attendees: ParsedCalendarAttendee[];
  meet_link: string | null;
}

class CalendarApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function dateTimeToIso(dt: CalendarEventDateTime | undefined): string {
  if (!dt) return new Date().toISOString();
  if (dt.dateTime) return new Date(dt.dateTime).toISOString();
  if (dt.date) return new Date(dt.date + 'T00:00:00Z').toISOString();
  return new Date().toISOString();
}

const VALID_RESPONSE_STATUSES = new Set(['accepted', 'declined', 'tentative', 'needsAction']);

function parseCalendarEvent(e: CalendarEvent, calendarId: string): ParsedCalendarEvent {
  const attendees: ParsedCalendarAttendee[] = (e.attendees ?? []).map((a) => ({
    email: a.email,
    response_status: VALID_RESPONSE_STATUSES.has(a.responseStatus ?? '')
      ? (a.responseStatus as ParsedCalendarAttendee['response_status'])
      : 'needsAction',
  }));
  // Google Meet link: hangoutLink directly OR conferenceData.entryPoints[].uri where entryPointType=='video'
  let meetLink: string | null = e.hangoutLink ?? null;
  if (!meetLink && e.conferenceData?.entryPoints) {
    const video = e.conferenceData.entryPoints.find((ep) => ep.entryPointType === 'video');
    if (video?.uri) meetLink = video.uri;
  }
  return {
    id: e.id ?? '',
    calendar_id: calendarId,
    summary: e.summary ?? '',
    start_at: dateTimeToIso(e.start),
    end_at: dateTimeToIso(e.end),
    organizer: e.organizer?.email ?? null,
    attendees,
    meet_link: meetLink,
  };
}

// ── query_gmail_delta ──────────────────────────────────────────────────────
//
// Container-side. Two modes:
//   - Fixture mode (GMAIL_FIXTURE env set in container): roundtrip to host
//     for fixture loading. Used by integration + e2e tests.
//   - Real mode (env unset): direct HTTPS calls to gmail.googleapis.com via
//     OneCLI's HTTPS_PROXY (the §24.6 rank_leads pattern).

export const queryGmailDelta: McpToolDefinition = {
  tool: {
    name: 'query_gmail_delta',
    description:
      'Fetch new Gmail messages since the last sync. Returns `{ messages, history_id, full_sync_performed, fixture_mode }` where messages is an array of `{ id, thread_id, labels, from_addr, to_addr, subject, received_at, body_text }`. In real mode: container-side direct HTTPS to gmail.googleapis.com through the OneCLI gateway (which injects the OAuth bearer transparently). In fixture mode (GMAIL_FIXTURE env set): the host serves the named fixture from tests/fixtures/gmail/. Read-only — does NOT write any state. Intended for the funnel-curator subagent only; do NOT call from orchestrator turns.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  async handler() {
    const fixtureName = process.env.GMAIL_FIXTURE;
    if (fixtureName) {
      const res = await sendAction<{ messages: unknown[]; fixture: string }>('career_pilot.load_gmail_fixture', {
        name: fixtureName,
      });
      if (!res.ok) return actionErr('query_gmail_delta (fixture)', res.error);
      const { messages } = res.data;
      return ok(
        `query_gmail_delta: ${messages.length} message${messages.length === 1 ? '' : 's'} (fixture: ${fixtureName}).`,
        {
          messages,
          history_id: null,
          full_sync_performed: true,
          fixture_mode: true,
        },
      );
    }

    // ── Real mode ───────────────────────────────────────────────────────
    try {
      const stateRes = await sendAction<{ history_id: string | null }>('career_pilot.get_gmail_sync_state', {});
      if (!stateRes.ok) return actionErr('query_gmail_delta (sync state)', stateRes.error);
      // Guard the null→"null" stringification: a stored historyId of the literal
      // string "null"/"undefined"/"" is truthy but invalid — sending it as
      // startHistoryId 400s Gmail ("Invalid value at 'start_history_id', null").
      // Treat it as "no prior" → fall through to the full-sync path, which
      // re-seeds a real historyId (heals the box's broken morning curator).
      const rawHistoryId = stateRes.data.history_id;
      const priorHistoryId =
        rawHistoryId && rawHistoryId !== 'null' && rawHistoryId !== 'undefined' ? rawHistoryId : null;

      const lookbackDays = Number(process.env.FUNNEL_CURATOR_GMAIL_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS;

      let messageIds: string[] = [];
      let newHistoryId: string | null = null;
      let fullSyncPerformed = false;

      if (priorHistoryId) {
        try {
          const data = await gmailFetch<GmailHistoryResponse>(
            `/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(priorHistoryId)}&historyTypes=messageAdded`,
          );
          newHistoryId = data.historyId ?? priorHistoryId;
          const seen = new Set<string>();
          for (const h of data.history ?? []) {
            for (const ma of h.messagesAdded ?? []) {
              if (!seen.has(ma.message.id)) {
                seen.add(ma.message.id);
                messageIds.push(ma.message.id);
              }
            }
            for (const m of h.messages ?? []) {
              if (!seen.has(m.id)) {
                seen.add(m.id);
                messageIds.push(m.id);
              }
            }
          }
        } catch (e) {
          if (e instanceof GmailApiError && e.status === 404) {
            // historyId expired → fall through to full-sync path below
            messageIds = [];
            newHistoryId = null;
          } else {
            throw e;
          }
        }
      }

      if (!priorHistoryId || newHistoryId === null) {
        // Full-sync via messages.list with date window. Cap at 200 to bound
        // first-run cost; subsequent runs are delta-only.
        fullSyncPerformed = true;
        const after = gmailDateFromLookback(lookbackDays);
        let pageToken: string | undefined;
        const cap = 200;
        const seen = new Set<string>();
        do {
          const qs = `q=${encodeURIComponent(`after:${after}`)}&maxResults=100${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`;
          const data = await gmailFetch<GmailMessagesListResponse>(`/gmail/v1/users/me/messages?${qs}`);
          for (const m of data.messages ?? []) {
            if (!seen.has(m.id)) {
              seen.add(m.id);
              messageIds.push(m.id);
              if (messageIds.length >= cap) break;
            }
          }
          pageToken = data.nextPageToken;
        } while (pageToken && messageIds.length < cap);

        const profile = await gmailFetch<GmailProfileResponse>('/gmail/v1/users/me/profile');
        newHistoryId = profile.historyId ?? null;
      }

      // Fetch full content for each new message ID. Sequential to keep the
      // request budget predictable; 200-msg cap means at most ~30s worst
      // case at typical Gmail latency. Could be parallelized later.
      const messages: ParsedGmailMessage[] = [];
      for (const id of messageIds) {
        try {
          const m = await gmailFetch<GmailMessageFull>(
            `/gmail/v1/users/me/messages/${encodeURIComponent(id)}?format=FULL`,
          );
          messages.push(parseGmailMessage(m));
        } catch {
          // Skip messages we can't fetch (e.g., recently-deleted); don't
          // fail the whole call. The next run will retry naturally.
        }
      }

      return ok(
        `query_gmail_delta: ${messages.length} message${messages.length === 1 ? '' : 's'}${fullSyncPerformed ? ' (full sync)' : ''}.`,
        {
          messages,
          history_id: newHistoryId,
          full_sync_performed: fullSyncPerformed,
          fixture_mode: false,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`query_gmail_delta failed: ${msg}`);
    }
  },
};

// ── query_calendar_delta ───────────────────────────────────────────────────

export const queryCalendarDelta: McpToolDefinition = {
  tool: {
    name: 'query_calendar_delta',
    description:
      'Fetch new Calendar events since the last sync. Returns `{ events, sync_tokens, full_sync_performed, fixture_mode }` where events is an array of `{ id, calendar_id, summary, start_at, end_at, organizer, attendees, meet_link }`. In real mode: container-side direct HTTPS to www.googleapis.com/calendar/... through the OneCLI gateway. In fixture mode (CALENDAR_FIXTURE env set): the host serves the named fixture from tests/fixtures/calendar/. Read-only — does NOT write any state. Intended for the funnel-curator subagent only.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  async handler() {
    const fixtureName = process.env.CALENDAR_FIXTURE;
    if (fixtureName) {
      const res = await sendAction<{ events: unknown[]; fixture: string }>('career_pilot.load_calendar_fixture', {
        name: fixtureName,
      });
      if (!res.ok) return actionErr('query_calendar_delta (fixture)', res.error);
      const { events } = res.data;
      return ok(
        `query_calendar_delta: ${events.length} event${events.length === 1 ? '' : 's'} (fixture: ${fixtureName}).`,
        {
          events,
          sync_tokens: {},
          full_sync_performed: true,
          fixture_mode: true,
        },
      );
    }

    // ── Real mode ───────────────────────────────────────────────────────
    try {
      const stateRes = await sendAction<{ sync_tokens: Record<string, string> }>(
        'career_pilot.get_calendar_sync_state',
        {},
      );
      if (!stateRes.ok) return actionErr('query_calendar_delta (sync state)', stateRes.error);
      const priorSyncTokens = stateRes.data.sync_tokens ?? {};

      const lookbackDays = Number(process.env.FUNNEL_CURATOR_GMAIL_LOOKBACK_DAYS) || DEFAULT_LOOKBACK_DAYS;

      // v1: poll the 'primary' calendar only. Multi-calendar fits cleanly later.
      const calendarId = 'primary';
      const events: ParsedCalendarEvent[] = [];
      const newSyncTokens: Record<string, string> = { ...priorSyncTokens };
      let fullSyncPerformed = false;
      const priorToken = priorSyncTokens[calendarId];

      const doFetch = async (qs: string): Promise<CalendarEventsListResponse> => {
        const t0 = Date.now();
        const tel = (ok: boolean, statusCode: number | null, error?: string): void => {
          void reportRequestTelemetry({
            provider: 'calendar',
            surface: 'funnel-curator-calendar',
            ok,
            latencyMs: Date.now() - t0,
            statusCode,
            error: error ?? null,
          });
        };
        let res: Response;
        try {
          res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${qs}`,
            { method: 'GET', headers: { Accept: 'application/json', 'x-onecli-placeholder': '1' } },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          tel(false, null, message);
          throw new CalendarApiError(0, message);
        }
        if (res.status === 410) {
          tel(false, 410, 'syncToken expired (410)');
          throw new CalendarApiError(410, 'syncToken expired (410)');
        }
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          const message = `${res.status} ${res.statusText}${body ? ' — ' + body.slice(0, 200) : ''}`;
          tel(false, res.status, message);
          throw new CalendarApiError(res.status, message);
        }
        tel(true, res.status);
        return (await res.json()) as CalendarEventsListResponse;
      };

      let pageToken: string | undefined;
      let useTokenMode = !!priorToken;
      while (true) {
        const qs =
          useTokenMode && priorToken && !pageToken
            ? `syncToken=${encodeURIComponent(priorToken)}&singleEvents=true&maxResults=100`
            : useTokenMode && pageToken
              ? `syncToken=${encodeURIComponent(priorToken!)}&singleEvents=true&maxResults=100&pageToken=${encodeURIComponent(pageToken)}`
              : pageToken
                ? `timeMin=${encodeURIComponent(new Date(Date.now() - lookbackDays * 86_400_000).toISOString())}&singleEvents=true&maxResults=100&pageToken=${encodeURIComponent(pageToken)}`
                : `timeMin=${encodeURIComponent(new Date(Date.now() - lookbackDays * 86_400_000).toISOString())}&singleEvents=true&maxResults=100`;

        try {
          const data = await doFetch(qs);
          for (const e of data.items ?? []) {
            events.push(parseCalendarEvent(e, calendarId));
          }
          if (data.nextSyncToken) newSyncTokens[calendarId] = data.nextSyncToken;
          if (data.nextPageToken) {
            pageToken = data.nextPageToken;
          } else {
            break;
          }
        } catch (e) {
          if (e instanceof CalendarApiError && e.status === 410 && useTokenMode) {
            // syncToken expired → restart from full-sync (timeMin)
            fullSyncPerformed = true;
            useTokenMode = false;
            pageToken = undefined;
            events.length = 0;
            continue;
          }
          throw e;
        }
      }

      if (!priorToken) fullSyncPerformed = true;

      return ok(
        `query_calendar_delta: ${events.length} event${events.length === 1 ? '' : 's'}${fullSyncPerformed ? ' (full sync)' : ''}.`,
        {
          events,
          sync_tokens: newSyncTokens,
          full_sync_performed: fullSyncPerformed,
          fixture_mode: false,
        },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return err(`query_calendar_delta failed: ${msg}`);
    }
  },
};

// ── persist_funnel_state ───────────────────────────────────────────────────

export const persistFunnelState: McpToolDefinition = {
  tool: {
    name: 'persist_funnel_state',
    description:
      "Single transactional write of the curator's run output. UPSERTs new email_events rows (keyed by gmail_msg_id — re-classifications overwrite), INSERTs a funnel_curator_output row, and updates the gmail/calendar sync-state pointers. Returns `{ run_id, events_written }`. Call this EXACTLY ONCE per curator spawn, at the end of reasoning, with the full run payload. Set cheap_out=true when both Gmail + Calendar deltas were empty AND no ghosting-threshold transitions are due — emits an audit row without doing classification work. Intended for the funnel-curator subagent only.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        new_email_events: {
          type: 'array',
          description:
            'Per-message classifications written this run. Each item: { gmail_msg_id, thread_id, classification (one of application_confirmation/screen_invite/screen_rejection/take_home_delivery/onsite_invite/next_round_update/offer/rejection/cold_recruiter_outreach/reference_check/noise/unclassified), confidence (0..1), linked_job_lead_id?, linked_application_id?, from_addr?, subject?, received_at?, evidence_excerpt? (≤500 chars) }. Empty array OK when cheap_out=true.',
          items: { type: 'object' },
        },
        narratives: {
          type: 'array',
          description:
            'One per active application/company. Each: { company, application_id?, lead_id?, current_state, last_event_at?, timeline_excerpt[] }. Capped at the funnel_curator_max_narratives preference.',
          items: { type: 'object' },
        },
        attention: {
          type: 'array',
          description:
            "Prioritized list of items needing the candidate's attention. Each: { priority (one of same_day/action_owed/fyi), reason, application_id?, company?, action_hint? }. Capped at funnel_curator_max_attention_items.",
          items: { type: 'object' },
        },
        suggestions: {
          type: 'array',
          description:
            'Read-only state-change suggestions for the orchestrator to act on (or surface for confirm). Each: { action (mark_applied|mark_interviewing|mark_rejected|mark_offer|create_lead|confirm_match|draft_followup), target_id?, evidence_msg_id?, rationale }. The curator does NOT directly mutate application status — it proposes; the orchestrator applies (gated by approval_scope).',
          items: { type: 'object' },
        },
        gmail_history_id: {
          type: 'string',
          description:
            'Snapshot of the Gmail historyId at the end of this run. Updates gmail_sync_state.primary so the next delta-fetch starts from here.',
        },
        calendar_sync_tokens: {
          type: 'object',
          description:
            'Map of { calendar_id → sync_token } captured at the end of this run. Each pair UPSERTs calendar_sync_state.',
        },
        cheap_out: {
          type: 'boolean',
          description:
            'True when both deltas were empty AND no ghosting transitions due — exit early without classification pass.',
        },
        cost_usd: {
          type: 'number',
          description: 'Estimated $ cost of this curator run (for telemetry). Optional.',
        },
      },
      required: ['new_email_events', 'narratives', 'attention', 'suggestions', 'cheap_out'],
    },
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const res = await sendAction<{ run_id: string; events_written: number }>('career_pilot.persist_funnel_state', args);
    if (!res.ok) return actionErr('persist_funnel_state', res.error);
    const { run_id, events_written } = res.data;
    return ok(
      `persist_funnel_state: run ${run_id} written (${events_written} event row${events_written === 1 ? '' : 's'}).`,
      res.data,
    );
  },
};

// ── read_funnel_state ──────────────────────────────────────────────────────

export const readFunnelState: McpToolDefinition = {
  tool: {
    name: 'read_funnel_state',
    description:
      "Read the most-recent funnel_curator_output (the materialized read-model). Returns `{ state }` where state is `{ id, run_at, gmail_history_id, calendar_sync_tokens, narratives, attention, suggestions, cheap_out, cost_usd }` — or `{ state: null }` when no curator runs have happened yet. Cheap DB read, no LLM. Use this in two places: (1) the orchestrator's funnel-curator handler after the subagent returns; (2) on-demand persona pattern when the candidate asks 'what's the state of X?' or 'what needs attention?' — pull from cache rather than re-spawning the curator.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  async handler() {
    const res = await sendAction<{ state: unknown }>('career_pilot.read_funnel_state', {});
    if (!res.ok) return actionErr('read_funnel_state', res.error);
    const { state } = res.data as { state: { run_at?: string; narratives?: unknown[]; attention?: unknown[] } | null };
    if (!state) return ok('read_funnel_state: no curator runs yet.', { state: null });
    const narrativeCount = Array.isArray(state.narratives) ? state.narratives.length : 0;
    const attentionCount = Array.isArray(state.attention) ? state.attention.length : 0;
    return ok(
      `read_funnel_state: ${narrativeCount} narrative${narrativeCount === 1 ? '' : 's'}, ${attentionCount} attention item${attentionCount === 1 ? '' : 's'} (run_at ${state.run_at}).`,
      res.data as unknown as Record<string, unknown>,
    );
  },
};

// ── read_email_events ──────────────────────────────────────────────────────

export const readEmailEvents: McpToolDefinition = {
  tool: {
    name: 'read_email_events',
    description:
      "Filtered query against the email_events audit table (curator's prior classifications). Returns `{ events, total }` where events is an array of `{ gmail_msg_id, thread_id, classification, confidence, linked_job_lead_id, linked_application_id, from_addr, subject, received_at, evidence_excerpt, classified_at, classified_by_run_id }`. Filter by `application_id`, `lead_id`, `thread_id`, or `since` (ISO timestamp). Limit defaults to 50, max 200. Cheap DB read. Used by the orchestrator to pull narrative evidence on-demand ('show me the thread for Acme') and by the curator to access prior classifications during synthesis.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        application_id: {
          type: 'string',
          description: 'Filter to events linked to this application id.',
        },
        lead_id: {
          type: 'string',
          description: 'Filter to events linked to this job_lead id.',
        },
        thread_id: {
          type: 'string',
          description: 'Filter to events in this Gmail thread.',
        },
        since: {
          type: 'string',
          description: 'ISO timestamp; only return events classified at or after this time.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max events to return. Default 50, max 200.',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const res = await sendAction<{ events: unknown[]; total: number }>('career_pilot.read_email_events', args);
    if (!res.ok) return actionErr('read_email_events', res.error);
    const { total } = res.data;
    return ok(
      `read_email_events: ${total} event${total === 1 ? '' : 's'}.`,
      res.data as unknown as Record<string, unknown>,
    );
  },
};

registerTools([queryGmailDelta, queryCalendarDelta, persistFunnelState, readFunnelState, readEmailEvents]);
