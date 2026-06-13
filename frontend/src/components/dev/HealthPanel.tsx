import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { HealthFinding, HealthReport, HealthSeverity } from '~/lib/use-dev-inspector'

/**
 * Dev-only health panel (§24.69 D8) — the §24.68 `runHealthChecks()` report in
 * the browser. Every non-ok finding carries its `next_step` runbook command
 * verbatim (the report IS the runbook), rendered as a copy-pasteable mono block.
 * Owner-only, dev-gated by the `/api/dev/*` prefix; the polled endpoint runs
 * `skipLiveProbes`, so the Gmail/gateway live probe stays CLI-only (`pnpm health`).
 *
 * Severity reads from a colored dot (non-text → no contrast trap) + accessible
 * foreground/muted text — never small light-on-saturated text, which fails WCAG
 * AA at badge sizes (the reason this isn't a filled `destructive` Badge).
 */
const SEVERITY_RANK: Record<HealthSeverity, number> = { critical: 0, warn: 1, ok: 2 }

/** Tailwind bg utility for the severity dot (aria-hidden — non-text, no contrast req). */
const SEVERITY_DOT: Record<HealthSeverity, string> = {
  critical: 'bg-destructive',
  warn: 'bg-warn',
  ok: 'bg-primary',
}

function Dot({ severity }: { severity: HealthSeverity }) {
  return <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${SEVERITY_DOT[severity]}`} />
}

export function HealthPanel({ report }: { report: HealthReport | null }) {
  if (!report) {
    return (
      <Card data-testid="health-panel">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Health</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 text-sm text-muted-foreground">Running checks…</CardContent>
      </Card>
    )
  }

  const findings = [...report.findings].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id),
  )
  const nonOk = findings.filter((f) => f.severity !== 'ok')
  const criticals = findings.filter((f) => f.severity === 'critical').length
  const warns = findings.filter((f) => f.severity === 'warn').length

  return (
    <Card data-testid="health-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Health</CardTitle>
        <span
          data-testid="health-summary-badge"
          className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 font-mono text-[11px] uppercase tracking-wider text-foreground"
        >
          <Dot severity={criticals > 0 ? 'critical' : warns > 0 ? 'warn' : 'ok'} />
          {criticals > 0 ? `${criticals} critical` : warns > 0 ? `${warns} warn` : 'all clear'}
        </span>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">
        {nonOk.length === 0 ? (
          <p data-testid="health-all-clear" className="text-sm text-muted-foreground">
            All checks pass. Live Gmail/gateway probes run only via <span className="font-mono">pnpm health</span> (they
            exec/spend, so they&apos;re skipped on this polled view).
          </p>
        ) : (
          <ul data-testid="health-findings" className="flex flex-col gap-3">
            {nonOk.map((f) => (
              <Finding key={f.id} finding={f} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function Finding({ finding }: { finding: HealthFinding }) {
  return (
    <li
      data-testid={`health-finding-${finding.id}`}
      className="flex flex-col gap-1.5 border-t border-border pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex items-center gap-2">
        <Dot severity={finding.severity} />
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{finding.severity}</span>
        <span className="font-mono text-sm text-foreground">{finding.title}</span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">{finding.id}</span>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{finding.detail}</p>
      {finding.next_step ? (
        <pre
          data-testid={`health-next-step-${finding.id}`}
          className="overflow-auto rounded-md border border-border bg-muted/40 p-2 text-[11px] leading-relaxed whitespace-pre-wrap"
        >
          {finding.next_step}
        </pre>
      ) : null}
    </li>
  )
}
