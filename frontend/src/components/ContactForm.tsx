import { zodResolver } from '@hookform/resolvers/zod'
import * as React from 'react'
import { useForm } from 'react-hook-form'
import { z } from 'zod'

import { Button } from '~/components/ui/button'

const API_BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:3001'

const schema = z.object({
  name: z.string().min(1, 'Your name is required'),
  email: z.string().min(1, 'Email is required').email('Enter a valid email'),
  company: z.string().optional(),
  role: z.string().min(1, 'Role / title is required'),
  message: z.string().min(1, 'A message (or a pasted JD) is required'),
})
type ContactFields = z.infer<typeof schema>

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
      const res = await fetch(`${API_BASE}/api/contact`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, source: from }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setSent(true)
    } catch {
      setSubmitError('Could not send right now — please reach me directly below.')
    }
  }

  if (sent) {
    return (
      <div
        data-testid="contact-sent"
        className="mt-10 rounded-lg border border-primary/40 bg-card p-6 text-sm text-foreground"
      >
        <p className="font-medium">Sent.</p>
        <p className="mt-1 text-muted-foreground">I typically reply within 24 hours.</p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit(onSubmit)} noValidate className="mt-10 flex flex-col gap-5" data-testid="contact-form">
      <Field label="Your name" error={errors.name?.message}>
        <input type="text" autoComplete="name" className={inputClass} {...register('name')} />
      </Field>
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
        <Field label="Email" error={errors.email?.message}>
          <input type="email" autoComplete="email" className={inputClass} {...register('email')} />
        </Field>
        <Field label="Company" error={errors.company?.message}>
          <input type="text" autoComplete="organization" className={inputClass} {...register('company')} />
        </Field>
      </div>
      <Field label="Role / title" error={errors.role?.message}>
        <input type="text" className={inputClass} {...register('role')} />
      </Field>
      <Field label="Message (or paste a JD)" error={errors.message?.message}>
        <textarea rows={5} className={inputClass} {...register('message')} />
      </Field>

      {submitError ? (
        <p data-testid="contact-error" role="alert" className="text-sm text-destructive">
          {submitError}
        </p>
      ) : null}

      <div className="flex justify-end">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Sending…' : 'Send →'}
        </Button>
      </div>
    </form>
  )
}
