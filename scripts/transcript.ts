#!/usr/bin/env tsx
/**
 * scripts/transcript.ts — read the user↔agent conversation from a terminal
 * (STRATEGY.md §24.198).
 *
 * Merges every session of an agent group (owner chat session + ops session)
 * into one timeline, on any channel. Strictly read-only: the central DB and
 * every session DB are opened `readonly`; nothing is migrated or written.
 *
 * Usage:
 *   pnpm transcript                      last 50 chat messages, owner group
 *   pnpm transcript --since 24h          ISO timestamp or 30m / 24h / 7d
 *   pnpm transcript --tools              + tool calls/results, telemetry, tasks, mirrors
 *   pnpm transcript --json               machine-readable, untruncated
 *   pnpm transcript --sessions           list the group's sessions (counts + ranges)
 *
 * Needs no env loaded — run it from the repo root of the environment to read
 * (the central DB and session files resolve from the working directory).
 *
 * Flags: --group <folder|id>  --channel <type>  --session <id>  --since <t>
 *        --until <t>  --limit <n> (0 = all)  --tools  --full  --utc  --json
 *        --sessions  --help
 *
 * Exit codes: 0 = ok; 1 = bad usage / central DB unreadable.
 */
import path from 'path';

import Database from 'better-sqlite3';

import { DATA_DIR, TIMEZONE } from '../src/config.js';
import {
  buildTranscript,
  DEFAULT_TRANSCRIPT_GROUP,
  type Transcript,
  type TranscriptEntry,
  type TranscriptOptions,
} from '../src/modules/career-pilot/transcript.js';
import { resolveTimezone } from '../src/timezone.js';

/** Default tail length — enough for a day's conversation without flooding a terminal. */
const DEFAULT_LIMIT = 50;
/** Human-output truncation for tool/system rows (chat text is never truncated). */
const TOOL_ROW_MAX_CHARS = 300;

const VALUE_FLAGS = new Set(['group', 'channel', 'session', 'since', 'until', 'limit']);
const BOOL_FLAGS = new Set(['tools', 'full', 'utc', 'json', 'sessions', 'help']);

const USAGE = `Usage: pnpm transcript [flags]

  --group <folder|id>   agent group (default: ${DEFAULT_TRANSCRIPT_GROUP})
  --channel <type>      only this channel (telegram, portal, cli, ...)
  --session <id>        only this session
  --since <t>           ISO timestamp, or relative: 30m / 24h / 7d
  --until <t>           same forms as --since
  --limit <n>           keep the last n entries (default ${DEFAULT_LIMIT}; 0 = all)
  --tools               include tool calls/results, telemetry, tasks, ops mirrors
  --full                don't truncate tool rows in human output
  --utc                 print UTC instead of the configured timezone
  --json                machine-readable output (untruncated)
  --sessions            list the group's sessions instead of messages
`;

interface Parsed {
  values: Record<string, string>;
  flags: Set<string>;
}

function parseArgs(argv: string[]): Parsed {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}"`);
    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    if (BOOL_FLAGS.has(name)) {
      flags.add(name);
    } else if (VALUE_FLAGS.has(name)) {
      const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
      if (value === undefined) throw new Error(`--${name} needs a value`);
      values[name] = value;
    } else {
      throw new Error(`unknown flag "--${name}"`);
    }
  }
  return { values, flags };
}

function clock(ts: string, utc: boolean): string {
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) return ts;
  // sv-SE renders as `YYYY-MM-DD HH:mm:ss`.
  return new Date(ms).toLocaleString('sv-SE', { timeZone: utc ? 'UTC' : resolveTimezone(TIMEZONE) });
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function printEntry(e: TranscriptEntry, utc: boolean, full: boolean): void {
  const head = `${clock(e.ts, utc)}  ${e.session_label.padEnd(4)}`;
  if (e.role === 'user' || e.role === 'agent') {
    const who = e.role === 'user' ? (e.sender ?? 'user') : 'AGENT';
    const tags = [e.channel, e.role === 'agent' && e.status !== 'delivered' ? e.status?.toUpperCase() : null]
      .filter(Boolean)
      .join(' · ');
    console.log(`${head}  ${who}${tags ? `  (${tags})` : ''}`);
    console.log(indent(e.text));
    return;
  }
  const arrow = e.role === 'tool_call' ? '→' : e.role === 'tool_result' ? '←' : '·';
  const body =
    full || e.text.length <= TOOL_ROW_MAX_CHARS
      ? e.text
      : `${e.text.slice(0, TOOL_ROW_MAX_CHARS)}… (+${e.text.length - TOOL_ROW_MAX_CHARS} chars)`;
  // Calls and results are identified by their arrow; other rows name their role.
  const label = e.role === 'tool_call' || e.role === 'tool_result' ? '' : `${e.role}: `;
  const due = e.due ? `(${e.status ?? 'queued'}, due ${clock(e.due, utc)}) ` : '';
  const ref = e.request_id ? `  [${e.request_id}]` : '';
  console.log(`${head}    ${arrow} ${label}${due}${body.replace(/\n/g, '\\n')}${ref}`);
}

function printSessions(t: Transcript, utc: boolean): void {
  for (const s of t.sessions) {
    const range = s.first_ts && s.last_ts ? `${clock(s.first_ts, utc)} → ${clock(s.last_ts, utc)}` : 'no rows';
    console.log(
      `${s.id}  ${s.label.padEnd(6)} ${String(s.channel ?? '-').padEnd(9)} ${String(s.status ?? '-').padEnd(7)} in=${s.in_count} out=${s.out_count}  ${range}`,
    );
  }
}

function main(): void {
  // A reader that closes early (`| head`, `| grep -m1`) is a normal way to use
  // this — stop quietly instead of surfacing EPIPE as an uncaught exception.
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });

  let parsed: Parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
    process.exit(1);
  }
  const { values, flags } = parsed;
  if (flags.has('help')) {
    console.log(USAGE);
    return;
  }

  const limit = values.limit === undefined ? DEFAULT_LIMIT : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 0) {
    console.error(`--limit must be a non-negative integer\n\n${USAGE}`);
    process.exit(1);
  }

  const opts: TranscriptOptions = {
    group: values.group,
    channel: values.channel,
    session: values.session,
    since: values.since,
    until: values.until,
    limit,
    includeTools: flags.has('tools'),
  };

  let central: Database.Database;
  try {
    central = new Database(path.join(DATA_DIR, 'v2.db'), { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(`cannot open central DB read-only: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  let transcript: Transcript;
  try {
    transcript = buildTranscript(central, opts);
  } finally {
    central.close();
  }

  if (flags.has('json')) {
    console.log(JSON.stringify(transcript, null, 2));
    return;
  }

  const utc = flags.has('utc');
  const listing = flags.has('sessions');
  const g = transcript.group;
  const count = listing
    ? `${transcript.sessions.length} session(s)`
    : `${transcript.entries.length} entr${transcript.entries.length === 1 ? 'y' : 'ies'}`;
  console.log(
    `transcript — ${g ? `${g.name} (${g.folder})` : 'no group'} · ${count} · times in ${utc ? 'UTC' : resolveTimezone(TIMEZONE)}`,
  );
  for (const w of transcript.warnings) console.log(`⚠ ${w}`);
  console.log('');

  if (listing) {
    printSessions(transcript, utc);
    return;
  }

  if (transcript.omitted > 0) {
    console.log(
      `… ${transcript.omitted} earlier entr${transcript.omitted === 1 ? 'y' : 'ies'} omitted (--limit 0 for all)\n`,
    );
  }
  for (const entry of transcript.entries) printEntry(entry, utc, flags.has('full'));
}

main();
