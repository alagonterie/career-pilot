import { Link, useRouterState } from '@tanstack/react-router'
import { Globe } from 'lucide-react'
import type { ComponentType } from 'react'

import { GitHubIcon, LinkedInIcon, XIcon } from '~/components/brand-icons'
import type { Identity } from '~/lib/profile-loader'
import { appVersion, CHROME_WIDTH, isMonoSurface, PERSON_NAME } from '~/lib/site'
import { cn } from '~/lib/utils'

type IconComponent = ComponentType<{ className?: string }>

export interface FooterSocial {
  label: string
  href: string
  Icon: IconComponent
}

/**
 * The "Built with" credit line (PORTAL §8.2 / STRATEGY §24.103): the headline
 * stack, each name a link a recruiter can follow. Static (no live data) — order
 * is the credit order. Claude points at the product home (recruiter-facing); a
 * one-line `href` swap retargets it (e.g. the Agent SDK docs) if preferred.
 */
export const FOOTER_CREDITS: { label: string; href: string }[] = [
  { label: 'NanoClaw', href: 'https://github.com/nanocoai/nanoclaw' },
  { label: 'Claude', href: 'https://claude.com' },
  { label: 'TanStack Start', href: 'https://tanstack.com/start' },
]

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
 * framed entrance after the home beat) and "Privacy" (`/privacy`, the formal policy
 * the OAuth consent screen points to — §24.148; it links on to the in-context
 * /about#privacy narrative). Full-bleed top border
 * (page chrome) with the content in the shared chrome gutter (`CHROME_WIDTH px-6`), so
 * the foot frames every page on the same column as the top nav — identical on every
 * page, no resize on nav. Only the mono surfaces (/dashboard, /architecture) wear the
 * terminal `font-mono`; read from the committed path so it doesn't flip ahead of a nav.
 */
export function SiteFooter({ identity }: { identity: Identity }) {
  const socials = footerSocials(identity)
  const pathname = useRouterState({
    select: (s) => s.resolvedLocation?.pathname ?? s.location.pathname,
  })
  const mono = isMonoSurface(pathname)
  // The §24.139 product version chip — the sanctioned narrow return of the
  // retired §8.2 deploy SHA (the version token ONLY, not the metadata block).
  const version = appVersion()

  return (
    <footer data-testid="site-footer" className={cn('w-full border-t border-border', mono && 'font-mono')}>
      <div
        className={cn(
          'mx-auto flex flex-col gap-4 px-6 py-6 text-xs text-muted-foreground sm:flex-row sm:items-center sm:justify-between',
          CHROME_WIDTH,
        )}
      >
        <div className="flex flex-col gap-1">
          <span className="font-mono text-sm font-semibold text-foreground">{PERSON_NAME}</span>
          <span>
            {'Built with '}
            {FOOTER_CREDITS.flatMap((c, i) => [
              ...(i > 0 ? [' · '] : []),
              <a
                key={c.label}
                href={c.href}
                target="_blank"
                rel="noreferrer"
                data-testid={`footer-credit-${c.label.split(' ')[0].toLowerCase()}`}
                className="transition-colors hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {c.label}
              </a>,
            ])}
          </span>
          {/* The product version (byte-stable `dev` under the @visual seed). A
              link to the release tag (prod) / commit (dev); plain text when
              unset. Carries only the version — not the retired §24.35 metadata. */}
          {version.href ? (
            <a
              href={version.href}
              target="_blank"
              rel="noreferrer"
              data-testid="footer-version"
              className="font-mono text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {version.label}
            </a>
          ) : (
            <span data-testid="footer-version" className="font-mono text-[11px] text-muted-foreground/70">
              {version.label}
            </span>
          )}
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
          <Link to="/privacy" data-testid="footer-privacy" className="transition-colors hover:text-foreground">
            Privacy
          </Link>
        </nav>
      </div>
    </footer>
  )
}
