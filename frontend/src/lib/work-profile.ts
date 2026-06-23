/**
 * The `/work` read-model shape (PORTAL §5.6) + a placeholder export.
 *
 * 6.2 ships `/work` as a SHELL rendered against this typed placeholder: the real
 * content lives in the private `candidate_profile` (PORTAL §5.8), which isn't
 * populated yet, so the live `GET /api/profile` projection is deferred. The
 * durable artifact here is the SHAPE — a future `/api/profile` returns this
 * verbatim and the page becomes data-driven with no component change.
 *
 * Content is a generic persona (Jane Doe), flavored toward real interests
 * (senior SWE · AI Systems · DevX) so the page reads finished — no real personal
 * details are committed to this public repo.
 */

/** A résumé bullet (§24.161). `group` ties bullets that stay together and in
 *  authored order; the tailoring snap treats a group atomically. Singletons omit it. */
export interface BulletItem {
  text: string
  group?: string
}

export interface ExperienceEntry {
  role: string
  company: string
  period: string
  bullets: BulletItem[]
  /** Optional company one-liner (scale + credential preface), §24.157. */
  descriptor?: string
  /** Optional prior-title progression line, e.g. "SE II (2020–24) · SE I (2019–20)" (§24.157). */
  titles?: string
}

export interface ProjectEntry {
  name: string
  description: string
  href?: string
  /** Optional source-repository link, shown beside the live `href` (§24.157). */
  repo?: string
  /** Optional detail bullets under the description (§24.157). */
  bullets?: string[]
  tags?: string[]
}

export interface WritingEntry {
  title: string
  venue?: string
  href?: string
}

export interface SocialLinks {
  github?: string
  linkedin?: string
  x?: string
  blog?: string
}

/** A labelled skill cluster — grouped skills render in preference to the flat list. */
export interface SkillGroup {
  category: string
  items: string[]
}

export interface WorkProfile {
  name: string
  title: string
  /** Optional focus areas (§24.158): the home hero shows `title` alone; `/experience`
   *  + the résumé PDF show `title · focus`. */
  focus?: string
  /** Bio paragraphs (PORTAL §5.6 §1). */
  bio: string[]
  /** "What I'm looking for" (PORTAL §5.6 §2): target roles / comp / location. */
  lookingFor: string[]
  /** Experience (PORTAL §5.6 §3): role / company / dates / bullets. */
  experience: ExperienceEntry[]
  /** Featured projects (PORTAL §5.6 §4) — this portal is one of them. */
  projects: ProjectEntry[]
  /** Optional writing / talks (PORTAL §5.6 §5) — renders only when present. */
  writing?: WritingEntry[]
  /** Curated skills tag-cloud (PORTAL §5.6 §6), not exhaustive. When `skillGroups`
   *  is present this is its de-duped union (kept consistent by the projector). */
  skills: string[]
  /** Optional grouped view of the skills, rendered in preference to `skills`. */
  skillGroups?: SkillGroup[]
  /** Education / certs (PORTAL §5.6 §7), brief. */
  education: string[]
  /** Where else to find me (PORTAL §5.6 §8). */
  links: SocialLinks
}

/** Generic placeholder profile — see file header. Replaced by `/api/profile` later. */
export const workProfile: WorkProfile = {
  name: 'Jane Doe',
  title: 'Senior Software Engineer · AI Systems, DevX',
  bio: [
    'I build the systems that let small teams move like big ones — internal developer tooling, agentic workflows, and the unglamorous platform glue that makes the shiny stuff reliable. Most of my favorite work lives one layer below the product, where a good abstraction quietly saves everyone hours.',
    'Lately that means putting LLMs to work as collaborators rather than features: agents that do real work on a schedule, with the guardrails, observability, and human-in-the-loop controls that make them trustworthy in production. This site is one of those systems, running live.',
  ],
  lookingFor: [
    'Senior / Staff / Lead — AI Systems or Developer Experience',
    'Remote-first (US) or hybrid',
    'Teams investing in internal tooling, platform, and agentic workflows',
  ],
  experience: [
    {
      role: 'Senior Software Engineer',
      company: 'Example Labs',
      period: '2022 — Present',
      bullets: [
        {
          text: 'Designed and shipped an internal agent platform that automates routine engineering toil, adopted across multiple teams.',
        },
        {
          text: 'Built the observability + approval layer that made LLM-driven automation safe to run unattended in production.',
        },
        {
          text: 'Mentored engineers on developer-experience patterns: typed contracts, fast local feedback loops, and ruthless removal of magic numbers.',
        },
      ],
    },
    {
      role: 'Software Engineer',
      company: 'Generic Co',
      period: '2019 — 2022',
      bullets: [
        { text: 'Owned a TypeScript/Node services layer from prototype to production scale.' },
        { text: 'Cut CI feedback time substantially by reworking the test harness and build pipeline.' },
        { text: 'Introduced an edge-deployed frontend that improved time-to-interactive for global users.' },
      ],
    },
  ],
  projects: [
    {
      name: 'career-pilot (this portal)',
      description:
        'An autonomous agent system running a real job search — researching companies, tailoring applications, and surfacing its own work live. You are looking at it right now.',
      href: 'https://github.com/janedoe/career-pilot',
      tags: ['Agents', 'AI Systems', 'DevX'],
    },
    {
      name: 'devx-toolkit',
      description:
        'A small collection of developer-experience utilities: typed config loaders, fast fixtures, and a local-first test harness.',
      href: 'https://github.com/janedoe/devx-toolkit',
      tags: ['Developer Experience', 'TypeScript'],
    },
  ],
  writing: [
    {
      title: 'Agents that do real work: guardrails before gloss',
      venue: 'janedoe — blog',
      href: 'https://example.com/blog/agents-real-work',
    },
    {
      title: 'Developer experience is a feature, not a chore',
      venue: 'janedoe — blog',
      href: 'https://example.com/blog/devx-is-a-feature',
    },
  ],
  skills: [
    'TypeScript',
    'Node.js',
    'React',
    'LLM orchestration',
    'Claude Agent SDK',
    'Agentic workflows',
    'Cloudflare Workers',
    'SQLite',
    'Playwright',
    'Developer tooling',
    'Observability',
    'CI/CD',
  ],
  skillGroups: [
    { category: 'Languages & Runtime', items: ['TypeScript', 'Node.js', 'React'] },
    { category: 'AI & Agents', items: ['LLM orchestration', 'Claude Agent SDK', 'Agentic workflows'] },
    { category: 'Platform & Infra', items: ['Cloudflare Workers', 'SQLite', 'CI/CD', 'Observability'] },
    { category: 'Tooling & Testing', items: ['Developer tooling', 'Playwright'] },
  ],
  education: ['B.S. Computer Science — Example University'],
  links: {
    github: 'https://github.com/janedoe',
    linkedin: 'https://www.linkedin.com/in/janedoe',
    x: 'https://x.com/janedoe',
    blog: 'https://example.com/blog',
  },
}
