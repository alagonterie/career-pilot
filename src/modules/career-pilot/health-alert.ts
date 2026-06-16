/**
 * Telemetry maintenance + proactive health alerting (STRATEGY.md §24.68).
 *
 * One host-sweep MODULE-HOOK entry point with two internally-throttled steps:
 *
 *   1. PRUNE — request_telemetry rows older than the retention window
 *      (`request_telemetry_retention_days`), every
 *      `request_telemetry_prune_interval_sec`.
 *   2. ALERT — run the health checks every `health_check_interval_sec`; NEW
 *      critical findings (no `health_alert_state` row, or a cleared one —
 *      re-occurrence re-alerts) are batched into ONE Telegram message sent via
 *      the contact-relay direct-adapter pattern (no agent wake, no LLM spend).
 *      Findings that disappear get `cleared_at` so the next occurrence alerts
 *      again. Dedupe state survives restarts (it's a table, not memory).
 *
 * Best-effort discipline throughout: never throws into the sweep.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { pruneVisitTelemetry } from '../../attribution.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import { pruneRequestTelemetry } from '../../request-telemetry.js';

import { type HealthFinding, runHealthChecks } from './health.js';
import { OWNER_GROUP_FOLDER } from './ops-session.js';

let lastPruneMs = 0;
let lastVisitPruneMs = 0;
let lastHealthMs = 0;

/** Test-only: reset the step throttles. */
export function _resetMaintenanceThrottleForTesting(): void {
  lastPruneMs = 0;
  lastVisitPruneMs = 0;
  lastHealthMs = 0;
}

/**
 * Decide which critical findings are NEW (alertable) and sync the dedupe
 * ledger: upsert live criticals, clear rows whose finding disappeared.
 * Exported for tests; pure DB, no delivery.
 */
export function reconcileAlertState(findings: HealthFinding[], nowIso: string): HealthFinding[] {
  const db = getDb();
  const criticals = findings.filter((f) => f.severity === 'critical');
  const liveIds = new Set(criticals.map((f) => f.id));

  const toAlert: HealthFinding[] = [];
  for (const f of criticals) {
    const row = db.prepare('SELECT cleared_at FROM health_alert_state WHERE finding_id = ?').get(f.id) as
      | { cleared_at: string | null }
      | undefined;
    if (!row || row.cleared_at !== null) toAlert.push(f);
    db.prepare(
      `INSERT INTO health_alert_state (finding_id, severity, first_alerted_at, last_seen_at, cleared_at)
       VALUES (@id, @severity, @now, @now, NULL)
       ON CONFLICT(finding_id) DO UPDATE SET
         severity = excluded.severity,
         last_seen_at = excluded.last_seen_at,
         first_alerted_at = CASE WHEN health_alert_state.cleared_at IS NOT NULL
                                 THEN excluded.first_alerted_at ELSE health_alert_state.first_alerted_at END,
         cleared_at = NULL`,
    ).run({ id: f.id, severity: f.severity, now: nowIso });
  }

  // Findings that were alerted but are no longer present → cleared (re-occurrence re-alerts).
  const open = db.prepare('SELECT finding_id FROM health_alert_state WHERE cleared_at IS NULL').all() as Array<{
    finding_id: string;
  }>;
  for (const o of open) {
    if (!liveIds.has(o.finding_id)) {
      db.prepare('UPDATE health_alert_state SET cleared_at = ? WHERE finding_id = ?').run(nowIso, o.finding_id);
    }
  }
  return toAlert;
}

/** One batched owner message for this interval's new criticals. */
function buildAlertText(newCriticals: HealthFinding[]): string {
  const lines = [
    `🚨 Health check: ${newCriticals.length} new critical finding${newCriticals.length === 1 ? '' : 's'}`,
    '',
  ];
  for (const f of newCriticals) {
    lines.push(`• ${f.title}`);
    if (f.next_step) lines.push(`  ↳ ${f.next_step}`);
  }
  lines.push('', 'Full report: pnpm health (on the box)');
  return lines.join('\n');
}

/** Deliver straight to the owner's channels — the contact-relay pattern. */
async function deliverToOwner(text: string): Promise<boolean> {
  const ag = getAgentGroupByFolder(OWNER_GROUP_FOLDER);
  if (!ag) return false;
  const channels = getMessagingGroupsByAgentGroup(ag.id);
  const adapter = getDeliveryAdapter();
  if (!adapter || channels.length === 0) {
    log.debug('health alert: no channel/adapter — skipping delivery');
    return false;
  }
  let delivered = 0;
  for (const mg of channels) {
    try {
      await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat', JSON.stringify({ text }));
      delivered++;
    } catch (err) {
      log.warn('health alert: delivery to a channel failed', { channelType: mg.channel_type, err });
    }
  }
  return delivered > 0;
}

/**
 * The host-sweep entry point (MODULE-HOOK:career-pilot-observability).
 * Both steps throttled; never throws.
 */
export async function runTelemetryMaintenance(): Promise<void> {
  try {
    const db = getDb();

    const pruneIntervalSec = getConfig<number>(db, 'request_telemetry_prune_interval_sec');
    if (Date.now() - lastPruneMs >= pruneIntervalSec * 1000) {
      lastPruneMs = Date.now();
      const retentionDays = getConfig<number>(db, 'request_telemetry_retention_days');
      const pruned = pruneRequestTelemetry(db, retentionDays);
      if (pruned > 0) log.info('request telemetry pruned', { pruned, retentionDays });
    }

    // §24.74: visit_telemetry prune — its own retention + interval.
    const visitPruneIntervalSec = getConfig<number>(db, 'visit_telemetry_prune_interval_sec');
    if (Date.now() - lastVisitPruneMs >= visitPruneIntervalSec * 1000) {
      lastVisitPruneMs = Date.now();
      const retentionDays = getConfig<number>(db, 'visit_telemetry_retention_days');
      const pruned = pruneVisitTelemetry(db, retentionDays);
      if (pruned > 0) log.info('visit telemetry pruned', { pruned, retentionDays });
    }

    const healthIntervalSec = getConfig<number>(db, 'health_check_interval_sec');
    if (Date.now() - lastHealthMs >= healthIntervalSec * 1000) {
      lastHealthMs = Date.now();
      if (!hasTable(db, 'health_alert_state')) return; // pre-migration DB — nothing to dedupe against
      const report = await runHealthChecks();
      const newCriticals = reconcileAlertState(report.findings, report.ranAt);
      if (newCriticals.length > 0) {
        const sent = await deliverToOwner(buildAlertText(newCriticals));
        log.warn('health alert: new critical findings', {
          findings: newCriticals.map((f) => f.id),
          delivered: sent,
        });
      }
    }
  } catch (err) {
    log.warn('telemetry maintenance failed', { err });
  }
}
