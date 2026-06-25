/** Shared `/admin` formatters (§24.174) — used by the Overview rollup and every
 * extracted panel, so the timestamp/cost rendering stays identical across tabs. */

/** A compact local timestamp ("Jun 24, 10:30 AM"); '—' for null/unparseable. */
export function fmtTs(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Micro-USD → "$X.XX". */
export const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`
