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

registerDeliveryAction('career_pilot.update_profile_field', handleUpdateProfileField);
registerDeliveryAction('career_pilot.update_application', handleUpdateApplication);
registerDeliveryAction('career_pilot.record_funnel_event', handleRecordFunnelEvent);
registerDeliveryAction('career_pilot.get_application', handleGetApplication);
registerDeliveryAction('career_pilot.list_applications', handleListApplications);
registerDeliveryAction('career_pilot.record_progress', handleRecordProgress);
registerDeliveryAction('career_pilot.create_gmail_draft', handleCreateGmailDraft);
