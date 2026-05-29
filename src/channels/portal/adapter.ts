/**
 * src/channels/portal/adapter.ts — the `portal` channel adapter.
 *
 * A NanoClaw channel whose transport is HTTP + SSE rather than bot-polling.
 * It carries the public Recruiter Simulator (PORTAL §5.3): each visitor run is
 * a first-class NanoClaw session in the `career-pilot-sandbox` agent group.
 *
 * Inbound: POST /api/simulator (src/modules/portal/{api,simulator}.ts) →
 *   submitSimulatorRun() → the captured ChannelSetup.onInbound, which the host
 *   routes like any other channel message. The run id is passed as the
 *   threadId, so the pre-seeded per-thread sandbox wiring (see
 *   scripts/init-sandbox-group.ts) spawns a fresh isolated session per run.
 *
 * Outbound: delivery.ts drains the sandbox session's messages_out and calls
 *   deliver(). In 5.5a that is a logged no-op — the outbound row is already
 *   persisted, so nothing is lost; the SSE push to the `simulator:<id>` topic
 *   lands in 5.5b (STRATEGY.md §24.20).
 *
 * Sub-milestone 5.5a (STRATEGY.md §24.19).
 */
import { log } from '../../log.js';
import { pushSimulatorEvent } from '../../modules/portal/sse-broadcaster.js';
import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from '../adapter.js';
import { registerChannelAdapter } from '../channel-registry.js';

/**
 * The messaging-group platform id for the public sandbox. Must match the row
 * created by scripts/init-sandbox-group.ts EXACTLY: the host's onInbound
 * forwards this string verbatim to routeInbound (no namespacing), so the
 * messaging_groups lookup `(channel_type='portal', platform_id=<this>)` only
 * resolves when both sides use the same literal.
 */
export const SANDBOX_PLATFORM_ID = 'sandbox';

// Module-level state: the host hands us one ChannelSetup at startup; the HTTP
// layer reaches submitSimulatorRun() to inject runs through it.
let activeSetup: ChannelSetup | null = null;
let connected = false;

export function createPortalAdapter(): ChannelAdapter {
  return {
    name: 'portal',
    channelType: 'portal',
    // Threaded so each run's threadId keys a distinct per-thread session and
    // the host does not collapse it to the channel.
    supportsThreads: true,

    async setup(config: ChannelSetup): Promise<void> {
      activeSetup = config;
      connected = true;
      log.info('Portal channel adapter ready');
    },

    async teardown(): Promise<void> {
      activeSetup = null;
      connected = false;
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(
      platformId: string,
      threadId: string | null,
      message: OutboundMessage,
    ): Promise<string | undefined> {
      // 5.5b: push the outbound row into the run's SSE stream. The run id is the
      // threadId (per-thread session). The SSE event name is the message kind
      // ('trace' | 'chat' | 'task'); the payload is the parsed content. No-op
      // when no client is watching (the row is still persisted by delivery.ts).
      if (threadId) {
        pushSimulatorEvent(threadId, message.kind, message.content);
      } else {
        log.debug('portal deliver: no threadId, dropping', { platformId, kind: message.kind });
      }
      return undefined;
    },
  };
}

/**
 * Inject a simulator run as an inbound message on the sandbox messaging group.
 * Called by the simulator orchestration. The run id becomes the threadId;
 * per-thread session_mode gives each run a fresh isolated session.
 *
 * Throws if the adapter is not yet set up (host not started) — the caller
 * (startSimulatorRun) translates that into a 503-shaped result.
 */
export function submitSimulatorRun(runId: string, prompt: string): void {
  if (!activeSetup) {
    throw new Error('portal channel adapter not initialized');
  }
  const message: InboundMessage = {
    id: `sim-${runId}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    content: { text: prompt, sender: 'simulator', senderId: `portal:${SANDBOX_PLATFORM_ID}` },
  };
  // onInbound is fire-and-forget on the host side (it .catch()es routeInbound
  // internally); we don't await it. Guard the sync call defensively.
  try {
    void activeSetup.onInbound(SANDBOX_PLATFORM_ID, runId, message);
  } catch (err) {
    log.error('portal submitSimulatorRun: onInbound threw', { runId, err });
    throw err;
  }
}

/** Test seam — reset module state between tests. */
export function _resetPortalAdapter(): void {
  activeSetup = null;
  connected = false;
}

registerChannelAdapter('portal', { factory: createPortalAdapter });
