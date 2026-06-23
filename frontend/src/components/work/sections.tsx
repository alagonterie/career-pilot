import type { ReactNode } from 'react'

import { LONGFORM_SCROLL_MT, LongformDoc } from '~/components/longform/LongformDoc'
import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import { cn } from '~/lib/utils'
import type { WorkProfile } from '~/lib/work-profile'

/** Strip protocol, a leading `www.`, and a trailing slash for a compact link label
 *  (mirrors resume-pdf; §24.159 drops the `www.` — the href keeps it). */
function cleanUrl(u: string): string {
  return u
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '')
}

/** §24.158: render `**bold**` markup as <strong> spans (split on '**' → odd index bold). */
function rich(text: string): ReactNode[] {
  return text
    .split('**')
    .map((seg, i) => (i % 2 === 1 ? <strong key={i}>{seg}</strong> : seg))
    .filter((seg) => seg !== '')
}

/** A labelled `/experience` section: the wrapper carries the long-form scaffold's
 *  `data-longform-section` anchor + scroll-margin + stable id; heading h2 → page h1. */
function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      id={id}
      data-longform-section={id}
      aria-labelledby={`h-${id}`}
      className={cn('w-full border-t border-border pt-10', LONGFORM_SCROLL_MT)}
    >
      <h2 id={`h-${id}`} className="font-mono text-sm font-medium uppercase tracking-widest text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

type WorkItem = { id: string; nav: string; title: string; body: ReactNode }

/**
 * The PORTAL §5.6 sections, rendered from a `WorkProfile` through the shared
 * long-form scaffold (STRATEGY §24.83): a sticky scroll-spy TOC over the résumé,
 * the same reading model as /kit + /about. Each section renders ONLY when it has
 * content — optional sections (writing/talks) and any section the agent left
 * unsourced both omit cleanly rather than showing an empty heading (no invented
 * data — the §24.24 honesty rule + the §24.71/PORTAL §12 placeholder-degradation
 * contract: a partial profile still reads finished, and its TOC simply has fewer
 * entries). The "Elsewhere" social-links section was removed (§24.83 D4) — the
 * sitewide footer is now the single socials strip.
 */
export function WorkSections({ profile }: { profile: WorkProfile }) {
  const items: WorkItem[] = []

  if (profile.bio.length > 0) {
    items.push({
      id: 'about',
      nav: 'About',
      title: 'About',
      body: profile.bio.map((p, i) => (
        <p key={i} className="mt-3 text-base leading-relaxed text-foreground/90 first:mt-0">
          {rich(p)}
        </p>
      )),
    })
  }

  if (profile.lookingFor.length > 0) {
    items.push({
      id: 'looking-for',
      nav: 'Looking for',
      title: "What I'm looking for",
      body: (
        <ul className="flex flex-col gap-2">
          {profile.lookingFor.map((item) => (
            <li key={item} className="text-base text-foreground/90">
              {item}
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (profile.experience.length > 0) {
    items.push({
      id: 'experience',
      nav: 'Experience',
      title: 'Experience',
      body: (
        <div className="flex flex-col gap-4">
          {profile.experience.map((job) => (
            <Card key={`${job.company}-${job.role}`}>
              <CardHeader>
                <CardTitle className="text-base">
                  {job.role} · {job.company}
                </CardTitle>
                <p className="font-mono text-xs text-muted-foreground">{job.period}</p>
                {job.titles ? <p className="text-xs text-muted-foreground/80">{job.titles}</p> : null}
              </CardHeader>
              <CardContent>
                {job.descriptor ? <p className="mb-3 text-sm text-muted-foreground">{rich(job.descriptor)}</p> : null}
                <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-foreground/90">
                  {job.bullets.map((b) => (
                    <li key={b}>{rich(b)}</li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          ))}
        </div>
      ),
    })
  }

  if (profile.projects.length > 0) {
    // §24.157: a lone project reads as a deliberate "Featured project" (full width); 2+ → "Projects" grid.
    const single = profile.projects.length === 1
    items.push({
      id: 'projects',
      nav: single ? 'Featured' : 'Projects',
      title: single ? 'Featured project' : 'Projects',
      body: (
        <div className={cn('grid gap-4', !single && 'sm:grid-cols-2')}>
          {profile.projects.map((proj) => (
            <Card key={proj.name}>
              <CardHeader>
                <CardTitle className="text-base">
                  {proj.href ? (
                    <a href={proj.href} className="text-primary hover:underline">
                      {proj.name}
                    </a>
                  ) : (
                    proj.name
                  )}
                </CardTitle>
                {proj.href || proj.repo ? (
                  <p className="flex flex-wrap gap-x-3 font-mono text-xs text-muted-foreground">
                    {proj.href ? (
                      <a href={proj.href} className="hover:text-primary hover:underline">
                        {cleanUrl(proj.href)}
                      </a>
                    ) : null}
                    {proj.repo ? (
                      <a href={proj.repo} className="hover:text-primary hover:underline">
                        {cleanUrl(proj.repo)}
                      </a>
                    ) : null}
                  </p>
                ) : null}
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <p className="text-sm text-foreground/90">{rich(proj.description)}</p>
                {proj.bullets && proj.bullets.length > 0 ? (
                  <ul className="flex list-disc flex-col gap-2 pl-5 text-sm text-foreground/90">
                    {proj.bullets.map((b) => (
                      <li key={b}>{rich(b)}</li>
                    ))}
                  </ul>
                ) : null}
                {proj.tags && proj.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {proj.tags.map((t) => (
                      <Badge key={t} variant="secondary">
                        {t}
                      </Badge>
                    ))}
                  </div>
                ) : null}
              </CardContent>
            </Card>
          ))}
        </div>
      ),
    })
  }

  if (profile.writing && profile.writing.length > 0) {
    items.push({
      id: 'writing',
      nav: 'Writing',
      title: 'Writing & talks',
      body: (
        <ul className="flex flex-col gap-2">
          {profile.writing.map((w) => (
            <li key={w.title} className="text-base">
              {w.href ? (
                <a href={w.href} className="text-primary hover:underline">
                  {w.title}
                </a>
              ) : (
                <span className="text-foreground/90">{w.title}</span>
              )}
              {w.venue ? <span className="text-muted-foreground"> — {w.venue}</span> : null}
            </li>
          ))}
        </ul>
      ),
    })
  }

  if (profile.skillGroups && profile.skillGroups.length > 0) {
    items.push({
      id: 'skills',
      nav: 'Skills',
      title: 'Skills',
      body: (
        <div className="flex flex-col gap-3">
          {profile.skillGroups.map((g) => (
            <div key={g.category} className="flex flex-col gap-2 sm:flex-row sm:items-baseline sm:gap-4">
              <h3 className="font-mono text-xs uppercase tracking-wider text-muted-foreground sm:w-40 sm:shrink-0">
                {g.category}
              </h3>
              <div className="flex flex-wrap gap-1.5">
                {g.items.map((s) => (
                  <Badge key={s} variant="outline">
                    {s}
                  </Badge>
                ))}
              </div>
            </div>
          ))}
        </div>
      ),
    })
  } else if (profile.skills.length > 0) {
    items.push({
      id: 'skills',
      nav: 'Skills',
      title: 'Skills',
      body: (
        <div className="flex flex-wrap gap-2">
          {profile.skills.map((s) => (
            <Badge key={s} variant="outline">
              {s}
            </Badge>
          ))}
        </div>
      ),
    })
  }

  if (profile.education.length > 0) {
    items.push({
      id: 'education',
      nav: 'Education',
      title: 'Education',
      body: (
        <ul className="flex flex-col gap-1.5 text-base text-foreground/90">
          {profile.education.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ),
    })
  }

  if (items.length === 0) return null

  const toc = items.map((s) => ({ id: s.id, title: s.nav }))
  return (
    <LongformDoc
      sections={toc}
      idPrefix="experience"
      navLabel="On this page"
      stepper
      contentClassName="flex w-full flex-col gap-10"
    >
      {items.map((s) => (
        <Section key={s.id} id={s.id} title={s.title}>
          {s.body}
        </Section>
      ))}
    </LongformDoc>
  )
}
