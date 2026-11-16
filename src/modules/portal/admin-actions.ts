/**
 * src/modules/portal/admin-actions.ts — the `/api/admin/actions` resource
 * (STRATEGY.md §24.203): the owner's agent-action buttons.
 *
 *   GET  /api/admin/actions[?lead_id=<id>]  → { actions, meta }
 *   GET  /api/admin/actions/<id>            → AgentActionDetail | 404
 *   POST /api/admin/actions                 → enqueue / run_now (202)
 *
 * Every route sits inside api.ts's `/api/admin/` block, so `adminEnabled()`
 * gates reads and writes server-side. The store and the agent loop live in
 * `career-pilot/agent-actions.ts`; this file only shapes HTTP answers and makes
 * sure nothing escapes as an unhandled exception.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import {
  type AgentActionDeps,
  type AgentActionDetail,
  type AgentActionRow,
  type AgentActionsMeta,
  applyAdminActionWrite,
  buildAgentActionsMeta,
  getAgentActionDetail,
  listAgentActions,
  refreshAgentActions,
} from '../career-pilot/agent-actions.js';
import { hasTable } from '../../db/connection.js';

export interface AdminActionsView {
  actions: AgentActionRow[];
  meta: AgentActionsMeta;
}

export interface AdminOutcome {
  status: number;
  body: unknown;
}

function internal(where: string, err: unknown): AdminOutcome {
  log.error(`admin actions: ${where} failed`, { err: err instanceof Error ? err.message : String(err) });
  return { status: 500, body: { error: 'internal_error' } };
}

/** `GET /api/admin/actions` — newest first, observed against the ops session first. */
export function readAdminActions(
  db: Database.Database,
  leadId: string | null,
  deps: AgentActionDeps = {},
): AdminOutcome {
  try {
    if (!hasTable(db, 'agent_actions')) return { status: 404, body: { error: 'agent_actions not migrated' } };
    const meta = buildAgentActionsMeta(db, deps); // observes + expires before the list is read
    const view: AdminActionsView = { actions: listAgentActions(db, leadId), meta };
    return { status: 200, body: view };
  } catch (err) {
    return internal('list', err);
  }
}

/** `GET /api/admin/actions/<id>`. */
export function readAdminAction(db: Database.Database, id: string, deps: AgentActionDeps = {}): AdminOutcome {
  try {
    if (!hasTable(db, 'agent_actions')) return { status: 404, body: { error: 'agent_actions not migrated' } };
    refreshAgentActions(db, deps);
    const detail: AgentActionDetail | null = getAgentActionDetail(db, id, deps.now?.() ?? new Date());
    if (!detail) return { status: 404, body: { error: 'not_found' } };
    return { status: 200, body: detail };
  } catch (err) {
    return internal('detail', err);
  }
}

/** `POST /api/admin/actions`. */
export function writeAdminAction(db: Database.Database, raw: unknown, deps: AgentActionDeps = {}): AdminOutcome {
  try {
    return applyAdminActionWrite(db, raw, deps);
  } catch (err) {
    return internal('enqueue', err);
  }
}
