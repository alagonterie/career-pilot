import { findByName, getAllDestinations, type DestinationEntry } from './destinations.js';
import { getPendingMessages, markProcessing, markCompleted, type MessageInRow } from './db/messages-in.js';
import { writeMessageOut } from './db/messages-out.js';
import { getInboundDb, touchHeartbeat, clearStaleProcessingAcks } from './db/connection.js';
import { clearContinuation, migrateLegacyContinuation, setContinuation } from './db/session-state.js';
import { clearCurrentInReplyTo, setCurrentInReplyTo } from './current-batch.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  stripInternalTags,
  type RoutingContext,
} from './formatter.js';
import { sendActionNoWait } from './career-pilot/action.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

const POLL_INTERVAL_MS = 1000;
const ACTIVE_POLL_INTERVAL_MS = 500;

/**
 * Max targeted "you wrote a tool call as text" nudges per query (STRATEGY.md
 * §24.13). The GLM tool-shape pathology recurs per tool-call step (delegate,
 * then deliver), so a one-shot nudge isn't enough; bounded to avoid a nudge
 * loop if the model never recovers. Inert for real Claude (never tripped).
 */
const MAX_TOOL_TEXT_NUDGES = 3;

/**
 * Number of consecutive `database disk image is malformed` errors after which
 * the follow-up poll gives up and exits the process. At ACTIVE_POLL_INTERVAL_MS
 * = 500ms this is roughly 5 seconds — long enough to dodge a transient torn
 * read during a host write, short enough to recover quickly from a poisoned
 * page cache (host-sweep then respawns with a fresh mount).
 */
const CORRUPTION_STREAK_EXIT = 10;

/**
 * True for SQLite errors that indicate a corrupt READ view — almost always a
 * cross-mount page-cache coherency issue on Docker Desktop macOS rather than
 * actual file damage (host-side integrity_check passes). Reopening the DB
 * handle inside this process does NOT recover; only a fresh container mount
 * does. Caller's job is to exit so host-sweep respawns the container.
 */
export function isCorruptionError(msg: string): boolean {
  return (
    msg.includes('database disk image is malformed') ||
    msg.includes('SQLITE_CORRUPT') ||
    msg.includes('file is not a database')
  );
}

function log(msg: string): void {
  console.error(`[poll-loop] ${msg}`);
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface PollLoopConfig {
  provider: AgentProvider;
  /**
   * Name of the provider (e.g. "claude", "codex", "opencode"). Used to key
   * the stored continuation per-provider so flipping providers doesn't
   * resurrect a stale id from a different backend.
   */
  providerName: string;
  cwd: string;
  systemContext?: {
    instructions?: string;
  };
  /**
   * Optional cancellation signal. When it fires, the loop exits at the next
   * iteration boundary and any in-flight idle sleep wakes immediately.
   * Undefined in production — runPollLoop runs until the process is killed.
   * Tests pass a signal so they can stop the loop deterministically instead
   * of leaking a `while (true)` that keeps contending on the shared inbound DB.
   */
  signal?: AbortSignal;
}

/**
 * Main poll loop. Runs indefinitely until the process is killed.
 *
 * 1. Poll messages_in for pending rows
 * 2. Format into prompt, call provider.query()
 * 3. While query active: continue polling, push new messages via provider.push()
 * 4. On result: write messages_out
 * 5. Mark messages completed
 * 6. Loop
 */
export async function runPollLoop(config: PollLoopConfig): Promise<void> {
  // Resume the agent's prior session from a previous container run if one
  // was persisted. The continuation is opaque to the poll-loop — the
  // provider decides how to use it (Claude resumes a .jsonl transcript,
  // other providers may reload a thread ID, etc.). Keyed per-provider so
  // a Codex thread id never gets handed to Claude or vice versa.
  let continuation: string | undefined = migrateLegacyContinuation(config.providerName);

  // Before resuming, drop a session whose on-disk transcript has grown too
  // large/old to cold-resume within the host's idle ceiling. Without this a
  // long-lived hub keeps trying to reload an ever-growing .jsonl, hangs the
  // first turn, and gets killed before it can reply (then repeats forever).
  if (continuation) {
    const rotateReason = config.provider.maybeRotateContinuation?.(continuation, config.cwd);
    if (rotateReason) {
      log(`Rotating session — ${rotateReason}; starting fresh`);
      clearContinuation(config.providerName);
      continuation = undefined;
    }
  }

  if (continuation) {
    log(`Resuming agent session ${continuation}`);
  }

  // Clear leftover 'processing' acks from a previous crashed container.
  // This lets the new container re-process those messages.
  clearStaleProcessingAcks();

  let pollCount = 0;
  let isFirstPoll = true;
  while (true) {
    // Cancellation (tests only — undefined signal in production). Checked at the
    // top of every iteration so an aborted loop exits instead of leaking.
    if (config.signal?.aborted) {
      log('Poll loop aborted — exiting');
      return;
    }
    // Skip system messages — they're responses for MCP tools (e.g., ask_user_question)
    const messages = getPendingMessages(isFirstPoll).filter((m) => m.kind !== 'system');
    isFirstPoll = false;
    pollCount++;

    // Periodic heartbeat so we know the loop is alive
    if (pollCount % 30 === 0) {
      log(`Poll heartbeat (${pollCount} iterations, ${messages.length} pending)`);
    }

    if (messages.length === 0) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    // Accumulate gate: if the batch contains only trigger=0 rows
    // (context-only, router-stored under ignored_message_policy='accumulate'),
    // don't wake the agent. Leave them `pending` — they'll ride along the
    // next time a real trigger=1 message lands via this same getPendingMessages
    // query. Without this gate, a warm container keeps processing
    // (and potentially responding to) every accumulate-only batch, defeating
    // the "store as context, don't engage" contract. Host-side countDueMessages
    // gates the same way for wake-from-cold (see src/db/session-db.ts).
    if (!messages.some((m) => m.trigger === 1)) {
      await sleep(POLL_INTERVAL_MS, config.signal);
      continue;
    }

    const ids = messages.map((m) => m.id);
    markProcessing(ids);

    const routing = extractRouting(messages);

    // Command handling: the host router gates filtered and unauthorized
    // admin commands before they reach the container. The only command
    // the runner handles directly is /clear (session reset).
    const normalMessages: MessageInRow[] = [];
    const commandIds: string[] = [];

    for (const msg of messages) {
      if ((msg.kind === 'chat' || msg.kind === 'chat-sdk') && isClearCommand(msg)) {
        log('Clearing session (resetting continuation)');
        continuation = undefined;
        clearContinuation(config.providerName);
        writeMessageOut({
          id: generateId(),
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: 'Session cleared.' }),
        });
        commandIds.push(msg.id);
        continue;
      }
      normalMessages.push(msg);
    }

    if (commandIds.length > 0) {
      markCompleted(commandIds);
    }

    if (normalMessages.length === 0) {
      const remainingIds = ids.filter((id) => !commandIds.includes(id));
      if (remainingIds.length > 0) markCompleted(remainingIds);
      log(`All ${messages.length} message(s) were commands, skipping query`);
      continue;
    }

    // Pre-task scripts: for any task rows with a `script`, run it before the
    // provider call. Scripts returning wakeAgent=false (or erroring) gate
    // their own task row only — surviving messages still go to the agent.
    // Without the scheduling module, the marker block is empty, `keep`
    // falls back to `normalMessages`, and no gating happens.
    let keep: MessageInRow[] = normalMessages;
    let skipped: string[] = [];
    // MODULE-HOOK:scheduling-pre-task:start
    const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
    const preTask = await applyPreTaskScripts(normalMessages);
    keep = preTask.keep;
    skipped = preTask.skipped;
    if (skipped.length > 0) {
      markCompleted(skipped);
      log(`Pre-task script skipped ${skipped.length} task(s): ${skipped.join(', ')}`);
    }
    // MODULE-HOOK:scheduling-pre-task:end

    if (keep.length === 0) {
      log(`All ${normalMessages.length} non-command message(s) gated by script, skipping query`);
      continue;
    }

    // Format messages: passthrough commands get raw text (only if the
    // provider natively handles slash commands), others get XML.
    const prompt = formatMessagesWithCommands(keep, config.provider.supportsNativeSlashCommands);

    log(`Processing ${keep.length} message(s), kinds: ${[...new Set(keep.map((m) => m.kind))].join(',')}`);

    const query = config.provider.query({
      prompt,
      continuation,
      cwd: config.cwd,
      systemContext: config.systemContext,
    });

    // Process the query while concurrently polling for new messages
    const skippedSet = new Set(skipped);
    const processingIds = ids.filter((id) => !commandIds.includes(id) && !skippedSet.has(id));
    // Publish the batch's in_reply_to so MCP tools (send_message, send_file)
    // can stamp it on outbound rows — needed for a2a return-path routing.
    setCurrentInReplyTo(routing.inReplyTo);
    try {
      const result = await processQuery(query, routing, processingIds, config.providerName);
      if (result.continuation && result.continuation !== continuation) {
        continuation = result.continuation;
        setContinuation(config.providerName, continuation);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log(`Query error: ${errMsg}`);

      // Stale/corrupt continuation recovery: ask the provider whether
      // this error means the stored continuation is unusable, and clear
      // it so the next attempt starts fresh.
      if (continuation && config.provider.isSessionInvalid(err)) {
        log(`Stale session detected (${continuation}) — clearing for next retry`);
        continuation = undefined;
        clearContinuation(config.providerName);
      }

      // Write error response so the user knows something went wrong
      writeMessageOut({
        id: generateId(),
        kind: 'chat',
        platform_id: routing.platformId,
        channel_type: routing.channelType,
        thread_id: routing.threadId,
        content: JSON.stringify({ text: `Error: ${errMsg}` }),
      });
    } finally {
      clearCurrentInReplyTo();
    }

    // Ensure completed even if processQuery ended without a result event
    // (e.g. stream closed unexpectedly).
    markCompleted(processingIds);
    log(`Completed ${ids.length} message(s)`);
  }
}

/**
 * Format messages, handling passthrough commands differently.
 * When the provider handles slash commands natively (Claude Code),
 * passthrough commands are sent raw (no XML wrapping) so the SDK can
 * dispatch them. Otherwise they fall through to standard XML formatting.
 */
function formatMessagesWithCommands(messages: MessageInRow[], nativeSlashCommands: boolean): string {
  const parts: string[] = [];
  const normalBatch: MessageInRow[] = [];

  for (const msg of messages) {
    if (nativeSlashCommands && (msg.kind === 'chat' || msg.kind === 'chat-sdk')) {
      const cmdInfo = categorizeMessage(msg);
      if (cmdInfo.category === 'passthrough' || cmdInfo.category === 'admin') {
        // Flush normal batch first
        if (normalBatch.length > 0) {
          parts.push(formatMessages(normalBatch));
          normalBatch.length = 0;
        }
        // Pass raw command text (no XML wrapping) — SDK handles it natively
        parts.push(cmdInfo.text);
        continue;
      }
    }
    normalBatch.push(msg);
  }

  if (normalBatch.length > 0) {
    parts.push(formatMessages(normalBatch));
  }

  return parts.join('\n\n');
}

interface QueryResult {
  continuation?: string;
}

async function processQuery(
  query: AgentQuery,
  routing: RoutingContext,
  initialBatchIds: string[],
  providerName: string,
): Promise<QueryResult> {
  let queryContinuation: string | undefined;
  let done = false;
  let unwrappedNudged = false;
  let toolTextNudges = 0;
  // The simulator's terminal marker (§24.21 Δ): the host finalizes a run on
  // the kind:'trace' t:'result' row, so it must be the LAST outbound row of
  // the query — after the final <message> chat rows (written from the result
  // text below) and after any nudge-recovered turns. Stash it here (cost is
  // cumulative; last wins) and write it once the SDK loop completes.
  let pendingResultTrace: unknown = null;

  // Concurrent polling: push follow-ups into the active query as they arrive.
  // We do NOT force-end the stream on silence — keeping the query open avoids
  // re-spawning the SDK subprocess (~few seconds) and re-loading the .jsonl
  // transcript on every turn. The Anthropic prompt cache is server-side with
  // a 5-min TTL keyed on prefix hash, so stream lifecycle does NOT affect
  // cache lifetime — close+reopen within 5 min still gets cache hits.
  // Stream liveness is decided host-side via the heartbeat file + processing
  // claim age (see src/host-sweep.ts); if something is truly stuck, the host
  // will kill the container and messages get reset to pending.
  let pollInFlight = false;
  let endedForCommand = false;
  let corruptionStreak = 0;
  const pollHandle = setInterval(() => {
    if (done || pollInFlight || endedForCommand) return;
    pollInFlight = true;

    void (async () => {
      try {
        const pending = getPendingMessages();

        // Slash commands need a fresh query: /clear resets the SDK's
        // resume id (fixed at sdkQuery() time); admin/passthrough commands
        // (/compact, /cost, …) only dispatch when they're the first input
        // of a query — pushed mid-stream they arrive as plain text and
        // the SDK never runs them. End the stream and leave the rows
        // pending; the outer loop handles them on next iteration via the
        // canonical command path + formatMessagesWithCommands.
        if (pending.some((m) => isRunnerCommand(m))) {
          log('Pending slash command — ending stream so outer loop can process');
          endedForCommand = true;
          query.end();
          return;
        }

        // Skip system messages (MCP tool responses).
        // Thread routing is the router's concern — if a message landed in this
        // session, the agent should see it. Per-thread sessions already isolate
        // threads into separate containers; shared sessions intentionally merge
        // everything. Filtering on thread_id here caused deadlocks when the
        // initial batch and follow-ups had mismatched thread_ids (e.g. a
        // host-generated welcome trigger with null thread vs a Discord DM reply).
        const newMessages = pending.filter((m) => m.kind !== 'system');
        if (newMessages.length === 0) return;

        const newIds = newMessages.map((m) => m.id);
        markProcessing(newIds);

        // Run pre-task scripts on follow-ups too — without this, a task that
        // arrives during an active query (e.g. a */10 monitoring cron) bypasses
        // its script gate and always wakes the agent, defeating the gate.
        // Mirrors the initial-batch hook above.
        let keep = newMessages;
        let skipped: string[] = [];
        // MODULE-HOOK:scheduling-pre-task-followup:start
        const { applyPreTaskScripts } = await import('./scheduling/task-script.js');
        const preTask = await applyPreTaskScripts(newMessages);
        keep = preTask.keep;
        skipped = preTask.skipped;
        if (skipped.length > 0) {
          markCompleted(skipped);
          log(`Pre-task script skipped ${skipped.length} follow-up task(s): ${skipped.join(', ')}`);
        }
        // MODULE-HOOK:scheduling-pre-task-followup:end

        if (keep.length === 0) return;
        // Re-check done — the outer query may have finished while the script
        // was awaited. Pushing into a closed stream is wasted work; the
        // claimed messages get released by the host's processing-claim sweep.
        if (done) return;

        const keptIds = keep.map((m) => m.id);
        const prompt = formatMessages(keep);
        log(`Pushing ${keep.length} follow-up message(s) into active query`);
        unwrappedNudged = false;
        query.push(prompt);
        markCompleted(keptIds);
      } catch (err) {
        // Without this catch the rejection escapes the void IIFE and Node
        // terminates the container on unhandled-rejection. The initial-batch
        // path is wrapped by processQuery's outer try/catch; the follow-up
        // path is not, so it needs its own.
        const errMsg = err instanceof Error ? err.message : String(err);
        log(`Follow-up poll error: ${errMsg}`);

        // Detect SQLite cross-mount corruption (Docker Desktop macOS virtiofs /
        // gRPC-FUSE coherency bug — the kernel page cache for the inbound.db
        // bind mount can latch a torn snapshot mid-host-write, after which
        // every fresh openInboundDb() in this process sees the same broken
        // view. Reopening inside the container does NOT recover; only a fresh
        // container mount does. Exit so the host sweep respawns us.
        if (isCorruptionError(errMsg)) {
          corruptionStreak += 1;
          if (corruptionStreak >= CORRUPTION_STREAK_EXIT) {
            log(
              `Follow-up poll: ${corruptionStreak} consecutive '${errMsg}' errors — ` +
                `inbound.db page cache is poisoned. Exiting so host respawns with a fresh mount.`,
            );
            // Stop touching the heartbeat so host-sweep stale detection fires
            // promptly even if exit() races with in-flight async work.
            done = true;
            clearInterval(pollHandle);
            // Defer exit one tick so this log line flushes through Docker's
            // log driver before the process dies.
            setTimeout(() => process.exit(75), 100);
          }
        } else {
          corruptionStreak = 0;
        }
      } finally {
        pollInFlight = false;
      }
    })();
  }, ACTIVE_POLL_INTERVAL_MS);

  try {
    for await (const event of query.events) {
      handleEvent(event, routing);
      touchHeartbeat();

      if (event.type === 'init') {
        queryContinuation = event.continuation;
        // Persist immediately so a mid-turn container crash still lets the
        // next wake resume the conversation. Without this, the session id
        // was only written after the full stream completed — if the
        // container died between `init` and `result`, the SDK session was
        // effectively orphaned and the next message started a blank
        // Claude session with no prior context.
        setContinuation(providerName, event.continuation);
      } else if (event.type === 'result') {
        // A result — with or without text — means the turn is done. Mark
        // the initial batch completed now so the host sweep doesn't see
        // stale 'processing' claims while the query stays open for
        // follow-up pushes. The agent may have responded via MCP
        // (send_message) mid-turn, or the message may not need a response
        // at all — either way the turn is finished.
        markCompleted(initialBatchIds);
        // §24.34: when the turn did portal-worthy work (made ≥1 record_* call),
        // emit a fire-and-forget per-turn telemetry row. Owner-only host-side
        // (registerOwnerOnly) — a sandbox emission is rejected by the perimeter,
        // so no group check is needed here. Never blocks turn teardown.
        if (event.telemetry && event.telemetry.record_calls > 0) {
          const t = event.telemetry;
          void sendActionNoWait('career_pilot.record_turn_telemetry', {
            model_used: t.model_used,
            tokens: t.tokens,
            cost_cents: t.cost_cents,
            cache_hit: t.cache_hit,
            latency_ms: t.latency_ms,
            record_calls: t.record_calls,
            details: t.details,
          }).catch((err) => log(`turn-telemetry emit failed: ${err instanceof Error ? err.message : String(err)}`));
        }
        if (event.text) {
          const { hasUnwrapped, toolTextEmissions } = dispatchResultText(event.text, routing);
          if (hasUnwrapped && toolTextEmissions.length > 0 && toolTextNudges < MAX_TOOL_TEXT_NUDGES) {
            // §24.13 footgun fix: the model TRIED to call a tool but wrote it as
            // text. The generic "wrap it in <message>" nudge makes GLM fabricate
            // a "work done" reply — so steer it to re-issue a REAL tool call.
            // Bounded (not one-shot) because the pathology recurs per tool-call
            // step (delegate, then deliver). Keyed on detected tool-text, so
            // this branch never runs for real Claude — production unchanged.
            toolTextNudges++;
            const first = toolTextEmissions[0];
            const isDelegation = first.tool === 'Agent' || first.tool === 'Task';
            const subTypes = [...new Set(toolTextEmissions.map((e) => e.subagentType).filter(Boolean))].join(', ');
            query.push(
              `<system>Your ${isDelegation ? 'delegation' : 'tool call'} did NOT happen. You wrote ${first.tool} as ` +
                `XML-shaped text (e.g. "<${first.tool} ...>") — that is inert text, not a tool call, so it never ran. ` +
                `Re-issue it as a REAL structured tool call: invoke ${first.tool}` +
                `${isDelegation && subTypes ? ` with subagent_type "${subTypes}"` : ''} via the tool-use mechanism, ` +
                `exactly as you call any other tool. Do NOT describe the call in text and do NOT claim it is done — ` +
                `make the tool call now.</system>`,
            );
          } else if (hasUnwrapped && toolTextEmissions.length === 0 && !unwrappedNudged) {
            unwrappedNudged = true;
            const destinations = getAllDestinations();
            const names = destinations.map((d) => d.name).join(', ');
            query.push(
              `<system>Your response was not delivered — it was not wrapped in <message to="name">...</message> blocks. ` +
                `All output must be wrapped: use <message to="name"> for content to send, or <internal> for scratchpad. ` +
                `Your destinations: ${names}. ` +
                `Please re-send your response with the correct wrapping.</system>`,
            );
          }
        }
      } else if (event.type === 'trace') {
        // Simulator trace step (§24.20). Sandbox-only — the provider only emits
        // these when emitTrace is set. Persist as a kind:'trace' outbound row
        // routed to the run's portal stream; the host pushes it to the
        // simulator:<id> SSE topic via the portal channel adapter. The t:'result'
        // trace is deferred to end-of-loop (see pendingResultTrace above).
        const t = (event.trace as { t?: string }).t;
        if (t === 'result') {
          pendingResultTrace = event.trace;
        } else {
          writeMessageOut({
            id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'trace',
            content: JSON.stringify(event.trace),
            platform_id: routing.platformId,
            channel_type: routing.channelType,
            thread_id: routing.threadId,
          });
        }
      }
    }
  } finally {
    done = true;
    clearInterval(pollHandle);
    if (pendingResultTrace) {
      // Written even when the loop ends by error: the run is over either way,
      // and the host should finalize with whatever output exists rather than
      // wait for the hard wall.
      try {
        writeMessageOut({
          id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          kind: 'trace',
          content: JSON.stringify(pendingResultTrace),
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
        });
      } catch (err) {
        log(`terminal result-trace write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return { continuation: queryContinuation };
}

function handleEvent(event: ProviderEvent, _routing: RoutingContext): void {
  switch (event.type) {
    case 'init':
      log(`Session: ${event.continuation}`);
      break;
    case 'result':
      log(`Result: ${event.text ? event.text.slice(0, 200) : '(empty)'}`);
      break;
    case 'error':
      log(
        `Error: ${event.message} (retryable: ${event.retryable}${event.classification ? `, ${event.classification}` : ''})`,
      );
      break;
    case 'progress':
      log(`Progress: ${event.message}`);
      break;
  }
}

export interface ParsedMessageBlock {
  toName: string;
  body: string;
}

export interface ParsedAgentOutput {
  /** Each block to dispatch (in source order). */
  blocks: ParsedMessageBlock[];
  /** Concatenated text outside delivered blocks (with <internal>...</internal> stripped). */
  scratchpad: string;
  /** Which parse path produced the result — for logging + assertions. */
  parseMode: 'strict' | 'lenient-recovered' | 'no-blocks';
}

/**
 * Pure parser for the agent's final text. Extracts `<message to="name">
 * ...</message>` blocks and the surrounding scratchpad.
 *
 * Strict mode (the contract): the agent wraps every delivered line in
 * complete `<message to="X">...</message>` blocks; bare text outside is
 * scratchpad; `<internal>...</internal>` is also scratchpad.
 *
 * Lenient recovery: when ZERO complete blocks parse AND exactly ONE
 * `<message to="X">` opener appears with no closing `</message>`, the
 * parser treats everything from the opener to EOF as the body. This
 * salvages a common GLM-on-Ollama instruction-following failure (open
 * tag without close, even after the unwrapped-warning system message
 * asks for a re-send) without changing semantics for well-behaved
 * agents. Multiple unclosed opens = ambiguous, returns `no-blocks`.
 *
 * See task #87 + STRATEGY.md §24.3 relaxation notes for the empirical
 * motivation. Exported for unit testing.
 */
export function parseAgentMessages(text: string): ParsedAgentOutput {
  const MESSAGE_RE = /<message\s+to="([^"]+)"\s*>([\s\S]*?)<\/message>/g;
  const blocks: ParsedMessageBlock[] = [];
  let scratchpadParts: string[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = MESSAGE_RE.exec(text)) !== null) {
    if (match.index > lastIndex) {
      scratchpadParts.push(text.slice(lastIndex, match.index));
    }
    blocks.push({ toName: match[1], body: match[2].trim() });
    lastIndex = MESSAGE_RE.lastIndex;
  }
  if (lastIndex < text.length) {
    scratchpadParts.push(text.slice(lastIndex));
  }

  if (blocks.length > 0) {
    return {
      blocks,
      scratchpad: stripInternalTags(scratchpadParts.join('')),
      parseMode: 'strict',
    };
  }

  // Lenient fallback: exactly one dangling open tag, no closer anywhere.
  const OPEN_ONLY_RE = /<message\s+to="([^"]+)"\s*>/g;
  const openMatches = [...text.matchAll(OPEN_ONLY_RE)];
  if (openMatches.length === 1) {
    const openMatch = openMatches[0];
    const openIdx = openMatch.index!;
    const openEnd = openIdx + openMatch[0].length;
    const rawBody = text.slice(openEnd);
    const body = stripInternalTags(rawBody).trim();
    if (body) {
      return {
        blocks: [{ toName: openMatch[1], body }],
        scratchpad: openIdx > 0 ? stripInternalTags(text.slice(0, openIdx)) : '',
        parseMode: 'lenient-recovered',
      };
    }
  }

  return {
    blocks: [],
    scratchpad: stripInternalTags(scratchpadParts.join('')),
    parseMode: 'no-blocks',
  };
}

export interface ToolCallTextEmission {
  /** The tool the model tried to call as text (e.g. "Agent", "send_message"). */
  tool: string;
  /** `subagent_type` attr value — only for Agent/Task delegations, else null. */
  subagentType: string | null;
  /** `prompt` attr value (best-effort) — only for Agent/Task delegations, else null. */
  prompt: string | null;
}

/**
 * Detect the GLM tool-shape failure (STRATEGY.md §24.13): the model emits a tool
 * call as literal XML-shaped TEXT instead of a structured `tool_use` block, e.g.
 *   <Agent subagent_type="research-company" prompt="..." />   (delegation step)
 *   <send_message to="owner">...the answer...</send_message>  (delivery step)
 * The SDK ignores such text, the call never runs, and the turn ends doing nothing.
 * The localized trigger is the `claude_code` system preset (upstream, not
 * author-controllable) — so the only in-our-control fix is runner-side. The
 * pathology is not Agent-specific; it recurs at every tool-call step.
 *
 * We match a CLOSED list of real tool names (delegation + NanoClaw delivery +
 * any `mcp__*` in-process tool), NOT arbitrary tags — so the legit delivery-
 * protocol tags `<message>` / `<internal>` and incidental prose/markup never
 * trip it.
 *
 * Production-safety invariant: a correct structured `tool_use` (what real Claude
 * emits) NEVER serializes into the final result text as one of these tags. So
 * this returns [] for well-behaved output and every recovery path keyed on it is
 * a strict no-op in production. Exported for unit testing.
 *
 * `prompt` extraction is best-effort: a double-quote inside the value truncates
 * capture. Tier-0 only needs the tag + subagent_type; a robust parse is Tier-1's.
 */
export function detectToolCallTextEmission(text: string): ToolCallTextEmission[] {
  const TAG_RE = /<(Agent|Task|send_message|send_file|edit_message|add_reaction|mcp__[A-Za-z0-9_-]+)\b([^>]*?)\/?>/gi;
  const out: ToolCallTextEmission[] = [];
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(text)) !== null) {
    const tool = m[1];
    const attrs = m[2] ?? '';
    const isDelegation = tool === 'Agent' || tool === 'Task';
    const subType = isDelegation ? /\bsubagent_type\s*=\s*"([^"]*)"/i.exec(attrs) : null;
    const prompt = isDelegation ? /\bprompt\s*=\s*"([^"]*)"/i.exec(attrs) : null;
    out.push({
      tool,
      subagentType: subType ? subType[1] : null,
      prompt: prompt ? prompt[1] : null,
    });
  }
  return out;
}

/**
 * Parse the agent's final text into message blocks (via `parseAgentMessages`)
 * and dispatch each block to its resolved destination. Logs the lenient
 * salvage path when it fires so operators can see when GLM trips it.
 */
function dispatchResultText(
  text: string,
  routing: RoutingContext,
): { sent: number; hasUnwrapped: boolean; toolTextEmissions: ToolCallTextEmission[] } {
  const parsed = parseAgentMessages(text);
  let sent = 0;

  for (const block of parsed.blocks) {
    const dest = findByName(block.toName);
    if (!dest) {
      log(`Unknown destination in <message to="${block.toName}">, dropping block`);
      continue;
    }
    sendToDestination(dest, block.body, routing);
    sent++;
  }

  if (parsed.parseMode === 'lenient-recovered' && parsed.blocks.length === 1) {
    log(
      `Lenient parse: dangling <message to="${parsed.blocks[0].toName}"> with no close — ` +
        `treating remaining ${parsed.blocks[0].body.length} chars as body`,
    );
  }

  // GLM tool-shape failure (§24.13): the model wrote a tool call as XML-shaped
  // text instead of calling the tool. Log loudly so e2e + operators see the real
  // cause rather than a downstream symptom. No-op for real Claude (structured
  // tool_use never serializes as a <tool ...> tag).
  const toolTextEmissions = detectToolCallTextEmission(text);
  if (toolTextEmissions.length > 0) {
    const names = toolTextEmissions.map((e) => (e.subagentType ? `${e.tool}(${e.subagentType})` : e.tool)).join(', ');
    log(
      `KNOWN GLM TOOL-SHAPE FAILURE: ${toolTextEmissions.length} tool call(s) emitted as XML-shaped TEXT, ` +
        `not a structured tool_use block (${names}). The call(s) did not run. See STRATEGY.md §24.13.`,
    );
  }

  if (parsed.scratchpad) {
    log(`[scratchpad] ${parsed.scratchpad.slice(0, 500)}${parsed.scratchpad.length > 500 ? '…' : ''}`);
  }

  const hasUnwrapped = sent === 0 && !!parsed.scratchpad;
  if (hasUnwrapped) {
    log(`WARNING: agent output had no <message to="..."> blocks — nothing was sent`);
  }
  return { sent, hasUnwrapped, toolTextEmissions };
}

function sendToDestination(dest: DestinationEntry, body: string, routing: RoutingContext): void {
  const platformId = dest.type === 'channel' ? dest.platformId! : dest.agentGroupId!;
  const channelType = dest.type === 'channel' ? dest.channelType! : 'agent';
  // Resolve thread_id per-destination from the most recent inbound message
  // that came from this same channel+platform. In agent-shared sessions,
  // different destinations have different thread contexts — using a single
  // routing.threadId would stamp one channel's thread onto another.
  const destRouting = resolveDestinationThread(channelType, platformId);
  writeMessageOut({
    id: generateId(),
    in_reply_to: destRouting?.inReplyTo ?? routing.inReplyTo,
    kind: 'chat',
    platform_id: platformId,
    channel_type: channelType,
    thread_id: destRouting?.threadId ?? null,
    content: JSON.stringify({ text: body }),
  });
}

/**
 * Find the thread_id and message id from the most recent inbound message
 * matching the given channel+platform. Returns null if no match found.
 */
function resolveDestinationThread(
  channelType: string,
  platformId: string,
): { threadId: string | null; inReplyTo: string | null } | null {
  try {
    const db = getInboundDb();
    const row = db
      .prepare(
        `SELECT thread_id, id FROM messages_in
         WHERE channel_type = ? AND platform_id = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(channelType, platformId) as { thread_id: string | null; id: string } | undefined;
    if (row) return { threadId: row.thread_id, inReplyTo: row.id };
  } catch (err) {
    log(`resolveDestinationThread error: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
