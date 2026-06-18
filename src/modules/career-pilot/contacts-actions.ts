/**
 * Contact recall host action (STRATEGY.md §24.121).
 *
 * career_pilot.read_contacts — RECALL. The host relay (`contact-relay.ts`)
 * persists every /contact submission to `contact_submissions`; this lets the
 * orchestrator pull recent ones on an OWNER-initiated turn ("how should I reply
 * to that Acme contact?" / "add that one to my pipeline"). The public form
 * never triggers an agent turn — recall is on demand, so there's zero spend tied
 * to the form itself.
 *
 * Owner-only (registered behind the §24.19 Layer-2 gate + the sandbox-reject
 * twin): contact submissions are private recruiter PII bound for the owner's
 * channel; a sandbox session must never read them.
 */
import type Database from 'better-sqlite3';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { insertMessage } from '../../db/session-db.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';

// ── response writer (mirrors learnings-actions.ts) ────────────────────────────

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

/** Defense-in-depth twin of registerOwnerOnly: `contact_submissions` is private
 *  recruiter PII — a sandbox session must never read it. Returns true (+ writes
 *  FORBIDDEN) when blocked. */
function rejectIfSandbox(inDb: Database.Database, requestId: string, session: Session, action: string): boolean {
  const group = getAgentGroup(session.agent_group_id);
  if (!group || group.folder !== 'career-pilot') {
    writeResponse(inDb, requestId, {
      ok: false,
      error: {
        code: 'FORBIDDEN',
        message: `${action} is not available in this agent group (sandbox sessions cannot read contacts).`,
      },
    });
    return true;
  }
  return false;
}

// ── career_pilot.read_contacts ────────────────────────────────────────────────

const READ_CONTACTS_DEFAULT_LIMIT = 10;
const READ_CONTACTS_MAX_LIMIT = 50;

interface ContactRow {
  id: string;
  name: string;
  email: string;
  company: string | null;
  role: string | null;
  source: string | null;
  message: string;
  delivered: number;
  created_at: string;
}

export async function handleReadContacts(
  content: Record<string, unknown>,
  session: Session,
  inDb: Database.Database,
): Promise<void> {
  const requestId = reqId(content);
  if (rejectIfSandbox(inDb, requestId, session, 'read_contacts')) return;
  const p = payload(content);
  const company = ((p.company as string | undefined) ?? '').trim() || null;
  const rawLimit = Number(p.limit);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(READ_CONTACTS_MAX_LIMIT, Math.max(1, Math.floor(rawLimit)))
    : READ_CONTACTS_DEFAULT_LIMIT;

  try {
    const db = getDb();
    const where: string[] = [];
    const args: unknown[] = [];
    if (company) {
      where.push('company LIKE ?');
      args.push(`%${company}%`);
    }
    const clause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db
      .prepare(
        `SELECT id, name, email, company, role, source, message, delivered, created_at
           FROM contact_submissions ${clause} ORDER BY created_at DESC LIMIT ?`,
      )
      .all(...args, limit) as ContactRow[];

    const contacts = rows.map((r) => ({
      id: r.id,
      name: r.name,
      email: r.email,
      company: r.company,
      role: r.role,
      source: r.source,
      message: r.message,
      delivered: r.delivered === 1,
      created_at: r.created_at,
    }));

    writeResponse(inDb, requestId, { ok: true, data: { contacts, count: contacts.length } });
  } catch (err) {
    log.error('handleReadContacts failed', { err });
    writeResponse(inDb, requestId, {
      ok: false,
      error: { code: 'READ_ERROR', message: err instanceof Error ? err.message : String(err) },
    });
  }
}
