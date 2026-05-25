/**
 * In-process MCP tool barrel for the career-pilot agent group.
 *
 * Tools defined here via the Claude Agent SDK's tool() helper are wrapped in
 * createSdkMcpServer({ name: "career-pilot", ... }) and exposed under the
 * mcp__career-pilot__* namespace. Tool visibility per agent group is
 * controlled by container_configs.allowedTools / disallowedTools — NOT by
 * this barrel.
 *
 * See STRATEGY.md §6 for the full tool catalog (14 tools) and
 * AGENT_SDK_PATTERNS.md §7 for the authoring discipline rules (never throw,
 * always structuredContent + isError, readOnlyHint for parallelizable tools).
 *
 * Phase 0 status: PLACEHOLDER. Tools land in Phase 1 (update_application,
 * analyze_jd, sanitize_text, get/list_application, record_funnel_event) and
 * Phase 2 (save_outreach_draft, send_outreach_email, query_gmail,
 * query_calendar, schedule_followup, add_learning, update_profile_field,
 * parse_email).
 */
// import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
//
// export const careerPilotMcpServer = createSdkMcpServer({
//   name: 'career-pilot',
//   version: '0.1.0',
//   tools: [
//     /* Phase 1: */
//     // analyzeJd,
//     // sanitizeText,
//     // updateApplication,
//     // getApplication,
//     // listApplications,
//     // recordFunnelEvent,
//     /* Phase 2: */
//     // saveOutreachDraft,
//     // sendOutreachEmail,
//     // queryGmail,
//     // queryCalendar,
//     // scheduleFollowup,
//     // addLearning,
//     // updateProfileField,
//     // parseEmail,
//   ],
// });

export {}; // placeholder export so this file is a valid module
