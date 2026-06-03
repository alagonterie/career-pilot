import { AnonymizationDemo } from '~/components/live/AnonymizationDemo'
import { useSanitizeDemo } from '~/lib/use-sanitize-demo'

/**
 * The live anonymization demo as hosted in the `/architecture` `pub-sanitize`
 * node modal (§24.35 Pass B). Self-fetches via `useSanitizeDemo`, so the
 * `POST /api/sanitize-demo` fires **lazily** — only when this modal mounts (the
 * node is clicked). The transformation is the real sanitizer over synthetic
 * input; this wrapper just owns the fetch and hands the state to the body.
 */
export function SanitizerDemo() {
  const state = useSanitizeDemo()
  return (
    <section aria-labelledby="sanitizer-demo-heading" className="flex flex-col gap-2 border-t border-border pt-4">
      <h3 id="sanitizer-demo-heading" className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
        Live sanitizer
      </h3>
      <AnonymizationDemo state={state} />
    </section>
  )
}
