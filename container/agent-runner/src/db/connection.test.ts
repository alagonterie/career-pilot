import { beforeEach, describe, expect, test } from 'bun:test';

import { getOutboundDb, initTestSessionDb, popToolInFlight, pushToolInFlight } from './connection.js';

/**
 * §24.178: the in-flight marker (container_state) must reflect the OUTERMOST
 * tool for the whole nested run. A subagent dispatch surfaces as a parent `Task`
 * whose Pre/PostToolUse bracket the subagent; the subagent's own nested tool
 * calls fire the same hooks on the same singleton row. The marker must stay set
 * until the outermost tool completes — otherwise a nested PostToolUse erases the
 * parent `Task` marker mid-subagent and the host's idle-ceiling extension
 * (§24.114) is dropped, letting the short ops ceiling reap the container mid-turn.
 */

beforeEach(() => {
  initTestSessionDb();
});

function marker(): { current_tool: string | null; tool_declared_timeout_ms: number | null } | undefined {
  return getOutboundDb()
    .prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state WHERE id = 1')
    .get() as { current_tool: string | null; tool_declared_timeout_ms: number | null } | undefined;
}

describe('container_state — nesting-aware in-flight marker', () => {
  test('push sets the marker; the matching pop clears it', () => {
    pushToolInFlight('Bash', 5000);
    expect(marker()).toMatchObject({ current_tool: 'Bash', tool_declared_timeout_ms: 5000 });

    popToolInFlight();
    expect(marker()?.current_tool).toBeNull();
  });

  test('a nested tool does NOT clear the outermost marker until its own pop (the subagent case)', () => {
    // Parent `Task` (no declared timeout) — the subagent dispatch.
    pushToolInFlight('Task', null);

    // Subagent's nested tool calls — each push/pop while `Task` is still running.
    pushToolInFlight('Bash', 3000);
    popToolInFlight(); // nested Bash done — Task still in flight
    expect(marker()).toMatchObject({ current_tool: 'Task', tool_declared_timeout_ms: null });

    pushToolInFlight('Read', null);
    popToolInFlight(); // another nested tool done — Task still in flight
    expect(marker()?.current_tool).toBe('Task');

    // Outermost `Task` completes — only now does the marker clear.
    popToolInFlight();
    expect(marker()?.current_tool).toBeNull();
  });

  test('the OUTERMOST tool governs the marker — a nested short timeout never overwrites it', () => {
    pushToolInFlight('Task', null); // outermost: no declared timeout → host applies the 30-min backstop
    pushToolInFlight('Bash', 1000); // a nested 1s Bash must NOT shorten the marker
    expect(marker()).toMatchObject({ current_tool: 'Task', tool_declared_timeout_ms: null });

    popToolInFlight();
    popToolInFlight();
    expect(marker()?.current_tool).toBeNull();
  });

  test('an unbalanced extra pop is a no-op (no throw, depth never goes negative)', () => {
    expect(() => popToolInFlight()).not.toThrow();
    expect(marker()?.current_tool ?? null).toBeNull();

    // A subsequent push/pop still behaves correctly (the depth did not desync).
    pushToolInFlight('Bash', 2000);
    expect(marker()?.current_tool).toBe('Bash');
    popToolInFlight();
    expect(marker()?.current_tool).toBeNull();
  });
});
