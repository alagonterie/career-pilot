/**
 * src/modules/portal/resume-pdf.ts — server-rendered résumé PDF (STRATEGY §24.72).
 * Renders the composed `WorkProfile` into a clean, dense ONE-page PDF via
 * `@react-pdf/renderer` (Inter, brand-matched; deterministic layout from
 * structured data). Pure `WorkProfile → Buffer`; the same engine serves the
 * Tier-2 tailored résumé. Built with `React.createElement` (no JSX) so the
 * backend's tsc/NodeNext build needs no changes. Empty sections are omitted
 * (never invented); contact + project URLs are real clickable Link annotations;
 * grouped skills render category-by-category; every PDF carries the §24.72 D4
 * provenance footer. Structural guarantees are locked by resume-pdf.render.test.
 */
import path from 'node:path';

import { createElement as h, type ReactElement, type ReactNode } from 'react';

import { Document, Font, Link, Page, StyleSheet, Text, View, renderToBuffer } from '@react-pdf/renderer';

import type { Identity, WorkProfile } from './profile.js';

// Register the brand font (Inter) so the PDF matches the site and reads as
// deliberate, not default. Resolved from the repo root (process.cwd()) — the
// committed assets/fonts ship with the source on the box; tsc ignores them.
const FONT_DIR = path.join(process.cwd(), 'assets', 'fonts');
Font.register({
  family: 'Inter',
  fonts: [
    { src: path.join(FONT_DIR, 'Inter-400.woff'), fontWeight: 400 },
    { src: path.join(FONT_DIR, 'Inter-600.woff'), fontWeight: 600 },
    { src: path.join(FONT_DIR, 'Inter-700.woff'), fontWeight: 700 },
  ],
});
// Never hyphen-split long tokens (URLs, "Testcontainers").
Font.registerHyphenationCallback((word) => [word]);

const LINK = '#0b66c3'; // a subtle, print-safe link blue

const styles = StyleSheet.create({
  page: {
    paddingTop: 32,
    paddingBottom: 34,
    paddingHorizontal: 42,
    fontFamily: 'Inter',
    color: '#1a1a1a',
    fontSize: 9,
    lineHeight: 1.3,
  },
  name: { fontSize: 20, fontWeight: 700, letterSpacing: 0.2, lineHeight: 1.15 },
  title: { fontSize: 10.5, color: '#555555', marginTop: 5 },
  contact: { fontSize: 8.5, color: '#555555', marginTop: 5 },
  contactSep: { color: '#999999' },
  link: { color: LINK, textDecoration: 'none' },
  section: { marginTop: 10 },
  heading: {
    fontSize: 8.5,
    fontWeight: 600,
    color: '#222222',
    letterSpacing: 1,
    borderBottomWidth: 0.5,
    borderBottomColor: '#cfcfcf',
    paddingBottom: 2.5,
    marginBottom: 5,
  },
  para: { marginBottom: 3 },
  expRow: { marginBottom: 6 },
  expHead: { flexDirection: 'row', justifyContent: 'space-between' },
  role: { fontWeight: 600, fontSize: 10 },
  period: { fontSize: 8.5, color: '#777777' },
  company: { fontSize: 9.5, color: '#444444', marginBottom: 1.5 },
  bullet: { flexDirection: 'row', marginBottom: 1 },
  bulletDot: { width: 9, color: '#888888' },
  bulletText: { flex: 1 },
  projName: { fontWeight: 600 },
  projLink: { fontSize: 8.5, color: LINK, textDecoration: 'none' },
  projDesc: { color: '#444444' },
  projTags: { fontSize: 8.5, color: '#777777', marginTop: 0.5 },
  body: { color: '#333333' },
  skillRow: { flexDirection: 'row', marginBottom: 2 },
  skillCat: { width: 96, fontWeight: 600, color: '#333333' },
  skillItems: { flex: 1, color: '#333333' },
  footer: {
    position: 'absolute',
    bottom: 16,
    left: 42,
    right: 42,
    fontSize: 7,
    color: '#9a9a9a',
    textAlign: 'center',
  },
});

/** Strip protocol + trailing slash for a compact, readable link label. */
function cleanUrl(u: string): string {
  return u.replace(/^https?:\/\//, '').replace(/\/+$/, '');
}

/** Contact identity as {label, href} pairs (omit-when-null), in display order. */
function contactSegments(id: Identity): { label: string; href: string }[] {
  const out: { label: string; href: string }[] = [];
  if (id.email) out.push({ label: id.email, href: `mailto:${id.email}` });
  if (id.github) out.push({ label: cleanUrl(id.github), href: id.github });
  if (id.linkedin) out.push({ label: cleanUrl(id.linkedin), href: id.linkedin });
  if (id.website) out.push({ label: cleanUrl(id.website), href: id.website });
  if (id.x) out.push({ label: cleanUrl(id.x), href: id.x });
  return out;
}

/** A titled section, or null when it has no content (omit — never invent). */
function section(heading: string, children: ReactNode[]): ReactElement | null {
  if (children.length === 0) return null;
  return h(View, { style: styles.section }, h(Text, { style: styles.heading }, heading.toUpperCase()), ...children);
}

function header(profile: WorkProfile, identity: Identity): ReactElement {
  const segs = contactSegments(identity);
  const contactChildren: ReactNode[] = [];
  segs.forEach((s, i) => {
    if (i > 0) contactChildren.push(h(Text, { key: `sep${i}`, style: styles.contactSep }, '   ·   '));
    contactChildren.push(h(Link, { key: `lnk${i}`, src: s.href, style: styles.link }, s.label));
  });
  return h(
    View,
    {},
    h(Text, { style: styles.name }, profile.name),
    profile.title ? h(Text, { style: styles.title }, profile.title) : null,
    segs.length > 0 ? h(Text, { style: styles.contact }, ...contactChildren) : null,
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
    { key, style: { marginBottom: 4 }, wrap: false },
    h(
      Text,
      {},
      h(Text, { style: styles.projName }, p.name),
      p.href ? h(Link, { src: p.href, style: styles.projLink }, `   ${cleanUrl(p.href)}`) : null,
    ),
    p.description ? h(Text, { style: styles.projDesc }, p.description) : null,
    p.tags && p.tags.length > 0 ? h(Text, { style: styles.projTags }, p.tags.join('  ·  ')) : null,
  );
}

/** Skills children: grouped (category → items) when `skillGroups` is present,
 *  else the flat list; empty → []. */
function skillsChildren(profile: WorkProfile): ReactNode[] {
  if (profile.skillGroups && profile.skillGroups.length > 0) {
    return profile.skillGroups.map((g, i) =>
      h(
        View,
        { key: i, style: styles.skillRow, wrap: false },
        h(Text, { style: styles.skillCat }, g.category),
        h(Text, { style: styles.skillItems }, g.items.join('  ·  ')),
      ),
    );
  }
  if (profile.skills.length > 0) return [h(Text, { style: styles.body }, profile.skills.join('   ·   '))];
  return [];
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
    section('Skills', skillsChildren(profile)),
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

/** Normalize a configured public URL to a bare host, or null when unset/blank —
 *  the footer never prints a faked URL. The value comes from getConfig
 *  (`portal_public_url`, a per-environment preference), so this stays pure. */
function siteHost(publicUrl: string): string | null {
  const raw = publicUrl.trim();
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return raw.replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null;
  }
}

/** The §24.72 D4 master-résumé provenance footer (transparency + traveling proof). */
export function masterFooter(publicUrl: string): string {
  const host = siteHost(publicUrl);
  return 'Composed by my AI agent system' + (host ? ` · ${host}` : '');
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
 * Reads cleanly with or without a configured host (no dangling clause).
 */
export function tailoredFooter(
  company: string | null,
  role: string | null,
  isoDate: string,
  publicUrl: string,
): string {
  const host = siteHost(publicUrl);
  const r = role && role.trim() ? role.trim() : 'this';
  const c = company && company.trim() ? company.trim() : 'your company';
  const where = host ? ` — the same system running my live job search at ${host}` : '';
  const when = footerDate(isoDate);
  const gen = when ? ` Generated ${when};` : '';
  return `Auto-tailored for the ${r} role at ${c} by my own AI agent system${where}.${gen} All content reflects real experience.`;
}
