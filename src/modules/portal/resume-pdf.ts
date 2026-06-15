/**
 * src/modules/portal/resume-pdf.ts — server-rendered résumé PDF (STRATEGY §24.72,
 * Tier 1 / 9.4b-r1). Renders the composed `WorkProfile` into a clean 1–2-page PDF
 * via `@react-pdf/renderer` — deterministic layout from structured data (D1), no
 * headless browser. The renderer is a pure `WorkProfile → Buffer`; the same
 * engine will serve the tailored Tier-2 résumé (just a different WorkProfile
 * cut). Built with `React.createElement` (no JSX) so the backend's tsc/NodeNext
 * build needs no changes. Empty sections are omitted (never invented), mirroring
 * the `/work` page. Every PDF carries the §24.72 D4 AI-provenance footer.
 */
import { createElement as h, type ReactElement, type ReactNode } from 'react';

import { Document, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';

import type { Identity, WorkProfile } from './profile.js';

const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 56,
    paddingHorizontal: 46,
    fontFamily: 'Helvetica',
    color: '#1a1a1a',
    fontSize: 10,
    lineHeight: 1.4,
  },
  name: { fontSize: 22, fontFamily: 'Helvetica-Bold', letterSpacing: 0.2 },
  title: { fontSize: 11, color: '#555555', marginTop: 3 },
  contact: { fontSize: 9, color: '#555555', marginTop: 6 },
  section: { marginTop: 15 },
  heading: {
    fontSize: 9,
    fontFamily: 'Helvetica-Bold',
    color: '#222222',
    letterSpacing: 1.2,
    borderBottomWidth: 0.5,
    borderBottomColor: '#cccccc',
    paddingBottom: 3,
    marginBottom: 6,
  },
  para: { marginBottom: 4 },
  expRow: { marginBottom: 8 },
  expHead: { flexDirection: 'row', justifyContent: 'space-between' },
  role: { fontFamily: 'Helvetica-Bold', fontSize: 10.5 },
  period: { fontSize: 9, color: '#777777' },
  company: { fontSize: 10, color: '#444444', marginBottom: 2 },
  bullet: { flexDirection: 'row', marginBottom: 1.5 },
  bulletDot: { width: 10 },
  bulletText: { flex: 1 },
  projName: { fontFamily: 'Helvetica-Bold' },
  projDesc: { color: '#444444' },
  projTags: { fontSize: 9, color: '#777777', marginTop: 1 },
  body: { color: '#333333' },
  footer: {
    position: 'absolute',
    bottom: 26,
    left: 46,
    right: 46,
    fontSize: 7.5,
    color: '#999999',
    textAlign: 'center',
  },
});

/** Strip protocol + trailing slash for a compact, readable contact display. */
function cleanUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

function contactSegments(id: Identity): string[] {
  const out: string[] = [];
  if (id.email) out.push(id.email);
  if (id.github) out.push(cleanUrl(id.github));
  if (id.linkedin) out.push(cleanUrl(id.linkedin));
  if (id.website) out.push(cleanUrl(id.website));
  if (id.x) out.push(cleanUrl(id.x));
  return out;
}

/** A titled section, or null when it has no content (omit — never invent). */
function section(heading: string, children: ReactNode[]): ReactElement | null {
  if (children.length === 0) return null;
  return h(View, { style: styles.section }, h(Text, { style: styles.heading }, heading.toUpperCase()), ...children);
}

function header(profile: WorkProfile, identity: Identity): ReactElement {
  const segs = contactSegments(identity);
  return h(
    View,
    {},
    h(Text, { style: styles.name }, profile.name),
    profile.title ? h(Text, { style: styles.title }, profile.title) : null,
    segs.length > 0 ? h(Text, { style: styles.contact }, segs.join('   ·   ')) : null,
  );
}

function experienceRow(e: WorkProfile['experience'][number], key: number): ReactElement {
  return h(
    View,
    { key, style: styles.expRow, wrap: false },
    h(
      View,
      { style: styles.expHead },
      h(Text, { style: styles.role }, e.role),
      e.period ? h(Text, { style: styles.period }, e.period) : null,
    ),
    e.company ? h(Text, { style: styles.company }, e.company) : null,
    ...e.bullets.map((b, j) =>
      h(
        View,
        { key: j, style: styles.bullet },
        h(Text, { style: styles.bulletDot }, '•'),
        h(Text, { style: styles.bulletText }, b),
      ),
    ),
  );
}

function projectRow(p: WorkProfile['projects'][number], key: number): ReactElement {
  return h(
    View,
    { key, style: { marginBottom: 5 } },
    h(
      Text,
      {},
      h(Text, { style: styles.projName }, p.name),
      p.href ? h(Text, { style: styles.period }, `   ${cleanUrl(p.href)}`) : null,
    ),
    p.description ? h(Text, { style: styles.projDesc }, p.description) : null,
    p.tags && p.tags.length > 0 ? h(Text, { style: styles.projTags }, p.tags.join(' · ')) : null,
  );
}

// Return type is inferred (a `ReactElement<DocumentProps>`) so it satisfies
// `renderToBuffer` — an explicit `ReactElement` annotation would widen it away.
function buildResumeDocument(profile: WorkProfile, identity: Identity, footer: string) {
  const sections: (ReactElement | null)[] = [
    section(
      'Summary',
      profile.bio.map((p, i) => h(Text, { key: i, style: styles.para }, p)),
    ),
    section(
      "What I'm looking for",
      profile.lookingFor.length > 0 ? [h(Text, { style: styles.body }, profile.lookingFor.join('   ·   '))] : [],
    ),
    section(
      'Experience',
      profile.experience.map((e, i) => experienceRow(e, i)),
    ),
    section(
      'Projects',
      profile.projects.map((p, i) => projectRow(p, i)),
    ),
    section(
      'Writing & Talks',
      (profile.writing ?? []).map((w, i) =>
        h(Text, { key: i, style: styles.para }, w.venue ? `${w.title} — ${w.venue}` : w.title),
      ),
    ),
    section(
      'Skills',
      profile.skills.length > 0 ? [h(Text, { style: styles.body }, profile.skills.join('   ·   '))] : [],
    ),
    section(
      'Education',
      profile.education.map((e, i) => h(Text, { key: i, style: styles.para }, e)),
    ),
  ];

  return h(
    Document,
    { title: `${profile.name} — Résumé`, author: profile.name },
    h(
      Page,
      { size: 'LETTER', style: styles.page },
      header(profile, identity),
      ...sections,
      h(Text, { style: styles.footer, fixed: true }, footer),
    ),
  );
}

/** Render the composed `WorkProfile` to a PDF buffer (the Tier-1 / Tier-2 engine). */
export function renderResumePdf(profile: WorkProfile, identity: Identity, footer: string): Promise<Buffer> {
  return renderToBuffer(buildResumeDocument(profile, identity, footer));
}

/** The portal's public host for the footer — a deploy-level value, read from env;
 *  omitted (not faked) when unset, so the attribution never prints a wrong URL. */
function portalHost(): string | null {
  const raw = (process.env.PORTAL_PUBLIC_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '').trim();
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
  }
}

/** The §24.72 D4 master-résumé provenance footer (transparency + traveling proof). */
export function masterFooter(): string {
  const host = portalHost();
  return '◇ Composed by my AI agent system' + (host ? ` · ${host}` : '');
}

/** UTC-fixed so the footer reads identically wherever it's rendered. */
function footerDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * The §24.72 D4 TAILORED-résumé footer — the traveling conversion vector: when a
 * recruiter forwards the PDF, it tells the hiring manager the candidate's own
 * agent auto-tailored it for this exact role, and states the honesty guardrail.
 */
export function tailoredFooter(company: string | null, role: string | null, isoDate: string): string {
  const host = portalHost();
  const r = role && role.trim() ? role.trim() : 'this';
  const c = company && company.trim() ? company.trim() : 'your company';
  const where = host ? ` running my live job search at ${host}` : '';
  const when = footerDate(isoDate);
  const gen = when ? ` Generated ${when};` : '';
  return `◇ Auto-tailored for the ${r} role at ${c} by my own AI agent system — the same one${where}.${gen} all content reflects real experience.`;
}
