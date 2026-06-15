import type { ReactNode } from 'react'

import { Badge } from '~/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card'
import type { WorkProfile } from '~/lib/work-profile'

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
}

/** A labelled `/work` section. Heading hierarchy: page h1 → section h2. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = `section-${slug(title)}`
  return (
    <section aria-labelledby={id} className="w-full border-t border-border pt-10">
      <h2 id={id} className="font-mono text-sm font-medium uppercase tracking-widest text-muted-foreground">
        {title}
      </h2>
      <div className="mt-4">{children}</div>
    </section>
  )
}

/**
 * The PORTAL §5.6 sections, rendered from a `WorkProfile`. Each section renders
 * ONLY when it has content — optional sections (writing/talks) and any section
 * the agent left unsourced both omit cleanly rather than showing an empty
 * heading (no invented data — the §24.24 honesty rule + the §24.71/PORTAL §12
 * placeholder-degradation contract: a partial profile still reads finished).
 */
export function WorkSections({ profile }: { profile: WorkProfile }) {
  const hasLinks = Boolean(profile.links.github || profile.links.linkedin || profile.links.x || profile.links.blog)
  return (
    <div className="flex w-full flex-col gap-10">
      {profile.bio.length > 0 ? (
        <Section title="About">
          {profile.bio.map((p, i) => (
            <p key={i} className="mt-3 text-base leading-relaxed text-foreground/90 first:mt-0">
              {p}
            </p>
          ))}
        </Section>
      ) : null}

      {profile.lookingFor.length > 0 ? (
        <Section title="What I'm looking for">
          <ul className="flex flex-col gap-2">
            {profile.lookingFor.map((item) => (
              <li key={item} className="text-base text-foreground/90">
                {item}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {profile.experience.length > 0 ? (
        <Section title="Experience">
          <div className="flex flex-col gap-4">
            {profile.experience.map((job) => (
              <Card key={`${job.company}-${job.role}`}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {job.role} · {job.company}
                  </CardTitle>
                  <p className="font-mono text-xs text-muted-foreground">{job.period}</p>
                </CardHeader>
                <CardContent>
                  <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-foreground/90">
                    {job.bullets.map((b) => (
                      <li key={b}>{b}</li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            ))}
          </div>
        </Section>
      ) : null}

      {profile.projects.length > 0 ? (
        <Section title="Projects">
          <div className="grid gap-4 sm:grid-cols-2">
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
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p className="text-sm text-foreground/90">{proj.description}</p>
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
        </Section>
      ) : null}

      {profile.writing && profile.writing.length > 0 ? (
        <Section title="Writing & talks">
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
        </Section>
      ) : null}

      {profile.skillGroups && profile.skillGroups.length > 0 ? (
        <Section title="Skills">
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
        </Section>
      ) : profile.skills.length > 0 ? (
        <Section title="Skills">
          <div className="flex flex-wrap gap-2">
            {profile.skills.map((s) => (
              <Badge key={s} variant="outline">
                {s}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}

      {profile.education.length > 0 ? (
        <Section title="Education">
          <ul className="flex flex-col gap-1.5 text-base text-foreground/90">
            {profile.education.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </Section>
      ) : null}

      {hasLinks ? (
        <Section title="Elsewhere">
          <div className="flex flex-wrap gap-x-4 gap-y-2 text-base">
            {profile.links.github ? (
              <a href={profile.links.github} className="text-primary hover:underline">
                GitHub
              </a>
            ) : null}
            {profile.links.linkedin ? (
              <a href={profile.links.linkedin} className="text-primary hover:underline">
                LinkedIn
              </a>
            ) : null}
            {profile.links.x ? (
              <a href={profile.links.x} className="text-primary hover:underline">
                X
              </a>
            ) : null}
            {profile.links.blog ? (
              <a href={profile.links.blog} className="text-primary hover:underline">
                Blog
              </a>
            ) : null}
          </div>
        </Section>
      ) : null}
    </div>
  )
}
