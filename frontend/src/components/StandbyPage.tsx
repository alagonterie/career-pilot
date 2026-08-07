import { Globe } from 'lucide-react'
import type { ComponentType } from 'react'

import { GitHubIcon, LinkedInIcon, XIcon } from '~/components/brand-icons'
import { PERSON_NAME, REPO_URL } from '~/lib/site'
import { standbyDuration, type StandbySnapshot, type StandbyState } from '~/lib/standby'

/**
 * The public standby page (§24.189 D6) — what the whole site is while the search
 * is deliberately paused and the VM is stopped.
 *
 * Tone is the point. This is NOT the `/halt` "temporarily offline — back shortly"
 * apology: nothing is broken, and a recruiter landing here should read a confident
 * career statement, not an outage. So it says plainly that the search isn't running,
 * gives one line on the system being deliberately powered down to zero (the pause
 * is itself a small proof of the engineering the site is about), and — the part
 * that actually matters — still hands over a way to make contact.
 *
 * Identity comes from the ENTRY snapshot in KV, not the backend (there isn't one).
 * The name is build-time (`PERSON_NAME`), so it's correct even with no snapshot;
 * every link is omit-when-null, per the identity SSR principle — a missing field
 * renders nothing, never a broken placeholder link.
 */

type IconComponent = ComponentType<{ className?: string }>

interface StandbyLink {
  label: string
  href: string
  Icon: IconComponent
}

/** Pure: snapshot → the ordered links to show. Exported for tests. */
export function standbyLinks(snapshot: StandbySnapshot | null): StandbyLink[] {
  if (!snapshot) return []
  const out: StandbyLink[] = []
  if (snapshot.github) out.push({ label: 'GitHub', href: snapshot.github, Icon: GitHubIcon })
  if (snapshot.linkedin) out.push({ label: 'LinkedIn', href: snapshot.linkedin, Icon: LinkedInIcon })
  if (snapshot.x) out.push({ label: 'X', href: snapshot.x, Icon: XIcon })
  if (snapshot.website) out.push({ label: 'Website', href: snapshot.website, Icon: Globe })
  return out
}

export function StandbyPage({
  state,
  snapshot,
  now,
}: {
  state: StandbyState
  snapshot: StandbySnapshot | null
  now?: number
}) {
  const name = snapshot?.name ?? PERSON_NAME
  const links = standbyLinks(snapshot)
  const duration = standbyDuration(state.since, now)

  return (
    <main
      data-testid="standby-page"
      className="relative mx-auto flex min-h-dvh w-full max-w-2xl flex-col justify-center gap-8 px-6 py-20"
    >
      {/* The same ambient wash the live hero uses — this is still the site, just at rest. */}
      <div
        aria-hidden="true"
        className="cp-aurora pointer-events-none absolute left-1/2 top-0 -z-10 h-[26rem] w-[44rem] max-w-full -translate-x-1/2 opacity-60"
      />

      <div className="flex flex-col gap-3">
        <span
          data-testid="standby-badge"
          className="inline-flex w-fit items-center gap-2 rounded-md border border-border px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-muted-foreground"
        >
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-muted-foreground" />
          Standby
        </span>
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">{name}</h1>
      </div>

      <div className="flex flex-col gap-4 text-base leading-relaxed text-muted-foreground">
        <p data-testid="standby-statement" className="text-foreground">
          I&apos;m not actively looking right now.
        </p>
        <p>
          This site normally runs a live AI agent that works my job search in the open — finding roles, tailoring
          applications, tracking every conversation. While the search is paused, that whole system is powered down to
          zero rather than left idling, so what you&apos;re reading is the only thing still running.
        </p>
        {state.note ? (
          <p data-testid="standby-note" className="border-l-2 border-border pl-4 italic text-foreground">
            {state.note}
          </p>
        ) : null}
        <p>
          It comes back the moment I&apos;m looking again. If you want to talk before then — about a role, or about how
          any of this was built — the fastest way is a direct email.
        </p>
      </div>

      <div className="flex flex-col gap-4">
        {snapshot?.email ? (
          <a
            data-testid="standby-email"
            href={`mailto:${snapshot.email}`}
            className="inline-flex w-fit items-center gap-2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            {snapshot.email}
          </a>
        ) : null}

        {links.length > 0 ? (
          <ul data-testid="standby-links" className="flex flex-wrap items-center gap-x-5 gap-y-2">
            {links.map((l) => (
              <li key={l.label}>
                <a
                  href={l.href}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
                >
                  <l.Icon className="h-4 w-4" />
                  {l.label}
                </a>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-6 font-mono text-[11px] text-muted-foreground">
        <a href={REPO_URL} target="_blank" rel="noreferrer" className="w-fit transition-colors hover:text-foreground">
          The system that runs this, on GitHub ↗
        </a>
        {duration ? (
          <span data-testid="standby-since">
            On standby for {duration}. The infrastructure is stopped, not deleted.
          </span>
        ) : (
          <span>The infrastructure is stopped, not deleted.</span>
        )}
      </div>
    </main>
  )
}
