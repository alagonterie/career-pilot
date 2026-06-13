import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { HealthFinding, HealthReport, HealthSeverity } from '~/lib/use-dev-inspector'

/**
 * Dev-only health panel (§24.69 D8) — the §24.68 `runHealthChecks()` report in
 * the browser. Every non-ok finding carries its `next_step` runbook command
 * verbatim (the report IS the runbook), rendered as a copy-pasteable mono block.
 * Owner-only, dev-gated by the `/api/dev/*` prefix; the polled endpoint runs
 * `skipLiveProbes`, so the Gmail/gateway live probe stays CLI-only (`pnpm health`).
 */
const SEVERITY_RANK: Record<HealthSeverity, number> = { critical: 0, warn: 1, ok: 2 }

const SEVERITY_BADGE: Record<HealthSeverity, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  critical: 'destructive',
  warn: 'secondary',
  ok: 'outline',
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
        <Badge
          variant={criticals > 0 ? 'destructive' : warns > 0 ? 'secondary' : 'default'}
          data-testid="health-summary-badge"
        >
          {criticals > 0 ? `${criticals} critical` : warns > 0 ? `${warns} warn` : 'all clear'}
        </Badge>
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
        <Badge variant={SEVERITY_BADGE[finding.severity]} className="uppercase">
          {finding.severity}
        </Badge>
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
