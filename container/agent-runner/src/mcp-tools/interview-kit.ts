/**
 * interview-kit MCP tool.
 *
 * persist_interview_kit — the build-interview-kit subagent's single writer.
 * Round-trips through the host system-action contract (../career-pilot/action.ts
 * + src/modules/career-pilot/interview-kit-actions.ts) to materialize the kit as
 * a native Google Doc in the candidate's career-account Drive and UPSERT the
 * interview_kits row. The subagent passes the kit content; the host owns all
 * Drive mechanics (folder, Archive/, create-vs-update by application+round).
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

export const persistInterviewKit: McpToolDefinition = {
  tool: {
    name: 'persist_interview_kit',
    description:
      "Materialize (or refresh) a mock-interview kit as a Google Doc in the candidate's career-account Drive and record it. Pass the FULL kit as markdown (the host converts it to a native Doc) plus its metadata; the host owns all Drive mechanics — the folder, the Archive/ subfolder, and the create-vs-update decision keyed on (application_id, round). Returns `{ kit_id, drive_url, drive_file_id, round }`. Call this EXACTLY ONCE at the end of your run with the complete two-part kit. Intended for the build-interview-kit subagent only.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        application_id: {
          type: 'string',
          description: 'The application this interview belongs to (provided in your invocation prompt).',
        },
        round: {
          type: 'string',
          description: 'The interview round / application status: SCREENING | TECH_SCREEN | SYS_DESIGN | FINAL.',
        },
        interview_type: {
          type: 'string',
          description: 'recruiter_screen | technical_screen | system_design | final_round (derived from the round).',
        },
        title: {
          type: 'string',
          description:
            'Doc title, e.g. "Interview Kit — Acme — Tech Screen — 2026-06-09". Use the REAL company name (this is the candidate\'s private Drive, never published).',
        },
        markdown: {
          type: 'string',
          description:
            'The full kit as markdown — Part 1 (interviewer operating-manual: rules of engagement + scoring rubric + grounding facts + gap-notes-to-probe) and Part 2 (candidate quick-reference: recent signal + what to lean into + questions to ask).',
        },
        interview_at: {
          type: 'string',
          description: 'ISO datetime of the interview if known; omit when TBD.',
        },
      },
      required: ['application_id', 'round', 'interview_type', 'title', 'markdown'],
    },
    annotations: { readOnlyHint: false },
  },
  async handler(args) {
    const res = await sendAction<{ kit_id: string; drive_url: string; drive_file_id: string; round: string }>(
      'career_pilot.persist_interview_kit',
      args,
    );
    if (!res.ok) return err(`persist_interview_kit failed (${res.error.code}): ${res.error.message}`);
    return ok(
      `persist_interview_kit: kit ${res.data.kit_id} (${res.data.round}) → ${res.data.drive_url}`,
      res.data as unknown as Record<string, unknown>,
    );
  },
};

registerTools([persistInterviewKit]);
