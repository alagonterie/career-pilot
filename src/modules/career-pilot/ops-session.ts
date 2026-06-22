/**
 * The career-pilot ops session (STRATEGY.md §24.67).
 *
 * The owner group's machine traffic — the five host-bootstrapped recurring
 * series and their action round-trips — lives in a dedicated long-lived
 * session so it stops accumulating into (and cold-resuming) the owner's chat
 * transcript. The session is keyed by a reserved synthetic thread id:
 * shared-mode inbound routing matches `thread_id IS NULL` strictly, so the
 * ops row is invisible to the router, while host-sweep wakes it on due tasks
 * like any other session.
 *
 * Four hooks call in here (all dynamic imports, all best-effort):
 *   - host-sweep `ensureOpsTopology()` — create the session once, keep the
 *     five series bootstrapped in it, retire misplaced live copies elsewhere.
 *   - container-runner `applyOpsSpawnEnv()` — aggressive transcript-rotation
 *     env for ops spawns only (each tick is self-contained; the DB is the
 *     world-model, so machine transcript history is dead-weight context).
 *   - delivery `mirrorOpsDeliveryToChat()` — owner-visible ops output is
 *     copied into the chat session as a context-only row (trigger=0) so a
 *     reply like "tell me more about #2" has its referent in front of the
 *     chat agent.
 *   - portal dev-inspector — targets the ops session for its one-shot sweep.
 */
import type Database from 'better-sqlite3';

import type { ContainerConfig } from '../../container-config.js';
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { createSession } from '../../db/sessions.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import {
  INTERNAL_THREAD_PREFIX,
  initSessionFolder,
  openInboundDb,
  writeSessionMessage,
} from '../../session-manager.js';
import type { AgentGroup, Session } from '../../types.js';

import { ensureCloseDetectionTask } from './close-detection-bootstrap.js';
import { ensureDailyBriefingTask } from './daily-briefing-bootstrap.js';
import { ensurePipelineScribeTask } from './pipeline-scribe-bootstrap.js';
import { ensureKillerMatchTask } from './killer-match-bootstrap.js';
import { ensureJobScrapeTask } from './scrape-jobs-bootstrap.js';

export const OPS_THREAD_ID = `${INTERNAL_THREAD_PREFIX}career-pilot-ops`;

export const OWNER_GROUP_FOLDER = 'career-pilot';

/** The five host-bootstrapped series that belong in the ops session. The
 *  pipeline-scribe series-id was migrated from the legacy 'funnel-curator' per
 *  §24.152 (see reconcileLegacySeriesIds, which renames deployed boxes' live
 *  messages_in rows in lockstep). */
export const OPS_SERIES_IDS = [
  'daily-briefing',
  'killer-match',
  'pipeline-scribe',
  'close-detection',
  'job-scrape',
] as const;

export function isOpsSession(session: Pick<Session, 'thread_id'>): boolean {
  return session.thread_id === OPS_THREAD_ID;
}

export function findOpsSession(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare("SELECT * FROM sessions WHERE agent_group_id = ? AND thread_id = ? AND status = 'active'")
    .get(agentGroupId, OPS_THREAD_ID) as Session | undefined;
}

/** The owner's chat session: the group's plain shared-mode session. */
function findChatSession(agentGroupId: string): Session | undefined {
  return getDb()
    .prepare(
      "SELECT * FROM sessions WHERE agent_group_id = ? AND thread_id IS NULL AND status = 'active' ORDER BY created_at ASC LIMIT 1",
    )
    .get(agentGroupId) as Session | undefined;
}

function createOpsSession(agentGroup: AgentGroup, chatSession: Session): Session {
  const session: Session = {
    id: `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    agent_group_id: agentGroup.id,
    // Bound to the owner's messaging group so default replies (the daily
    // briefing) deliver to the owner chat exactly like the chat session's do.
    // The synthetic thread id never reaches the adapter — writeSessionRouting
    // nulls `internal:`-prefixed thread ids.
    messaging_group_id: chatSession.messaging_group_id,
    thread_id: OPS_THREAD_ID,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: new Date().toISOString(),
  };
  createSession(session);
  initSessionFolder(agentGroup.id, session.id);
  log.info('career-pilot: ops session created', { sessionId: session.id, agentGroupId: agentGroup.id });
  return session;
}

/**
 * Cancel live host-bootstrapped series rows in a NON-ops session — the
 * self-healing migration that moves the series without a manual box op.
 * Same semantics as scheduling's cancelTask: status → completed,
 * recurrence → NULL so handleRecurrence never clones the retired row.
 * Owner-created tasks (different series ids) are untouched.
 */
export function retireMisplacedSeries(inDb: Database.Database): number {
  const placeholders = OPS_SERIES_IDS.map(() => '?').join(',');
  const result = inDb
    .prepare(
      `UPDATE messages_in SET status = 'completed', recurrence = NULL
        WHERE series_id IN (${placeholders}) AND kind = 'task' AND status IN ('pending', 'paused')`,
    )
    .run(...OPS_SERIES_IDS);
  return result.changes;
}

/**
 * §24.152: rename the legacy 'funnel-curator' series-id → 'pipeline-scribe' in a
 * session's messages_in queue. The series-id was the last internal "funnel"
 * name; it lives in the per-session inbound DB (which the central-DB migration
 * system does not manage), so this host-side reconciliation does the rename
 * instead — idempotent (0 rows after the first run) and data-preserving (the
 * recurring task's id + schedule are untouched, only its series_id changes).
 * Shipped in the same deploy as the SERIES_ID constant flip, so there is never a
 * half-renamed window: readLiveTask(SERIES_ID='pipeline-scribe') finds the
 * renamed row. Runs before bootstrap/retire on every inbound DB the topology
 * keeper touches.
 */
export function reconcileLegacySeriesIds(inDb: Database.Database): number {
  const result = inDb
    .prepare("UPDATE messages_in SET series_id = 'pipeline-scribe' WHERE series_id = 'funnel-curator'")
    .run();
  return result.changes;
}

/** Run the five series bootstraps against the ops session's inbound.db. */
export function bootstrapOpsSeries(
  centralDb: Database.Database,
  inDb: Database.Database,
  agentGroup: AgentGroup,
  opsSession: Session,
): void {
  const results = {
    'daily-briefing': ensureDailyBriefingTask(centralDb, inDb, agentGroup, opsSession),
    'killer-match': ensureKillerMatchTask(centralDb, inDb, agentGroup, opsSession),
    'pipeline-scribe': ensurePipelineScribeTask(centralDb, inDb, agentGroup, opsSession),
    'close-detection': ensureCloseDetectionTask(centralDb, inDb, agentGroup, opsSession),
    'job-scrape': ensureJobScrapeTask(centralDb, inDb, agentGroup, opsSession),
  };
  for (const [series, res] of Object.entries(results)) {
    if (res.action === 'inserted') {
      log.info('career-pilot: ops series bootstrapped', {
        sessionId: opsSession.id,
        series,
        recurrence: res.recurrence,
        nextFireAt: res.nextFireAt,
      });
    }
  }
}

let lastEnsureMs = 0;

/** Test-only: reset the ensure throttle. */
export function _resetEnsureThrottleForTesting(): void {
  lastEnsureMs = 0;
}

/**
 * Idempotent, throttled topology keeper — called from host-sweep each tick.
 * Ensures the ops session exists, its five series are live in it, and any
 * live copies in other owner sessions are retired. Best-effort: never throws.
 *
 * Deliberately a no-op until the owner's chat session exists (pairing /
 * first message creates it) — without it we don't know the messaging group
 * the briefing should deliver to, and there's no machine work to schedule
 * for an unpaired install anyway.
 */
export function ensureOpsTopology(): void {
  try {
    const centralDb = getDb();
    const minIntervalSec = getConfig<number>(centralDb, 'ops_bootstrap_min_interval_sec');
    if (Date.now() - lastEnsureMs < minIntervalSec * 1000) return;
    lastEnsureMs = Date.now();

    const agentGroup = getAgentGroupByFolder(OWNER_GROUP_FOLDER);
    if (!agentGroup) return;
    const chatSession = findChatSession(agentGroup.id);
    if (!chatSession) {
      log.debug('career-pilot: ops topology deferred — no chat session yet', { agentGroupId: agentGroup.id });
      return;
    }

    const opsSession = findOpsSession(agentGroup.id) ?? createOpsSession(agentGroup, chatSession);

    const opsDb = openInboundDb(agentGroup.id, opsSession.id);
    try {
      reconcileLegacySeriesIds(opsDb);
      bootstrapOpsSeries(centralDb, opsDb, agentGroup, opsSession);
    } finally {
      opsDb.close();
    }

    const others = getDb()
      .prepare("SELECT * FROM sessions WHERE agent_group_id = ? AND id != ? AND status = 'active'")
      .all(agentGroup.id, opsSession.id) as Session[];
    for (const other of others) {
      try {
        const otherDb = openInboundDb(agentGroup.id, other.id);
        try {
          reconcileLegacySeriesIds(otherDb);
          const retired = retireMisplacedSeries(otherDb);
          if (retired > 0) {
            log.info('career-pilot: retired misplaced ops series rows', { sessionId: other.id, retired });
          }
        } finally {
          otherDb.close();
        }
      } catch (err) {
        log.warn('career-pilot: series retirement failed for session', { sessionId: other.id, err });
      }
    }
  } catch (err) {
    log.warn('career-pilot: ops topology ensure failed', { err });
  }
}

// ── ops spawn env (per-class transcript rotation) ────────────────────────────

/** Where rotated/compacted ops transcripts archive — out of the agent's main
 *  conversation memory so machine ticks don't pollute its recall. */
const OPS_CONVERSATIONS_DIR = '/workspace/agent/conversations/ops';

/**
 * Merge aggressive transcript-rotation env into the container config for ops
 * spawns. Returns the config unchanged for every other session. Values read
 * through getConfig so they're operator-tunable (and dev-inspector-writable)
 * without a deploy; applied on the next ops container spawn.
 *
 * §24.78: the former Haiku→Sonnet model floor (§24.68 Δ B1) was REMOVED. It was
 * added on the now-disproven premise that Haiku caused the missing ops traces;
 * box evidence (Jun 16 Haiku + Jun 17 Sonnet, both zero traces, while traces had
 * worked under Haiku Jun 11–15) showed the model was a red herring — the real
 * gap was the model-dependent record_progress emission, now fixed deterministically
 * host-side (§24.78). The floor only added cost and silently overrode the owner's
 * dev_model_tier choice. The ops cascade now honors the configured tier like every
 * other session.
 */
export function applyOpsSpawnEnv(config: ContainerConfig, session: Session, agentGroup: AgentGroup): ContainerConfig {
  try {
    if (agentGroup.folder !== OWNER_GROUP_FOLDER || !isOpsSession(session)) return config;
    const db = getDb();
    const rotateBytes = getConfig<number>(db, 'ops_transcript_rotate_bytes');
    const rotateAgeDays = getConfig<number>(db, 'ops_transcript_rotate_age_days');

    return {
      ...config,
      env: {
        ...config.env,
        CLAUDE_TRANSCRIPT_ROTATE_BYTES: String(rotateBytes),
        CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS: String(rotateAgeDays),
        NANOCLAW_CONVERSATIONS_DIR: OPS_CONVERSATIONS_DIR,
      },
    };
  } catch (err) {
    log.warn('career-pilot: ops spawn env failed — spawning with group defaults', { sessionId: session.id, err });
    return config;
  }
}

// ── mirror to chat (D2, §24.67) ──────────────────────────────────────────────

/**
 * After a channel delivery from the ops session, write a context-only copy
 * (trigger=0 — accumulates, never wakes) into the chat session so the owner's
 * next reply finds what it's replying to. Best-effort: never throws.
 */
export function mirrorOpsDeliveryToChat(session: Session, msg: { id: string; kind: string; content: string }): void {
  try {
    if (!isOpsSession(session)) return;
    const centralDb = getDb();
    if (!getConfig<boolean>(centralDb, 'ops_mirror_to_chat')) return;

    let text = '';
    try {
      const content = JSON.parse(msg.content) as { text?: unknown; markdown?: unknown };
      text =
        typeof content.text === 'string' ? content.text : typeof content.markdown === 'string' ? content.markdown : '';
    } catch {
      /* non-JSON content — nothing mirrorable */
    }
    if (!text) return;

    const chatSession = findChatSession(session.agent_group_id);
    if (!chatSession) return;

    writeSessionMessage(session.agent_group_id, chatSession.id, {
      id: `cp-ops-mirror-${msg.id}`,
      kind: 'system',
      timestamp: new Date().toISOString(),
      content: JSON.stringify({
        type: 'career_pilot_ops_mirror',
        action: 'career_pilot.ops_mirror',
        status: 'info',
        result: { note: 'Copy of a message you (via the ops session) just sent the owner.', text },
      }),
      trigger: 0,
    });
    log.debug('career-pilot: mirrored ops delivery to chat session', {
      opsSessionId: session.id,
      chatSessionId: chatSession.id,
      messageId: msg.id,
    });
  } catch (err) {
    log.warn('career-pilot: ops→chat mirror failed', { sessionId: session.id, messageId: msg.id, err });
  }
}
