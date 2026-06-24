import { zodResolver } from '@hookform/resolvers/zod'
import { Link } from '@tanstack/react-router'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { AgentRef } from '~/components/AgentRef'
import { FormField, StableLabel } from '~/components/form-controls'
import { Button } from '~/components/ui/button'
import { useTurnstile } from '~/lib/use-turnstile'
import type { SimRunInput } from '~/lib/use-simulator-run'

/**
 * Pure: does this look like garbage rather than a real company/role name
 * (STRATEGY §24.104)? Conservative — rejects only the two unambiguous shapes so
 * a real (if obscure) name never trips it: (1) a single character repeated
 * ("aaaa", "....", "----"), (2) no letters at all ("1234", "!!!"). Exported so
 * the cases are unit-testable without rendering the form. The §24.70 abuse caps
 * + the agent's honest "couldn't find this company" remain the backstop for
 * plausible-looking junk this can't catch.
 */
export function looksLikeGarbage(value: string): boolean {
  const compact = value.trim().replace(/\s/g, '')
  if (compact.length === 0) return true
  if (new Set(compact).size <= 1) return true
  if (!/\p{L}/u.test(compact)) return true
  return false
}

const realName = (label: string) =>
  z
    .string()
    .trim()
    .min(2, `Enter a real ${label}`)
    .refine((v) => !looksLikeGarbage(v), `Enter a real ${label}`)

const schema = z.object({
  company: realName('company name'),
  role: realName('role or title'),
  public_url: z.string().optional(),
  jd: z.string().optional(),
})
type SimFields = z.infer<typeof schema>

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
        <FormField label="Company name" error={errors.company?.message}>
          <input type="text" autoComplete="organization" className={inputClass} {...register('company')} />
        </FormField>
        <FormField label="Public URL (optional)">
          <input type="url" placeholder="https://…" className={inputClass} {...register('public_url')} />
        </FormField>
      </div>
      <FormField label="Role / title" error={errors.role?.message}>
        <input type="text" className={inputClass} {...register('role')} />
      </FormField>
      <FormField label="What the role looks for (paste the JD or describe — optional)">
        <textarea rows={5} className={inputClass} {...register('jd')} />
      </FormField>

      <div className="flex flex-col items-center gap-3">
        {widget}
        {/* §24.120 Δ: StableLabel fixes the width to the widest label so the
            button doesn't shrink when "Watch me apply →" swaps to "Starting…". */}
        <Button type="submit" disabled={disabled || (enforce && !token)}>
          <StableLabel
            labels={['Watch me apply →', 'Starting…']}
            active={disabled ? 'Starting…' : 'Watch me apply →'}
          />
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
            You walk away with two things: a <span className="text-foreground/90">tailored résumé to download</span> and
            a personalized cold-outreach email — a real run takes a few minutes.
          </li>
        </ol>
        <p className="mt-3 text-xs">
          Nothing is submitted to any employer. The run is saved — that&rsquo;s how you get a shareable result, and how
          the abuse limits work: it keeps the company, role, and JD you enter, a redacted activity trace, the cost +
          runtime, and your IP, visible only to me and deleted after a short window. More in the{' '}
          <Link to="/privacy" className="underline hover:text-foreground">
            privacy policy
          </Link>
          .
        </p>
      </div>
    </form>
  )
}
