import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { fieldLabel, parseList, type DevPersonaResponse } from '~/lib/use-dev-inspector'

interface PersonaPanelProps {
  persona: DevPersonaResponse | null
}

/**
 * Read-only candidate/persona view (24.42c). Serves the REAL profile (full name,
 * master resume) — the reason the whole surface is dev-only + owner-only. Shows
 * onboarding progress, the populated profile fields, and the freshly-rendered
 * `candidate.md` (the onboarding sentinel when the profile is empty).
 */
export function PersonaPanel({ persona }: PersonaPanelProps) {
  if (!persona) {
    return (
      <Card data-testid="persona-panel">
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Candidate / persona</CardTitle>
        </CardHeader>
        <CardContent className="pt-0 text-sm text-muted-foreground">Loading profile…</CardContent>
      </Card>
    )
  }

  const { profile, candidateMd, onboarding } = persona
  const roles = parseList(profile?.target_roles ?? null)
  const skills = parseList(profile?.skills ?? null)
  const protectedTerms = parseList(profile?.protected_terms ?? null)

  return (
    <Card data-testid="persona-panel">
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Candidate / persona</CardTitle>
        <Badge variant={onboarding.complete ? 'default' : 'secondary'} data-testid="onboarding-badge">
          onboarding {onboarding.filledCount}/{onboarding.totalCount}
        </Badge>
      </CardHeader>
      <CardContent className="flex flex-col gap-5 pt-0">
        {/* onboarding checklist (interview order; next field highlighted) */}
        <ul className="flex flex-col gap-1" data-testid="onboarding-checklist">
          {onboarding.fields.map((f) => {
            const isNext = f.field === onboarding.nextField
            return (
              <li
                key={f.field}
                data-testid={`onboarding-${f.field}`}
                className={`flex items-center gap-2 text-sm ${isNext ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}
              >
                <span className={f.filled ? 'text-accent-cool' : 'text-muted-foreground'}>{f.filled ? '✓' : '○'}</span>
                {fieldLabel(f.field)}
                {isNext ? <span className="font-mono text-[10px] text-accent-cool">← next</span> : null}
              </li>
            )
          })}
        </ul>

        {profile ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
            <Field label="Name" value={profile.full_name} />
            <Field label="Display" value={profile.display_name} />
            <Field
              label="Comp floor"
              value={profile.comp_floor != null ? `$${profile.comp_floor.toLocaleString()}` : null}
            />
            <Field label="Roles" value={roles.length ? roles.join(', ') : null} />
            <Field label="Skills" value={skills.length ? skills.join(', ') : null} />
            <Field label="Gmail" value={profile.gmail_account} />
            <Field label="GitHub" value={profile.github_url} />
            <Field label="LinkedIn" value={profile.linkedin_url} />
            <Field label="Website" value={profile.website_url} />
            <Field label="Updated" value={profile.updated_at} />
          </dl>
        ) : (
          <p className="rounded-md border border-dashed border-border px-3 py-2 text-xs text-muted-foreground">
            No candidate_profile row yet — the agent is in onboarding mode (it interviews the candidate one field per
            turn over Telegram).
          </p>
        )}

        {profile?.bio ? <LongField label="Bio" value={profile.bio} /> : null}
        {profile?.search_goals ? <LongField label="My goals" value={profile.search_goals} /> : null}
        {profile?.master_resume ? <LongField label="Master resume" value={profile.master_resume} mono /> : null}

        {/* §24.134e: an OPTIONAL DEV override — not an onboarding step, not
            auto-populated, and NOT agent-visible (the agent has no tool for it).
            The redaction belt's model (Sonnet) normally keeps the candidate's own
            résumé terms on its own; this is a deterministic escape hatch the owner
            sets directly in the DB for the rare term the model over-redacts. */}
        <div className="flex flex-col gap-1" data-testid="persona-protected-terms">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            Keep-list
            <span className="rounded-sm bg-muted px-1 font-mono text-[9px] tracking-wide text-muted-foreground">
              dev override
            </span>
          </span>
          <p className="text-[11px] leading-snug text-muted-foreground">
            Terms the redaction belt must never anonymize on public kits. The model normally keeps the candidate&apos;s
            own employers/projects on its own — this is a deterministic dev escape hatch (set directly in{' '}
            <code className="text-[10px]">candidate_profile.protected_terms</code>) for the rare term it over-redacts.
            Not agent-managed.
          </p>
          <p className="text-xs">
            {protectedTerms.length ? (
              protectedTerms.join(', ')
            ) : (
              <span className="text-muted-foreground">— none set</span>
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            rendered candidate.md
          </span>
          <pre
            data-testid="candidate-md"
            className="max-h-72 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-[11px] leading-relaxed whitespace-pre-wrap"
          >
            {candidateMd}
          </pre>
        </div>
      </CardContent>
    </Card>
  )
}

function Field({ label, value }: { label: string; value: string | null }) {
  if (!value) return null
  return (
    <>
      <dt className="font-mono text-[11px] uppercase tracking-wider text-muted-foreground">{label}</dt>
      <dd className="break-words">{value}</dd>
    </>
  )
}

function LongField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
      <p className={`max-h-48 overflow-auto whitespace-pre-wrap text-xs ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  )
}
