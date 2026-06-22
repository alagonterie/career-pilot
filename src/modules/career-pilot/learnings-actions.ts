/**
 * Learnings host actions (STRATEGY.md §24.107 — rejection-as-fuel).
 *
 * The two halves that turn a post-outcome reflection into durable, reusable
 * signal (mirrors the pipeline-scribe / interview-kit internal-writer pattern):
 *
 *  - career_pilot.persist_learning — CAPTURE. After a reflection conversation,
 *    the orchestrator saves the signal as a `learnings` row. `publish:true` opts
 *    the lesson onto the public /pipeline detail (reflection_published=1).
 *  - career_pilot.read_learnings   — FUEL. Before researching/tailoring for a NEW
 *    role, the orchestrator pulls prior reflections for the same role_category and
 *    injects them into the subagent brief (## Prior learnings) — the system's
 *    memory, so each outcome sharpens the next similar application.
 *
 * Both are owner-only (registered behind the §24.19 Layer-2 gate): the `learnings`
 * table is the candidate's private post-mortem signal — the sandbox must never
 * touch it. Real candidate PII never leaves these handlers (the public projection
 * is sanitized downstream by public-pipeline-view).
 */
import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import { upsertPublicPipelineView } from '../portal/public-pipeline-view.js';
import type { Session } from '../../types.js';

// ── response writer (mirrors pipeline-actions.ts / interview-kit-actions.ts) ────

type ActionFrame =
  | { ok: true; data: Record<string, unknown> }
  | { ok: false; error: { code: string; message: string } };

function writeResponse(inDb: Database.Database, requestId: string, frame: ActionFrame): void {
  insertMessage(inDb, {
    id: `cp-resp-${requestId}`,
    kind: 'system',
    timestamp: new Date().toISOString(),
    platformId: null,
    channelType: null,
    threadId: null,
    content: JSON.stringify({ type: 'career_pilot_response', requestId, frame }),
    processAfter: null,
    recurrence: null,
    trigger: 0,
  });
}

function reqId(content: Record<string, unknown>): string {
  return (content.requestId as string) || 'unknown';
}

function payload(content: Record<string, unknown>): Record<string, unknown> {
  return (content.payload as Record<string, unknown>) ?? {};
}

/** Defense-in-depth twin of the registerOwnerOnly gate (mirrors pipeline-actions):
 *  the `learnings` table is private candidate signal — a sandbox session must
 *  never read or write it. Returns true (and writes FORBIDDEN) when blocked. */
function rejectIfSandbox(inDb: Database.Database, requestId: string, session: Session, action: string): boolean {
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: `${action} is not available in this agent group (sandbox sessions cannot read or write learnings).`,
      },
    });
    return true;
  }
  return false;
}

/** Stringify a reflections value for storage: a structured object → JSON (so
 *  public-pipeline-view's excerpt builder can pull labelled answers), a string →
 *  itself. The column is TEXT NOT NULL, so empty/whitespace is rejected upstream. */
function serializeReflections(v: unknown): string | null {
  if (typeof v === 'string') {
    const t = v.trim();
    return t.length > 0 ? t : null;
  }
  if (v && typeof v === 'object') {
    const json = JSON.stringify(v);
    return json === '{}' || json === '[]' ? null : json;
  }
  return null;
}

// ── career_pilot.persist_learning ────────────────────────────────────────────

export async function handlePersistLearning(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'persist_learning')) return;
  const p = payload(content);
  const applicationId = (p.application_id as string | undefined) || null;
  const kind = String((p.kind as string | undefined) ?? '').trim();
  const roleCategory = ((p.role_category as string | undefined) ?? '').trim() || null;
  const reflections = serializeReflections(p.reflections);
  const publish = p.publish === true || p.publish === 'true';

  if (!kind || !reflections) {
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'BAD_ARGS', message: 'kind and a non-empty reflections value are required' },
    });
    return;
  }

  try {
    const db = getDb();
    const id = `learn-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.prepare(
      `INSERT INTO learnings (id, application_id, kind, role_category, reflections, reflection_published, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, applicationId, kind, roleCategory, reflections, publish ? 1 : 0, new Date().toISOString());

    log.info('learning persisted', { id, applicationId, kind, roleCategory, published: publish });
    writeResponse(inDb, requestId, {
      ok: true,
      data: { learning_id: id, published: publish, role_category: roleCategory },
    });

    // A published learning is public metadata on the /pipeline detail — re-project
    // AFTER the response frame (best-effort; upsertPublicPipelineView never throws).
    if (publish && applicationId) upsertPublicPipelineView(db, applicationId);
  } catch (err) {
    log.error('handlePersistLearning failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'PERSIST_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

// ── career_pilot.read_learnings ──────────────────────────────────────────────

interface LearningRow {
  id: string;
  application_id: string | null;
  kind: string;
  role_category: string | null;
  reflections: string;
  reflection_published: number;
  created_at: string;
}

const READ_LEARNINGS_DEFAULT_LIMIT = 8;
const READ_LEARNINGS_MAX_LIMIT = 50;

/**
 * The fuel read: prior reflections, most-recent first, filtered by `role_category`
 * (the same taxonomy as obfuscated labels / lead scoring) and/or `application_id`.
 * `reflections` is parsed back to its object form when it was stored as JSON, so
 * the orchestrator can embed labelled answers in the subagent brief.
 */
export async function handleReadLearnings(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'read_learnings')) return;
  const p = payload(content);
  const roleCategory = ((p.role_category as string | undefined) ?? '').trim() || null;
  const applicationId = (p.application_id as string | undefined) || null;
  const rawLimit = Number(p.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(READ_LEARNINGS_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : READ_LEARNINGS_DEFAULT_LIMIT;

  try {
    const db = getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (roleCategory) {
      where.push('role_category = ?');
      args.push(roleCategory);
    }
    if (applicationId) {
      where.push('application_id = ?');
      args.push(applicationId);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT id, application_id, kind, role_category, reflections, reflection_published, created_at
           FROM learnings ${clause} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as LearningRow[];

    const learnings = rows.map((r) => ({
      id: r.id,
      application_id: r.application_id,
      kind: r.kind,
      role_category: r.role_category,
      reflections: parseReflections(r.reflections),
      published: r.reflection_published === 1,
      created_at: r.created_at,
    }));

    writeResponse(inDb, requestId, { ok: true, data: { learnings, count: learnings.length } });
  } catch (err) {
    log.error('handleReadLearnings failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'READ_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}

/** A stored reflections string → its object form when it parses to one, else the raw text. */
function parseReflections(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* plain text */
  }
  return raw;
}
