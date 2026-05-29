/**
 * Tests for the Sub-milestone 5.5b simulator SSE topic (STRATEGY.md §24.20):
 *   - the push-based simulator:<id> broadcaster registry (unit, fake res)
 *   - GET /api/simulator/:id/stream + the portal adapter routing trace/chat
 *     events into the matching run's stream (integration, real server)
 */
import type http from 'http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelSetup } from '../../channels/adapter.js';
import { _resetPortalAdapter, createPortalAdapter } from '../../channels/portal/adapter.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { startPortalApi, stopPortalApi } from './api.js';
import {
  _simulatorClientCount,
  addSimulatorClient,
  pushSimulatorEvent,
  removeSimulatorClient,
  stopBroadcaster,
} from './sse-broadcaster.js';

// ── unit: the push-based simulator topic ───────────────────────────────────

describe('simulator SSE topic (broadcaster)', () => {
  function fakeRes(sink: string[]): http.ServerResponse {
    return {
      write: (chunk: string) => {
        sink.push(chunk);
        return true;
      },
      end: () => undefined,
    } as unknown as http.ServerResponse;
  }

  afterEach(() => stopBroadcaster());

  it('registers, pushes only to the matching run, and removes', () => {
    const a: string[] = [];
    const b: string[] = [];
    const resA = fakeRes(a);
    const resB = fakeRes(b);

    addSimulatorClient('run-A', resA);
    addSimulatorClient('run-B', resB);
    expect(_simulatorClientCount('run-A')).toBe(1);

    pushSimulatorEvent('run-A', 'trace', { t: 'tool', name: 'WebSearch' });
    expect(a.join('')).toContain('event: trace');
    expect(a.join('')).toContain('WebSearch');
    expect(b.join('')).not.toContain('WebSearch'); // isolation between runs

    removeSimulatorClient('run-A', resA);
    expect(_simulatorClientCount('run-A')).toBe(0);
    // Push after removal is a no-op (no throw).
    pushSimulatorEvent('run-A', 'trace', { t: 'tool', name: 'late' });
    expect(a.join('')).not.toContain('late');
  });

  it('stopBroadcaster clears all simulator clients', () => {
    addSimulatorClient('run-C', fakeRes([]));
    expect(_simulatorClientCount('run-C')).toBe(1);
    stopBroadcaster();
    expect(_simulatorClientCount('run-C')).toBe(0);
  });
});

// ── integration: GET /:id/stream + adapter routing ─────────────────────────

describe('GET /api/simulator/:id/stream', () => {
  let base: string;

  beforeEach(async () => {
    closeDb();
    const db = initTestDb();
    runMigrations(db);
    const { port } = await startPortalApi({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${port}`;
    const setup: ChannelSetup = {
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    };
    await createPortalAdapter().setup(setup);
  });

  afterEach(async () => {
    _resetPortalAdapter();
    await stopPortalApi();
    closeDb();
  });

  async function drainUntil(
    url: string,
    opts: { predicate: (buf: string) => boolean; onConnect?: () => void; timeoutMs?: number },
  ): Promise<string> {
    const ac = new AbortController();
    const guard = setTimeout(() => ac.abort(), opts.timeoutMs ?? 3000);
    let buf = '';
    try {
      const res = await fetch(url, { signal: ac.signal });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      opts.onConnect?.();
      while (true) {
        if (opts.predicate(buf)) break;
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
      ac.abort();
    } catch {
      // aborted — return what we have
    } finally {
      clearTimeout(guard);
    }
    return buf;
  }

  it('streams a trace event pushed after connect', async () => {
    const buf = await drainUntil(`${base}/api/simulator/sb-abc/stream`, {
      onConnect: () => pushSimulatorEvent('sb-abc', 'trace', { t: 'subagent', subagent: 'research-company' }),
      predicate: (b) => b.includes('research-company'),
    });
    expect(buf).toContain('event: trace');
    expect(buf).toContain('research-company');
  });

  it('routes a portal adapter deliver() into the run stream', async () => {
    const adapter = createPortalAdapter();
    const buf = await drainUntil(`${base}/api/simulator/sb-xyz/stream`, {
      onConnect: () => {
        void adapter.deliver('sandbox', 'sb-xyz', { kind: 'task', content: { text: 'done — $0.04' } });
      },
      predicate: (b) => b.includes('done'),
    });
    expect(buf).toContain('event: task');
    expect(buf).toContain('done');
  });
});
