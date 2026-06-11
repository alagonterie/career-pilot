import { renderMarkdownish } from '~/lib/markdownish'

/**
 * The simulator run's OUTPUT pane (PORTAL §5.3, right pane) — also reused by the
 * `/simulator/results/:id` share page. Renders the streamed `chat` text
 * faithfully as it materializes (the §24.24 render-what-you-have rule). The
 * §5.3 two-panel RESUME/OUTREACH *concurrent fill* is deferred (it needs a
 * pinned sandbox output format + subagent attribution on the wire) — until then
 * the agent's own `## ` section headers (Tailored resume / Cold outreach) give
 * the text its structure honestly, with no fabricated backend split.
 *
 * The markdown-ish renderer lives in ~/lib/markdownish (§24.31 Δ; extracted
 * §24.65 — the /kit dossier shares it).
 */

export function SimOutput({ text, pending }: { text: string; pending?: boolean }) {
  return (
    <section
      aria-labelledby="sim-output-heading"
      data-testid="sim-output"
      className="flex h-full min-w-0 flex-col rounded-lg border border-border bg-card"
    >
      <header className="border-b border-border px-4 py-3">
        <h2
          id="sim-output-heading"
          className="font-mono text-xs font-semibold uppercase tracking-widest text-muted-foreground"
        >
          Result
        </h2>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {text.length > 0 ? (
          <div data-testid="sim-output-body">{renderMarkdownish(text)}</div>
        ) : pending ? (
          <div data-testid="sim-output-skeleton" aria-hidden="true" className="space-y-2">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
            <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted" />
          </div>
        ) : (
          <p data-testid="sim-output-empty" className="text-sm text-muted-foreground">
            No output yet.
          </p>
        )}
      </div>
    </section>
  )
}
