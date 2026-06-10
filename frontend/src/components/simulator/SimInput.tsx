import { zodResolver } from '@hookform/resolvers/zod'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '~/components/ui/button'
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
        <Button type="submit" disabled={disabled}>
          {disabled ? 'Starting…' : 'Run simulation →'}
        </Button>
      </div>

      <div className="mt-2 rounded-lg border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
        <p className="mb-2 font-mono text-xs uppercase tracking-widest text-foreground">What happens</p>
        <ol className="ml-4 list-decimal space-y-1">
          <li>A sandbox container spins up.</li>
          <li>
            <span className="text-foreground/90">research-company</span> digests your role + company — live web
            research, not a canned demo.
          </li>
          <li>
            <span className="text-foreground/90">tailor-resume</span> +{' '}
            <span className="text-foreground/90">draft-outreach</span> run in parallel.
          </li>
          <li>You get a tailored pitch + outreach email — a real run takes a few minutes.</li>
        </ol>
        <p className="mt-3 text-xs">
          No private data is touched. No DB writes. The run cost is reported transparently.
        </p>
      </div>
    </form>
  )
}
