import { Link } from '@tanstack/react-router'
import { Globe } from 'lucide-react'
import type { ComponentType } from 'react'

import { GitHubIcon, LinkedInIcon, XIcon } from '~/components/brand-icons'
import type { Identity } from '~/lib/profile-loader'
import { PERSON_NAME } from '~/lib/site'

type IconComponent = ComponentType<{ className?: string }>

export interface FooterSocial {
  label: string
  href: string
  Icon: IconComponent
}

/**
 * Pure: the candidate's identity → the ordered social links the footer renders,
 * one per non-null field (omit-when-null — the identity SSR principle; a fork with
 * no X account simply shows no X link). Email is deliberately excluded — `/contact`
 * and the rail's "Talk to me" own that path, and a footer `mailto:` invites
 * scraping. Exported so the omit-when-null mapping is unit-testable without a
 * router context (the rendering is covered by the E2E).
 */
export function footerSocials(identity: Identity): FooterSocial[] {
  const out: FooterSocial[] = []
  if (identity.github) out.push({ label: 'GitHub', href: identity.github, Icon: GitHubIcon })
  if (identity.linkedin) out.push({ label: 'LinkedIn', href: identity.linkedin, Icon: LinkedInIcon })
  if (identity.x) out.push({ label: 'X', href: identity.x, Icon: XIcon })
  if (identity.website) out.push({ label: 'Website', href: identity.website, Icon: Globe })
  return out
}

/**
 * The sitewide footer (PORTAL §8.2 / STRATEGY §24.76): a single slim, muted
 * social/legal strip below the §8.4 connective rail, on every page (both register
 * layouts host it). Carries the persona wordmark + a static "built with" credit,
 * the candidate's socials as themed `fill-current` brand icons (SSR'd identity,
 * omit-when-null), and the two background doorways — "About" (`/about`, the second
 * framed entrance after the home beat) and "Privacy" (`/about#privacy`, the
 * visitor-privacy disclosure; no standalone `/privacy` page). The `register` prop
 * matches the rail's per-layout width so the footer aligns with the band above it.
 */
export function SiteFooter({ identity, register }: { identity: Identity; register: 'marketing' | 'ops' }) {
  const socials = footerSocials(identity)
  const ops = register === 'ops'

  return (
    <footer
      data-testid="site-footer"
      className={[
        'mx-auto flex w-full flex-col gap-4 border-t border-border px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
        ops ? 'max-w-6xl font-mono' : 'max-w-3xl',
      ].join(' ')}
    >
      <div className="flex flex-col gap-1">
        <span className="font-mono text-sm font-semibold text-foreground">{PERSON_NAME}</span>
        <span>Built with NanoClaw · Claude · TanStack Start</span>
      </div>

      <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {socials.map((s) => (
          <a
            key={s.label}
            href={s.href}
            target="_blank"
            rel="noreferrer"
            aria-label={s.label}
            data-testid={`footer-social-${s.label.toLowerCase()}`}
            className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <s.Icon className="h-[18px] w-[18px]" />
          </a>
        ))}
        {socials.length > 0 ? <span aria-hidden="true" className="hidden h-3 w-px bg-border sm:block" /> : null}
        <Link to="/about" data-testid="footer-about" className="transition-colors hover:text-foreground">
          About
        </Link>
        <Link
          to="/about"
          hash="privacy"
          data-testid="footer-privacy"
          className="transition-colors hover:text-foreground"
        >
          Privacy
        </Link>
      </nav>
    </footer>
  )
}
