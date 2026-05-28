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

// ── query_gmail_delta ──────────────────────────────────────────────────────

export const queryGmailDelta: McpToolDefinition = {
  tool: {
    name: 'query_gmail_delta',
    description:
      "Fetch new Gmail messages since the last sync. Returns `{ messages, history_id, full_sync_performed, fixture_mode }` where messages is an array of `{ id, thread_id, labels, from_addr, to_addr, subject, received_at, body_text }`. In production: driven by the stored Gmail historyId — falls back to a lookback-window full sync if Google returned HTTP 404 (historyId expired). In test/e2e: when GMAIL_FIXTURE env is set on the host, returns the named fixture from tests/fixtures/gmail/. Read-only — does NOT write any state. Intended for the funnel-curator subagent only; do NOT call from orchestrator turns.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  async handler() {
    const res = await sendAction<{
      messages: unknown[];
      history_id: string | null;
      full_sync_performed: boolean;
      fixture_mode: boolean;
    }>('career_pilot.gmail_query_delta', {});
    if (!res.ok) return actionErr('query_gmail_delta', res.error);
    const { messages, full_sync_performed, fixture_mode } = res.data;
    const tag = fixture_mode ? ' (fixture)' : full_sync_performed ? ' (full sync)' : '';
    return ok(`query_gmail_delta: ${messages.length} message${messages.length === 1 ? '' : 's'}${tag}.`, res.data as unknown as Record<string, unknown>);
  },
};

// ── query_calendar_delta ───────────────────────────────────────────────────

export const queryCalendarDelta: McpToolDefinition = {
  tool: {
    name: 'query_calendar_delta',
    description:
      "Fetch new Calendar events since the last sync. Returns `{ events, sync_tokens, full_sync_performed, fixture_mode }` where events is an array of `{ id, calendar_id, summary, start_at, end_at, organizer, attendees, meet_link }`. In production: driven by per-calendar syncTokens — falls back to lookback-window full re-sync if Google returned HTTP 410 (token expired). In test/e2e: when CALENDAR_FIXTURE env is set on the host, returns the named fixture from tests/fixtures/calendar/. Read-only — does NOT write any state. Intended for the funnel-curator subagent only.",
    inputSchema: {
      type: 'object' as const,
      properties: {},
    },
    annotations: { readOnlyHint: true },
  },
  async handler() {
    const res = await sendAction<{
      events: unknown[];
      sync_tokens: Record<string, string>;
      full_sync_performed: boolean;
      fixture_mode: boolean;
    }>('career_pilot.calendar_query_delta', {});
    if (!res.ok) return actionErr('query_calendar_delta', res.error);
    const { events, full_sync_performed, fixture_mode } = res.data;
    const tag = fixture_mode ? ' (fixture)' : full_sync_performed ? ' (full sync)' : '';
    return ok(`query_calendar_delta: ${events.length} event${events.length === 1 ? '' : 's'}${tag}.`, res.data as unknown as Record<string, unknown>);
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
            "Per-message classifications written this run. Each item: { gmail_msg_id, thread_id, classification (one of application_confirmation/screen_invite/screen_rejection/take_home_delivery/onsite_invite/next_round_update/offer/rejection/cold_recruiter_outreach/reference_check/noise/unclassified), confidence (0..1), linked_job_lead_id?, linked_application_id?, from_addr?, subject?, received_at?, evidence_excerpt? (≤500 chars) }. Empty array OK when cheap_out=true.",
          items: { type: 'object' },
        },
        narratives: {
          type: 'array',
          description:
            "One per active application/company. Each: { company, application_id?, lead_id?, current_state, last_event_at?, timeline_excerpt[] }. Capped at the funnel_curator_max_narratives preference.",
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
            "Read-only state-change suggestions for the orchestrator to act on (or surface for confirm). Each: { action (mark_applied|mark_interviewing|mark_rejected|mark_offer|create_lead|confirm_match|draft_followup), target_id?, evidence_msg_id?, rationale }. The curator does NOT directly mutate application status — it proposes; the orchestrator applies (gated by approval_scope).",
          items: { type: 'object' },
        },
        gmail_history_id: {
          type: 'string',
          description: 'Snapshot of the Gmail historyId at the end of this run. Updates gmail_sync_state.primary so the next delta-fetch starts from here.',
        },
        calendar_sync_tokens: {
          type: 'object',
          description: 'Map of { calendar_id → sync_token } captured at the end of this run. Each pair UPSERTs calendar_sync_state.',
        },
        cheap_out: {
          type: 'boolean',
          description: 'True when both deltas were empty AND no ghosting transitions due — exit early without classification pass.',
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
    const res = await sendAction<{ run_id: string; events_written: number }>(
      'career_pilot.persist_funnel_state',
      args,
    );
    if (!res.ok) return actionErr('persist_funnel_state', res.error);
    const { run_id, events_written } = res.data;
    return ok(`persist_funnel_state: run ${run_id} written (${events_written} event row${events_written === 1 ? '' : 's'}).`, res.data);
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
    const res = await sendAction<{ events: unknown[]; total: number }>(
      'career_pilot.read_email_events',
      args,
    );
    if (!res.ok) return actionErr('read_email_events', res.error);
    const { total } = res.data;
    return ok(`read_email_events: ${total} event${total === 1 ? '' : 's'}.`, res.data as unknown as Record<string, unknown>);
  },
};

registerTools([queryGmailDelta, queryCalendarDelta, persistFunnelState, readFunnelState, readEmailEvents]);
