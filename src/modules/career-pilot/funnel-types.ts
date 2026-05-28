/**
 * Shared TypeScript types for the funnel-curator subsystem (Phase 3.2 §24.9).
 *
 * The parsed Gmail / Calendar shapes here describe what the host actions
 * (`gmail_query_delta`, `calendar_query_delta`) return to the funnel-curator
 * subagent. The fixture loader at `scripts/test/load-funnel-fixtures.ts`
 * normalizes its higher-level fixture format into these same shapes, so a
 * test against a fixture is indistinguishable from a real Google API
 * response at the curator's tool-call boundary.
 */

export interface ParsedGmailMessage {
  id: string;
  thread_id: string;
  labels: string[];
  from_addr: string;
  to_addr: string;
  subject: string;
  received_at: string;
  body_text: string;
}

export interface ParsedCalendarAttendee {
  email: string;
  response_status: 'accepted' | 'declined' | 'tentative' | 'needsAction';
}

export interface ParsedCalendarEvent {
  id: string;
  calendar_id: string;
  summary: string;
  start_at: string;
  end_at: string;
  organizer: string | null;
  attendees: ParsedCalendarAttendee[];
  meet_link: string | null;
}

export const EMAIL_CLASSIFICATIONS = [
  'application_confirmation',
  'screen_invite',
  'screen_rejection',
  'take_home_delivery',
  'onsite_invite',
  'next_round_update',
  'offer',
  'rejection',
  'cold_recruiter_outreach',
  'reference_check',
  'noise',
  'unclassified',
] as const;

export type EmailClassification = (typeof EMAIL_CLASSIFICATIONS)[number];

export interface NewEmailEvent {
  gmail_msg_id: string;
  thread_id: string;
  classification: EmailClassification;
  confidence: number;
  linked_job_lead_id: string | null;
  linked_application_id: string | null;
  from_addr: string | null;
  subject: string | null;
  received_at: string | null;
  evidence_excerpt: string | null;
}

export interface FunnelNarrative {
  company: string;
  application_id: string | null;
  lead_id: string | null;
  current_state: string;
  last_event_at: string | null;
  timeline_excerpt: string[];
}

export interface FunnelAttentionItem {
  priority: 'same_day' | 'action_owed' | 'fyi';
  reason: string;
  application_id: string | null;
  company: string | null;
  action_hint: string | null;
}

export interface FunnelSuggestion {
  action:
    | 'mark_applied'
    | 'mark_interviewing'
    | 'mark_rejected'
    | 'mark_offer'
    | 'create_lead'
    | 'confirm_match'
    | 'draft_followup';
  target_id: string | null;
  evidence_msg_id: string | null;
  rationale: string;
}

export interface FunnelCuratorOutput {
  new_email_events: NewEmailEvent[];
  narratives: FunnelNarrative[];
  attention: FunnelAttentionItem[];
  suggestions: FunnelSuggestion[];
  gmail_history_id: string | null;
  calendar_sync_tokens: Record<string, string>;
  cheap_out: boolean;
  cost_usd: number | null;
}
