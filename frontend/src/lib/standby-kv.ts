import { env } from 'cloudflare:workers'

import {
  ACTIVE_STATE,
  STANDBY_PROFILE_KEY,
  STANDBY_STATE_KEY,
  parseStandbySnapshot,
  parseStandbyState,
  type StandbyMode,
  type StandbySnapshot,
  type StandbyState,
  type StandbyVmState,
} from './standby'

/**
 * The KV + workflow-dispatch layer for standby (§24.189). SERVER-ONLY.
 *
 * Three-way split, and the boundaries are load-bearing:
 *   `standby.ts`        — pure helpers, safe for components + tests
 *   `standby-kv.ts`     — THIS file; holds the `cloudflare:workers` binding, so it
 *                         must only ever be imported from server-only modules
 *                         (`routes/api/$.ts` and the server-fn wrappers)
 *   `standby-server.ts` — the `createServerFn` wrappers the route loaders import
 *
 * That last hop exists because a route layout is client-reachable: importing this
 * module from one would drag `cloudflare:workers` into the client bundle, which
 * fails the build outright.
 *
 * Everything here degrades to "the site is live" on any failure. A KV outage must
 * never black out a working public site, so the read fails OPEN — the standby page
 * appears only when KV affirmatively says so.
 */

export interface StandbyEnv {
  /** The KV namespace holding the standby record + the entry snapshot. */
  STANDBY_KV?: KVNamespace
  /** `owner/repo` for the workflow dispatch (the GH Environment supplies it). */
  GH_REPO?: string
  /** Repo-scoped PAT with `actions: write` — the ONLY credential the edge holds.
   *  Deliberately not a cloud credential: the workflow authenticates to GCP with
   *  the existing Workload Identity Federation (§24.189 D4). */
  GH_DISPATCH_TOKEN?: string
  /** Branch the workflow is dispatched on (defaults to `master`). */
  GH_DISPATCH_REF?: string
  BACKEND_API_BASE?: string
  CF_ACCESS_CLIENT_ID?: string
  CF_ACCESS_CLIENT_SECRET?: string
}

const WORKFLOW_FILE = 'standby.yml'

function kv(): KVNamespace | null {
  return (env as StandbyEnv).STANDBY_KV ?? null
}

/**
 * Read the current standby record. `cacheTtl` is the KV default (60 s) — standby
 * changes a few times a year, so paying for a fresh read on every public request
 * would be pure waste. The console renders the outcome of its own write rather
 * than re-reading (§24.189 D5).
 */
export async function readStandbyState(): Promise<StandbyState> {
  const ns = kv()
  if (!ns) return ACTIVE_STATE
  try {
    return parseStandbyState(await ns.get(STANDBY_STATE_KEY))
  } catch {
    return ACTIVE_STATE
  }
}

export async function readStandbySnapshot(): Promise<StandbySnapshot | null> {
  const ns = kv()
  if (!ns) return null
  try {
    return parseStandbySnapshot(await ns.get(STANDBY_PROFILE_KEY))
  } catch {
    return null
  }
}

/** Write the standby record. Returns false when KV isn't bound (an unconfigured
 *  stack), so the caller can report that instead of silently no-op'ing. */
export async function writeStandbyState(next: {
  mode: StandbyMode
  note?: string | null
  vm?: StandbyVmState
  since?: string | null
}): Promise<boolean> {
  const ns = kv()
  if (!ns) return false
  const now = new Date().toISOString()
  const record: StandbyState = {
    mode: next.mode,
    since: next.since ?? (next.mode === 'standby' ? now : null),
    note: next.note ?? null,
    vm: next.vm ?? (next.mode === 'standby' ? 'stopping' : 'running'),
    updatedAt: now,
  }
  await ns.put(STANDBY_STATE_KEY, JSON.stringify(record))
  return true
}

/**
 * Capture the identity the standby page needs, from the still-running backend.
 * Called at ENTRY, before anything is stopped — this is the only moment the data
 * is reachable, and without it the one page a visitor can still load would render
 * the committed `Jane Doe` placeholder (§24.189 D6).
 *
 * A failure here is reported to the console but does NOT block entry: a standby
 * page with fewer links is a far smaller problem than a stuck teardown.
 */
export async function captureStandbySnapshot(): Promise<boolean> {
  const ns = kv()
  if (!ns) return false
  const e = env as StandbyEnv
  const base = (e.BACKEND_API_BASE ?? 'http://localhost:3001').replace(/\/$/, '')
  const headers: Record<string, string> = {}
  if (e.CF_ACCESS_CLIENT_ID) headers['CF-Access-Client-Id'] = e.CF_ACCESS_CLIENT_ID
  if (e.CF_ACCESS_CLIENT_SECRET) headers['CF-Access-Client-Secret'] = e.CF_ACCESS_CLIENT_SECRET

  try {
    const res = await fetch(`${base}/api/profile`, { headers, redirect: 'manual' })
    if (!res.ok) return false
    const data = (await res.json()) as {
      profile?: { name?: string } | null
      identity?: Record<string, string | null> | null
    }
    const id = data.identity ?? {}
    const snapshot: StandbySnapshot = {
      name: data.profile?.name ?? null,
      email: id.email ?? null,
      github: id.github ?? null,
      linkedin: id.linkedin ?? null,
      x: id.x ?? null,
      website: id.website ?? null,
      capturedAt: new Date().toISOString(),
    }
    await ns.put(STANDBY_PROFILE_KEY, JSON.stringify(snapshot))
    return true
  } catch {
    return false
  }
}

/**
 * Fire `standby.yml` via `workflow_dispatch`. The Worker holds only a repo-scoped
 * PAT; the workflow itself reaches GCP through the existing WIF, so no cloud
 * credential ever sits at the edge (§24.189 D4).
 */
export async function dispatchStandbyWorkflow(op: 'stop' | 'start'): Promise<{ ok: boolean; error?: string }> {
  const e = env as StandbyEnv
  if (!e.GH_DISPATCH_TOKEN || !e.GH_REPO) {
    return { ok: false, error: 'workflow dispatch is not configured (GH_REPO / GH_DISPATCH_TOKEN unset)' }
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${e.GH_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${e.GH_DISPATCH_TOKEN}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        // GitHub rejects API requests without a User-Agent.
        'user-agent': 'career-pilot-standby',
      },
      body: JSON.stringify({ ref: e.GH_DISPATCH_REF ?? 'master', inputs: { op } }),
    })
    // A successful dispatch is 204 No Content.
    if (res.status === 204) return { ok: true }
    const body = await res.text()
    return { ok: false, error: `github dispatch failed (${res.status}): ${body.slice(0, 200)}` }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'dispatch failed' }
  }
}

export interface StandbyView {
  state: StandbyState
  snapshot: StandbySnapshot | null
}

/** The state + the entry snapshot together — what the gate and the console both
 *  need, in one KV round-trip pair. */
export async function readStandbyView(): Promise<StandbyView> {
  const [state, snapshot] = await Promise.all([readStandbyState(), readStandbySnapshot()])
  return { state, snapshot }
}
