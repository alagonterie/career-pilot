/**
 * Unit tests for the `portal` channel adapter (Sub-milestone 5.5a,
 * STRATEGY.md §24.19): the adapter contract + the submitSimulatorRun → captured
 * onInbound injection that spawns a per-thread sandbox session.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { ChannelSetup, InboundMessage } from '../adapter.js';

import {
  _resetPortalAdapter,
  createPortalAdapter,
  SANDBOX_PLATFORM_ID,
  submitSimulatorRun,
} from './adapter.js';

type InboundCall = [platformId: string, threadId: string | null, message: InboundMessage];

function capturingSetup(calls: InboundCall[]): ChannelSetup {
  return {
    onInbound: (platformId, threadId, message) => {
      calls.push([platformId, threadId, message]);
    },
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  };
}

describe('portal channel adapter', () => {
  beforeEach(() => _resetPortalAdapter());
  afterEach(() => _resetPortalAdapter());

  it('exposes the portal contract (threaded, disconnected until setup)', () => {
    const a = createPortalAdapter();
    expect(a.name).toBe('portal');
    expect(a.channelType).toBe('portal');
    expect(a.supportsThreads).toBe(true);
    expect(a.isConnected()).toBe(false);
  });

  it('submitSimulatorRun throws before the adapter is set up', () => {
    expect(() => submitSimulatorRun('sb-1', 'hi')).toThrow(/not initialized/);
  });

  it('routes a run through the captured onInbound on the sandbox platform', async () => {
    const calls: InboundCall[] = [];
    const a = createPortalAdapter();
    await a.setup(capturingSetup(calls));
    expect(a.isConnected()).toBe(true);

    submitSimulatorRun('sb-9', 'PROMPT-BODY');

    expect(calls).toHaveLength(1);
    const [platformId, threadId, message] = calls[0];
    expect(platformId).toBe(SANDBOX_PLATFORM_ID);
    expect(threadId).toBe('sb-9'); // run id is the threadId → per-thread session
    expect(message.kind).toBe('chat');
    const content = message.content as { text: string; sender: string; senderId: string };
    expect(content.text).toBe('PROMPT-BODY');
    expect(content.sender).toBe('simulator');
    expect(content.senderId).toContain('portal:');
  });

  it('teardown disconnects and clears the captured setup', async () => {
    const a = createPortalAdapter();
    await a.setup(capturingSetup([]));
    await a.teardown();
    expect(a.isConnected()).toBe(false);
    expect(() => submitSimulatorRun('sb-2', 'x')).toThrow(/not initialized/);
  });

  it('deliver is a no-op that resolves undefined (SSE push is 5.5b)', async () => {
    const a = createPortalAdapter();
    await a.setup(capturingSetup([]));
    await expect(
      a.deliver('sandbox', 'sb-1', { kind: 'chat', content: { text: 'x' } }),
    ).resolves.toBeUndefined();
  });
});
