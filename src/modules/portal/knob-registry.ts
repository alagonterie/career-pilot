/**
 * src/modules/portal/knob-registry.ts — the canonical config-knob registry
 * (STRATEGY §24.138 — Phase A1).
 *
 * One source of truth for every operationally-meaningful `preferences`-tier
 * lever. The dev inspector (`/api/dev/knobs`, ENVIRONMENT==='dev', owner-gated)
 * may write the WHOLE registry; the prod `/admin` control-center
 * (`/api/admin/knobs`, behind Cloudflare Access + `admin_api_enabled`) writes the
 * registry MINUS `ADMIN_DENY` (the short, explicit deny-list — recruiter-sim,
 * dev_model_tier; the self-referential gates / boot-identity / non-scalar object
 * knobs are absent from the registry entirely and live in `UNSPEC_KNOBS`).
 *
 * Inclusion, not curation: `UNSPEC_KNOBS` records EVERY non-registry
 * `config/defaults.json` preferences key with a reason, and a coverage test
 * (knob-registry.test.ts) fails CI if a new default is neither spec'd here nor
 * explicitly unspec'd — the teeth behind "don't forget a knob".
 *
 * Every entry is a `preferences`-tier key whose default lives in
 * config/defaults.json (see STRATEGY §20 for the four-tier config model). The
 * builders here are pure-ish (take a db handle, return plain data); the HTTP
 * shell in api.ts wraps them.
 */
import type Database from 'better-sqlite3';

import { getConfig, getConfigDefault } from '../../get-config.js';

export type KnobType = 'boolean' | 'number' | 'cron' | 'enum' | 'text';
export type KnobGroup =
  | 'sim'
  | 'budget'
  | 'polling'
  | 'models'
  | 'sessions'
  | 'system'
  | 'telemetry'
  | 'health'
  | 'contact'
  | 'simulator'
  | 'briefing'
  | 'scouting'
  | 'curator'
  | 'kits'
  | 'sanitization'
  | 'notify';

export interface KnobSpec {
  type: KnobType;
  group: KnobGroup;
  label: string;
  /** Numeric bounds (inclusive), for `type: 'number'`. */
  min?: number;
  max?: number;
  integer?: boolean;
  /** Allowed values, for `type: 'enum'`. */
  options?: string[];
  /** Max length, for `type: 'text'`. */
  maxLength?: number;
  /** Validation regex (string source), for `type: 'text'` — only checked when the value is non-empty. */
  pattern?: string;
  /** Surfaced to the UI — e.g. cron changes only take effect on the next reclone. */
  note?: string;
}

const CRON_NOTE =
  'Saved immediately, but the running recurring task keeps its old cadence until its series is re-bootstrapped (next fresh session / reset:dev) — the bootstrap skips an existing task and the cron is copied onto the queued row at insert.';

const MODEL_TIER_NOTE =
  'Retargets the orchestrator + every subagent model for cost (dev only). Applies on the next container spawn (a fresh session / reset:dev), not mid-session. default = real Opus · sonnet = Opus→Sonnet (Haiku kept) · haiku = everything→Haiku.';

const SANDBOX_ORCH_NOTE =
  'Model for the PUBLIC "Watch it work" simulator ORCHESTRATOR — it writes the tailored-résumé bio, the quality the visitor sees (§24.142). The only visitor-facing money path; the owner agent is unaffected (prod-safe, not deny-listed). Applies on the next sandbox spawn. Sonnet recommended.';
const SANDBOX_SUB_NOTE =
  'Model for the simulator SUBAGENTS (research / tailor / draft). Research is retrieval+summarization and the latency hog; tailor bullets are snapped to the master host-side — so Haiku keeps runs fast + cheap without touching bio quality (§24.142). Applies on the next sandbox spawn.';

const OPS_SPAWN_NOTE =
  'Pushed as container env when the career-pilot ops session spawns — applies on its NEXT spawn, not mid-session. Other sessions keep the upstream rotation defaults.';

const OUTCOME_SPLIT_NOTE =
  'At an application’s terminal step the outcome is offer-vs-rejection in proportion to these two — only the RATIO matters (offer / (offer + rejection)), not the absolute values. Most apps never reach the terminal step (the screen-pass cull + ghosting close them earlier).';

// gmail_poll_interval_sec / calendar_poll_interval_sec are defined in
// defaults.json and exposed here, but nothing in src/ or the container reads
// them — inbound mail is pulled by the pipeline-scribe cron + the on-demand
// sweep, not a fixed poll loop. The notes say so honestly (§24.105).
const ORPHAN_POLL_NOTE =
  'No live consumer today — inbound mail is pulled by the pipeline-scribe cron (pipeline_scribe_cron) + the on-demand sweep, not a fixed poll loop. Kept as a tunable for a future host poller; changing it currently has no effect.';

/** The current model IDs the redaction belts may target (an enum keeps a typo from breaking the call). */
const MODEL_OPTIONS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'];

/**
 * The canonical registry. Keys are `preferences`-tier config keys; the value is
 * the UI/validation spec. `ADMIN_DENY` (below) names the subset the prod /admin
 * surface excludes.
 */
export const KNOB_SPECS: Record<string, KnobSpec> = {
  // ── budgets & caps ──
  owner_daily_llm_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Owner daily LLM budget (USD)',
    min: 0,
    max: 1000,
    note: 'A SOFT/advisory cap on the owner session’s daily LLM spend — the persona warns past ~80%, but the agent can still run past it. The hard stop is /killswitch (pause + kill containers).',
  },
  sandbox_daily_global_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Sandbox daily budget (USD)',
    min: 0,
    max: 1000,
    note: 'The HARD global cap on public-simulator (sandbox) spend — checkSimulatorAllowed refuses new runs once the day’s sandbox spend reaches it. Also the /architecture Web-sandbox "degraded" threshold.',
  },
  sandbox_per_ip_daily_run_cap: {
    type: 'number',
    group: 'budget',
    label: 'Sandbox per-IP daily runs',
    min: 0,
    max: 1000,
    integer: true,
    note: 'Host-side ceiling on simulator runs from a single IP per day (defense-in-depth behind the §24.70 edge per-IP cap). 0 disables the host check (the edge stays in force).',
  },
  simulator_max_budget_usd: {
    type: 'number',
    group: 'budget',
    label: 'Simulator per-run budget (USD)',
    min: 0,
    max: 10,
    note: 'Per-run spend ceiling for one public simulator session — wired into the sandbox provider as the in-SDK maxBudgetUsd, AND reserved per in-flight run by the global-budget check. NB maxBudgetUsd enforces on the SDK’s ESTIMATED cost (may under-count the Haiku web-search/fetch spend), so the 300s hard-wall + the daily global budget are the real backstops.',
  },
  daily_briefing_max_cost_usd: {
    type: 'number',
    group: 'budget',
    label: 'Daily-briefing cost cap (USD)',
    min: 0,
    max: 10,
    note: 'Ceiling on one daily-briefing composition run’s LLM spend.',
  },
  sanitization_pass3_budget_usd_per_day: {
    type: 'number',
    group: 'budget',
    label: 'Sanitization pass-3 budget (USD/day)',
    min: 0,
    max: 100,
    note: 'Daily cap on the optional LLM sanitization pass; once spent, the pass falls back to the deterministic scrub.',
  },
  kit_entity_redact_budget_usd_per_day: {
    type: 'number',
    group: 'budget',
    label: 'Kit entity-redact budget (USD/day)',
    min: 0,
    max: 100,
    note: 'Daily cap on the interview-kit entity-redaction belt; fail-safe to the deterministic scrub once spent.',
  },

  // ── polling ──
  gmail_poll_interval_sec: {
    type: 'number',
    group: 'polling',
    label: 'Gmail poll interval (s)',
    min: 10,
    max: 86_400,
    note: `Intended cadence for polling the connected Gmail account. ${ORPHAN_POLL_NOTE}`,
  },
  calendar_poll_interval_sec: {
    type: 'number',
    group: 'polling',
    label: 'Calendar poll interval (s)',
    min: 10,
    max: 86_400,
    note: `Intended cadence for polling the connected Google Calendar. ${ORPHAN_POLL_NOTE}`,
  },

  // ── ops-session topology (§24.67) — FROZEN set (a dev test pins membership) ──
  container_idle_timeout_sec: {
    type: 'number',
    group: 'sessions',
    label: 'Idle container ceiling (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'How long a warm-but-idle CHAT container lives before the host sweep reaps it (default 600 = 10 min). Idle = local polling only, no LLM spend — the cost is held RAM + one concurrency slot. Applies live on the next sweep tick.',
  },
  ops_container_idle_timeout_sec: {
    type: 'number',
    group: 'sessions',
    label: 'Idle OPS-container ceiling (s)',
    min: 30,
    max: 86_400,
    integer: true,
    note: 'How long the OPS container (scheduled jobs — briefing, pipeline sweep, scouting) lives once idle (default 60 s) — much shorter than the chat ceiling since ops jobs are spaced apart. An actively-working ops turn is unaffected. Applies live on the next sweep tick.',
  },
  container_orphan_reap_grace_sec: {
    type: 'number',
    group: 'sessions',
    label: 'Orphan-container reap grace (s)',
    min: 30,
    max: 3600,
    integer: true,
    note: 'How long a running container the host is NOT tracking (orphaned by a restart/deploy) is left before the sweep reaps it. The grace protects a just-spawned container still registering; above the cold-start (default 120 s). Applies live on the next sweep tick.',
  },
  ops_mirror_to_chat: {
    type: 'boolean',
    group: 'sessions',
    label: 'Mirror ops output to chat',
    note: 'Owner-visible ops-session output (daily briefing, killer-match pings) is copied into the chat session as silent context so replies have their referent. Applies to the next delivery.',
  },
  ops_transcript_rotate_bytes: {
    type: 'number',
    group: 'sessions',
    label: 'Ops transcript rotation (bytes)',
    min: 65_536,
    max: 12_582_912,
    integer: true,
    note: OPS_SPAWN_NOTE,
  },
  ops_transcript_rotate_age_days: {
    type: 'number',
    group: 'sessions',
    label: 'Ops transcript rotation (days)',
    min: 0,
    max: 14,
    note: `${OPS_SPAWN_NOTE} 0 disables the age check; size alone governs.`,
  },

  // ── system / container & perf internals ──
  container_memory_mb: {
    type: 'number',
    group: 'system',
    label: 'Container memory (MB)',
    min: 128,
    max: 8192,
    integer: true,
    note: 'Per-container memory ceiling. Applies on the next container spawn.',
  },
  container_cpu: {
    type: 'number',
    group: 'system',
    label: 'Container CPUs',
    min: 0.25,
    max: 8,
    note: 'Per-container CPU allocation (fractional allowed). Applies on the next container spawn.',
  },
  container_max_concurrent: {
    type: 'number',
    group: 'system',
    label: 'Max concurrent containers',
    min: 1,
    max: 32,
    integer: true,
    note: 'The container-pool ceiling — the host won’t spawn past this many live containers at once. The capacity figure on the Overview pool gauge.',
  },
  site_lifecycle_state: {
    type: 'enum',
    group: 'system',
    label: 'Site lifecycle state',
    options: ['active', 'concluded'],
    note: 'PUBLIC-FACING — changes the face of / and /pipeline immediately. active = the normal live job search. concluded = an accepted-offer retrospective: / and /pipeline lead with a calm “search concluded” banner (the search is over). The accepted company stays anonymized until separately revealed. Set DELIBERATELY — never auto-flipped on a data read (§24.149 D3).',
  },
  ops_bootstrap_min_interval_sec: {
    type: 'number',
    group: 'system',
    label: 'Ops bootstrap min interval (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'Minimum spacing between ops-session bootstraps — throttles re-bootstrapping the scheduled-job series.',
  },
  portal_sse_tail_interval_ms: {
    type: 'number',
    group: 'system',
    label: 'SSE tail interval (ms)',
    min: 250,
    max: 60_000,
    integer: true,
    note: 'How often the activity SSE stream polls the DB for new rows to push. Applies to new SSE connections.',
  },
  portal_sse_keepalive_ms: {
    type: 'number',
    group: 'system',
    label: 'SSE keepalive (ms)',
    min: 1000,
    max: 120_000,
    integer: true,
    note: 'Heartbeat interval on the activity SSE stream (beats the proxy idle-timeout). Applies to new connections.',
  },
  portal_telemetry_cache_ms: {
    type: 'number',
    group: 'system',
    label: 'Telemetry cache TTL (ms)',
    min: 0,
    max: 600_000,
    integer: true,
    note: 'Server-side cache window for /api/telemetry. 0 disables caching.',
  },
  portal_architecture_cache_ms: {
    type: 'number',
    group: 'system',
    label: 'Architecture cache TTL (ms)',
    min: 0,
    max: 600_000,
    integer: true,
    note: 'Server-side cache window for /api/architecture + /api/system-status. 0 disables caching.',
  },
  portal_observability_cache_ms: {
    type: 'number',
    group: 'system',
    label: 'Observability cache TTL (ms)',
    min: 0,
    max: 600_000,
    integer: true,
    note: 'Server-side cache window for /api/observability. 0 disables caching.',
  },
  arch_provider_error_rate_degraded: {
    type: 'number',
    group: 'system',
    label: 'Provider degraded error-rate',
    min: 0,
    max: 1,
    note: 'A provider whose 24 h error-rate exceeds this reads "degraded" on the architecture map / observability panel.',
  },
  arch_sweep_stale_sec: {
    type: 'number',
    group: 'system',
    label: 'Cron-sweep stale threshold (s)',
    min: 30,
    max: 3600,
    integer: true,
    note: 'How long the host sweep loop may go silent before the architecture "Cron sweep" node reads "down".',
  },
  action_response_orphan_ttl_sec: {
    type: 'number',
    group: 'system',
    label: 'Orphan-response TTL (s)',
    min: 30,
    max: 86_400,
    integer: true,
    note: 'How long a pending action-response row lives before the health check flags it as orphaned.',
  },
  llm_fetch_timeout_ms: {
    type: 'number',
    group: 'system',
    label: 'LLM fetch timeout (ms)',
    min: 1000,
    max: 120_000,
    integer: true,
    note: 'Per-request timeout for host-side LLM calls (sim prose, lead-scoring, sanitization).',
  },

  // ── telemetry (§24.68) ──
  telemetry_capture: {
    type: 'boolean',
    group: 'telemetry',
    label: 'Telemetry capture',
    note: 'Kill switch for BOTH the public per-turn rows (/dashboard panels) and the private request_telemetry table. Applies to the next request.',
  },
  owner_subagent_trace_emit_enabled: {
    type: 'boolean',
    group: 'telemetry',
    label: 'Owner subagent-trace emit',
    note: 'Whether the owner cascade emits deterministic subagent dispatch/progress rows into the trace (§24.134c). Off → only the model’s own record_progress rows show.',
  },
  request_telemetry_retention_days: {
    type: 'number',
    group: 'telemetry',
    label: 'Request-telemetry retention (days)',
    min: 1,
    max: 365,
    integer: true,
    note: 'Rows older than this are pruned by the host-sweep maintenance step.',
  },
  request_telemetry_prune_interval_sec: {
    type: 'number',
    group: 'telemetry',
    label: 'Request-telemetry prune interval (s)',
    min: 300,
    max: 86_400,
    integer: true,
    note: 'How often the host sweep prunes aged request_telemetry rows.',
  },
  visit_telemetry_retention_days: {
    type: 'number',
    group: 'telemetry',
    label: 'Visit-telemetry retention (days)',
    min: 1,
    max: 3650,
    integer: true,
    note: 'Retention for the first-party visit log (the /admin attribution feed). Rows older than this are pruned.',
  },
  visit_telemetry_prune_interval_sec: {
    type: 'number',
    group: 'telemetry',
    label: 'Visit-telemetry prune interval (s)',
    min: 300,
    max: 86_400,
    integer: true,
    note: 'How often the host sweep prunes aged visit_telemetry rows.',
  },

  // ── health (§24.68) ──
  health_check_interval_sec: {
    type: 'number',
    group: 'health',
    label: 'Health-check interval (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'Cadence of the proactive host-side health run (new critical findings alert the owner Telegram once until cleared).',
  },
  health_stale_pending_threshold_sec: {
    type: 'number',
    group: 'health',
    label: 'Stale-pending threshold (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'A pending inbound message older than this raises a queue-starvation finding.',
  },
  health_series_overdue_threshold_sec: {
    type: 'number',
    group: 'health',
    label: 'Series-overdue threshold (s)',
    min: 60,
    max: 604_800,
    integer: true,
    note: 'A recurring series whose next run is overdue by more than this raises a dead-recurrence finding.',
  },
  health_orphan_response_warn_count: {
    type: 'number',
    group: 'health',
    label: 'Orphan-response warn count',
    min: 1,
    max: 1000,
    integer: true,
    note: 'More than this many orphaned action-responses raises a finding.',
  },
  health_outbound_backlog_warn_count: {
    type: 'number',
    group: 'health',
    label: 'Outbound-backlog warn count',
    min: 1,
    max: 1000,
    integer: true,
    note: 'More than this many undelivered outbound rows raises a delivery-backlog finding.',
  },
  health_failure_streak_threshold: {
    type: 'number',
    group: 'health',
    label: 'Failure-streak threshold',
    min: 1,
    max: 50,
    integer: true,
    note: 'A provider whose newest N requests ALL failed raises a critical finding.',
  },
  health_surface_stale_hours: {
    type: 'number',
    group: 'health',
    label: 'Surface-stale threshold (h)',
    min: 1,
    max: 720,
    integer: true,
    note: 'A public surface with no fresh activity in this many hours reads stale.',
  },
  health_cascade_silent_window_hours: {
    type: 'number',
    group: 'health',
    label: 'Cascade silent window (h)',
    min: 1,
    max: 720,
    integer: true,
    note: 'The window the cascade-silence check uses to detect a proactive loop that has gone quiet.',
  },

  // ── contact relay safety (§24.121) ──
  contact_relay_enabled: {
    type: 'boolean',
    group: 'contact',
    label: 'Contact relay enabled',
    note: 'Master toggle for the /contact form relay. Off → submissions return "unavailable" and nothing is delivered or persisted. The emergency off-switch for a contact-spam event.',
  },
  contact_relay_max_per_window: {
    type: 'number',
    group: 'contact',
    label: 'Contact flood cap / window',
    min: 0,
    max: 1000,
    integer: true,
    note: 'Global ceiling on contacts accepted per window (defense-in-depth behind the per-IP edge rate-limit). Over the cap → "unavailable". 0 disables the host-side cap (the edge stays in force).',
  },
  contact_relay_window_sec: {
    type: 'number',
    group: 'contact',
    label: 'Contact flood window (s)',
    min: 1,
    max: 3600,
    integer: true,
    note: 'The sliding window the flood cap counts over (default 60 s).',
  },
  contact_message_max_chars: {
    type: 'number',
    group: 'contact',
    label: 'Contact message max chars',
    min: 100,
    max: 100_000,
    integer: true,
    note: 'Payload ceiling on a single contact-form message; longer submissions are rejected.',
  },
  contact_retention_max: {
    type: 'number',
    group: 'contact',
    label: 'Contact retention (rows)',
    min: 0,
    max: 100_000,
    integer: true,
    note: 'Keep at most this many contact_submissions rows; older ones are pruned on insert.',
  },
  contact_dedup_window_sec: {
    type: 'number',
    group: 'contact',
    label: 'Contact dedup window (s)',
    min: 0,
    max: 86_400,
    integer: true,
    note: 'A duplicate submission (same fingerprint) within this window is dropped. 0 disables dedup.',
  },

  // ── public simulator ──
  simulator_enabled: {
    type: 'boolean',
    group: 'simulator',
    label: 'Simulator enabled',
    note: 'Master toggle for the public web simulator. Off → checkSimulatorAllowed refuses new runs (the kill switch for the only money-spend visitor path).',
  },
  simulator_max_turns: {
    type: 'number',
    group: 'simulator',
    label: 'Simulator max turns',
    min: 1,
    max: 200,
    integer: true,
    note: 'Per-run agent-turn ceiling for one public simulator session.',
  },
  simulator_idle_timeout_ms: {
    type: 'number',
    group: 'simulator',
    label: 'Simulator idle timeout (ms)',
    min: 1000,
    max: 600_000,
    integer: true,
    note: 'How long a simulator run may stall with no output before it’s abandoned.',
  },
  simulator_hard_wall_ms: {
    type: 'number',
    group: 'simulator',
    label: 'Simulator hard wall (ms)',
    min: 10_000,
    max: 1_800_000,
    integer: true,
    note: 'Absolute wall-clock ceiling on one simulator run regardless of progress.',
  },
  simulator_abandon_grace_ms: {
    type: 'number',
    group: 'simulator',
    label: 'Simulator abandon grace (ms)',
    min: 0,
    max: 600_000,
    integer: true,
    note: 'Grace after a client disconnect before the run is torn down (a quick reconnect resumes).',
  },
  simulator_results_ttl_days: {
    type: 'number',
    group: 'simulator',
    label: 'Simulator results TTL (days)',
    min: 1,
    max: 365,
    integer: true,
    note: 'How long a finished simulator result (sharable link) is retained.',
  },
  simulator_recent_limit: {
    type: 'number',
    group: 'simulator',
    label: 'Simulator recent limit',
    min: 1,
    max: 100,
    integer: true,
    note: 'How many recent shareable runs the /watch simulator "Recent runs" strip lists — and that strip only renders in the fallback (when the live simulator is paused/disabled), so it’s usually unseen while the demo is on.',
  },
  sandbox_session_reap_idle_sec: {
    type: 'number',
    group: 'simulator',
    label: 'Sandbox session reap idle (s)',
    min: 60,
    max: 86_400,
    integer: true,
    note: 'How long an idle sandbox session lingers before the host reaps it.',
  },

  // ── proactive: daily briefing ──
  daily_briefing_enabled: {
    type: 'boolean',
    group: 'briefing',
    label: 'Daily briefing enabled',
    note: 'Master toggle for the scheduled daily briefing.',
  },
  daily_briefing_time: { type: 'cron', group: 'briefing', label: 'Daily briefing cron', note: CRON_NOTE },
  daily_briefing_min_llm_score: {
    type: 'number',
    group: 'briefing',
    label: 'Briefing min LLM score',
    min: 0,
    max: 100,
    integer: true,
    note: 'Only leads scoring at least this (LLM relevance) are eligible for the briefing.',
  },
  daily_briefing_top_n: {
    type: 'number',
    group: 'briefing',
    label: 'Briefing top-N',
    min: 1,
    max: 50,
    integer: true,
    note: 'How many top items the briefing surfaces.',
  },
  daily_briefing_backstop_enabled: {
    type: 'boolean',
    group: 'briefing',
    label: 'Briefing backstop enabled',
    note: 'Host-side backstop that delivers the briefing deterministically if the agent run didn’t (§24.134 #1).',
  },
  daily_briefing_backstop_window_min: {
    type: 'number',
    group: 'briefing',
    label: 'Briefing backstop window (min)',
    min: 1,
    max: 1440,
    integer: true,
    note: 'How long after the scheduled time the backstop waits before delivering its own briefing.',
  },
  daily_briefing_backstop_max_age_min: {
    type: 'number',
    group: 'briefing',
    label: 'Briefing backstop max age (min)',
    min: 1,
    max: 1440,
    integer: true,
    note: 'The backstop won’t fire if the last delivery is older than this (avoids a stale double-send).',
  },

  // ── proactive: scouting / killer-match ──
  job_scrape_enabled: {
    type: 'boolean',
    group: 'scouting',
    label: 'Job scrape enabled',
    note: 'Master toggle for the scheduled job-lead scrape.',
  },
  job_scrape_cron: { type: 'cron', group: 'scouting', label: 'Job-scrape cron', note: CRON_NOTE },
  killer_match_enabled: {
    type: 'boolean',
    group: 'scouting',
    label: 'Killer-match enabled',
    note: 'Master toggle for the high-score lead alert (the "this one’s for you" proactive ping).',
  },
  killer_match_cron: { type: 'cron', group: 'scouting', label: 'Killer-match cron', note: CRON_NOTE },
  killer_match_min_rules_score: {
    type: 'number',
    group: 'scouting',
    label: 'Killer-match min rules score',
    min: 0,
    max: 100,
    integer: true,
    note: 'Deterministic rules score a lead must clear before it’s eligible for a killer-match alert.',
  },
  killer_match_recency_window_hours: {
    type: 'number',
    group: 'scouting',
    label: 'Killer-match recency window (h)',
    min: 1,
    max: 720,
    integer: true,
    note: 'Only leads first seen within this window are eligible for an alert.',
  },
  killer_match_max_per_fire: {
    type: 'number',
    group: 'scouting',
    label: 'Killer-match max per fire',
    min: 1,
    max: 50,
    integer: true,
    note: 'Cap on alerts emitted in a single killer-match run.',
  },

  // ── pipeline curator + close detection ──
  pipeline_scribe_enabled: {
    type: 'boolean',
    group: 'curator',
    label: 'Pipeline curator enabled',
    note: 'Master toggle for the pipeline-scribe (pipeline curator) scheduled pass.',
  },
  pipeline_scribe_cron: { type: 'cron', group: 'curator', label: 'Pipeline curator cron', note: CRON_NOTE },
  pipeline_scribe_gmail_lookback_days: {
    type: 'number',
    group: 'curator',
    label: 'Curator Gmail lookback (days)',
    min: 1,
    max: 365,
    integer: true,
    note: 'How far back the curator queries Gmail for pipeline-relevant mail.',
  },
  pipeline_scribe_max_narratives: {
    type: 'number',
    group: 'curator',
    label: 'Curator max narratives',
    min: 1,
    max: 200,
    integer: true,
    note: 'Ceiling on narrative rows the curator writes per pass.',
  },
  pipeline_scribe_max_attention_items: {
    type: 'number',
    group: 'curator',
    label: 'Curator max attention items',
    min: 1,
    max: 100,
    integer: true,
    note: 'Ceiling on "needs attention" items the curator surfaces per pass.',
  },
  pipeline_scribe_skip_if_no_deltas: {
    type: 'boolean',
    group: 'curator',
    label: 'Curator skips on no deltas',
    note: 'When on, a curator pass with no new mail exits early instead of re-running the LLM over an unchanged board.',
  },
  pipeline_scribe_skip_classified_messages: {
    type: 'boolean',
    group: 'curator',
    label: 'Curator skips classified mail',
    note: 'On (default): query_gmail_delta drops emails already classified on a prior run, so a full-sync does not re-process old noise. Off: a one-time full re-classification pass.',
  },
  close_detection_enabled: {
    type: 'boolean',
    group: 'curator',
    label: 'Close detection enabled',
    note: 'Master toggle for the ghosting/close-detection pass.',
  },
  close_detection_cron: { type: 'cron', group: 'curator', label: 'Close detection cron', note: CRON_NOTE },
  close_detection_threshold_days: {
    type: 'number',
    group: 'curator',
    label: 'Close detection threshold (days)',
    min: 1,
    max: 365,
    integer: true,
    note: 'An application silent for this many days is a close-detection candidate.',
  },

  // ── interview kits ──
  interview_kit_auto_generate: {
    type: 'boolean',
    group: 'kits',
    label: 'Auto-generate kits',
    note: 'When on, an interview-kit is generated automatically on the qualifying status transition.',
  },
  interview_kit_folder_name: {
    type: 'text',
    group: 'kits',
    label: 'Kit Drive folder name',
    maxLength: 200,
    note: 'The Google Drive folder name the kits are written into (used when no explicit folder id is set).',
  },
  interview_kit_drive_folder_id: {
    type: 'text',
    group: 'kits',
    label: 'Kit Drive folder id',
    maxLength: 200,
    note: 'Explicit Drive folder id for kits. Empty → resolved/created by name. A wrong id mis-routes kit delivery.',
  },
  interview_kit_drive_archive_folder_id: {
    type: 'text',
    group: 'kits',
    label: 'Kit archive folder id',
    maxLength: 200,
    note: 'Drive folder id stale kits are archived into. Empty → archive disabled.',
  },
  interview_kit_cleanup_enabled: {
    type: 'boolean',
    group: 'kits',
    label: 'Kit cleanup enabled',
    note: 'Whether stale kits are archived/removed by the cleanup pass.',
  },
  interview_kit_stale_days: {
    type: 'number',
    group: 'kits',
    label: 'Kit stale (days)',
    min: 1,
    max: 365,
    integer: true,
    note: 'A kit older than this (and past its interview) is eligible for cleanup.',
  },

  // ── sanitization / redaction ──
  sanitization_llm_review_threshold_chars: {
    type: 'number',
    group: 'sanitization',
    label: 'LLM-review threshold (chars)',
    min: 0,
    max: 100_000,
    integer: true,
    note: 'Text longer than this gets the optional LLM sanitization review on top of the deterministic scrub.',
  },
  sanitization_llm_review_aggressiveness: {
    type: 'enum',
    group: 'sanitization',
    label: 'LLM-review aggressiveness',
    options: ['low', 'medium', 'high'],
    note: 'How aggressively the LLM review redacts borderline entities.',
  },
  sanitization_pass3_enabled: {
    type: 'boolean',
    group: 'sanitization',
    label: 'Sanitization pass-3 enabled',
    note: 'Toggle for the optional third (LLM) sanitization pass over public text.',
  },
  sanitization_pass3_model: {
    type: 'enum',
    group: 'sanitization',
    label: 'Sanitization pass-3 model',
    options: MODEL_OPTIONS,
    note: 'The model the optional public-text pass-3 LLM scrub uses — default Haiku, and the pass itself is OFF by default (sanitization_pass3_enabled). This is NOT the kit entity-redact belt, which defaults to Sonnet (kit_entity_redact_model). Applies to the next run.',
  },
  sanitization_pass3_timeout_ms: {
    type: 'number',
    group: 'sanitization',
    label: 'Sanitization pass-3 timeout (ms)',
    min: 1000,
    max: 120_000,
    integer: true,
    note: 'Per-call timeout for the optional LLM sanitization pass; on timeout it fails safe to the deterministic scrub.',
  },
  sanitization_public_summary_max_chars: {
    type: 'number',
    group: 'sanitization',
    label: 'Public summary max chars',
    min: 50,
    max: 10_000,
    integer: true,
    note: 'Ceiling on the length of a public audit-trail summary.',
  },
  sanitization_audit_drop_on_unmatched_company: {
    type: 'boolean',
    group: 'sanitization',
    label: 'Drop audit on unmatched company',
    note: 'When on, an audit row whose company can’t be matched/anonymized is dropped (fail-safe over leaking).',
  },
  sanitization_resanitize_on_application_update: {
    type: 'boolean',
    group: 'sanitization',
    label: 'Re-sanitize on app update',
    note: 'When on, an application update re-runs sanitization over its public projection.',
  },
  kit_entity_redact_enabled: {
    type: 'boolean',
    group: 'sanitization',
    label: 'Kit entity-redact enabled',
    note: 'Toggle for the interview-kit entity-redaction belt (§24.134a).',
  },
  kit_entity_redact_model: {
    type: 'enum',
    group: 'sanitization',
    label: 'Kit entity-redact model',
    options: MODEL_OPTIONS,
    note: 'The model the kit entity-redaction belt uses (§24.134e — Sonnet by default). Applies to the next run.',
  },
  kit_entity_redact_timeout_ms: {
    type: 'number',
    group: 'sanitization',
    label: 'Kit entity-redact timeout (ms)',
    min: 1000,
    max: 120_000,
    integer: true,
    note: 'Per-call timeout for the kit entity-redaction belt; fails safe to the deterministic scrub.',
  },

  // ── notify / quiet hours ──
  quiet_hours: {
    type: 'text',
    group: 'notify',
    label: 'Quiet hours (HH:MM-HH:MM)',
    maxLength: 11,
    pattern: '^\\d{2}:\\d{2}-\\d{2}:\\d{2}$',
    note: 'Local-time window during which proactive Telegram pings are suppressed (queued for after). Empty disables quiet hours.',
  },
  quiet_hours_tz: {
    type: 'text',
    group: 'notify',
    label: 'Quiet-hours timezone',
    maxLength: 64,
    note: 'IANA timezone for the quiet-hours window (e.g. America/Denver). Empty → the host default.',
  },
  telegram_proactive_frequency_cap_per_day: {
    type: 'number',
    group: 'notify',
    label: 'Proactive cap / day',
    min: 0,
    max: 1000,
    integer: true,
    note: 'Ceiling on proactive Telegram messages per day. 0 = unlimited.',
  },
  auto_research_threshold: {
    type: 'enum',
    group: 'notify',
    label: 'Auto-research threshold',
    options: ['manual', 'after_jd_pasted', 'always'],
    note: 'When the agent auto-runs company research: never (manual), once a JD is pasted, or always on a new application.',
  },

  // ── dev model tier (§24.43) — ADMIN_DENY (dev/container-only) ──
  dev_model_tier: {
    type: 'enum',
    group: 'models',
    label: 'Dev model tier',
    options: ['default', 'sonnet', 'haiku'],
    note: MODEL_TIER_NOTE,
  },

  // ── §24.142 sandbox model split: prod-safe model levers (NOT deny-listed) ──
  sandbox_orchestrator_model: {
    type: 'enum',
    group: 'models',
    label: 'Sandbox orchestrator model',
    options: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    note: SANDBOX_ORCH_NOTE,
  },
  sandbox_subagent_model: {
    type: 'enum',
    group: 'models',
    label: 'Sandbox subagent model',
    options: ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-8'],
    note: SANDBOX_SUB_NOTE,
  },
  win_confidence_model: {
    type: 'enum',
    group: 'models',
    label: 'Win-confidence model',
    options: MODEL_OPTIONS,
    note: 'The model the win-confidence scorer uses (§24.140 — Haiku by default; a heuristic 0–100 score, so Haiku is plenty). Applies to the next scoring run.',
  },

  // ── recruiter-sim dial (SIM_KNOB_KEYS) — ADMIN_DENY (dev-only sim) ──
  recruiter_sim_enabled: {
    type: 'boolean',
    group: 'sim',
    label: 'Sim enabled',
    note: 'Master toggle for the recruiter-sim host loop (seeding + stepping applications). Off → the sim does nothing. Also flipped off by /halt and any session-clearing reset.',
  },
  recruiter_sim_job_source: {
    type: 'enum',
    group: 'sim',
    label: 'Job source',
    options: ['real', 'synthetic'],
    note: 'real → seed simulated applications from the scraped job_leads pool (falls back to synthetic when empty); synthetic → fictional companies.',
  },
  recruiter_sim_pace: {
    type: 'enum',
    group: 'sim',
    label: 'Pace',
    options: ['fast', 'realistic'],
    note: 'fast → minutes (compressed; email dates backdated); realistic → real-life timing (days between steps).',
  },
  recruiter_sim_max_concurrent: {
    type: 'number',
    group: 'sim',
    label: 'Max concurrent',
    min: 0,
    max: 100,
    integer: true,
    note: 'Ceiling on simultaneously-active sim applications. A new application seeds only while the active count is below this.',
  },
  recruiter_sim_screen_pass_rate: {
    type: 'number',
    group: 'sim',
    label: 'Screen pass rate',
    min: 0,
    max: 1,
    note: 'Fraction of applications that advance past the confirmation to a screen; the rest get an early rejection.',
  },
  recruiter_sim_offer_probability: {
    type: 'number',
    group: 'sim',
    label: 'Offer probability',
    min: 0,
    max: 1,
    note: OUTCOME_SPLIT_NOTE,
  },
  recruiter_sim_rejection_probability: {
    type: 'number',
    group: 'sim',
    label: 'Rejection probability',
    min: 0,
    max: 1,
    note: OUTCOME_SPLIT_NOTE,
  },
  recruiter_sim_ghost_probability: {
    type: 'number',
    group: 'sim',
    label: 'Ghost probability',
    min: 0,
    max: 1,
    note: 'Per-step chance (never on the first email) that a thread goes quiet instead of advancing — exercises close-detection.',
  },
  recruiter_sim_noise_ratio: {
    type: 'number',
    group: 'sim',
    label: 'Noise ratio',
    min: 0,
    max: 1,
    note: 'Per-tick chance of injecting a standalone non-application email (newsletter/digest) — classifier-precision filler.',
  },
  recruiter_sim_daily_budget_usd: {
    type: 'number',
    group: 'sim',
    label: 'Sim daily budget (USD)',
    min: 0,
    max: 100,
    note: 'Caps the sim’s OWN host-side LLM spend (the Haiku that writes realistic email prose). Once spent, injected emails fall back to templates.',
  },
};

/**
 * Every `config/defaults.json` `preferences` key NOT in `KNOB_SPECS`, with the
 * reason it's not an editable knob. The coverage test asserts:
 * (a) every defaults.json preferences key is in KNOB_SPECS or here, and
 * (b) nothing is in both — so a newly-added default forces a conscious decision.
 */
export const UNSPEC_KNOBS: Record<string, string> = {
  // Self-referential gates — flipping these from inside /admin locks the owner out / weakens its own gate. Env/Telegram/CI only.
  admin_api_enabled:
    'self-referential: the admin surface’s own kill-switch — managed via env/Telegram/CI, never from inside /admin.',
  origin_jwt_validation_enabled:
    'self-referential security gate — weakens the origin-JWT check protecting /admin; env-managed (CF_ACCESS_*).',
  // Boot-time / deploy identity — no runtime effect once bound, or breaks minted links.
  portal_api_port: 'boot-time bind port — no runtime effect once bound; set via env/deploy.',
  portal_cors_origins: 'array + boot-time CORS allow-list — set via env/deploy.',
  portal_public_url: 'deploy identity — a wrong value silently breaks every minted /r link; set via GH env at cutover.',
  // Non-scalar (object/array) — need a structured editor; out of A1 scope (scalar siblings ARE editable).
  channel_pref_by_class: 'object — per-class channel routing; needs a structured editor (Telegram/DB).',
  approval_scope: 'object — per-action approval policy; structured editor (Telegram/DB).',
  briefing_schedule: 'object — morning/evening times; the daily_briefing_time cron is the scalar lever.',
  pipeline_scribe_ghosting_thresholds_days: 'object — per-stage ghosting thresholds; structured editor.',
  killer_match_source_allow_list: 'array — lead-source allow-list; structured editor.',
  llm_pricing_usd_per_mtok: 'object — model pricing map; structured editor.',
  recruiter_sim_pace_presets: 'object — dev-only sim pacing presets.',
};

/** Every writable knob key (the dev inspector's allow-list). */
export const ALL_KNOB_KEYS = Object.keys(KNOB_SPECS);

/**
 * The /admin exclusion list (STRATEGY §24.138 D1): recruiter-sim dial +
 * dev_model_tier. (The self-referential gates / boot-identity / non-scalar
 * knobs aren't in the registry at all — they're in UNSPEC_KNOBS.)
 */
export const ADMIN_DENY: ReadonlySet<string> = new Set<string>([
  'recruiter_sim_enabled',
  'recruiter_sim_job_source',
  'recruiter_sim_pace',
  'recruiter_sim_max_concurrent',
  'recruiter_sim_screen_pass_rate',
  'recruiter_sim_offer_probability',
  'recruiter_sim_rejection_probability',
  'recruiter_sim_ghost_probability',
  'recruiter_sim_noise_ratio',
  'recruiter_sim_daily_budget_usd',
  'dev_model_tier',
]);

/** The knobs the prod /admin control-center may read + write: registry − ADMIN_DENY. */
export const ADMIN_KNOB_KEYS = ALL_KNOB_KEYS.filter((k) => !ADMIN_DENY.has(k));

// ── value validation (pure) ───────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  /** The string to persist in the preferences tier (which stores everything as text). */
  stored?: string;
  /** The coerced native value (echoed back to the caller). */
  value?: boolean | number | string;
  error?: string;
}

/** Structural cron check: 5 whitespace-separated fields of the allowed charset. */
export function isValidCron(v: string): boolean {
  const parts = v.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^[0-9*/,-]+$/.test(p));
}

/**
 * Validate (and coerce) a single knob write against its spec. Rejects unknown
 * keys (not in the registry) and out-of-type/out-of-range values. Pure.
 */
export function validateKnobWrite(key: string, value: unknown): ValidationResult {
  const spec = KNOB_SPECS[key];
  if (!spec) return { ok: false, error: `key not writable: ${key}` };

  if (spec.type === 'boolean') {
    let b: boolean;
    if (typeof value === 'boolean') b = value;
    else if (value === 'true' || value === '1') b = true;
    else if (value === 'false' || value === '0') b = false;
    else return { ok: false, error: `expected a boolean for ${key}` };
    return { ok: true, stored: b ? 'true' : 'false', value: b };
  }

  if (spec.type === 'number') {
    const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(n)) return { ok: false, error: `expected a number for ${key}` };
    if (spec.integer && !Number.isInteger(n)) return { ok: false, error: `${key} must be an integer` };
    if (spec.min != null && n < spec.min) return { ok: false, error: `${key} must be ≥ ${spec.min}` };
    if (spec.max != null && n > spec.max) return { ok: false, error: `${key} must be ≤ ${spec.max}` };
    return { ok: true, stored: String(n), value: n };
  }

  if (spec.type === 'enum') {
    const opts = spec.options ?? [];
    if (typeof value !== 'string' || !opts.includes(value)) {
      return { ok: false, error: `${key} must be one of: ${opts.join(', ')}` };
    }
    return { ok: true, stored: value, value };
  }

  if (spec.type === 'text') {
    if (typeof value !== 'string') return { ok: false, error: `expected a string for ${key}` };
    const v = value.trim();
    if (spec.maxLength != null && v.length > spec.maxLength) {
      return { ok: false, error: `${key} must be ≤ ${spec.maxLength} characters` };
    }
    if (spec.pattern && v.length > 0 && !new RegExp(spec.pattern).test(v)) {
      return { ok: false, error: `${key} must match ${spec.pattern}` };
    }
    return { ok: true, stored: v, value: v };
  }

  // cron
  if (typeof value !== 'string' || !isValidCron(value)) {
    return { ok: false, error: `${key} must be a 5-field cron expression` };
  }
  return { ok: true, stored: value.trim(), value: value.trim() };
}

// ── preferences write ──────────────────────────────────────────────────────────

export function writePreference(db: Database.Database, key: string, stored: string): void {
  db.prepare(
    `INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, stored, new Date().toISOString());
}

/** Whether a key carries a `preferences`-tier override (the thing "reset" clears). */
function hasPreference(db: Database.Database, key: string): boolean {
  try {
    return db.prepare('SELECT 1 FROM preferences WHERE key = ?').get(key) !== undefined;
  } catch {
    return false;
  }
}

/** Delete one key's override → its value falls back through the tiers to defaults.json. */
function deletePreference(db: Database.Database, key: string): void {
  db.prepare('DELETE FROM preferences WHERE key = ?').run(key);
}

/** Clear every override in `keys` at once. Returns the rows removed. */
function resetKeys(db: Database.Database, keys: readonly string[]): number {
  if (keys.length === 0) return 0;
  const placeholders = keys.map(() => '?').join(',');
  return db.prepare(`DELETE FROM preferences WHERE key IN (${placeholders})`).run(...keys).changes;
}

export interface KnobWriteOutcome {
  status: number;
  body: unknown;
}

/**
 * Mutate a knob. Three shapes (all guarded by `allowedKeys`):
 *   { key, value }       → validate + persist the override; echo the coerced value.
 *   { key, reset: true } → delete the override so it falls back to the default.
 *   { resetAll: true }   → clear every `allowedKeys` override at once.
 * 400 on any invalid/unknown input — nothing is written in that case.
 *
 * `allowedKeys` defaults to the full registry (the dev inspector); the prod
 * /admin surface passes `ADMIN_KNOB_KEYS` so a denied key (in the registry but
 * excluded) is refused even though its spec validates.
 */
export function applyKnobWrite(
  db: Database.Database,
  raw: unknown,
  allowedKeys: readonly string[] = ALL_KNOB_KEYS,
): KnobWriteOutcome {
  if (typeof raw !== 'object' || raw === null) {
    return { status: 400, body: { error: 'expected a JSON object { key, value }' } };
  }
  const body = raw as { key?: unknown; value?: unknown; reset?: unknown; resetAll?: unknown };

  if (body.resetAll === true) {
    const cleared = resetKeys(db, allowedKeys);
    return { status: 200, body: { resetAll: true, cleared } };
  }

  if (typeof body.key !== 'string') {
    return { status: 400, body: { error: 'missing or non-string "key"' } };
  }
  const key = body.key;
  const allowed = allowedKeys.includes(key);

  if (body.reset === true) {
    if (!KNOB_SPECS[key] || !allowed) return { status: 400, body: { error: `key not writable: ${key}` } };
    deletePreference(db, key);
    return { status: 200, body: { key, reset: true, value: getConfig(db, key) } };
  }

  if (!allowed) return { status: 400, body: { error: `key not writable: ${key}` } };
  const res = validateKnobWrite(key, body.value);
  if (!res.ok) {
    return { status: 400, body: { error: res.error } };
  }
  writePreference(db, key, res.stored as string);
  const spec = KNOB_SPECS[key];
  return { status: 200, body: { key, value: res.value, applied: true, note: spec.note ?? null } };
}

// ── read builder ────────────────────────────────────────────────────────────────

export interface KnobView {
  key: string;
  value: unknown;
  /** The config/defaults.json value — what "reset" falls back to. */
  default: unknown;
  /** True when a preferences-tier override exists (so reset has something to clear). */
  overridden: boolean;
  type: KnobType;
  group: KnobGroup;
  label: string;
  min: number | null;
  max: number | null;
  integer: boolean;
  /** Allowed values for an `enum` knob (drives the select); null otherwise. */
  options: string[] | null;
  /** Max length for a `text` knob; null otherwise. */
  maxLength: number | null;
  note: string | null;
}

/** Current value + metadata for each key in `keys` (drives a control UI). */
export function buildKnobs(db: Database.Database, keys: readonly string[]): KnobView[] {
  return keys.map<KnobView>((key) => {
    const spec = KNOB_SPECS[key];
    return {
      key,
      value: getConfig(db, key),
      default: getConfigDefault(key),
      overridden: hasPreference(db, key),
      type: spec.type,
      group: spec.group,
      label: spec.label,
      min: spec.min ?? null,
      max: spec.max ?? null,
      integer: spec.integer ?? false,
      options: spec.options ?? null,
      maxLength: spec.maxLength ?? null,
      note: spec.note ?? null,
    };
  });
}
