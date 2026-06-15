/**
 * Structural guarantees for the rendered résumé PDF (STRATEGY §24.72 — the
 * résumé-quality rework). Instead of "how does it look?", we INSPECT the rendered
 * PDF with pdfjs: page count, the text layer (+ positions), and link annotations.
 * Each identified bug is a red assertion here first, then fixed to green:
 *   - a realistic full master résumé fits on ONE page (page-balance + no orphans)
 *   - contact details are real clickable Link annotations, not plain text
 *   - the footer renders the real glyph (no Helvetica ◇→Ç mojibake)
 *   - the title sits clearly below the name (no overlap)
 *   - grouped skills render with their category labels
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import type { Identity, WorkProfile } from './profile.js';
import { masterFooter, renderResumePdf } from './resume-pdf.js';

// A realistic, dense master profile (generic identity — no real PII) sized like a
// strong senior résumé: a long summary, two roles with 8 bullets total, a project,
// ~25 grouped skills, education. The one-page guarantee is meaningful at this size.
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
      bullets: [
        'Promoted from Software Engineer I to Senior & Team Lead over seven years; lead a 7-person scrum team while remaining its senior IC, owning the modernization workstream.',
        'Architected the .NET successor backend: CQRS with hybrid event sourcing over the live legacy database, single-round-trip transactional commits, and Roslyn source generators enforcing the architecture at compile time.',
        'Built a Rust in-memory authorization engine (gRPC, Roaring Bitmaps) replacing per-request SQL — 137ns point checks, 850×–22,000× faster, under 1GB of memory, with zero-downtime reloads and 600+ tests.',
        'Built the delivery platform: GitLab CI and AWS CDK with ephemeral per-feature-branch environments and integration suites against real SQL Server with millisecond data resets.',
        'Created the AI-native developer tooling suite, unprompted: four CLI + MCP tools on a shared core with an umbrella installer, plus a Claude Code plugin marketplace.',
        'As API Product Warden owned all code review, conventions, and architecture; rebuilt database versioning for multitenancy, deleting 20k+ redundant lines and improving every request ~10%.',
      ],
    },
    {
      role: 'Software Engineer',
      company: 'Northwind Labs',
      period: '2017 — 2019',
      bullets: [
        'Owned a TypeScript/Node services layer from prototype to production scale.',
        'Cut CI feedback time substantially by reworking the test harness and build pipeline.',
      ],
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
  it('a realistic full master résumé fits on ONE page', async () => {
    const pdf = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    expect(pdf.pageCount).toBe(1);
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

  it('renders grouped skills with their category labels', async () => {
    const { text } = await inspectPdf(await renderResumePdf(FULL_MASTER, FULL_IDENTITY, masterFooter('')));
    expect(text).toContain('Languages');
    expect(text).toContain('Backend & Data');
  });
});
