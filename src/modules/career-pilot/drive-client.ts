/**
 * Google Drive REST client for interview-kit Docs (STRATEGY.md §24.53).
 *
 * Host-side, authenticated through OneCLI's gateway exactly like the
 * recruiter-sim injector (`recruiter-sim/inject.ts`): `onecli run -- curl …`
 * injects HTTPS_PROXY + the CA trust, and the gateway MITM-injects the career
 * account's `drive.file` OAuth bearer for googleapis.com. The container never
 * sees the token; shelling the supported `onecli run` reuses OneCLI's wiring
 * rather than reverse-engineering the gateway proxy URL + CA for an in-process
 * client.
 *
 * Pure builders (`buildMultipartRelated`, `kitMarkdownToHtml`, `docUrl`) are
 * exported for unit tests; the I/O functions are validated on the box (no
 * googleapis creds locally), like the injector.
 */
import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import { log } from '../../log.js';
import { recordRequestTelemetry } from '../../request-telemetry.js';

const execFileAsync = promisify(execFile);

const DRIVE_TELEMETRY_SURFACE = 'interview-kit-drive';

/** One request_telemetry row per gateway exchange (§24.68). */
function recordDriveTelemetry(t0: number, status: number | null, error?: string): void {
  const ok = status !== null && status >= 200 && status < 300;
  recordRequestTelemetry({
    provider: 'drive',
    surface: DRIVE_TELEMETRY_SURFACE,
    trafficClass: 'host',
    ok,
    latencyMs: Date.now() - t0,
    statusCode: status,
    error: ok ? null : (error ?? `HTTP ${status}`),
  });
}

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3/files';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DOC_MIME = 'application/vnd.google-apps.document';

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

function parseCurlStdout(stdout: string): CurlResult {
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
  return { status, json, raw: bodyText };
}

/** One JSON request (folder create, move) through the gateway. */
async function gatewayJson(method: string, url: string, jsonBody?: unknown): Promise<CurlResult> {
  const args = ['run', '--', 'curl', '-s', '-S', '-w', '\n%{http_code}', '-X', method, url];
  if (jsonBody !== undefined) {
    args.push('-H', 'Content-Type: application/json', '--data-binary', JSON.stringify(jsonBody));
  }
  const t0 = Date.now();
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(onecliBin(), args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }));
  } catch (err) {
    recordDriveTelemetry(t0, null, err instanceof Error ? err.message : String(err));
    throw err;
  }
  const result = parseCurlStdout(stdout);
  recordDriveTelemetry(t0, result.status || null, result.raw.slice(0, 200));
  return result;
}

/**
 * One multipart/related upload (Doc create/update) through the gateway. The body
 * is written to a temp file and sent via `curl --data-binary @file` so the exact
 * CRLF-delimited multipart bytes survive (`--data-binary` does not strip them).
 */
async function gatewayMultipart(method: string, url: string, body: string, boundary: string): Promise<CurlResult> {
  const tmp = path.join(os.tmpdir(), `cp-kit-${crypto.randomBytes(8).toString('hex')}.part`);
  fs.writeFileSync(tmp, body, 'utf8');
  try {
    const args = [
      'run',
      '--',
      'curl',
      '-s',
      '-S',
      '-w',
      '\n%{http_code}',
      '-X',
      method,
      '-H',
      `Content-Type: multipart/related; boundary=${boundary}`,
      '--data-binary',
      `@${tmp}`,
      url,
    ];
    const t0 = Date.now();
    let stdout: string;
    try {
      ({ stdout } = await execFileAsync(onecliBin(), args, { maxBuffer: 16 * 1024 * 1024, timeout: 60_000 }));
    } catch (err) {
      recordDriveTelemetry(t0, null, err instanceof Error ? err.message : String(err));
      throw err;
    }
    const result = parseCurlStdout(stdout);
    recordDriveTelemetry(t0, result.status || null, result.raw.slice(0, 200));
    return result;
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* best-effort temp cleanup */
    }
  }
}

// ── pure builders (unit-tested; no I/O) ──────────────────────────────────────

/** Build a `multipart/related` body: a JSON metadata part + a media part. */
export function buildMultipartRelated(
  boundary: string,
  metadata: Record<string, unknown>,
  mediaContentType: string,
  mediaBody: string,
): string {
  return [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    `Content-Type: ${mediaContentType}`,
    '',
    mediaBody,
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** The canonical URL to open a Google Doc by id. */
export function docUrl(fileId: string): string {
  return `https://docs.google.com/document/d/${fileId}/edit`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape, then apply a small set of inline markdown → HTML transforms. */
function inlineMd(s: string): string {
  let t = escapeHtml(s);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return t;
}

/**
 * Minimal markdown → HTML for kit Docs (Drive converts the HTML to a native
 * Doc). We author the kit markdown, so this only needs to cover its shapes:
 * ATX headings, `---` rules, unordered (`-`/`*`/`+`) and ordered (`1.`) lists,
 * **bold**, `code`, [links](), and blank-line-separated paragraphs. Anything
 * else falls through as a paragraph — never throws, never drops content.
 */
export function kitMarkdownToHtml(md: string): string {
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const openList = (type: 'ul' | 'ol'): void => {
    if (listType !== type) {
      closeList();
      out.push(`<${type}>`);
      listType = type;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim() === '') {
      closeList();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = heading[1].length;
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      closeList();
      out.push('<hr />');
      continue;
    }
    const unordered = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (unordered) {
      openList('ul');
      out.push(`<li>${inlineMd(unordered[1])}</li>`);
      continue;
    }
    const ordered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (ordered) {
      openList('ol');
      out.push(`<li>${inlineMd(ordered[1])}</li>`);
      continue;
    }
    closeList();
    out.push(`<p>${inlineMd(line.trim())}</p>`);
  }
  closeList();
  return `<html><body>\n${out.join('\n')}\n</body></html>`;
}

function newBoundary(): string {
  return `cp_${crypto.randomBytes(12).toString('hex')}`;
}

// ── I/O ops (gateway-proxied; box-validated) ─────────────────────────────────

/** Create a Drive folder (optionally inside `parentId`). Returns the new folder id, or null on failure. */
export async function createFolder(name: string, parentId?: string): Promise<string | null> {
  const meta: Record<string, unknown> = { name, mimeType: FOLDER_MIME };
  if (parentId) meta.parents = [parentId];
  try {
    const res = await gatewayJson('POST', `${DRIVE_FILES_URL}?fields=id`, meta);
    if (res.status >= 200 && res.status < 300 && typeof res.json?.id === 'string') return res.json.id;
    log.error('drive createFolder failed', { name, status: res.status, raw: res.raw.slice(0, 200) });
    return null;
  } catch (err) {
    log.error('drive createFolder threw', { name, err });
    return null;
  }
}

export interface CreatedDoc {
  id: string;
  url: string;
}

/** Create a native Google Doc from HTML inside `parentId`. Returns its id + URL, or null. */
export async function createDoc(name: string, html: string, parentId: string): Promise<CreatedDoc | null> {
  const boundary = newBoundary();
  const body = buildMultipartRelated(boundary, { name, mimeType: DOC_MIME, parents: [parentId] }, 'text/html', html);
  try {
    const res = await gatewayMultipart('POST', `${DRIVE_UPLOAD_BASE}?uploadType=multipart&fields=id`, body, boundary);
    if (res.status >= 200 && res.status < 300 && typeof res.json?.id === 'string') {
      const id = res.json.id;
      return { id, url: docUrl(id) };
    }
    log.error('drive createDoc failed', { name, status: res.status, raw: res.raw.slice(0, 200) });
    return null;
  } catch (err) {
    log.error('drive createDoc threw', { name, err });
    return null;
  }
}

/** Replace an existing Doc's content with `html` (full-content replace), optionally renaming it. */
export async function updateDocContent(fileId: string, html: string, name?: string): Promise<boolean> {
  const boundary = newBoundary();
  const meta: Record<string, unknown> = name ? { name } : {};
  const body = buildMultipartRelated(boundary, meta, 'text/html', html);
  try {
    const res = await gatewayMultipart('PATCH', `${DRIVE_UPLOAD_BASE}/${fileId}?uploadType=multipart`, body, boundary);
    if (res.status >= 200 && res.status < 300) return true;
    log.error('drive updateDocContent failed', { fileId, status: res.status, raw: res.raw.slice(0, 200) });
    return false;
  } catch (err) {
    log.error('drive updateDocContent threw', { fileId, err });
    return false;
  }
}

/** Move a file from `removeParent` to `addParent`. Returns true on success. */
export async function moveFile(fileId: string, addParent: string, removeParent: string): Promise<boolean> {
  const url =
    `${DRIVE_FILES_URL}/${fileId}` +
    `?addParents=${encodeURIComponent(addParent)}&removeParents=${encodeURIComponent(removeParent)}&fields=id`;
  try {
    const res = await gatewayJson('PATCH', url);
    if (res.status >= 200 && res.status < 300) return true;
    log.error('drive moveFile failed', { fileId, status: res.status, raw: res.raw.slice(0, 200) });
    return false;
  } catch (err) {
    log.error('drive moveFile threw', { fileId, err });
    return false;
  }
}
