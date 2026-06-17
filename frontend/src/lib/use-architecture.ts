import { useSurfaceState, withState } from './dev-state'
import { usePolledJson, type PollStatus } from './use-polled-json'

/**
 * The live system state delivered by `GET /api/architecture`
 * (src/modules/portal/api.ts → handleArchitecture). Counts are cheap DB reads;
 * `containers.running` is null when the `docker ps` probe is unavailable.
 */
export interface ArchitectureData {
  sessions: { active: number; running: number }
  containers: {
    running: number | null
    capacity_max: number
    memory_mb_each: number
    runtime: 'up' | 'down'
  }
  /** §24.80 Web-sandbox probe inputs: the kill switch + 24h sandbox spend vs the
   * daily cap. Absent on an older backend → the node falls back to idle (cold). */
  sandbox?: {
    enabled: boolean
    spend_24h_usd: number
    daily_budget_usd: number
  }
  /** §24.80 Cron-sweep freshness: age of the last completed host-sweep tick
   * (`null` before the first), and `fresh` = within the host-tier staleness
   * threshold (kept backend-side). Absent on an older backend → idle (cold). */
  sweep?: {
    last_run_age_sec: number | null
    fresh: boolean
  }
  backend: string
}

/**
 * The operating mode delivered by `GET /api/system-status`
 * (src/modules/portal/system-modes.ts → getSystemStatus). `live_mode` is the
 * shadow/live switch; `pause_state` is the kill-switch ladder.
 */
export interface SystemMode {
  live_mode: boolean
  pause_state: 'active' | 'paused' | 'halted' | 'killswitch'
  pause_reason: string | null
  backend: string
}

export interface ArchitectureState {
  arch: ArchitectureData | null
  mode: SystemMode | null
  status: PollStatus
}

/**
 * Poll both system endpoints and merge. Two independent polls (the endpoints
 * are separate) reusing `usePolledJson`. The diagram renders as soon as `arch`
 * is present; the mode banner degrades gracefully if `mode` is still null.
 * Combined status: `ok` once both feeds are ok, `error` if either cold-failed,
 * else `loading`.
 */
export function useArchitecture(baseUrl: string, pollMs?: number): ArchitectureState {
  const forced = useSurfaceState('architecture')
  const arch = usePolledJson<ArchitectureData>(withState(`${baseUrl}/api/architecture`, forced), pollMs)
  const mode = usePolledJson<SystemMode>(withState(`${baseUrl}/api/system-status`, forced), pollMs)

  const status: PollStatus =
    arch.status === 'ok' && mode.status === 'ok'
      ? 'ok'
      : arch.status === 'error' || mode.status === 'error'
        ? 'error'
        : 'loading'

  return { arch: arch.data, mode: mode.data, status }
}
