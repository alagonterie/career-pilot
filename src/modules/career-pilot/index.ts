/**
 * Career-pilot host module barrel.
 *
 * Side-effect: registers our delivery action handlers with the host's
 * delivery sweep so the container's MCP tools can round-trip through
 * the system-action contract (see STRATEGY.md §6.1 + actions.ts).
 *
 * Imported from `src/modules/index.ts` at host startup.
 */
import { registerDeliveryAction } from '../../delivery.js';

import {
  handleCreateGmailDraft,
  handleGetApplication,
  handleListApplications,
  handleRecordFunnelEvent,
  handleRecordProgress,
  handleUpdateApplication,
  handleUpdateProfileField,
} from './actions.js';
import {
  handleClaimKillerMatches,
  handleCloseStaleLeads,
  handleDiscoverAtsBoard,
  handleFetchSource,
  handleGetLeadSummariesForRanking,
  handleQueryJobLeads,
  handleRecordJobLead,
  handleUpdateJobLeadStatus,
  handleWriteLlmScores,
} from './job-lead-actions.js';
import {
  handleCalendarQueryDelta,
  handleGetCalendarSyncState,
  handleGetGmailSyncState,
  handleGmailQueryDelta,
  handleLoadCalendarFixture,
  handleLoadGmailFixture,
  handlePersistFunnelState,
  handleReadEmailEvents,
  handleReadFunnelState,
} from './funnel-actions.js';

registerDeliveryAction('career_pilot.update_profile_field', handleUpdateProfileField);
registerDeliveryAction('career_pilot.update_application', handleUpdateApplication);
registerDeliveryAction('career_pilot.record_funnel_event', handleRecordFunnelEvent);
registerDeliveryAction('career_pilot.get_application', handleGetApplication);
registerDeliveryAction('career_pilot.list_applications', handleListApplications);
registerDeliveryAction('career_pilot.record_progress', handleRecordProgress);
registerDeliveryAction('career_pilot.create_gmail_draft', handleCreateGmailDraft);
registerDeliveryAction('career_pilot.record_job_lead', handleRecordJobLead);
registerDeliveryAction('career_pilot.query_job_leads', handleQueryJobLeads);
registerDeliveryAction('career_pilot.update_job_lead_status', handleUpdateJobLeadStatus);
registerDeliveryAction('career_pilot.discover_ats_board', handleDiscoverAtsBoard);
registerDeliveryAction('career_pilot.fetch_source', handleFetchSource);
registerDeliveryAction('career_pilot.get_lead_summaries_for_ranking', handleGetLeadSummariesForRanking);
registerDeliveryAction('career_pilot.write_llm_scores', handleWriteLlmScores);
registerDeliveryAction('career_pilot.claim_killer_matches', handleClaimKillerMatches);
registerDeliveryAction('career_pilot.close_stale_leads', handleCloseStaleLeads);
registerDeliveryAction('career_pilot.gmail_query_delta', handleGmailQueryDelta);
registerDeliveryAction('career_pilot.calendar_query_delta', handleCalendarQueryDelta);
registerDeliveryAction('career_pilot.persist_funnel_state', handlePersistFunnelState);
registerDeliveryAction('career_pilot.read_funnel_state', handleReadFunnelState);
registerDeliveryAction('career_pilot.read_email_events', handleReadEmailEvents);
registerDeliveryAction('career_pilot.load_gmail_fixture', handleLoadGmailFixture);
registerDeliveryAction('career_pilot.load_calendar_fixture', handleLoadCalendarFixture);
registerDeliveryAction('career_pilot.get_gmail_sync_state', handleGetGmailSyncState);
registerDeliveryAction('career_pilot.get_calendar_sync_state', handleGetCalendarSyncState);
