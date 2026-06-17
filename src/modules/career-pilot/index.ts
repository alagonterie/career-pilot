/**
 * Career-pilot host module barrel.
 *
 * Side-effect: registers our delivery action handlers with the host's
 * delivery sweep so the container's MCP tools can round-trip through
 * the system-action contract (see STRATEGY.md §6.1 + actions.ts).
 *
 * Imported from `src/modules/index.ts` at host startup.
 */
import { registerDeliveryAction, type DeliveryActionHandler } from '../../delivery.js';

import {
  denyIfNotOwner,
  handleCreateGmailDraft,
  handleGetApplication,
  handleListApplications,
  handleRecordFunnelEvent,
  handleRecordProgress,
  handleRecordRequestTelemetry,
  handleRecordTurnTelemetry,
  handleSetPreference,
  handleSetWorkProfile,
  handleUpdateApplication,
  handleUpdateProfileField,
} from './actions.js';
import {
  handleCheckTriggerEligibility,
  handleClaimKillerMatches,
  handleCloseStaleLeads,
  handleDiscoverAtsBoard,
  handleFetchSource,
  handleGetLeadSummariesForRanking,
  handleQueryJobLeads,
  handleRecordJobLead,
  handleStashJobPayloads,
  handleUpdateJobLeadStatus,
  handleWriteLlmScores,
} from './job-lead-actions.js';
import {
  handleCalendarQueryDelta,
  handleFilterSeenEmailEvents,
  handleGetCalendarSyncState,
  handleGetGmailSyncState,
  handleGmailQueryDelta,
  handleLoadCalendarFixture,
  handleLoadGmailFixture,
  handlePersistFunnelState,
  handleReadEmailEvents,
  handleReadFunnelState,
} from './funnel-actions.js';
import { handlePersistInterviewKit } from './interview-kit-actions.js';

/**
 * Every career_pilot action that touches private candidate data is owner-only —
 * the sandbox group must never reach it. Register each behind the §24.19
 * Layer-2 owner gate so the chokepoint is a single auditable place and any
 * action added here is guarded by construction. For the owner group
 * (`folder === 'career-pilot'`) the gate is a no-op; for a sandbox session it
 * writes FORBIDDEN and the handler never runs. The two telemetry actions are
 * the deliberate exception (§24.68 D-C) — registered plain below, sandbox-safe
 * by construction inside their handlers.
 */
function registerOwnerOnly(action: string, handler: DeliveryActionHandler): void {
  registerDeliveryAction(action, async (content, session, inDb) => {
    if (denyIfNotOwner(action, content, session, inDb)) return;
    await handler(content, session, inDb);
  });
}

registerOwnerOnly('career_pilot.update_profile_field', handleUpdateProfileField);
registerOwnerOnly('career_pilot.set_work_profile', handleSetWorkProfile);
registerOwnerOnly('career_pilot.set_preference', handleSetPreference);
registerOwnerOnly('career_pilot.update_application', handleUpdateApplication);
registerOwnerOnly('career_pilot.record_funnel_event', handleRecordFunnelEvent);
registerOwnerOnly('career_pilot.get_application', handleGetApplication);
registerOwnerOnly('career_pilot.list_applications', handleListApplications);
registerOwnerOnly('career_pilot.record_progress', handleRecordProgress);
// The two telemetry actions register PLAIN, not owner-only (§24.68 D-C): a
// sandbox emission writes a private numbers-only request_telemetry row classed
// 'sandbox' host-side — and never a public_audit_trail row (the invariant
// moved into handleRecordTurnTelemetry's branch, pinned by integration test).
registerDeliveryAction('career_pilot.record_turn_telemetry', handleRecordTurnTelemetry);
registerDeliveryAction('career_pilot.record_request_telemetry', handleRecordRequestTelemetry);
registerOwnerOnly('career_pilot.create_gmail_draft', handleCreateGmailDraft);
registerOwnerOnly('career_pilot.record_job_lead', handleRecordJobLead);
registerOwnerOnly('career_pilot.query_job_leads', handleQueryJobLeads);
registerOwnerOnly('career_pilot.update_job_lead_status', handleUpdateJobLeadStatus);
registerOwnerOnly('career_pilot.discover_ats_board', handleDiscoverAtsBoard);
registerOwnerOnly('career_pilot.fetch_source', handleFetchSource);
registerOwnerOnly('career_pilot.stash_job_payloads', handleStashJobPayloads);
registerOwnerOnly('career_pilot.get_lead_summaries_for_ranking', handleGetLeadSummariesForRanking);
registerOwnerOnly('career_pilot.write_llm_scores', handleWriteLlmScores);
registerOwnerOnly('career_pilot.claim_killer_matches', handleClaimKillerMatches);
registerOwnerOnly('career_pilot.close_stale_leads', handleCloseStaleLeads);
registerOwnerOnly('career_pilot.check_trigger_eligibility', handleCheckTriggerEligibility);
registerOwnerOnly('career_pilot.gmail_query_delta', handleGmailQueryDelta);
registerOwnerOnly('career_pilot.calendar_query_delta', handleCalendarQueryDelta);
registerOwnerOnly('career_pilot.persist_funnel_state', handlePersistFunnelState);
registerOwnerOnly('career_pilot.read_funnel_state', handleReadFunnelState);
registerOwnerOnly('career_pilot.persist_interview_kit', handlePersistInterviewKit);
registerOwnerOnly('career_pilot.read_email_events', handleReadEmailEvents);
registerOwnerOnly('career_pilot.load_gmail_fixture', handleLoadGmailFixture);
registerOwnerOnly('career_pilot.load_calendar_fixture', handleLoadCalendarFixture);
registerOwnerOnly('career_pilot.get_gmail_sync_state', handleGetGmailSyncState);
registerOwnerOnly('career_pilot.get_calendar_sync_state', handleGetCalendarSyncState);
registerOwnerOnly('career_pilot.filter_seen_email_events', handleFilterSeenEmailEvents);
