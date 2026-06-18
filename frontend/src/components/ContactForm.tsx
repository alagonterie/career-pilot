import { zodResolver } from '@hookform/resolvers/zod'
import { motion } from 'motion/react'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { FormField, StableLabel } from '~/components/form-controls'
import { Button } from '~/components/ui/button'
import { useTurnstile } from '~/lib/use-turnstile'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

const schema = z.object({
  name: z.string().min(1, 'Your name is required'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  company: z.string().optional(),
  role: z.string().min(1, 'Role / title is required'),
  message: z.string().min(1, 'A message (or a pasted JD) is required'),
})
type ContactFields = z.infer<typeof schema>

const inputClass =
  'rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring'

/**
 * The contact form (PORTAL §5.7) — prop-driven so it's unit-testable without a
 * router context. Posts to the built `POST /api/contact` relay; shows a "Sent"
 * confirmation on success and an honest, direct-contact-pointing error otherwise.
 * `company`/`role` prefill from the page's carried context; `from` (the
 * originating surface) is relayed as `source` so the owner sees where a lead
 * engaged — it's context only, never shown back to the visitor.
 */
export function ContactForm({ company, role, from }: { company?: string; role?: string; from?: string }) {
  const [sent, setSent] = React.useState(false)
  const [submitError, setSubmitError] = React.useState<string | null>(null)
  const { token, enforce, widget } = useTurnstile('contact_submit')

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ContactFields>({
    resolver: zodResolver(schema),
    defaultValues: { name: '', email: '', company: company ?? '', role: role ?? '', message: '' },
  })

  const onSubmit = async (data: ContactFields): Promise<void> => {
    setSubmitError(null)
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (token) headers['x-turnstile-token'] = token
      const res = await fetch(`${API_BASE}/api/contact`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ ...data, source: from }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSent(true)
    } catch {
      setSubmitError('Couldn’t send right now — please try again, or reach me via the links in the footer.')
    }
  }

  if (sent) {
    // §24.120: the one place a visitor *acts* gets a real payoff — a warmer,
    // specific, lightly-animated confirmation that leans into the true fact that
    // the relay just hit my phone. The fade/scale-in is reduced-motion-safe via
    // the root MotionConfig; visual snapshots disable animations (settled state).
    return (
      <motion.div
        data-testid="contact-sent"
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: 0.2, ease: 'easeOut' }}
        className="mt-10 flex items-start gap-3 rounded-lg border border-primary/40 bg-card p-6 text-sm text-foreground"
      >
        <span
          aria-hidden="true"
          className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/15 font-mono text-primary"
        >
          ✓
        </span>
        <div>
          <p className="font-medium">Sent — that just pinged my phone.</p>
          <p className="mt-1 text-muted-foreground">I typically reply within 24 hours.</p>
        </div>
      </motion.div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-10 flex flex-col gap-5" data-testid="contact-form">
      <FormField label="Your name" error={errors.name?.message}>
        <input type="text" autoComplete="name" className={inputClass} {...register('name')} />
      </FormField>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <FormField label="Email" error={errors.email?.message}>
          <input type="email" autoComplete="email" className={inputClass} {...register('email')} />
        </FormField>
        <FormField label="Company" error={errors.company?.message}>
          <input type="text" autoComplete="organization" className={inputClass} {...register('company')} />
        </FormField>
      </div>
      <FormField label="Role / title" error={errors.role?.message}>
        <input type="text" className={inputClass} {...register('role')} />
      </FormField>
      <FormField label="Message (or paste a JD)" error={errors.message?.message}>
        <textarea rows={5} className={inputClass} {...register('message')} />
      </FormField>

      {submitError ? (
        <p data-testid="contact-error" role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      {widget}

      <div className="flex justify-end">
        {/* §24.120 Δ: StableLabel fixes the button's width to its widest label so
            it never resizes when "Send →" swaps to "Sending…". */}
        <Button type="submit" disabled={isSubmitting || (enforce && !token)}>
          <StableLabel labels={['Send →', 'Sending…']} active={isSubmitting ? 'Sending…' : 'Send →'} />
        </Button>
      </div>
    </form>
  )
}
