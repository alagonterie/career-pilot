/**
 * The admin-action tools' argument guards — these branches return before the
 * host round-trip, so no mock is needed. Handlers never throw.
 */
import { describe, expect, it } from 'bun:test';

import { completeAdminAction, getAdminAction } from './admin-actions.js';

describe('get_admin_action', () => {
  it('requires an action_id (isError, no throw)', async () => {
    expect((await getAdminAction.handler({})).isError).toBe(true);
    expect((await getAdminAction.handler({ action_id: '  ' })).isError).toBe(true);
  });
});

describe('complete_admin_action', () => {
  it('requires an action_id and a boolean ok', async () => {
    expect((await completeAdminAction.handler({ ok: true })).isError).toBe(true);
    expect((await completeAdminAction.handler({ action_id: 'act-1' })).isError).toBe(true);
    expect((await completeAdminAction.handler({ action_id: 'act-1', ok: 'yes' })).isError).toBe(true);
  });

  it('tells the agent not to use the draft tool', () => {
    expect(completeAdminAction.tool.description).toContain('Never call create_gmail_draft');
  });
});
