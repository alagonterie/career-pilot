/**
 * Recruiter-sim Gmail/Calendar injector (Sub-milestone 9.3b, STRATEGY.md §24.40 D14).
 *
 * The I/O boundary: turns InjectEmailIntents into real mailbox messages via the
 * Gmail API `messages.insert` (no SMTP — IMAP-APPEND-like, verified in the 9.3b
 * build-prereq smoke), and onsite invites into Calendar events. Authenticated
 * through OneCLI's own host-side path: `onecli run -- curl …` injects
 * `HTTPS_PROXY` → the gateway + the CA trust, and the gateway MITM-injects the
 * dev account's OAuth bearer for googleapis.com. Shelling the supported
 * `onecli run` is deliberate — it reuses OneCLI's wiring rather than
 * reverse-engineering the gateway proxy URL + CA for an in-process client.
 *
 * The self-only allow-list (D14) is the load-bearing guard: the recipient is
 * NEVER intent-controlled — it is always the dev account, re-checked before the
 * call. Nothing in dev is ever external.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { log } from '../../../log.js';
import { recordRequestTelemetry } from '../../../request-telemetry.js';
import { assertSelfOnly } from './allow-list.js';
import type { InjectEmailIntent, SimCalendarInvite } from './types.js';

const execFileAsync = promisify(execFile);

const GMAIL_INSERT_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages?internalDateSource=dateHeader';
const GMAIL_PROFILE_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
const CALENDAR_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none';

export interface InjectResult {
  ok: boolean;
  /** The RFC822 Message-ID header we set (so the runner can chain replies). */
  messageId?: string;
  /** Gmail's returned message/thread ids. */
  gmailId?: string;
  threadId?: string | null;
  error?: string;
}

// ── pure builders (unit-tested; no I/O) ──────────────────────────────────────

/** Base64URL (no `+`/`/`), padding kept — Gmail's `raw` field accepts it. */
export function toBase64Url(input: Buffer | string): string {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

/** RFC 2047-encode a header value iff it contains non-ASCII (e.g. an em dash). */
export function encodeMimeHeader(value: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

export interface RawMessageParts {
  fromName: string;
  fromAddress: string;
  to: string;
  subject: string;
  dateMs: number;
  messageId: string;
  inReplyTo: string | null;
  body: string;
}

/** Build a base64url-encoded RFC822 message (the Gmail `raw` field). */
export function buildRawMessage(p: RawMessageParts): string {
  const headers = [
    `From: ${encodeMimeHeader(p.fromName)} <${p.fromAddress}>`,
    `To: ${p.to}`,
    `Subject: ${encodeMimeHeader(p.subject)}`,
    `Date: ${new Date(p.dateMs).toUTCString()}`,
    `Message-ID: ${p.messageId}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  if (p.inReplyTo) {
    headers.push(`In-Reply-To: ${p.inReplyTo}`);
    headers.push(`References: ${p.inReplyTo}`);
  }
  const mime = `${headers.join('\r\n')}\r\n\r\n${p.body}`;
  return toBase64Url(Buffer.from(mime, 'utf8'));
}

export function buildInsertBody(rawBase64Url: string, threadId: string | null): Record<string, unknown> {
  const body: Record<string, unknown> = { raw: rawBase64Url, labelIds: ['INBOX', 'UNREAD'] };
  if (threadId) body.threadId = threadId;
  return body;
}

export function buildCalendarBody(invite: SimCalendarInvite, devAccount: string): Record<string, unknown> {
  const startIso = new Date(invite.startMs).toISOString();
  const endIso = new Date(invite.startMs + invite.durationMin * 60_000).toISOString();
  return {
    summary: invite.summary,
    start: { dateTime: startIso, timeZone: 'UTC' },
    end: { dateTime: endIso, timeZone: 'UTC' },
    attendees: [{ email: devAccount }],
  };
}

function newMessageId(): string {
  return `<sim-${crypto.randomBytes(8).toString('hex')}@recruiter-sim.invalid>`;
}

// ── the gateway-proxied HTTP boundary ────────────────────────────────────────

/** Resolve the `onecli` binary (the dev VM keeps it in ~/.local/bin, off the systemd PATH). */
function onecliBin(): string {
  if (process.env.ONECLI_BIN) return process.env.ONECLI_BIN;
  const local = path.join(os.homedir(), '.local', 'bin', 'onecli');
  return fs.existsSync(local) ? local : 'onecli';
}

interface CurlResult {
  status: number;
  json: Record<string, unknown> | null;
  raw: string;
}

/** Telemetry identity for one gateway request (provider + call-site slug). */
interface GatewayTel {
  provider: string;
  surface: string;
}

/**
 * Run one `onecli run -- curl …` request through the gateway, which MITM-injects
 * the matching OneCLI credential for the target host (the Gmail OAuth bearer for
 * googleapis.com). LLM prose goes direct to Portkey (see prose.ts), not here.
 *
 * Every request records a request_telemetry row (§24.68): the HTTP status from
 * curl's `%{http_code}` on a completed exchange (non-2xx ⇒ ok=0 — the Gmail-401
 * detector), or a NULL status when the exec itself fails (gateway down / binary
 * missing). Exec failures rethrow after recording, preserving caller behavior.
 */
async function gatewayCurl(method: string, url: string, tel: GatewayTel, jsonBody?: unknown): Promise<CurlResult> {
  const args = ['run', '--', 'curl', '-s', '-S', '-w', '\n%{http_code}', '-X', method, url];
  if (jsonBody !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(jsonBody));
  }
  const t0 = Date.now();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(onecliBin(), args, { maxBuffer: 16 * 1024 * 1024, timeout: 30_000 }));
  } catch (err) {
    recordRequestTelemetry({
      provider: tel.provider,
      surface: tel.surface,
      trafficClass: 'host',
      ok: false,
      latencyMs: Date.now() - t0,
      statusCode: null,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
  const lines = stdout.trimEnd().split('\n');
  const status = Number.parseInt(lines[lines.length - 1] ?? '', 10) || 0;
  let bodyText = lines.slice(0, -1).join('\n');
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    // `onecli run` may prepend a "gateway connected" status line — parse from the first brace.
    const brace = bodyText.indexOf('{');
    if (brace >= 0) {
      bodyText = bodyText.slice(brace);
      try {
        json = JSON.parse(bodyText) as Record<string, unknown>;
      } catch {
        json = null;
      }
    }
  }
  const ok = status >= 200 && status < 300;
  recordRequestTelemetry({
    provider: tel.provider,
    surface: tel.surface,
    trafficClass: 'host',
    ok,
    latencyMs: Date.now() - t0,
    statusCode: status || null,
    error: ok ? null : `HTTP ${status}: ${bodyText.slice(0, 200)}`,
  });
  return { status, json, raw: bodyText };
}

/** The connected dev account address (the self-only allow-list target). null on failure. */
export async function fetchDevAccount(): Promise<string | null> {
  try {
    const res = await gatewayCurl('GET', GMAIL_PROFILE_URL, { provider: 'gmail', surface: 'sim-profile-probe' });
    const addr = res.json?.emailAddress;
    return typeof addr === 'string' ? addr : null;
  } catch (err) {
    log.warn('recruiter-sim: fetchDevAccount failed', { err });
    return null;
  }
}

export interface GmailProbeResult {
  ok: boolean;
  /** HTTP status from the gateway exchange; null when the exec itself failed. */
  status: number | null;
  /** False iff `onecli run` could not execute at all (gateway down / binary missing). */
  gatewayReachable: boolean;
  error?: string;
}

/**
 * LIVE Gmail token probe for the health check (§24.68): exercises
 * `users/me/profile` through the gateway, distinguishing "gateway unreachable"
 * (exec failure) from "token dead" (401/403 while OneCLI may still report
 * `connected` — the §24.66 lesson). Never throws.
 */
export async function probeGmailProfile(): Promise<GmailProbeResult> {
  try {
    const res = await gatewayCurl('GET', GMAIL_PROFILE_URL, { provider: 'gmail', surface: 'gmail-health-probe' });
    const ok = res.status >= 200 && res.status < 300 && typeof res.json?.emailAddress === 'string';
    return ok
      ? { ok: true, status: res.status, gatewayReachable: true }
      : {
          ok: false,
          status: res.status,
          gatewayReachable: true,
          error: `HTTP ${res.status}: ${res.raw.slice(0, 200)}`,
        };
  } catch (err) {
    return {
      ok: false,
      status: null,
      gatewayReachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Insert one email into the dev mailbox. The recipient is ALWAYS `devAccount`
 * (never the intent) and is re-asserted self-only before the call. `body` is the
 * resolved (Haiku-enriched or deterministic) message body; `parentMessageId` is
 * the prior email's Message-ID for in-thread replies.
 */
export async function insertEmail(
  intent: InjectEmailIntent,
  body: string,
  devAccount: string,
  parentMessageId: string | null = null,
): Promise<InjectResult> {
  try {
    assertSelfOnly(devAccount, devAccount); // structural: recipient is the dev account, never intent-derived
    const messageId = newMessageId();
    const raw = buildRawMessage({
      fromName: intent.fromName,
      fromAddress: intent.fromAddress,
      to: devAccount,
      subject: intent.subject,
      dateMs: intent.internalDateMs,
      messageId,
      inReplyTo: intent.newThread ? null : parentMessageId,
      body,
    });
    const reqBody = buildInsertBody(raw, intent.newThread ? null : intent.threadId);
    const res = await gatewayCurl('POST', GMAIL_INSERT_URL, { provider: 'gmail', surface: 'sim-inject' }, reqBody);
    if (res.status >= 200 && res.status < 300 && typeof res.json?.id === 'string') {
      return {
        ok: true,
        messageId,
        gmailId: res.json.id as string,
        threadId: (res.json.threadId as string | undefined) ?? null,
      };
    }
    return { ok: false, error: `gmail insert HTTP ${res.status}: ${res.raw.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Create a Calendar event (the onsite invite) with the dev account as attendee. */
export async function insertCalendarEvent(invite: SimCalendarInvite, devAccount: string): Promise<InjectResult> {
  try {
    assertSelfOnly(devAccount, devAccount);
    const res = await gatewayCurl(
      'POST',
      CALENDAR_EVENTS_URL,
      { provider: 'calendar', surface: 'sim-inject' },
      buildCalendarBody(invite, devAccount),
    );
    if (res.status >= 200 && res.status < 300 && typeof res.json?.id === 'string') {
      return { ok: true, gmailId: res.json.id as string };
    }
    return { ok: false, error: `calendar insert HTTP ${res.status}: ${res.raw.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
