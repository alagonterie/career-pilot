import { describe, expect, it } from 'vitest';

import { OWNER_DISALLOWED_TOOLS } from './owner-disallowed-tools.js';

// §24.49d: the owner tool-palette trim. The load-bearing guard is the second
// test — disallowing a tool the orchestrator or a subagent actually calls would
// silently break a flow, so we assert none of the in-use tools can appear here.

// Tools the orchestrator (persona) or any of the six subagents actually invoke.
// Sourced from the persona's built-in list + the agents/*.md `tools:` palettes.
const TOOLS_IN_USE = [
  // orchestrator built-ins
  'Read',
  'Write',
  'Edit',
  'Bash',
  'Glob',
  'Grep',
  'WebSearch',
  'WebFetch',
  'Agent',
  'Task',
  'TodoWrite',
  // NOTE: `Skill` is intentionally NOT here. The owner has the Skill tool in its
  // default palette but never INVOKES a skill (the persona only listed it), so
  // §24.49e disallows it to drop the whole skills-descriptions block. If a
  // future custom-skills refactor makes the owner actually invoke a skill, move
  // `Skill` back here AND remove it from OWNER_DISALLOWED_TOOLS together.
  // MCP tools the orchestrator + subagents use
  'mcp__nanoclaw__record_progress',
  'mcp__nanoclaw__fetch_source',
  'mcp__nanoclaw__record_job_lead',
  'mcp__nanoclaw__query_gmail_delta',
  'mcp__nanoclaw__query_calendar_delta',
  'mcp__nanoclaw__list_applications',
  'mcp__nanoclaw__get_application',
  'mcp__nanoclaw__query_job_leads',
  'mcp__nanoclaw__read_funnel_state',
  'mcp__nanoclaw__read_email_events',
  'mcp__nanoclaw__persist_funnel_state',
  'mcp__nanoclaw__create_gmail_draft',
  'mcp__nanoclaw__update_application',
  'mcp__nanoclaw__record_funnel_event',
  'mcp__nanoclaw__update_profile_field',
  'mcp__nanoclaw__update_job_lead_status',
  'mcp__nanoclaw__rank_leads',
  'mcp__nanoclaw__query_killer_matches',
  'mcp__nanoclaw__close_stale_leads',
  'mcp__nanoclaw__schedule_task',
  'mcp__nanoclaw__send_message',
  'mcp__nanoclaw__send_file',
];

describe('OWNER_DISALLOWED_TOOLS', () => {
  it('is exactly the audited 13-tool trim (12 from §24.49d + Skill from §24.49e)', () => {
    expect([...OWNER_DISALLOWED_TOOLS].sort()).toEqual(
      [
        'Monitor',
        'NotebookEdit',
        'PushNotification',
        'RemoteTrigger',
        'SendMessage',
        'Skill',
        'TaskOutput',
        'TaskStop',
        'TeamCreate',
        'TeamDelete',
        'mcp__nanoclaw__add_mcp_server',
        'mcp__nanoclaw__create_agent',
        'mcp__nanoclaw__install_packages',
      ].sort(),
    );
  });

  it('never disallows a tool the orchestrator or a subagent uses', () => {
    const overlap = OWNER_DISALLOWED_TOOLS.filter((t) => TOOLS_IN_USE.includes(t));
    expect(overlap).toEqual([]);
  });

  it('has no duplicates', () => {
    expect(new Set(OWNER_DISALLOWED_TOOLS).size).toBe(OWNER_DISALLOWED_TOOLS.length);
  });
});
