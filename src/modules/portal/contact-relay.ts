/**
 * src/modules/portal/contact-relay.ts — POST /api/contact handler.
 *
 * Relays a recruiter's contact-form submission (PORTAL §5.7) to the owner's
 * channel. One-way — "no conversation" (PORTAL §8). In prod the Cloudflare
 * Worker Turnstile-verifies + rate-limits (5/IP/hr) and forwards the verified
 * body here over the Tunnel; in dev it's posted directly.
 *
 * Delivery is channel-agnostic: resolve the channel(s) wired to the
 * `career-pilot` agent group and push through the host delivery adapter (the
 * same host-initiated path the §24.18 killswitch uses) — Telegram in prod, the
 * CLI in dev, no container spawn.
 *
 * NO public sanitizer (corrects the Phase-0 placeholder): the submission goes
 * to the owner's PRIVATE channel and its whole value is the recruiter's name +
 * email + message; redacting would defeat it. Delivered verbatim (length-capped),
 * not persisted to the DB — it lives in the owner's channel history.
 *
 * See STRATEGY.md §24.22 + PORTAL.md §5.7.
 */
import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';

const OWNER_FOLDER = 'career-pilot';
const MAX_NAME = 200;
const MAX_EMAIL = 320;
const MAX_COMPANY = 200;
const MAX_ROLE = 200;
const DEFAULT_MESSAGE_MAX = 4000;

export interface ContactInput {
  name?: unknown;
  email?: unknown;
  company?: unknown;
  role?: unknown;
  message?: unknown;
}

export interface ContactResult {
  ok: boolean;
  delivered?: number;
  error?: { code: 'BAD_ARGS' | 'UNAVAILABLE'; message: string };
}

function field(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length > 0 ? t.slice(0, max) : null;
}

/** Pure: format the owner-facing notification from a validated submission. */
export function buildContactNotification(c: {
  name: string;
  email: string;
  company: string | null;
  role: string | null;
  message: string;
}): string {
  const lines = ['📬 New contact via the portal', '', `From: ${c.name} <${c.email}>`];
  if (c.company) lines.push(`Company: ${c.company}`);
  if (c.role) lines.push(`Role: ${c.role}`);
  lines.push('', c.message);
  return lines.join('\n');
}

/**
 * Relay a contact submission to the owner's wired channel(s). Validates,
 * formats, and delivers verbatim. Returns ok iff ≥1 delivery succeeded so the
 * visitor is only told "Sent" when it actually was. Never throws.
 */
export async function relayContactSubmission(input: ContactInput): Promise<ContactResult> {
  const name = field(input.name, MAX_NAME);
  const email = field(input.email, MAX_EMAIL);

  let messageMax = DEFAULT_MESSAGE_MAX;
  try {
    messageMax = getConfig<number>(getDb(), 'contact_message_max_chars', DEFAULT_MESSAGE_MAX);
  } catch {
    messageMax = DEFAULT_MESSAGE_MAX;
  }
  const message = field(input.message, messageMax);

  if (!name || !email || !message) {
    return { ok: false, error: { code: 'BAD_ARGS', message: 'name, email, and message are required.' } };
  }
  const company = field(input.company, MAX_COMPANY);
  const role = field(input.role, MAX_ROLE);
  const text = buildContactNotification({ name, email, company, role, message });

  const ag = getAgentGroupByFolder(OWNER_FOLDER);
  if (!ag) {
    log.error('contact relay: owner agent group not found', { folder: OWNER_FOLDER });
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'Contact relay is not available right now.' } };
  }
  const channels = getMessagingGroupsByAgentGroup(ag.id);
  const adapter = getDeliveryAdapter();
  if (!adapter || channels.length === 0) {
    log.error('contact relay: no channel/adapter to relay to', { channels: channels.length, hasAdapter: !!adapter });
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'Contact relay is not available right now.' } };
  }

  let delivered = 0;
  for (const mg of channels) {
    try {
      await adapter.deliver(mg.channel_type, mg.platform_id, null, 'chat', JSON.stringify({ text }));
      delivered++;
    } catch (err) {
      log.warn('contact relay: delivery to a channel failed', { channelType: mg.channel_type, err });
    }
  }
  if (delivered === 0) {
    return { ok: false, error: { code: 'UNAVAILABLE', message: 'Contact relay could not reach a channel.' } };
  }
  log.info('Contact relayed to owner', { delivered, company });
  return { ok: true, delivered };
}
