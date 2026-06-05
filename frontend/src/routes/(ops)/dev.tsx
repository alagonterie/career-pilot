import { createFileRoute } from '@tanstack/react-router'

import { KnobControls } from '~/components/dev/KnobControls'
import { PersonaPanel } from '~/components/dev/PersonaPanel'
import { SimStatePanel } from '~/components/dev/SimStatePanel'
import { StateNote } from '~/components/states'
import { Skeleton } from '~/components/ui/skeleton'
import { seo } from '~/lib/seo'
import { postKnob, resetAllKnobs, resetKnob, useDevKnobs, useDevPersona, useDevState } from '~/lib/use-dev-inspector'

// The dev-only inspector + sim-control surface (§24.42c). Lives in the `(ops)`
// group (shared header/rail) but is NOT in the public nav — it's reached by
// direct URL. The backend `/api/dev/*` endpoints 404 unless ENVIRONMENT==='dev',
// so on any other stack this page degrades to an "unavailable" note and renders
// nothing sensitive (the real PII never leaves the dev stack). `noindex` keeps
// it out of search even though prod can't serve its data.
export const Route = createFileRoute('/(ops)/dev')({
  component: DevInspectorPage,
  head: () => {
    const base = seo({
      title: 'Dev inspector — Jane Doe',
      description: 'Dev-only inspector + sim controls. Owner-gated; served only on the dev stack.',
      path: '/dev',
    })
    return { meta: [...base.meta, { name: 'robots', content: 'noindex' }] }
  },
})

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

function DevInspectorPage() {
  const knobs = useDevKnobs(API_BASE)
  const state = useDevState(API_BASE)
  const persona = useDevPersona(API_BASE)

  const onWrite = (key: string, value: boolean | number | string) => postKnob(API_BASE, key, value)
  const onReset = (key: string) => resetKnob(API_BASE, key)
  const onResetAll = () => resetAllKnobs(API_BASE)

  // Cold 404 on the knobs feed = not the dev stack → the whole surface is
  // unavailable (and no PII is reachable). This is the prod-degradation path.
  const unavailable = knobs.status === 'error' && knobs.data === null

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="flex flex-col gap-2">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight sm:text-3xl">Dev inspector</h1>
          <span className="rounded-md border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            dev · owner-only
          </span>
        </div>
        <p className="text-sm text-muted-foreground">
          Tune the recruiter sim and the proactive-loop pacing, and inspect the candidate/persona state that drives the
          agent. Light-control only — destructive ops stay on CI / Telegram. This surface is served only on the dev
          stack.
        </p>
      </header>

      {unavailable ? (
        <div className="flex min-h-[16rem] items-center justify-center">
          <StateNote data-testid="dev-unavailable" tone="error">
            The dev inspector is only served on the dev stack (ENVIRONMENT=dev). Nothing to show here.
          </StateNote>
        </div>
      ) : knobs.status === 'loading' && !knobs.data ? (
        <div className="flex flex-col gap-4">
          <Skeleton data-testid="dev-skeleton" className="h-48 w-full rounded-xl" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : (
        <>
          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Controls</h2>
            {knobs.data ? (
              <KnobControls knobs={knobs.data.knobs} onWrite={onWrite} onReset={onReset} onResetAll={onResetAll} />
            ) : null}
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Sim</h2>
            <SimStatePanel state={state.data} />
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="font-mono text-xs uppercase tracking-widest text-foreground">Persona</h2>
            <PersonaPanel persona={persona.data} />
          </section>
        </>
      )}
    </main>
  )
}
