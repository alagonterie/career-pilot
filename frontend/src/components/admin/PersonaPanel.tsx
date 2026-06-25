import { useState } from 'react'

import { type AdminPersona, postAdminPersona } from '~/lib/use-admin'

/**
 * §24.170 — the owner-only candidate-profile editor. candidate_profile is the one
 * source for the agent persona, the public /api/profile identity, and name
 * redaction; edits apply to the agent on its next session. Simple fields save one
 * at a time (the server normalizes + allow-lists); work_profile_json is a
 * validated JSON edit stored source='manual' (never faked as AI-composed).
 */

const ARRAY_FIELDS = new Set(['target_roles', 'skills', 'protected_terms'])
const MULTILINE_FIELDS = new Set(['bio', 'master_resume', 'search_goals'])

const GROUPS: { title: string; fields: string[]; note?: string }[] = [
  { title: 'Identity', fields: ['full_name', 'display_name', 'bio'] },
  { title: 'Search & fit', fields: ['target_roles', 'skills', 'location_pref', 'comp_floor', 'search_goals'] },
  { title: 'Résumé', fields: ['master_resume'] },
  { title: 'Links & contact', fields: ['github_url', 'linkedin_url', 'x_url', 'website_url', 'public_email'] },
  { title: 'Branding', fields: ['brand_color_hsl', 'headshot_path'] },
  {
    title: 'Redaction',
    fields: ['protected_terms'],
    note: 'The keep-list — your own employers/projects, never redacted on public kits.',
  },
  { title: 'Account', fields: ['gmail_account'] },
]

const LABELS: Record<string, string> = {
  full_name: 'Full name',
  display_name: 'Display name',
  bio: 'Bio',
  target_roles: 'Target roles',
  skills: 'Skills',
  location_pref: 'Location preference',
  comp_floor: 'Comp floor',
  search_goals: 'Search goals',
  master_resume: 'Master résumé',
  github_url: 'GitHub',
  linkedin_url: 'LinkedIn',
  x_url: 'X',
  website_url: 'Website',
  public_email: 'Public email',
  brand_color_hsl: 'Brand color (HSL)',
  headshot_path: 'Headshot path',
  protected_terms: 'Protected terms',
  gmail_account: 'Gmail account',
}

/** Array fields are stored as a JSON-array string; show them comma-joined for editing. */
function toEditable(field: string, raw: unknown): string {
  if (raw == null) return ''
  if (ARRAY_FIELDS.has(field) && typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr)) return arr.join(', ')
    } catch {
      // not JSON — show as-is
    }
  }
  return String(raw)
}

function SaveButton({ onClick, saving, testid }: { onClick: () => void; saving: boolean; testid: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={saving}
      data-testid={testid}
      className="rounded bg-foreground px-2 py-0.5 text-[11px] font-medium text-background disabled:opacity-50"
    >
      {saving ? 'Saving…' : 'Save'}
    </button>
  )
}

function Field({
  field,
  raw,
  readOnly,
  baseUrl,
  onSaved,
}: {
  field: string
  raw: unknown
  readOnly: boolean
  baseUrl: string
  onSaved: () => void
}) {
  const initial = toEditable(field, raw)
  const [val, setVal] = useState(initial)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = val !== initial
  const inputClass = 'w-full rounded border border-border bg-background px-2 py-1 text-sm read-only:opacity-60'

  async function save() {
    setSaving(true)
    setErr(null)
    const res = await postAdminPersona(baseUrl, field, val)
    setSaving(false)
    if (res.ok) onSaved()
    else setErr(res.error ?? 'save failed')
  }

  return (
    <div className="flex flex-col gap-1 py-2" data-testid={`persona-field-${field}`}>
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          {LABELS[field] ?? field}
          {ARRAY_FIELDS.has(field) ? <span className="ml-1 text-muted-foreground/60">(comma-separated)</span> : null}
          {readOnly ? <span className="ml-1 text-muted-foreground/60">(read-only)</span> : null}
        </label>
        {dirty && !readOnly ? <SaveButton onClick={save} saving={saving} testid={`persona-save-${field}`} /> : null}
      </div>
      {MULTILINE_FIELDS.has(field) ? (
        <textarea
          value={val}
          onChange={(e) => setVal(e.target.value)}
          readOnly={readOnly}
          rows={field === 'master_resume' ? 8 : 3}
          className={`${inputClass} font-mono text-xs`}
        />
      ) : (
        <input value={val} onChange={(e) => setVal(e.target.value)} readOnly={readOnly} className={inputClass} />
      )}
      {err ? <p className="text-[11px] text-red-500">{err}</p> : null}
    </div>
  )
}

function WorkProfileEditor({ data, baseUrl, onSaved }: { data: AdminPersona; baseUrl: string; onSaved: () => void }) {
  const pretty = (() => {
    if (!data.workProfile.json) return ''
    try {
      return JSON.stringify(JSON.parse(data.workProfile.json), null, 2)
    } catch {
      return data.workProfile.json
    }
  })()
  const [val, setVal] = useState(pretty)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const dirty = val !== pretty

  async function save() {
    setSaving(true)
    setErr(null)
    const res = await postAdminPersona(baseUrl, 'work_profile_json', val)
    setSaving(false)
    if (res.ok) onSaved()
    else setErr(res.error ?? 'save failed (must be a WorkProfile with a non-empty name)')
  }

  return (
    <section className="rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Work profile (the /work résumé)</h3>
        {dirty ? <SaveButton onClick={save} saving={saving} testid="persona-save-work_profile_json" /> : null}
      </div>
      <p className="mt-1 text-[11px] text-muted-foreground">
        Provenance: <span className="font-mono">{data.workProfile.source ?? 'none'}</span>
        {data.workProfile.generated_at ? ` · ${new Date(data.workProfile.generated_at).toLocaleDateString()}` : ''} — a
        manual save stores <span className="font-mono">source=manual</span>. The /work page only claims AI composition
        when source=agent, so an edit shows no false AI mark.
      </p>
      <textarea
        value={val}
        onChange={(e) => setVal(e.target.value)}
        rows={12}
        spellCheck={false}
        data-testid="persona-work-profile-json"
        className="mt-2 w-full rounded border border-border bg-background px-2 py-1 font-mono text-[11px]"
      />
      {err ? <p className="mt-1 text-[11px] text-red-500">{err}</p> : null}
    </section>
  )
}

const LOCATION_TYPES = ['remote', 'hybrid', 'onsite'] as const

/** location_pref is the §24.100 structured schema { type[], preferred_cities[] }, NOT
 * free text — a plain string reaches neither the persona's ## Location nor
 * lead-scoring's `location_specified` gate (so off-location leads aren't demoted).
 * Toggles + a cities field build the canonical object. */
function LocationField({ raw, baseUrl, onSaved }: { raw: unknown; baseUrl: string; onSaved: () => void }) {
  const initial = (() => {
    if (typeof raw === 'string' && raw) {
      try {
        const o = JSON.parse(raw) as { type?: unknown; preferred_cities?: unknown }
        return {
          type: Array.isArray(o.type) ? o.type.filter((t): t is string => typeof t === 'string') : [],
          cities: Array.isArray(o.preferred_cities)
            ? o.preferred_cities.filter((c): c is string => typeof c === 'string')
            : [],
        }
      } catch {
        // legacy bare string (the pre-fix shape) — can't structure it; start empty
      }
    }
    return { type: [] as string[], cities: [] as string[] }
  })()
  const [types, setTypes] = useState<string[]>(initial.type)
  const [cities, setCities] = useState(initial.cities.join(', '))
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const cityArr = cities
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean)
  const dirty =
    JSON.stringify(types) !== JSON.stringify(initial.type) || JSON.stringify(cityArr) !== JSON.stringify(initial.cities)

  function toggle(t: string) {
    setTypes((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]))
  }
  async function save() {
    setSaving(true)
    setErr(null)
    const res = await postAdminPersona(baseUrl, 'location_pref', { type: types, preferred_cities: cityArr })
    setSaving(false)
    if (res.ok) onSaved()
    else setErr(res.error ?? 'save failed')
  }

  return (
    <div className="flex flex-col gap-1.5 py-2" data-testid="persona-field-location_pref">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">Location preference</label>
        {dirty ? <SaveButton onClick={save} saving={saving} testid="persona-save-location_pref" /> : null}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {LOCATION_TYPES.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            data-testid={`persona-loc-type-${t}`}
            aria-pressed={types.includes(t)}
            className={`rounded-full border px-2.5 py-0.5 text-[11px] capitalize ${
              types.includes(t)
                ? 'border-foreground bg-foreground text-background'
                : 'border-border text-muted-foreground'
            }`}
          >
            {t}
          </button>
        ))}
      </div>
      <input
        value={cities}
        onChange={(e) => setCities(e.target.value)}
        placeholder="Preferred cities (comma-separated)"
        className="w-full rounded border border-border bg-background px-2 py-1 text-sm"
      />
      {err ? <p className="text-[11px] text-red-500">{err}</p> : null}
    </div>
  )
}

export function PersonaPanel({
  data,
  baseUrl,
  onSaved,
}: {
  data: AdminPersona | null
  baseUrl: string
  onSaved: () => void
}) {
  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading the candidate profile…</p>
  }
  const readonly = new Set(data.readonlyFields)
  return (
    <div className="flex flex-col gap-5" data-testid="persona-panel">
      <p className="text-xs text-muted-foreground">
        The single source for your agent persona, the public profile, and name redaction. Edits apply to the agent on
        its <strong>next session</strong>.
      </p>

      {data.blockers.length > 0 ? (
        <div
          data-testid="persona-blockers"
          className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-600 dark:text-amber-400"
        >
          Incomplete for live mode — missing: <span className="font-mono">{data.blockers.join(', ')}</span>
        </div>
      ) : null}

      {GROUPS.map((g) => (
        <section key={g.title} className="rounded-lg border border-border p-4">
          <h3 className="text-sm font-semibold">{g.title}</h3>
          {g.note ? <p className="mt-0.5 text-[11px] text-muted-foreground">{g.note}</p> : null}
          <div className="mt-1 divide-y divide-border/50">
            {g.fields.map((f) =>
              f === 'location_pref' ? (
                <LocationField
                  key={`location_pref:${String(data.fields[f] ?? '')}`}
                  raw={data.fields[f]}
                  baseUrl={baseUrl}
                  onSaved={onSaved}
                />
              ) : (
                <Field
                  key={`${f}:${String(data.fields[f] ?? '')}`}
                  field={f}
                  raw={data.fields[f]}
                  readOnly={readonly.has(f)}
                  baseUrl={baseUrl}
                  onSaved={onSaved}
                />
              ),
            )}
          </div>
        </section>
      ))}

      <WorkProfileEditor
        key={data.workProfile.generated_at ?? 'none'}
        data={data}
        baseUrl={baseUrl}
        onSaved={onSaved}
      />

      <details className="rounded-lg border border-border p-4">
        <summary className="cursor-pointer text-sm font-semibold">Persona preview (what the agent receives)</summary>
        <pre
          data-testid="persona-preview"
          className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded bg-muted/40 p-3 font-mono text-[11px] text-muted-foreground"
        >
          {data.personaPreview}
        </pre>
      </details>
    </div>
  )
}
