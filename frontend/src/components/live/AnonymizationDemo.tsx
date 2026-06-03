import { Panel } from '~/components/live/panels'
import type { SanitizeDemoState } from '~/lib/use-sanitize-demo'

/**
 * The `/live` ANONYMIZATION DEMO panel (PORTAL §5.2, the "wow-finish"). A
 * two-pane raw↔sanitized display proving the public side is privacy-aware. The
 * transformation is the REAL sanitizer run server-side (§24.33) over a
 * server-authored **synthetic** sample — labeled as such, never real data.
 * Prop-driven so it's unit-testable without a fetch.
 */
export function AnonymizationDemo({ state }: { state: SanitizeDemoState }) {
  const { data, status, showAnother } = state

  return (
    <Panel title="Anonymization demo" className="lg:col-span-3">
      <p className="-mt-1 font-mono text-[11px] text-muted-foreground">
        The real sanitizer, live. <span className="text-foreground/80">Demo data — synthetic only.</span>
      </p>

      {status === 'error' ? (
        <p data-testid="anon-error" className="font-mono text-xs text-muted-foreground">
          Demo unavailable right now.
        </p>
      ) : data ? (
        <>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Raw · host-side, never published
              </p>
              <pre
                data-testid="anon-raw"
                className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-background p-3 font-mono text-[11px] leading-relaxed text-muted-foreground"
              >
                {data.raw}
              </pre>
            </div>
            <div>
              <p className="mb-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                Sanitized · what /live shows
              </p>
              <pre
                data-testid="anon-sanitized"
                className="overflow-x-auto whitespace-pre-wrap rounded-md border border-primary/30 bg-background p-3 font-mono text-[11px] leading-relaxed text-foreground"
              >
                {data.sanitized}
              </pre>
            </div>
          </div>

          <div className="flex items-center justify-between gap-3">
            <span data-testid="anon-count" className="font-mono text-[11px] text-primary">
              {data.redactions} redaction{data.redactions === 1 ? '' : 's'}
            </span>
            <button
              type="button"
              data-testid="anon-another"
              onClick={showAnother}
              disabled={data.total <= 1}
              className="rounded-md border border-border px-3 py-1 font-mono text-[11px] text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              Show another →
            </button>
          </div>
        </>
      ) : (
        <p data-testid="anon-loading" className="font-mono text-xs text-muted-foreground">
          Running the pipeline…
        </p>
      )}
    </Panel>
  )
}
