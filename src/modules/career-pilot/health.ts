/**
 * Host health-check library (STRATEGY.md §24.68).
 *
 * One pass over the failure shapes the §24.66 incident took "four probes of
 * schema archaeology" to find: stale due pending rows (queue starvation), dead
 * recurrence chains, orphaned action responses, undelivered outbound backlog,
 * auth-failure streaks in request_telemetry, stale surfaces, and a LIVE Gmail
 * token probe (OneCLI reports `connected` from stored state, not token
 * validity — only exercising the API tells the truth).
 *
 * Consumers: `scripts/health-check.ts` (the `pnpm health` CLI), the host-sweep
 * proactive alert (health-alert.ts), and — later — portal endpoints (Deep
 * Dive 3) via `runHealthChecks({ skipLiveProbes: true })`.
 *
 * Every non-ok finding carries a concrete `next_step` — the report IS the
 * runbook, not a pointer to one. Each check is individually try/caught into a
 * `health-check-error:<check>` warn finding; the run itself never throws.
 */
import fs from 'fs';

import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getActiveSessions } from '../../db/sessions.js';
import { getConfig } from '../../get-config.js';
import { inboundDbPath, openInboundDb, openOutboundDb, outboundDbPath } from '../../session-manager.js';
import type { Session } from '../../types.js';

import { OPS_SERIES_IDS, OWNER_GROUP_FOLDER, findOpsSession, isOpsSession } from './ops-session.js';
import { probeGmailProfile } from './recruiter-sim/inject.js';

export type HealthSeverity = 'ok' | 'warn' | 'critical';

export interface HealthFinding {
  /** Stable id — the alert dedupe key (e.g. 'auth-failure:gmail'). */
  id: string;
  severity: HealthSeverity;
  title: string;
  detail: string;
  /** Concrete follow-up command/query for non-ok findings. */
  next_step?: string;
}

export interface HealthReport {
  ranAt: string;
  findings: HealthFinding[];
}

export interface RunHealthChecksOpts {
  /** Skip the live Gmail/gateway probe (CLI --no-live; portal reads). */
  skipLiveProbes?: boolean;
  /** Clock override for tests (epoch ms). */
  now?: number;
}

/** Non-zero (2) iff any finding is critical — the CLI's exit code. */
export function exitCodeForReport(report: HealthReport): number {
  return report.findings.some((f) => f.severity === 'critical') ? 2 : 0;
}

const Q_TS = 'pnpm exec tsx scripts/q.ts';

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

interface SessionHandle {
  session: Session;
  groupFolder: string;
  inDb: Database.Database;
  outDb: Database.Database | null;
}

/** Open every active session's DBs (inbound required, outbound optional). */
function openSessions(): { handles: SessionHandle[]; close: () => void } {
  const handles: SessionHandle[] = [];
  let sessions: Session[] = [];
  try {
    sessions = getActiveSessions();
  } catch {
    // Bare/pre-migration DB — session checks degrade to "nothing to check".
    sessions = [];
  }
  for (const session of sessions) {
    const group = getAgentGroup(session.agent_group_id);
    if (!group) continue;
    if (!fs.existsSync(inboundDbPath(group.id, session.id))) continue;
    let inDb: Database.Database;
    try {
      inDb = openInboundDb(group.id, session.id);
    } catch {
      continue;
    }
    let outDb: Database.Database | null = null;
    try {
      if (fs.existsSync(outboundDbPath(group.id, session.id))) {
        outDb = openOutboundDb(group.id, session.id);
      }
    } catch {
      outDb = null;
    }
    handles.push({ session, groupFolder: group.folder, inDb, outDb });
  }
  return {
    handles,
    close: () => {
      for (const h of handles) {
        try {
          h.inDb.close();
        } catch {
          /* already closed */
        }
        try {
          h.outDb?.close();
        } catch {
          /* already closed */
        }
      }
    },
  };
}

// ── individual checks ────────────────────────────────────────────────────────

/** The §24.66 starvation signature: due wake-able rows that never got processed. */
function checkStaleDuePending(handles: SessionHandle[], now: number, findings: HealthFinding[]): void {
  const thresholdSec = getConfig<number>(getDb(), 'health_stale_pending_threshold_sec');
  const cutoff = iso(now - thresholdSec * 1000);
  let anyStale = false;
  for (const h of handles) {
    const row = h.inDb
      .prepare(
        `SELECT COUNT(*) AS n, MIN(COALESCE(process_after, timestamp)) AS oldest
           FROM messages_in
          WHERE status = 'pending' AND trigger = 1
            AND datetime(COALESCE(process_after, timestamp)) <= datetime(?)`,
      )
      .get(cutoff) as { n: number; oldest: string | null };
    if (row.n > 0) {
      anyStale = true;
      findings.push({
        id: `stale-due-pending:${h.session.id}`,
        severity: 'critical',
        title: `${row.n} due pending row(s) stuck in session ${h.session.id}`,
        detail: `Oldest due since ${row.oldest}. Wake-able (trigger=1) rows past the ${thresholdSec}s threshold are the §24.66 starvation signature — the session is not processing its queue.`,
        next_step: `${Q_TS} "data/v2-sessions/${h.session.agent_group_id}/${h.session.id}/inbound.db" "SELECT id, kind, series_id, status, timestamp, process_after FROM messages_in WHERE status='pending' ORDER BY seq DESC LIMIT 20"`,
      });
    }
  }
  if (!anyStale) {
    findings.push({ id: 'stale-due-pending', severity: 'ok', title: 'No stale due pending rows', detail: '' });
  }
}

/** A series whose chain stopped: newest row terminal with no pending successor, or successor overdue. */
function checkOpsSeries(handles: SessionHandle[], now: number, findings: HealthFinding[]): void {
  const db = getDb();
  const ownerGroup = handles.find((h) => h.groupFolder === OWNER_GROUP_FOLDER && !isOpsSession(h.session));
  const opsHandle = handles.find((h) => h.groupFolder === OWNER_GROUP_FOLDER && isOpsSession(h.session));

  if (!opsHandle) {
    // Only meaningful once the owner is paired (chat session exists).
    if (ownerGroup) {
      const opsRow = findOpsSession(ownerGroup.session.agent_group_id);
      findings.push({
        id: 'ops-session-missing',
        severity: 'warn',
        title: opsRow ? 'Ops session exists but its inbound.db is unreadable' : 'Ops session not created yet',
        detail:
          'The owner chat session exists but no readable ops session was found — the five machine series have nowhere to live.',
        next_step:
          'Check host-sweep logs for "ops topology" lines; the sweep creates the session within ops_bootstrap_min_interval_sec.',
      });
    }
    return;
  }

  const overdueSec = getConfig<number>(db, 'health_series_overdue_threshold_sec');
  let anyDead = false;
  for (const seriesId of OPS_SERIES_IDS) {
    const newest = opsHandle.inDb
      .prepare(
        `SELECT id, status, timestamp, process_after FROM messages_in
          WHERE series_id = ? AND kind = 'task' ORDER BY seq DESC LIMIT 1`,
      )
      .get(seriesId) as { id: string; status: string; timestamp: string; process_after: string | null } | undefined;

    if (!newest) {
      // Bootstrapped lazily by the sweep — absence right after creation is normal; flag softly.
      continue;
    }
    if (newest.status === 'pending' || newest.status === 'paused') {
      const due = newest.process_after ?? newest.timestamp;
      if (newest.status === 'pending' && new Date(due).getTime() < now - overdueSec * 1000) {
        anyDead = true;
        findings.push({
          id: `dead-series:${seriesId}`,
          severity: 'critical',
          title: `Series '${seriesId}' is overdue`,
          detail: `Next occurrence (${newest.id}) was due ${due} — more than ${overdueSec}s ago — and is still pending. The sweep is not waking the ops session, or the container is failing before completion.`,
          next_step: `tail the host log for sessionId="${opsHandle.session.id}", then ${Q_TS} the ops inbound.db: "SELECT id, status, tries, process_after FROM messages_in WHERE series_id='${seriesId}' ORDER BY seq DESC LIMIT 5"`,
        });
      }
      continue;
    }
    // Newest row terminal (completed/failed) with no pending successor → the
    // recurrence chain died (handleRecurrence fans out from completed rows).
    anyDead = true;
    findings.push({
      id: `dead-series:${seriesId}`,
      severity: 'critical',
      title: `Series '${seriesId}' has no scheduled next occurrence`,
      detail: `Newest row (${newest.id}) is '${newest.status}' at ${newest.timestamp} and nothing is pending — the recurrence chain is dead.`,
      next_step: `The host-sweep ops bootstrap re-ensures missing series within ops_bootstrap_min_interval_sec; if it doesn't reappear, check "ops series bootstrapped" log lines and ${Q_TS} the ops inbound.db for series '${seriesId}'.`,
    });
  }
  if (!anyDead) {
    findings.push({
      id: 'dead-series',
      severity: 'ok',
      title: 'All ops series have a live next occurrence',
      detail: '',
    });
  }
}

/** Orphaned cp-resp rows growing again means the §24.66 TTL sweep is broken. */
function checkOrphanResponses(handles: SessionHandle[], findings: HealthFinding[]): void {
  const warnCount = getConfig<number>(getDb(), 'health_orphan_response_warn_count');
  let any = false;
  for (const h of handles) {
    const row = h.inDb
      .prepare(
        `SELECT COUNT(*) AS n FROM messages_in WHERE kind = 'system' AND status = 'pending' AND id LIKE 'cp-resp-%'`,
      )
      .get() as { n: number };
    if (row.n > warnCount) {
      any = true;
      findings.push({
        id: `orphan-responses:${h.session.id}`,
        severity: 'warn',
        title: `${row.n} pending cp-resp rows in session ${h.session.id}`,
        detail: `Above the ${warnCount} threshold — the action_response_orphan_ttl_sec sweep should be expiring these (§24.66).`,
        next_step: `Check host logs for "orphan response sweep failed"; verify action_response_orphan_ttl_sec via the dev inspector.`,
      });
    }
  }
  if (!any) {
    findings.push({ id: 'orphan-responses', severity: 'ok', title: 'No orphan-response pileup', detail: '' });
  }
}

/** Due outbound messages the delivery loop has not delivered. */
function checkOutboundBacklog(handles: SessionHandle[], findings: HealthFinding[]): void {
  const warnCount = getConfig<number>(getDb(), 'health_outbound_backlog_warn_count');
  let any = false;
  for (const h of handles) {
    if (!h.outDb) continue;
    let due: Array<{ id: string }>;
    try {
      due = h.outDb
        .prepare(`SELECT id FROM messages_out WHERE deliver_after IS NULL OR deliver_after <= datetime('now')`)
        .all() as Array<{ id: string }>;
    } catch {
      continue; // older outbound.db without the table — nothing to report
    }
    const delivered = new Set(
      (h.inDb.prepare('SELECT message_out_id FROM delivered').all() as Array<{ message_out_id: string }>).map(
        (r) => r.message_out_id,
      ),
    );
    const backlog = due.filter((m) => !delivered.has(m.id)).length;
    if (backlog > warnCount) {
      any = true;
      findings.push({
        id: `outbound-backlog:${h.session.id}`,
        severity: 'warn',
        title: `${backlog} undelivered due outbound messages in session ${h.session.id}`,
        detail: `Above the ${warnCount} threshold — the delivery loop is failing or the channel adapter is down.`,
        next_step: `Check host logs for "Message delivery failed"; ${Q_TS} "data/v2-sessions/${h.session.agent_group_id}/${h.session.id}/outbound.db" "SELECT id, kind, timestamp FROM messages_out ORDER BY seq DESC LIMIT 10"`,
      });
    }
  }
  if (!any) {
    findings.push({ id: 'outbound-backlog', severity: 'ok', title: 'No outbound delivery backlog', detail: '' });
  }
}

/** 401/403s in the last 24h — the Gmail-401 detector — plus all-failure streaks. */
function checkRequestTelemetry(now: number, findings: HealthFinding[]): void {
  const db = getDb();
  if (!hasTable(db, 'request_telemetry')) {
    findings.push({
      id: 'health-check-error:request-telemetry',
      severity: 'warn',
      title: 'request_telemetry table missing',
      detail: 'Migration 131 has not run on this DB — telemetry-based checks skipped.',
      next_step: 'Restart the service (migrations run at startup) or run scripts/run-migrations.ts.',
    });
    return;
  }

  const cutoff24h = iso(now - 86_400_000);
  const authRows = db
    .prepare(
      `SELECT provider, COUNT(*) AS n, MAX(ts) AS latest
         FROM request_telemetry WHERE status_code IN (401, 403) AND ts >= ? GROUP BY provider`,
    )
    .all(cutoff24h) as Array<{ provider: string; n: number; latest: string }>;
  for (const r of authRows) {
    findings.push({
      id: `auth-failure:${r.provider}`,
      severity: 'critical',
      title: `${r.n} auth failure(s) (401/403) from '${r.provider}' in the last 24h`,
      detail: `Latest at ${r.latest}. For gmail: the §24.66 lesson — a Testing-mode consent screen expires refresh tokens after 7 days while OneCLI still reports 'connected'.`,
      next_step:
        r.provider === 'gmail' || r.provider === 'calendar'
          ? 'Reconnect the Google account in the OneCLI web UI (Apps → Gmail → Connect); publish the GCP consent screen to "In production" to stop the weekly expiry.'
          : `${Q_TS} data/v2.db "SELECT ts, surface, status_code, error FROM request_telemetry WHERE provider='${r.provider}' AND ok=0 ORDER BY ts DESC LIMIT 10"`,
    });
  }
  if (authRows.length === 0) {
    findings.push({ id: 'auth-failure', severity: 'ok', title: 'No auth failures in the last 24h', detail: '' });
  }

  // Failure streaks: the newest N rows for a provider all failed.
  const streakN = getConfig<number>(db, 'health_failure_streak_threshold');
  const providers = db.prepare('SELECT DISTINCT provider FROM request_telemetry').all() as Array<{
    provider: string;
  }>;
  let anyStreak = false;
  for (const { provider } of providers) {
    const newest = db
      .prepare('SELECT ok FROM request_telemetry WHERE provider = ? ORDER BY ts DESC LIMIT ?')
      .all(provider, streakN) as Array<{ ok: number }>;
    if (newest.length >= streakN && newest.every((r) => r.ok === 0)) {
      anyStreak = true;
      findings.push({
        id: `failure-streak:${provider}`,
        severity: 'critical',
        title: `The last ${newest.length} '${provider}' requests ALL failed`,
        detail: `Every recent request to this provider is failing — outage, dead credential, or quota.`,
        next_step: `${Q_TS} data/v2.db "SELECT ts, surface, status_code, error FROM request_telemetry WHERE provider='${provider}' ORDER BY ts DESC LIMIT ${streakN}"`,
      });
    }
  }
  if (!anyStreak) {
    findings.push({ id: 'failure-streak', severity: 'ok', title: 'No provider failure streaks', detail: '' });
  }

  // Stale surfaces: active recently, but the newest SUCCESS is old (or absent).
  const staleHours = getConfig<number>(db, 'health_surface_stale_hours');
  const staleCutoff = iso(now - staleHours * 3_600_000);
  const surfaces = db
    .prepare(
      `SELECT surface, MAX(ts) AS last_any, MAX(CASE WHEN ok = 1 THEN ts END) AS last_ok
         FROM request_telemetry GROUP BY surface`,
    )
    .all() as Array<{ surface: string; last_any: string; last_ok: string | null }>;
  let anyStale = false;
  for (const s of surfaces) {
    if (s.last_any < staleCutoff) continue; // dormant surface — nothing has been trying
    if (s.last_ok === null || (s.last_ok < staleCutoff && s.last_any > s.last_ok)) {
      anyStale = true;
      findings.push({
        id: `stale-surface:${s.surface}`,
        severity: 'warn',
        title: `Surface '${s.surface}' is active but hasn't succeeded ${s.last_ok ? `since ${s.last_ok}` : 'at all'}`,
        detail: `Latest activity ${s.last_any}; no success inside the ${staleHours}h window.`,
        next_step: `${Q_TS} data/v2.db "SELECT ts, provider, ok, status_code, error FROM request_telemetry WHERE surface='${s.surface}' ORDER BY ts DESC LIMIT 10"`,
      });
    }
  }
  if (!anyStale) {
    findings.push({
      id: 'stale-surface',
      severity: 'ok',
      title: 'All active surfaces have recent successes',
      detail: '',
    });
  }
}

/** LIVE probe: gateway reachability + Gmail token validity in one exchange. */
async function checkGmailLive(findings: HealthFinding[]): Promise<void> {
  const probe = await probeGmailProfile();
  if (probe.ok) {
    findings.push({
      id: 'gmail-token',
      severity: 'ok',
      title: 'Gmail token live-verified via the gateway',
      detail: '',
    });
    return;
  }
  if (!probe.gatewayReachable) {
    findings.push({
      id: 'onecli-gateway',
      severity: 'critical',
      title: 'OneCLI gateway unreachable',
      detail: `\`onecli run\` failed to execute: ${probe.error ?? 'unknown error'}. Nothing that depends on gateway-injected credentials (Gmail, Calendar, Drive, SerpApi) can work.`,
      next_step: 'On the box: systemctl status onecli (or `onecli start`); then re-run pnpm health.',
    });
    return;
  }
  if (probe.status === 401 || probe.status === 403) {
    findings.push({
      id: 'gmail-token',
      severity: 'critical',
      title: `Gmail token is dead (HTTP ${probe.status} from a live profile probe)`,
      detail:
        'OneCLI may still report the app as connected — that is stored state, not token validity (§24.66). A Testing-mode GCP consent screen expires refresh tokens after 7 days.',
      next_step:
        'Reconnect in the OneCLI web UI (Apps → Gmail → Connect); publish the GCP consent screen to "In production" to stop the weekly expiry.',
    });
    return;
  }
  findings.push({
    id: 'gmail-token',
    severity: 'warn',
    title: `Gmail profile probe returned HTTP ${probe.status ?? 'unknown'}`,
    detail: probe.error ?? 'Unexpected non-auth failure from the live probe.',
    next_step: 'Retry; if persistent, check Google API status and the OneCLI gateway logs (docker logs onecli).',
  });
}

// ── the run ──────────────────────────────────────────────────────────────────

export async function runHealthChecks(opts: RunHealthChecksOpts = {}): Promise<HealthReport> {
  const now = opts.now ?? Date.now();
  const findings: HealthFinding[] = [];

  const guarded = async (check: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (err) {
      findings.push({
        id: `health-check-error:${check}`,
        severity: 'warn',
        title: `Health check '${check}' itself failed`,
        detail: err instanceof Error ? err.message : String(err),
        next_step: 'Read the host log around this run; the check may need a schema it cannot find.',
      });
    }
  };

  const { handles, close } = openSessions();
  try {
    await guarded('stale-due-pending', () => checkStaleDuePending(handles, now, findings));
    await guarded('ops-series', () => checkOpsSeries(handles, now, findings));
    await guarded('orphan-responses', () => checkOrphanResponses(handles, findings));
    await guarded('outbound-backlog', () => checkOutboundBacklog(handles, findings));
    await guarded('request-telemetry', () => checkRequestTelemetry(now, findings));
    if (!opts.skipLiveProbes) {
      await guarded('gmail-live', () => checkGmailLive(findings));
    }
  } finally {
    close();
  }

  return { ranAt: iso(now), findings };
}
