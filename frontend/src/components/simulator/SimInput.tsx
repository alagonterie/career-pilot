import { zodResolver } from '@hookform/resolvers/zod'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { AgentRef } from '~/components/AgentRef'
import { Button } from '~/components/ui/button'
import { useTurnstile } from '~/lib/use-turnstile'
import type { SimRunInput } from '~/lib/use-simulator-run'

const schema = z.object({
  company: z.string().min(1, 'Company is required'),
  role: z.string().min(1, 'Role / title is required'),
  public_url: z.string().optional(),
  jd: z.string().optional(),
})
type SimFields = z.infer<typeof schema>

function Field({ label, error, children }: { label: string; error?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium text-foreground">{label}</span>
      {children}
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </label>
  )
}

const inputClass =
  'rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * The recruiter-simulator input view (PORTAL §5.3, Apple register). Prop-driven
 * (`onRun`) so it's unit-testable without the run hook or a router. Validates
 * company + role (mirrors the backend's required fields); JD + URL are optional.
 * The rate-limit indicator is display-only until the Phase-9 Turnstile/per-IP cap
 * lands (§24.31).
 */
export function SimInput({ onRun, disabled }: { onRun: (input: SimRunInput) => void; disabled?: boolean }) {
  const { token, enforce, widget } = useTurnstile('simulator_run')
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<SimFields>({
    resolver: zodResolver(schema),
    defaultValues: { company: '', role: '', public_url: '', jd: '' },
  })

  const submit = (data: SimFields): void => {
    onRun({
      company: data.company,
      role: data.role,
      public_url: data.public_url?.trim() ? data.public_url.trim() : undefined,
      jd: data.jd?.trim() ? data.jd.trim() : undefined,
      turnstileToken: token ?? undefined,
    })
  }

  return (
    <form onSubmit={handleSubmit(submit)} noValidate data-testid="sim-input-form" className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Company name" error={errors.company?.message}>
          <input type="text" autoComplete="organization" className={inputClass} {...register('company')} />
        </Field>
        <Field label="Public URL (optional)">
          <input type="url" placeholder="https://…" className={inputClass} {...register('public_url')} />
        </Field>
      </div>
      <Field label="Role / title" error={errors.role?.message}>
        <input type="text" className={inputClass} {...register('role')} />
      </Field>
      <Field label="What the role looks for (paste the JD or describe — optional)">
        <textarea rows={5} className={inputClass} {...register('jd')} />
      </Field>

      <div className="flex flex-col items-center gap-3">
        {widget}
        <Button type="submit" disabled={disabled || (enforce && !token)}>
          {disabled ? 'Starting…' : 'Watch me apply →'}
        </Button>
      </div>

      <div className="mt-2 rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-foreground">What happens</p>
        <ol className="ml-4 list-decimal space-y-1">
          <li>A sandbox container spins up.</li>
          <li>
            <AgentRef name="research-company" /> digests your role + company — live web research, not a canned demo.
          </li>
          <li>
            <AgentRef name="tailor-resume" /> + <AgentRef name="draft-outreach" /> run in parallel.
          </li>
          <li>
            You walk away with a <span className="text-foreground/90">tailored résumé to download</span>, plus pitch
            bullets + a cold-outreach email — a real run takes a few minutes.
          </li>
        </ol>
        <p className="mt-3 text-xs">
          Nothing gets submitted anywhere. No private data is touched, no DB writes. The run cost is reported
          transparently.
        </p>
      </div>
    </form>
  )
}
