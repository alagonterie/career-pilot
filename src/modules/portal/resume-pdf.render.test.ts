/**
 * Structural guarantees for the rendered résumé PDF (STRATEGY §24.72 — the
 * résumé-quality rework). Instead of "how does it look?", we INSPECT the rendered
 * PDF with pdfjs: page count, the text layer (+ positions), and link annotations.
 * Each identified bug is a red assertion here first, then fixed to green:
 *   - a realistic full master résumé fits within two pages (§24.157; page-balance + no orphans)
 *   - contact details are real clickable Link annotations, not plain text
 *   - the footer renders the real glyph (no Helvetica ◇→Ç mojibake)
 *   - the title sits clearly below the name (no overlap)
 *   - grouped skills render with their category labels
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import type { Identity, WorkProfile } from './profile.js';
import { masterFooter, renderResumePdf, tailoredFooter } from './resume-pdf.js';

/** Wrap plain bullet strings into the §24.161 `BulletItem[]` fixture shape. */
const b = (...texts: string[]) => texts.map((text) => ({ text }));

// A realistic, dense master profile (generic identity — no real PII) sized like a
// strong senior résumé: a long summary, two roles with 8 bullets total, a project,
// ~25 grouped skills, education. The two-page budget is meaningful at this size.
const FULL_MASTER: WorkProfile = {
  name: 'Jordan Rivera',
  title: 'Senior Software Engineer · Team Lead',
  bio: [
    'Senior software engineer and team lead with seven years building reliable, high-performance backend systems. I architect next-generation platforms and the developer tooling that makes a whole team faster.',
    'My favorite work lives at the systems layer: CQRS and event sourcing over a live legacy database, architecture enforced at compile time, in-memory engines measured in nanoseconds, and agentic developer tools.',
  ],
  lookingFor: [
    'Senior / Staff / Lead — backend, distributed systems, or developer platform',
    'Remote-first (US) or Denver hybrid',
    'Teams that value performance engineering and AI-native tooling',
  ],
  experience: [
    {
      role: 'Senior Software Engineer & Team Lead',
      company: 'Vertex Systems',
      period: 'Sept 2019 — Present',
      bullets: b(
        'Promoted from Software Engineer I to Senior & Team Lead over seven years; lead a 7-person scrum team while remaining its senior IC, owning the modernization workstream.',
        'Architected the .NET successor backend: CQRS with hybrid event sourcing over the live legacy database, single-round-trip transactional commits, and Roslyn source generators enforcing the architecture at compile time.',
        'Built a Rust in-memory authorization engine (gRPC, Roaring Bitmaps) replacing per-request SQL — 137ns point checks, 850×–22,000× faster, under 1GB of memory, with zero-downtime reloads and 600+ tests.',
        'Built the delivery platform: GitLab CI and AWS CDK with ephemeral per-feature-branch environments and integration suites against real SQL Server with millisecond data resets.',
        'Created the AI-native developer tooling suite, unprompted: four CLI + MCP tools on a shared core with an umbrella installer, plus a Claude Code plugin marketplace.',
        'As API Product Warden owned all code review, conventions, and architecture; rebuilt database versioning for multitenancy, deleting 20k+ redundant lines and improving every request ~10%.',
      ),
    },
    {
      role: 'Software Engineer',
      company: 'Northwind Labs',
      period: '2017 — 2019',
      bullets: b(
        'Owned a TypeScript/Node services layer from prototype to production scale.',
        'Cut CI feedback time substantially by reworking the test harness and build pipeline.',
      ),
    },
  ],
  projects: [
    {
      name: 'career-pilot (this portal)',
      description:
        'An autonomous agent system running my real job search — researching companies, tailoring applications, and surfacing its own work live.',
      href: 'https://github.com/example/career-pilot',
      tags: ['Agents', 'AI Systems', 'TypeScript'],
    },
  ],
  skills: [],
  skillGroups: [
    {
      category: 'Languages',
      items: ['C# (.NET 10)', 'Rust', 'TypeScript', 'Python', 'SQL / T-SQL', 'PowerShell / Bash'],
    },
    {
      category: 'Backend & Data',
      items: [
        'CQRS',
        'Event sourcing',
        'DDD',
        'gRPC / protobuf',
        'REST / OpenAPI',
        'Multi-tenant SaaS',
        'Redis',
        'SQL Server',
      ],
    },
    {
      category: 'Performance & Tooling',
      items: [
        'Performance engineering',
        'Roslyn source generators',
        'MCP servers',
        'Agentic workflows',
        'AI-native tooling',
      ],
    },
    {
      category: 'Platform & Ops',
      items: ['AWS (ECS, CDK)', 'Docker', 'GitLab CI/CD', 'OpenTelemetry', 'Dynatrace', 'Testcontainers'],
    },
  ],
  education: ['B.S. Computer Science — Example State University'],
  links: { github: 'https://github.com/example', linkedin: 'https://www.linkedin.com/in/example' },
};

const FULL_IDENTITY: Identity = {
  email: 'jordan.rivera@example.com',
  github: 'https://github.com/example',
  linkedin: 'https://www.linkedin.com/in/example',
  x: null,
  website: 'https://jordanrivera.example.com',
};

interface PdfInspection {
  pageCount: number;
  text: string;
  items: { str: string; x: number; y: number; page: number }[];
  links: string[];
}

/** Render → introspect: page count, text layer with positions, Link annotations. */
async function inspectPdf(buf: Buffer): Promise<PdfInspection> {
  const doc = await getDocument({ data: new Uint8Array(buf) }).promise;
  const items: PdfInspection['items'] = [];
  const links: string[] = [];
  let text = '';
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    for (const it of content.items as Array<{ str?: string; transform?: number[] }>) {
      if (typeof it.str === 'string' && it.str.length > 0) {
        text += it.str + ' ';
        if (it.transform) items.push({ str: it.str, x: it.transform[4], y: it.transform[5], page: p });
      }
    }
    const annots = (await page.getAnnotations()) as Array<{ subtype?: string; url?: string }>;
    for (const a of annots) if (a.subtype === 'Link' && a.url) links.push(a.url);
  }
  return { pageCount: doc.numPages, text, items, links };
}

describe('rendered résumé — structural guarantees', () => {
  it('a realistic full master résumé fits within two pages (§24.157 two-pages-max — no overflow)', async () => {
    const pdf = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    expect(pdf.pageCount).toBeGreaterThanOrEqual(1);
    expect(pdf.pageCount).toBeLessThanOrEqual(2);
  });

  it('contact details are real clickable Link annotations, not plain text', async () => {
    const { links } = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    expect(links).toContain('mailto:jordan.rivera@example.com');
    expect(links.some((u) => u.includes('github.com/example'))).toBe(true);
    expect(links.some((u) => u.includes('linkedin.com/in/example'))).toBe(true);
  });

  it('renders the footer glyph correctly (no Helvetica ◇→Ç mojibake)', async () => {
    const { text } = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    expect(text).toContain('Composed by my AI agent system');
    expect(text).not.toContain('Ç');
  });

  it('places the title clearly below the name (no overlap)', async () => {
    const { items } = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    const name = items.find((i) => i.str.includes('Jordan'));
    const title = items.find((i) => i.str.includes('Team Lead'));
    expect(name).toBeDefined();
    expect(title).toBeDefined();
    // PDF y grows upward: the name (top) has a higher y than the title below it,
    // and the gap must clear the name's cap-height so the two never collide.
    expect(name!.y - title!.y).toBeGreaterThan(14);
  });

  it('makes the footer host a clickable link when a public URL is configured', async () => {
    const url = 'https://hire.example.com';
    const { links } = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter(url), url));
    expect(links.some((u) => u.includes('hire.example.com'))).toBe(true);
  });

  it('routes the footer host link through the attribution token when footerLinkUrl is set (§24.74)', async () => {
    const url = 'https://hire.example.com';
    const footerLinkUrl = 'https://hire.example.com/r/Xk9f2Abc';
    const { links } = await inspectPdf(
      await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter(url), url, { footerLinkUrl }),
    );
    // The clickable link target is the tokenized URL; the displayed host stays bare.
    expect(links).toContain(footerLinkUrl);
    expect(links).not.toContain(url);
  });

  it('routes self-referential links (project href + website on the portal host) through the §24.74 token', async () => {
    const url = 'https://hire.example.com';
    const footerLinkUrl = 'https://hire.example.com/r/SelfTok9';
    const profile: WorkProfile = {
      ...FULL_MASTER,
      projects: [
        {
          name: 'portal',
          description: 'this site',
          href: 'https://hire.example.com',
          repo: 'https://github.com/example/portal',
        },
      ],
    };
    const identity: Identity = { ...FULL_IDENTITY, website: 'https://hire.example.com/' };
    const { links } = await inspectPdf(
      await renderResumePdf(profile, identity, masterFooter(url), url, { footerLinkUrl }),
    );
    // Footer host + the project href + the website all share the portal host → all tokenized.
    expect(links.filter((u) => u === footerLinkUrl).length).toBeGreaterThanOrEqual(2);
    expect(links).not.toContain('https://hire.example.com'); // no bare self-host target survives
    // An external link (the repo) passes through untouched.
    expect(links.some((u) => u.includes('github.com/example/portal'))).toBe(true);
  });

  it('renders grouped skills with their category labels', async () => {
    const { text } = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    expect(text).toContain('Languages');
    expect(text).toContain('Backend & Data');
  });

  // §24.106: the Projects-before-Experience layout hint. PDF y grows upward, so a
  // higher-on-page section has the LARGER y. We compare distinctive section
  // content (an experience company vs a project name) rather than the headings,
  // which carry letterSpacing and could split in the text layer.
  it('orders Experience above Projects by default, and flips when projectsFirst is set', async () => {
    const yOf = (items: PdfInspection['items'], sub: string): number | null =>
      items.find((i) => i.str.includes(sub))?.y ?? null;

    const def = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    const expY = yOf(def.items, 'Vertex Systems');
    const projY = yOf(def.items, 'career-pilot');
    expect(expY).not.toBeNull();
    expect(projY).not.toBeNull();
    expect(expY!).toBeGreaterThan(projY!); // Experience sits above Projects

    const flipped = await inspectPdf(
      await renderResumePdf({ ...FULL_MASTER, projectsFirst: true }, FULL_IDENTITY, masterFooter('')),
    );
    const expY2 = yOf(flipped.items, 'Vertex Systems');
    const projY2 = yOf(flipped.items, 'career-pilot');
    expect(projY2!).toBeGreaterThan(expY2!); // Projects now sits above Experience
  });

  // §24.157 retired the one-page rule (two pages max); compact stays a *density*
  // option the tailored caller passes (`{ compact: true }`), so it must never use
  // MORE pages than the master density — a denser variant of the same content.
  it('compact mode is never looser than the master density', async () => {
    const DENSE: WorkProfile = {
      ...FULL_MASTER,
      bio: [
        ...FULL_MASTER.bio,
        'A third summary paragraph that pushes the document just past a single page at the normal density, so the compact path has something real to reclaim and the one-page guarantee is meaningful.',
      ],
      experience: [
        ...FULL_MASTER.experience,
        {
          role: 'Software Engineer',
          company: 'Initech',
          period: '2015 — 2017',
          bullets: b(
            'Built and operated a high-throughput billing pipeline processing millions of records nightly.',
            'Owned the migration from a monolith to a set of well-bounded services with clear contracts.',
            'Cut the integration test suite runtime by reworking fixtures and parallelizing the run.',
          ),
        },
      ],
    };
    const atNormal = await inspectPdf(await renderResumePdf(DENSE, FULL_IDENTITY, masterFooter('')));
    const atCompact = await inspectPdf(
      await renderResumePdf(DENSE, FULL_IDENTITY, masterFooter(''), '', { compact: true }),
    );
    expect(atNormal.pageCount).toBeGreaterThanOrEqual(2); // a dense résumé spans 2+ at master density
    expect(atCompact.pageCount).toBeLessThanOrEqual(atNormal.pageCount); // compact reclaims, never adds
  });
});

/**
 * §24.194 — a section heading must never render with nothing beneath it.
 *
 * Reported on a résumé generated for a live application: "FEATURED PROJECT" sat
 * alone at the bottom of page 1 with the project itself overleaf. Cause was the
 * project row being one `wrap: false` block — harmless while a project was a name
 * plus a one-line blurb, but §24.193 restored the master's description AND detail
 * bullets, and an unbreakable ~8-line block that doesn't fit the page remainder
 * jumps wholesale, stranding the heading above a blank half-page.
 *
 * The configurations below are not invented: they were found by sweeping bullet
 * counts against a single-line shifter that walks the page break one line at a
 * time, and each one orphans a heading when the fix is reverted (a 460-layout
 * sweep goes from 48 orphaned headings to 0).
 */
describe('section headings are never orphaned (§24.194)', () => {
  const HEADINGS = ['SUMMARY', "WHATI'MLOOKINGFOR", 'EXPERIENCE', 'FEATUREDPROJECT', 'PROJECTS', 'SKILLS', 'EDUCATION'];
  const squash = (s: string): string => s.replace(/\s+/g, '').toUpperCase();

  const LONG_BULLET =
    'Architected the successor backend: CQRS with hybrid event sourcing over the live legacy database, single-round-trip transactional commits, and source generators enforcing the architecture at compile time.';

  function fixture(nBullets: number, shift: number, nProjects: number): WorkProfile {
    const project = (i: number) => ({
      name: i === 0 ? 'career-pilot' : `side-project-${i}`,
      description:
        'An autonomous multi-agent AI system that runs a real software-engineering job search end to end, with a public showcase portal. Built solo.',
      href: 'https://example.com',
      // Verbatim from the sweep that found these cases — shortening them changes
      // the line count and the configurations stop straddling a page break.
      bullets: [
        'An orchestrator agent coordinates six specialized subagents (company research, résumé tailoring, outreach, interview-kit generation, job sourcing and pipeline tracking) over an agent SDK, each in an isolated, budget-capped container with host-side approval gating.',
        'Full-stack and production-grade: SSR on edge workers with a same-origin BFF proxying JSON + SSE to a zero-ingress tunnel; a cloud backend; Terraform-managed DNS/WAF; an anonymization layer for the public pipeline view.',
        'All model traffic (agents and host) is routed and observed through a multi-model gateway with prompt caching and per-request telemetry.',
        'Built spec-first — every change traces to a written spec — and held to a layered test suite: unit, integration, and end-to-end with visual-regression snapshots.',
      ],
    });
    return {
      name: 'Jordan Rivera',
      title: 'Senior Software Engineer · Team Lead',
      bio: ['Senior engineer and team lead with seven years building reliable, high-performance backend systems.'],
      lookingFor: [
        'Senior / Staff / Lead — backend, distributed systems, or developer platform',
        ...Array.from({ length: shift }, (_, i) => `Additional preference line number ${i + 1}`),
      ],
      links: {},
      experience: [
        {
          role: 'Senior Software Engineer & Team Lead',
          company: 'Vertex Systems',
          period: 'Sept 2019 — Present',
          bullets: b(...Array.from({ length: nBullets }, () => LONG_BULLET)),
        },
      ],
      projects: Array.from({ length: nProjects }, (_, i) => project(i)),
      skills: ['TypeScript', 'Go', 'Rust'],
      education: ['BS, Computer Science, Example University'],
    };
  }

  /** Orphaned = nothing but the fixed footer follows the heading on its page. */
  function orphaned(items: PdfInspection['items']): string[] {
    const bad: string[] = [];
    items.forEach((it, i) => {
      if (!HEADINGS.includes(squash(it.str))) return;
      const after = items.slice(i + 1).filter((n) => n.page === it.page && !n.str.startsWith('Auto-tailored'));
      if (after.length === 0) bad.push(squash(it.str));
    });
    return bad;
  }

  // [bullets, shift, projects] — each orphans a heading with the §24.194 fix reverted.
  // Found by sweeping 650 layouts with the fix reverted (74 reproduced). Each
  // orphans the named heading without §24.194; all pass with it.
  const CASES: [number, number, number][] = [
    [9, 18, 1], // EDUCATION
    [11, 18, 1], // SKILLS
    [12, 0, 1], // EDUCATION
    [6, 0, 2], // EDUCATION
    [8, 0, 2], // SKILLS
    [5, 20, 2], // SKILLS
  ];

  it.each(CASES)('keeps every heading with its content (bullets=%i shift=%i projects=%i)', async (nb, shift, np) => {
    const buf = await renderResumePdf(
      fixture(nb, shift, np),
      FULL_IDENTITY,
      tailoredFooter('Stripe', 'Backend Engineer', '2026-08-07', ''),
      '',
      { compact: true },
    );
    const { items, pageCount } = await inspectPdf(buf);
    expect(pageCount).toBeGreaterThan(1); // the case must actually span a break to be meaningful
    expect(orphaned(items)).toEqual([]);
  });
});

/**
 * §24.194, second failure mode. The orphan check above catches a heading left
 * ALONE, but not the bug actually reported: a project emitted as one `wrap: false`
 * block is too tall for the page remainder and jumps WHOLESALE, taking the heading
 * with it (once the heading is atomic with its lead) and leaving a third of a page
 * blank. No heading is orphaned in that layout, so only a fill measurement sees it.
 *
 * Measured across 650 layouts: worst bottom gap is 71pt with the entry flowing,
 * 211pt with it unbreakable. 120pt sits cleanly between.
 */
describe('a page never breaks early leaving a large blank (§24.194)', () => {
  const MAX_BOTTOM_GAP_PT = 120;

  it('fills each page before breaking, with the project entry flowing', async () => {
    // nb=13 shift=12 — the worst offender found when the entry is unbreakable.
    const profile: WorkProfile = {
      name: 'Jordan Rivera',
      title: 'Senior Software Engineer · Team Lead',
      bio: ['Senior engineer and team lead with seven years building reliable, high-performance backend systems.'],
      lookingFor: [
        'Senior / Staff / Lead — backend, distributed systems, or developer platform',
        ...Array.from({ length: 12 }, (_, i) => `Additional preference line number ${i + 1}`),
      ],
      links: {},
      experience: [
        {
          role: 'Senior Software Engineer & Team Lead',
          company: 'Vertex Systems',
          period: 'Sept 2019 — Present',
          bullets: b(
            ...Array.from(
              { length: 13 },
              () =>
                'Architected the successor backend: CQRS with hybrid event sourcing over the live legacy database, single-round-trip transactional commits, and source generators enforcing the architecture at compile time.',
            ),
          ),
        },
      ],
      projects: [
        {
          name: 'career-pilot',
          description:
            'An autonomous multi-agent AI system that runs a real software-engineering job search end to end, with a public showcase portal. Built solo.',
          href: 'https://example.com',
          bullets: [
            'An orchestrator agent coordinates six specialized subagents (company research, résumé tailoring, outreach, interview-kit generation, job sourcing and pipeline tracking) over an agent SDK, each in an isolated, budget-capped container with host-side approval gating.',
            'Full-stack and production-grade: SSR on edge workers with a same-origin BFF proxying JSON + SSE to a zero-ingress tunnel; a cloud backend; Terraform-managed DNS/WAF; an anonymization layer for the public pipeline view.',
            'All model traffic (agents and host) is routed and observed through a multi-model gateway with prompt caching and per-request telemetry.',
            'Built spec-first — every change traces to a written spec — and held to a layered test suite: unit, integration, and end-to-end with visual-regression snapshots.',
          ],
        },
      ],
      skills: ['TypeScript', 'Go', 'Rust'],
      education: ['BS, Computer Science, Example University'],
    };
    const { items, pageCount } = await inspectPdf(
      await renderResumePdf(
        profile,
        FULL_IDENTITY,
        tailoredFooter('Stripe', 'Backend Engineer', '2026-08-07', ''),
        '',
        { compact: true },
      ),
    );
    expect(pageCount).toBeGreaterThan(1);
    for (let p = 1; p < pageCount; p++) {
      const ys = items.filter((i) => i.page === p && !i.str.startsWith('Auto-tailored')).map((i) => i.y);
      expect(ys.length).toBeGreaterThan(0);
      // PDF origin is bottom-left, so the smallest y is the lowest content.
      expect(Math.min(...ys), `page ${p} breaks early leaving a blank gap`).toBeLessThan(MAX_BOTTOM_GAP_PT);
    }
  });
});
