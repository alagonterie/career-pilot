import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ClaudeProvider, transcriptStartMs } from './claude.js';

// maybeRotateContinuation guards the cold-resume failure mode: a long-lived
// session whose on-disk transcript has grown so large (or old) that the SDK
// can't reload it before the host's idle ceiling kills the container.

let tmp: string;
let prevHome: string | undefined;
let prevConv: string | undefined;
let prevBytes: string | undefined;
let prevDays: string | undefined;

const PROJECT_DIR = '-workspace-agent';
const CWD = '/workspace/agent';

function writeTranscript(sessionId: string, bytes: number, firstTs?: string): string {
  const dir = path.join(tmp, '.claude', 'projects', PROJECT_DIR);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, `${sessionId}.jsonl`);
  const first =
    JSON.stringify({
      type: 'user',
      timestamp: firstTs ?? new Date().toISOString(),
      message: { role: 'user', content: 'hello' },
    }) + '\n';
  const filler = 'x'.repeat(Math.max(0, bytes - first.length));
  fs.writeFileSync(p, first + filler);
  return p;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-rotate-'));
  prevHome = process.env.HOME;
  prevConv = process.env.NANOCLAW_CONVERSATIONS_DIR;
  prevBytes = process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES;
  prevDays = process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS;
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore('HOME', prevHome);
  restore('NANOCLAW_CONVERSATIONS_DIR', prevConv);
  restore('CLAUDE_TRANSCRIPT_ROTATE_BYTES', prevBytes);
  restore('CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS', prevDays);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('ClaudeProvider.maybeRotateContinuation', () => {
  it('keeps a small, recent transcript (returns null, leaves file in place)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    const p = writeTranscript('sess-small', 4096);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-small', CWD)).toBeNull();
    expect(fs.existsSync(p)).toBe(true);
  });

  it('rotates an oversized transcript (returns reason, moves the .jsonl aside)', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(64 * 1024);
    const p = writeTranscript('sess-big', 200 * 1024);
    const provider = new ClaudeProvider();
    const reason = provider.maybeRotateContinuation('sess-big', CWD);
    expect(reason).toContain('MB');
    expect(fs.existsSync(p)).toBe(false); // original moved out of the resume path
    const dir = path.dirname(p);
    expect(fs.readdirSync(dir).some((f) => f.startsWith('sess-big.jsonl.rotated-'))).toBe(true);
  });

  it('rotates an aged transcript even when small', () => {
    process.env.CLAUDE_TRANSCRIPT_ROTATE_BYTES = String(1024 * 1024);
    process.env.CLAUDE_TRANSCRIPT_ROTATE_AGE_DAYS = '7';
    const old = new Date(Date.now() - 10 * 86400_000).toISOString();
    writeTranscript('sess-old', 2048, old);
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('sess-old', CWD)).toContain('d');
  });

  it('returns null for an unknown session id', () => {
    const provider = new ClaudeProvider();
    expect(provider.maybeRotateContinuation('does-not-exist', CWD)).toBeNull();
  });
});

// §24.197: Claude Code 2.1.321 opens a transcript with a session-owner record
// that has NO timestamp. Dating a transcript by its first line then yields
// nothing, and age-based rotation silently stops for every new session.
describe('transcriptStartMs', () => {
  function write(lines: unknown[]): string {
    const p = path.join(tmp, 'dated.jsonl');
    fs.writeFileSync(
      p,
      lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join(String.fromCharCode(10)) +
        String.fromCharCode(10),
    );
    return p;
  }

  it('dates a transcript by its first entry that carries a timestamp, not its first line', () => {
    const p = write([
      { type: 'session-owner', sessionId: 'abc' },
      { type: 'user', timestamp: '2026-01-02T03:04:05.000Z', message: { role: 'user', content: 'hi' } },
      { type: 'assistant', timestamp: '2026-06-01T00:00:00.000Z' },
    ]);
    expect(transcriptStartMs(p)).toBe(Date.parse('2026-01-02T03:04:05.000Z'));
  });

  it('skips a non-JSON line and returns null when nothing is dated', () => {
    expect(transcriptStartMs(write(['not json', { type: 'user', timestamp: '2026-03-03T00:00:00.000Z' }]))).toBe(
      Date.parse('2026-03-03T00:00:00.000Z'),
    );
    expect(transcriptStartMs(write([{ type: 'session-owner' }, { type: 'summary' }]))).toBeNull();
    expect(transcriptStartMs(path.join(tmp, 'missing.jsonl'))).toBeNull();
  });
});
