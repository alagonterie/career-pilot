/**
 * Career-pilot MCP tools (Phase 1).
 *
 * Five tools that round-trip through the host via the system-action contract
 * (see STRATEGY.md §6.1 + the helper at `../career-pilot/action.ts`):
 *
 *   - update_profile_field   — UPSERT candidate_profile (onboarding-critical)
 *   - update_application     — UPSERT applications (the "add an application" path)
 *   - record_funnel_event    — INSERT funnel_events
 *   - get_application        — SELECT one
 *   - list_applications      — SELECT filtered
 *
 * The persona's "Tools & subagents" section in `groups/career-pilot/
 * .claude-host-fragments/persona.md` instructs the agent on when to use each.
 *
 * Deferred to later phases (per STRATEGY.md §6.2):
 *   - analyze_jd (Phase 2 — needs sub-LLM via OneCLI gateway)
 *   - sanitize_text (Phase 3 — sanitizer pipeline)
 *   - parse_email, save_outreach_draft (Phase 2 — outreach flow)
 *   - send_outreach_email, query_gmail, query_calendar (Phase 2 — Gmail API)
 *   - add_learning (Phase 2 — reflection loop)
 *   - schedule_followup (Phase 2 — leverages NanoClaw schedule_task)
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

/** Format an action error frame as a tool error result. */
function actionErr(action: string, error: { code: string; message: string }) {
  return err(`${action} failed (${error.code}): ${error.message}`);
}

// ── update_profile_field ───────────────────────────────────────────────────

const PROFILE_FIELDS = [
  'full_name',
  'display_name',
  'bio',
  'target_roles',
  'location_pref',
  'comp_floor',
  'master_resume',
  'skills',
  'github_url',
  'linkedin_url',
  'x_url',
  'website_url',
  'public_email',
  'search_goals',
  'headshot_path',
  'brand_color_hsl',
  'gmail_account',
] as const;

export const updateProfileField: McpToolDefinition = {
  tool: {
    name: 'update_profile_field',
    description:
      "Update a single field on the candidate_profile (the candidate's persona content). Use during onboarding (one field per turn) and any time the candidate explicitly updates their profile. The change takes effect on the NEXT container spawn (the persona render hook re-runs and the agent sees the updated context). For JSON-valued fields (target_roles, location_pref, skills), pass the JSON-encoded string.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        field: {
          type: 'string',
          enum: [...PROFILE_FIELDS],
          description: 'Which candidate_profile column to update.',
        },
        value: {
          description:
            'New value. For comp_floor pass an integer (USD/year). For target_roles, location_pref, skills pass a JSON-encoded string (e.g. \'["Staff Backend", "Platform"]\'). For null-able fields pass null to clear.',
        },
      },
      required: ['field', 'value'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const field = args.field as string;
    const value = args.value;
    if (!field || !PROFILE_FIELDS.includes(field as (typeof PROFILE_FIELDS)[number])) {
      return err(`field must be one of: ${PROFILE_FIELDS.join(', ')}`);
    }
    const res = await sendAction<{ field: string }>('career_pilot.update_profile_field', { field, value });
    if (!res.ok) return actionErr('update_profile_field', res.error);
    return ok(`Profile field "${field}" updated.`, { field });
  },
};

// ── update_application ─────────────────────────────────────────────────────

export const updateApplication: McpToolDefinition = {
  tool: {
    name: 'update_application',
    description:
      "UPSERT an application row. If `id` doesn't exist, INSERT (requires company_name + role_title + status in patch; host assigns obfuscated_label deterministically). If `id` exists, UPDATE only the fields present in patch. Use to bookmark a new role, update status after a signal, or correct mistaken fields. Always follow with record_funnel_event to log the transition.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: {
          type: 'string',
          description:
            'Application UUID. Generate a fresh one (any RFC4122-ish string is fine) when creating; reuse an existing id to update.',
        },
        patch: {
          type: 'object',
          description: 'Fields to set. On INSERT, company_name + role_title + status are REQUIRED.',
          properties: {
            company_name: { type: 'string' },
            company_aliases: {
              type: 'string',
              description: 'JSON array of alternate company names for the sanitizer (Phase 3).',
            },
            role_title: { type: 'string' },
            job_url: { type: 'string' },
            jd_text: { type: 'string' },
            jd_analyzed: {
              type: 'string',
              description: 'JSON: { level, skills, comp_hint, role_category }',
            },
            status: {
              type: 'string',
              enum: [
                'BOOKMARKED',
                'APPLIED',
                'SCREENING',
                'TECH_SCREEN',
                'SYS_DESIGN',
                'FINAL',
                'OFFER',
                'REJECTED',
                'WITHDRAWN',
              ],
            },
            win_confidence: { type: 'integer', minimum: 0, maximum: 100 },
            applied_at: { type: 'string', description: 'ISO 8601 timestamp' },
            public_state: {
              type: 'string',
              enum: ['obfuscated', 'partial', 'public'],
              description: 'Defaults to "obfuscated" on INSERT — only set explicitly via confirm-before approval.',
            },
          },
        },
      },
      required: ['id', 'patch'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const id = args.id as string;
    const patch = args.patch as Record<string, unknown>;
    if (!id || !patch || typeof patch !== 'object') {
      return err('id and patch are required');
    }
    const res = await sendAction<{ id: string; created: boolean; obfuscated_label: string | null }>(
      'career_pilot.update_application',
      { id, patch },
    );
    if (!res.ok) return actionErr('update_application', res.error);
    const verb = res.data.created ? 'created' : 'updated';
    const labelSuffix = res.data.obfuscated_label ? ` (label: ${res.data.obfuscated_label})` : '';
    return ok(`Application ${verb}: ${id}${labelSuffix}`, res.data);
  },
};

// ── record_funnel_event ────────────────────────────────────────────────────

const FUNNEL_EVENT_KINDS = [
  'status_change',
  'agent_action',
  'gmail_signal',
  'calendar_signal',
  'reflection_added',
  'outreach_drafted',
  'outreach_sent',
  'interview_scheduled',
] as const;

export const recordFunnelEvent: McpToolDefinition = {
  tool: {
    name: 'record_funnel_event',
    description:
      'Log a funnel event for an application. Always call this alongside any state-changing tool — record the transition (with from/to status if applicable) plus a short payload describing what triggered the event. Phase 3 will add automatic sanitization mirror to public_audit_trail.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        application_id: { type: 'string', description: 'The applications.id this event belongs to.' },
        kind: { type: 'string', enum: [...FUNNEL_EVENT_KINDS] },
        from_status: {
          type: 'string',
          description: 'Previous status (only for kind="status_change").',
        },
        to_status: {
          type: 'string',
          description: 'New status (only for kind="status_change").',
        },
        payload: {
          type: 'object',
          description:
            'Free-form structured payload — schema varies by kind. Common fields: summary (short string), source (gmail_subject / calendar_event_title / agent_reasoning / candidate_message), confidence (0-100).',
        },
      },
      required: ['application_id', 'kind', 'payload'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const application_id = args.application_id as string;
    const kind = args.kind as string;
    const payload = args.payload as Record<string, unknown>;
    if (!application_id || !kind || !payload) {
      return err('application_id, kind, and payload are required');
    }
    if (!FUNNEL_EVENT_KINDS.includes(kind as (typeof FUNNEL_EVENT_KINDS)[number])) {
      return err(`kind must be one of: ${FUNNEL_EVENT_KINDS.join(', ')}`);
    }
    const res = await sendAction<{ event_id: string }>('career_pilot.record_funnel_event', {
      application_id,
      kind,
      from_status: args.from_status ?? null,
      to_status: args.to_status ?? null,
      payload,
    });
    if (!res.ok) return actionErr('record_funnel_event', res.error);
    return ok(`Funnel event recorded: ${res.data.event_id} (${kind})`, res.data);
  },
};

// ── get_application ────────────────────────────────────────────────────────

export const getApplication: McpToolDefinition = {
  tool: {
    name: 'get_application',
    description: 'Fetch one application by id. Returns the full row including jd_analyzed (parsed JSON if present).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        id: { type: 'string', description: 'Application UUID.' },
      },
      required: ['id'],
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const id = args.id as string;
    if (!id) return err('id is required');
    const res = await sendAction<{ application: Record<string, unknown> | null }>('career_pilot.get_application', {
      id,
    });
    if (!res.ok) return actionErr('get_application', res.error);
    if (!res.data.application) {
      return ok(`No application found with id "${id}".`);
    }
    return ok(JSON.stringify(res.data.application, null, 2), res.data);
  },
};

// ── list_applications ──────────────────────────────────────────────────────

export const listApplications: McpToolDefinition = {
  tool: {
    name: 'list_applications',
    description:
      'List applications, optionally filtered by status. Returns up to `limit` rows ordered by last_activity_at DESC (most recent activity first). Pass no filter to see the full funnel.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          enum: [
            'BOOKMARKED',
            'APPLIED',
            'SCREENING',
            'TECH_SCREEN',
            'SYS_DESIGN',
            'FINAL',
            'OFFER',
            'REJECTED',
            'WITHDRAWN',
          ],
          description: 'Filter to one status. Omit to see all.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 200,
          description: 'Max rows to return (default 50).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const res = await sendAction<{ applications: Array<Record<string, unknown>> }>('career_pilot.list_applications', {
      status: (args.status as string | undefined) ?? null,
      limit: (args.limit as number | undefined) ?? 50,
    });
    if (!res.ok) return actionErr('list_applications', res.error);
    const apps = res.data.applications;
    if (apps.length === 0) {
      return ok('No applications found.', { applications: [] });
    }
    const summary = apps
      .map((a) => `- ${a.obfuscated_label} | ${a.role_title} | ${a.status} | ${a.last_activity_at ?? '—'}`)
      .join('\n');
    return ok(`${apps.length} application(s):\n${summary}`, res.data);
  },
};

// ── record_progress ────────────────────────────────────────────────────────

export const recordProgress: McpToolDefinition = {
  tool: {
    name: 'record_progress',
    description:
      'Emit a short progress marker that surfaces on the portal\'s live agent-activity stream (PORTAL.md §5.2). Call 2-4 times per run at meaningful inflection points (e.g., stage="understanding-recipient", "drafting-subject", "drafting-body", "final-pass"). The host caps you at 6 calls per session-subagent-run — over-call returns a RATE_LIMITED error. Subagent identifies itself via `subagent_name` (your frontmatter `name:` value). Detail is short prose (≤80 chars target, 200 cap); PII (emails, phone numbers) is regex-redacted before persistence. This tool is fire-and-forget — its result does not influence your output.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        subagent_name: {
          type: 'string',
          description:
            'Your own subagent name from your frontmatter (e.g. "draft-outreach", "research-company"). Used to attribute the progress row.',
        },
        stage: {
          type: 'string',
          description:
            'Short stage identifier (kebab-case, ≤32 chars). Examples: "understanding-recipient", "drafting-subject", "drafting-body", "final-pass", "researching-funding", "extracting-jd-terms".',
        },
        detail: {
          type: 'string',
          description:
            "One-line prose describing what you're doing right now (≤80 chars target). Visible to portal visitors on the public trace stream — keep it candidate-friendly, no PII (it gets regex-sanitized anyway).",
        },
        application_id: {
          type: 'string',
          description:
            'Optional. The internal application id (e.g. "app-acme") when this run\'s work is about one specific application — pass it on EVERY progress call so the public stream attributes the work to that application. The host derives the public-safe label from the id; never put a company name here or lean on this for the detail text. Omit when the work is not about a single application.',
        },
      },
      required: ['subagent_name', 'stage', 'detail'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const subagent_name = args.subagent_name as string;
    const stage = args.stage as string;
    const detail = args.detail as string;
    const application_id = typeof args.application_id === 'string' && args.application_id ? args.application_id : null;
    if (!subagent_name || !stage || !detail) {
      return err('subagent_name, stage, and detail are all required');
    }
    const res = await sendAction<{ id: string; stage: string }>('career_pilot.record_progress', {
      subagent_name,
      stage,
      detail,
      ...(application_id ? { application_id } : {}),
    });
    if (!res.ok) return actionErr('record_progress', res.error);
    return ok(`Progress recorded (${stage}).`, res.data);
  },
};

// ── create_gmail_draft ─────────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export const createGmailDraft: McpToolDefinition = {
  tool: {
    name: 'create_gmail_draft',
    description:
      "Materialize a Gmail draft on the candidate's behalf. Reversible (no send) — the candidate opens Gmail to review and send. ONLY available in the owner agent group; sandbox sessions get a FORBIDDEN error. Body should already include the candidate's full email content (do NOT append signature/footer here — the orchestrator handles attribution via preferences.outreach_show_ai_attribution before calling). Returns { draft_id, draft_url }. When GMAIL_STUB=1 is set in the host env (e2e/test mode), draft_id matches /^stub-draft-/ and no real Gmail API call happens. The future send_outreach_email tool is the one that lands approval-gating; this one does not need approval since drafts cannot be sent automatically.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Recipient email address (RFC 5322). Validated server-side; non-email strings are rejected.',
        },
        subject: {
          type: 'string',
          description:
            'Email subject line. The drafter subagent produces this under its `## Subject` section; the orchestrator extracts it.',
        },
        body: {
          type: 'string',
          description:
            'Email body. The drafter subagent produces this under its `## Body` section. If preferences.outreach_show_ai_attribution=true, the orchestrator appends preferences.outreach_attribution_template here BEFORE calling — do not double-append.',
        },
        in_reply_to: {
          type: 'string',
          description: 'Optional RFC 5322 message-id to thread this draft as a reply. Leave omitted for cold outreach.',
        },
      },
      required: ['to', 'subject', 'body'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const to = args.to as string;
    const subject = args.subject as string;
    const body = args.body as string;
    const in_reply_to = args.in_reply_to as string | undefined;
    if (!to || !EMAIL_RE.test(to)) {
      return err('to must be a valid email address');
    }
    if (!subject || typeof subject !== 'string') {
      return err('subject is required (non-empty string)');
    }
    if (!body || typeof body !== 'string') {
      return err('body is required (non-empty string)');
    }
    const res = await sendAction<{ draft_id: string; draft_url: string; stub?: boolean }>(
      'career_pilot.create_gmail_draft',
      { to, subject, body, in_reply_to: in_reply_to ?? null },
    );
    if (!res.ok) return actionErr('create_gmail_draft', res.error);
    const stubNote = res.data.stub ? ' (stub mode)' : '';
    return ok(
      `Draft saved${stubNote}: "${subject}" → ${to} (id ${res.data.draft_id}). Open Gmail to review and send.`,
      res.data,
    );
  },
};

// ── set_preference (proactive guardrails, §24.52) ──────────────────────────

const PROACTIVE_PREF_KEYS = ['quiet_hours', 'quiet_hours_tz', 'telegram_proactive_frequency_cap_per_day'] as const;

export const setPreference: McpToolDefinition = {
  tool: {
    name: 'set_preference',
    description:
      'Set one of the candidate\'s proactive-messaging preferences when they ask in conversation (e.g. "don\'t ping me before 9", "mute alerts on weekends", "you can send up to 5 a day"). Translate their words into the key + value: quiet_hours = a "HH:MM-HH:MM" 24-hour window (or "" to disable); quiet_hours_tz = an IANA zone like "America/Denver" (or "" to follow the system zone); telegram_proactive_frequency_cap_per_day = a non-negative integer (0 = no cap). The host validates + persists it; quiet hours take effect immediately at the host gate. Confirm back what you set.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        key: {
          type: 'string',
          enum: [...PROACTIVE_PREF_KEYS],
          description: 'Which preference to set.',
        },
        value: {
          description:
            'quiet_hours: "HH:MM-HH:MM" or "". quiet_hours_tz: an IANA zone or "". telegram_proactive_frequency_cap_per_day: an integer >= 0.',
        },
      },
      required: ['key', 'value'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const key = args.key as string;
    if (!key || !PROACTIVE_PREF_KEYS.includes(key as (typeof PROACTIVE_PREF_KEYS)[number])) {
      return err(`key must be one of: ${PROACTIVE_PREF_KEYS.join(', ')}`);
    }
    const res = await sendAction<{ key: string; value: string }>('career_pilot.set_preference', {
      key,
      value: args.value,
    });
    if (!res.ok) return actionErr('set_preference', res.error);
    return ok(`Preference "${key}" set to "${res.data?.value}".`, { key, value: res.data?.value });
  },
};

// ── set_work_profile (the composed /work page, §24.71 9.4b-2) ──────────────

export const setWorkProfile: McpToolDefinition = {
  tool: {
    name: 'set_work_profile',
    description:
      "Compose and publish the candidate's public /work page (and the landing hero). Pass the FULL profile as a structured object that you BUILD from the candidate's master resume + basics — choosing which sections present well and wording the prose. The portal renders it on the next load, with a \"composed by the agent\" provenance marker. RULES: (1) Compose, never invent — every fact (company, date, title, project, metric) must come from the candidate's real material; do not fabricate. (2) Omit any section you lack source for — do NOT pad with filler (an absent section renders cleanly). (3) A non-empty `name` is required. Shape: { name: string, title: string, bio: string[] (1-2 short paragraphs, candidate voice), lookingFor: string[], experience: [{ role, company, period, bullets: string[] }], projects: [{ name, description, href?, tags?: string[] }], writing?: [{ title, venue?, href? }], skills: string[] (curated, not exhaustive), education: string[], links: { github?, linkedin?, x?, blog? } }. Show the candidate a preview and get their OK before publishing; re-call to recompose after their edits.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        profile: {
          type: 'object',
          description:
            'The full WorkProfile object (see the tool description for the exact shape). Only `name` is strictly required; include every section the resume genuinely supports and omit the rest.',
        },
      },
      required: ['profile'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const profile = args.profile;
    if (!profile || typeof profile !== 'object') {
      return err('profile must be a WorkProfile object (see the tool description for the shape).');
    }
    const res = await sendAction<{ name: string }>('career_pilot.set_work_profile', { profile });
    if (!res.ok) return actionErr('set_work_profile', res.error);
    return ok(`Work page composed and published for ${res.data.name}. It renders on the next portal load.`, res.data);
  },
};

// ── persist_learning (rejection-as-fuel: CAPTURE, §24.107) ──────────────────

export const persistLearning: McpToolDefinition = {
  tool: {
    name: 'persist_learning',
    description:
      'Save the candidate\'s reflection after an outcome (rejection, interview, offer) so it becomes durable memory — the system\'s learning loop. Call it AFTER you\'ve had the reflection conversation, not instead of it. Capture the signal that will sharpen the NEXT similar application: which round, the skill/fit/noise read, anything quotable for next time. Pass `role_category` (the role family, e.g. "backend", "platform", "ai") so `read_learnings` can surface it when researching/tailoring a similar role later. `reflections` can be a short string OR a structured object of labelled answers. Set `publish:true` ONLY when the candidate wants the lesson shown publicly on the /pipeline detail — generalize it first so no company is identifiable. This writes private candidate signal; never call it from a sandbox run.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        kind: {
          type: 'string',
          enum: ['rejection', 'interview', 'offer', 'withdrawal', 'other'],
          description: 'What kind of outcome this reflection is about.',
        },
        reflections: {
          description:
            'The reflection itself — a short string, or a structured object of labelled answers (e.g. { round, gut_read, note_for_next_time }). Required and non-empty.',
        },
        role_category: {
          type: 'string',
          description:
            'The role family this lesson belongs to (e.g. "backend", "platform", "ai") — the same taxonomy as application labels. Lets read_learnings surface it for similar future roles. Strongly recommended.',
        },
        application_id: {
          type: 'string',
          description: 'Optional. The application this reflection is about (e.g. "app-acme").',
        },
        publish: {
          type: 'boolean',
          description:
            'Optional (default false). True surfaces a generalized version on the public /pipeline detail. Only with the candidate’s OK and after generalizing.',
        },
      },
      required: ['kind', 'reflections'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async handler(args) {
    const res = await sendAction<{ learning_id: string; published: boolean; role_category: string | null }>(
      'career_pilot.persist_learning',
      {
        kind: args.kind,
        reflections: args.reflections,
        role_category: (args.role_category as string | undefined) ?? null,
        application_id: (args.application_id as string | undefined) ?? null,
        publish: args.publish === true,
      },
    );
    if (!res.ok) return actionErr('persist_learning', res.error);
    return ok(
      `Learning saved${res.data.published ? ' (published to /pipeline)' : ''}${
        res.data.role_category ? ` under "${res.data.role_category}"` : ''
      }.`,
      res.data,
    );
  },
};

// ── read_learnings (rejection-as-fuel: FUEL, §24.107) ───────────────────────

export const readLearnings: McpToolDefinition = {
  tool: {
    name: 'read_learnings',
    description:
      'Pull the candidate’s prior reflections (most recent first) so past outcomes inform the next application — the fuel half of the learning loop. Call it BEFORE dispatching research-company / tailor-resume for a NEW role, filtered by `role_category` (the role family), and embed what comes back under a `## Prior learnings` heading in the subagent’s brief so the tailoring reflects what was learned (e.g. "last two backend rejections were at the system-design round — lead with distributed-systems depth"). Returns [] when there’s nothing yet (a fresh search has no history — that’s fine).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        role_category: {
          type: 'string',
          description: 'Filter to one role family (e.g. "backend"). Omit to read across all categories.',
        },
        application_id: {
          type: 'string',
          description: 'Optional. Filter to reflections about one application.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max reflections to return (default 8, newest first).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const res = await sendAction<{ learnings: Array<Record<string, unknown>>; count: number }>(
      'career_pilot.read_learnings',
      {
        role_category: (args.role_category as string | undefined) ?? null,
        application_id: (args.application_id as string | undefined) ?? null,
        limit: (args.limit as number | undefined) ?? null,
      },
    );
    if (!res.ok) return actionErr('read_learnings', res.error);
    if (res.data.count === 0) return ok('No prior learnings yet for that filter.', res.data);
    return ok(`${res.data.count} prior learning(s):\n${JSON.stringify(res.data.learnings, null, 2)}`, res.data);
  },
};

// ── read_contacts (recruiter contact recall, §24.121) ───────────────────────

export const readContacts: McpToolDefinition = {
  tool: {
    name: 'read_contacts',
    description:
      'Pull recent recruiter submissions from the /contact form (most recent first). Each carries the sender’s name, email, company, role, and message. Use it when the candidate references a contact ("how should I reply to that Acme one?", "add that recruiter to my pipeline") — read the contact, then help draft a reply or file it. These arrive as instant notifications to the candidate’s phone; this tool is how YOU see them. Returns [] when none match.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        company: {
          type: 'string',
          description: 'Optional. Filter to contacts whose company contains this text (e.g. "Acme").',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: 50,
          description: 'Max contacts to return (default 10, newest first).',
        },
      },
    },
    annotations: { readOnlyHint: true },
  },
  async handler(args) {
    const res = await sendAction<{ contacts: Array<Record<string, unknown>>; count: number }>(
      'career_pilot.read_contacts',
      {
        company: (args.company as string | undefined) ?? null,
        limit: (args.limit as number | undefined) ?? null,
      },
    );
    if (!res.ok) return actionErr('read_contacts', res.error);
    if (res.data.count === 0) return ok('No recruiter contacts yet for that filter.', res.data);
    return ok(`${res.data.count} contact(s):\n${JSON.stringify(res.data.contacts, null, 2)}`, res.data);
  },
};

registerTools([
  updateProfileField,
  setWorkProfile,
  setPreference,
  updateApplication,
  recordFunnelEvent,
  getApplication,
  listApplications,
  recordProgress,
  createGmailDraft,
  persistLearning,
  readLearnings,
  readContacts,
]);
