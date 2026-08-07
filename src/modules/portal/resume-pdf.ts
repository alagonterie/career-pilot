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

import { cloneElement, createElement as h, type ReactElement, type ReactNode } from 'react';

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

/** The PDF stylesheet. `compact` tightens vertical spacing + fonts a touch so a
 *  TAILORED résumé that runs marginally longer than the master (a role summary +
 *  an extra target-role line) still fits one page; the MASTER renders at the
 *  normal, owner-verified density (it's not passed `compact`). Both variants are
 *  built once at module load. */
function makeStyles(compact: boolean) {
  const f = (normal: number, tight: number): number => (compact ? tight : normal);
  return StyleSheet.create({
    page: {
      paddingTop: f(32, 26),
      paddingBottom: f(34, 26),
      paddingHorizontal: 42,
      fontFamily: 'Inter',
      color: '#1a1a1a',
      fontSize: f(9, 8.6),
      lineHeight: f(1.3, 1.24),
    },
    name: { fontSize: f(20, 17), fontWeight: 700, letterSpacing: 0.2, lineHeight: 1.15 },
    title: { fontSize: f(10.5, 9.5), color: '#555555', marginTop: f(7, 5) },
    contact: { fontSize: 8.5, color: '#555555', marginTop: f(5, 3) },
    contactSep: { color: '#999999' },
    link: { color: LINK, textDecoration: 'none' },
    section: { marginTop: f(14, 11) },
    heading: {
      fontSize: 8.5,
      fontWeight: 600,
      color: '#222222',
      letterSpacing: 1,
      borderBottomWidth: 0.5,
      borderBottomColor: '#cfcfcf',
      paddingBottom: f(2.5, 2),
      marginBottom: f(7, 5),
    },
    para: { marginBottom: f(5, 4) },
    expRow: { marginBottom: f(6, 4) },
    expHead: { flexDirection: 'row', justifyContent: 'space-between' },
    role: { fontWeight: 600, fontSize: f(10, 9.5) },
    period: { fontSize: 8.5, color: '#777777' },
    company: { fontSize: 9.5, color: '#444444', marginTop: f(3.5, 3), marginBottom: f(3.5, 3) },
    // §24.157: the company one-liner preface + the prior-title progression line.
    descriptor: { fontSize: 8.5, color: '#555555', marginBottom: f(3.5, 3) },
    titles: { fontSize: 8.5, color: '#777777', marginBottom: f(5, 4) },
    // §24.159/160: generous air between bullets + header pieces — page 2 has slack.
    bullet: { flexDirection: 'row', marginBottom: f(5, 4) },
    bulletDot: { width: 9, color: '#888888' },
    bulletText: { flex: 1 },
    projRow: { marginBottom: f(4, 3) },
    projName: { fontWeight: 600 },
    projLink: { fontSize: 8.5, color: LINK, textDecoration: 'none' },
    projDesc: { color: '#444444', marginTop: f(3, 2.5), marginBottom: f(2, 1.5) },
    projTags: { fontSize: 8.5, color: '#777777', marginTop: 0.5 },
    body: { color: '#333333' },
    skillRow: { flexDirection: 'row', marginBottom: f(3, 2) },
    skillCat: { width: 96, fontWeight: 600, color: '#333333' },
    skillItems: { flex: 1, color: '#333333' },
    footer: {
      position: 'absolute',
      bottom: f(16, 12),
      left: 42,
      right: 42,
      fontSize: 7,
      color: '#9a9a9a',
      textAlign: 'center',
    },
    footerLink: { color: LINK, textDecoration: 'none' },
  });
}

const NORMAL = makeStyles(false);
const COMPACT = makeStyles(true);
type Styles = ReturnType<typeof makeStyles>;
/** One stylesheet entry — derived locally so no @react-pdf internal type is imported. */
type PdfStyle = Styles[keyof Styles];

/** Strip protocol, a leading `www.`, and a trailing slash for a compact, readable
 *  link label (§24.159 drops the `www.` — the real href keeps it). */
function cleanUrl(u: string): string {
  return u
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/+$/, '');
}

/** §24.158: split `**bold**` markup into plain/bold runs (split on `**` → even
 *  index plain, odd index bold; tolerant of an unmatched marker). Exported for tests. */
export function splitBold(text: string): { text: string; bold: boolean }[] {
  return text
    .split('**')
    .map((t, i) => ({ text: t, bold: i % 2 === 1 }))
    .filter((r) => r.text.length > 0);
}

/** Render a string with `**bold**` runs as `<Text>` children (bold via Inter-700);
 *  a plain string returns a single text child. Spread into a parent `<Text>`. */
function rich(str: string): ReactNode[] {
  return splitBold(str).map((r) => (r.bold ? h(Text, { style: { fontWeight: 700 } }, r.text) : r.text));
}

/** §24.74 follow-on: a self-referential link (its host matches the PDF's own
 *  portal host) routes through the first-party `…/r/<code>` token when present —
 *  so a recruiter clicking the résumé's own site is tracked like the footer host.
 *  External links (github, etc.) pass through unchanged. */
function trackedHref(href: string, portalHost: string | null, footerLinkUrl?: string): string {
  return footerLinkUrl && portalHost && siteHost(href) === portalHost ? footerLinkUrl : href;
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
/**
 * §24.194 — a section heading never renders without content beneath it.
 *
 * The heading and the section's FIRST child share one `wrap: false` unit, so the
 * pagination algorithm treats "heading + first line" as indivisible and moves
 * both to the next page rather than stranding the heading. Everything after the
 * first child flows normally, so a long section still breaks across pages
 * wherever it naturally falls.
 *
 * `minPresenceAhead` — react-pdf's documented orphan/widow hint — was tried first
 * and is INERT here: measured on a reproducing fixture it changed nothing on
 * either a `Text` or a `View`, at values from 4 lines up to 30 (~320pt, most of a
 * page). Hence the structural approach, which is verified by the sweep in
 * `resume-pdf.render.test.ts`.
 *
 * This makes each row builder's first child load-bearing: it must be SMALL (a
 * line or two), because it is what gets dragged onto the next page alongside the
 * heading. Both builders are written that way deliberately.
 */
function section(s: Styles, heading: string, children: ReactNode[]): ReactElement | null {
  if (children.length === 0) return null;
  const [lead, ...rest] = children;
  return h(
    View,
    { style: s.section },
    h(View, { wrap: false }, h(Text, { style: s.heading }, heading.toUpperCase()), lead),
    ...rest,
  );
}

function header(
  s: Styles,
  profile: WorkProfile,
  identity: Identity,
  portalHost: string | null,
  footerLinkUrl?: string,
): ReactElement {
  const segs = contactSegments(identity);
  const contactChildren: ReactNode[] = [];
  segs.forEach((seg, i) => {
    if (i > 0) contactChildren.push(h(Text, { key: `sep${i}`, style: s.contactSep }, '   ·   '));
    contactChildren.push(
      h(Link, { key: `lnk${i}`, src: trackedHref(seg.href, portalHost, footerLinkUrl), style: s.link }, seg.label),
    );
  });
  return h(
    View,
    {},
    h(Text, { style: s.name }, profile.name),
    // §24.158: the PDF always carries the full "role · focus"; the home hero shows `title` alone.
    profile.title
      ? h(Text, { style: s.title }, profile.focus ? `${profile.title} · ${profile.focus}` : profile.title)
      : null,
    segs.length > 0 ? h(Text, { style: s.contact }, ...contactChildren) : null,
  );
}

/**
 * §24.158 + §24.194: an entry FLOWS across a page break — a long entry that
 * doesn't fit the page remainder must not jump wholesale — so it is emitted as a
 * FLAT list of section-level siblings rather than one wrapping View. Flat matters
 * because `section()` keeps the heading atomic with the section's first child:
 * with a wrapping View that child would be the whole entry, making the entry
 * unbreakable again and reintroducing the very bug this guards. So the first node
 * here is just the compact header block, and each bullet is separately
 * unbreakable, letting the break fall between bullets.
 */
function experienceNodes(s: Styles, e: WorkProfile['experience'][number], key: number): ReactNode[] {
  const nodes: ReactNode[] = [
    h(
      View,
      { key: `e${key}h`, wrap: false },
      h(
        View,
        { style: s.expHead },
        h(Text, { style: s.role }, e.role),
        e.period ? h(Text, { style: s.period }, e.period) : null,
      ),
      e.company ? h(Text, { style: s.company }, e.company) : null,
      e.descriptor ? h(Text, { style: s.descriptor }, ...rich(e.descriptor)) : null,
      e.titles ? h(Text, { style: s.titles }, e.titles) : null,
    ),
    ...e.bullets.map((b, j) =>
      h(
        View,
        { key: `e${key}b${j}`, style: s.bullet, wrap: false },
        h(Text, { style: s.bulletDot }, '•'),
        h(Text, { style: s.bulletText }, ...rich(b.text)),
      ),
    ),
  ];
  return withRowGap(nodes, s.expRow);
}

/** Re-attach the inter-entry gap that the removed wrapping View used to provide,
 *  by adding its margin to the entry's LAST node. Flattening must not silently
 *  collapse the spacing between two entries. */
function withRowGap(nodes: ReactNode[], gap: PdfStyle): ReactNode[] {
  if (nodes.length === 0) return nodes;
  const last = nodes[nodes.length - 1] as ReactElement<{ style?: PdfStyle | PdfStyle[] }>;
  const existing = last.props.style;
  const merged: PdfStyle[] = existing ? (Array.isArray(existing) ? [...existing, gap] : [existing, gap]) : [gap];
  return [...nodes.slice(0, -1), cloneElement(last, { style: merged })];
}

function projectNodes(
  s: Styles,
  p: WorkProfile['projects'][number],
  key: number,
  portalHost: string | null,
  footerLinkUrl?: string,
): ReactNode[] {
  // §24.194: flat siblings, same as an experience entry and for the same reasons.
  // This used to be one View with `wrap: false`, which was harmless while a
  // project was a name plus a one-line blurb — it always fit. Once §24.193
  // restored the master's description AND its detail bullets the block became
  // ~8 lines, and an unbreakable 8-line block that doesn't fit the page remainder
  // jumps WHOLESALE to the next page, stranding the "Featured project" heading
  // above a blank half-page (observed on a real submitted résumé).
  //
  // The first node is deliberately just the name+links LINE: `section()` keeps it
  // atomic with the heading, so that pairing must stay one line tall. The
  // description follows as a flowing sibling.
  const nodes: ReactNode[] = [
    h(
      Text,
      { key: `p${key}n`, wrap: false },
      h(Text, { style: s.projName }, p.name),
      p.href
        ? h(Link, { src: trackedHref(p.href, portalHost, footerLinkUrl), style: s.projLink }, `   ${cleanUrl(p.href)}`)
        : null,
      p.repo
        ? h(
            Link,
            { src: trackedHref(p.repo, portalHost, footerLinkUrl), style: s.projLink },
            `   ·   ${cleanUrl(p.repo)}`,
          )
        : null,
    ),
  ];
  if (p.description) nodes.push(h(Text, { key: `p${key}d`, style: s.projDesc }, ...rich(p.description)));
  (p.bullets ?? []).forEach((b, j) =>
    nodes.push(
      h(
        View,
        { key: `p${key}b${j}`, style: s.bullet, wrap: false },
        h(Text, { style: s.bulletDot }, '•'),
        h(Text, { style: s.bulletText }, ...rich(b)),
      ),
    ),
  );
  if (p.tags && p.tags.length > 0) {
    nodes.push(h(Text, { key: `p${key}t`, style: s.projTags }, p.tags.join('  ·  ')));
  }
  return withRowGap(nodes, s.projRow);
}

/** Skills children: grouped (category → items) when `skillGroups` is present,
 *  else the flat list; empty → []. */
function skillsChildren(s: Styles, profile: WorkProfile): ReactNode[] {
  if (profile.skillGroups && profile.skillGroups.length > 0) {
    return profile.skillGroups.map((g, i) =>
      h(
        View,
        { key: i, style: s.skillRow, wrap: false },
        h(Text, { style: s.skillCat }, g.category),
        h(Text, { style: s.skillItems }, g.items.join('  ·  ')),
      ),
    );
  }
  if (profile.skills.length > 0) return [h(Text, { style: s.body }, profile.skills.join('   ·   '))];
  return [];
}

/** The fixed footer Text, with the configured host rendered as a clickable Link
 *  (so the traveling-proof URL is clickable like every other link). `linkUrl`
 *  defaults to `publicUrl` but can differ — the §24.74 master-PDF token points
 *  the host text at `…/r/<code>` while still DISPLAYING the bare host. */
function footerElement(s: Styles, footer: string, publicUrl: string, linkUrl: string = publicUrl) {
  const host = siteHost(publicUrl);
  if (!host || !footer.includes(host)) {
    return h(Text, { style: s.footer, fixed: true }, footer);
  }
  const i = footer.indexOf(host);
  return h(
    Text,
    { style: s.footer, fixed: true },
    footer.slice(0, i),
    h(Link, { src: linkUrl, style: s.footerLink }, host),
    footer.slice(i + host.length),
  );
}

// Return type is inferred (a `ReactElement<DocumentProps>`) so it satisfies
// `renderToBuffer` — an explicit `ReactElement` annotation would widen it away.
function buildResumeDocument(
  profile: WorkProfile,
  identity: Identity,
  footer: string,
  publicUrl: string,
  s: Styles,
  footerLinkUrl?: string,
) {
  // §24.74 follow-on: self-referential links (host === the portal) route through the token.
  const portalHost = siteHost(publicUrl);
  // Experience + Projects, ordered by the §24.106 layout hint (Projects first
  // when the tailoring agent flags this role as projects-led; else the default).
  const experienceSection = section(
    s,
    'Experience',
    profile.experience.flatMap((e, i) => experienceNodes(s, e, i)),
  );
  // §24.157: a lone project reads as a deliberate "Featured Project"; 2+ → "Projects".
  const projectsSection = section(
    s,
    profile.projects.length === 1 ? 'Featured Project' : 'Projects',
    profile.projects.flatMap((p, i) => projectNodes(s, p, i, portalHost, footerLinkUrl)),
  );
  const orderedCore = profile.projectsFirst
    ? [projectsSection, experienceSection]
    : [experienceSection, projectsSection];

  const sections: (ReactElement | null)[] = [
    section(
      s,
      'Summary',
      profile.bio.map((p, i) => h(Text, { key: i, style: s.para }, ...rich(p))),
    ),
    section(
      s,
      "What I'm looking for",
      profile.lookingFor.length > 0 ? [h(Text, { style: s.body }, profile.lookingFor.join('   ·   '))] : [],
    ),
    ...orderedCore,
    section(
      s,
      'Writing & Talks',
      (profile.writing ?? []).map((w, i) =>
        h(Text, { key: i, style: s.para }, w.venue ? `${w.title} — ${w.venue}` : w.title),
      ),
    ),
    section(s, 'Skills', skillsChildren(s, profile)),
    section(
      s,
      'Education',
      profile.education.map((e, i) => h(Text, { key: i, style: s.para }, e)),
    ),
  ];

  return h(
    Document,
    { title: `${profile.name} — Résumé`, author: profile.name },
    h(
      Page,
      { size: 'LETTER', style: s.page },
      header(s, profile, identity, portalHost, footerLinkUrl),
      ...sections,
      footerElement(s, footer, publicUrl, footerLinkUrl ?? publicUrl),
    ),
  );
}

/** Render the composed `WorkProfile` to a PDF buffer (the Tier-1 / Tier-2 engine).
 *  `publicUrl` (the configured portal URL) linkifies the footer host. `compact`
 *  (the tailored caller) tightens the layout a touch to guarantee one page when
 *  the tailored content runs marginally longer than the master. */
export function renderResumePdf(
  profile: WorkProfile,
  identity: Identity,
  footer: string,
  publicUrl = '',
  opts: { compact?: boolean; footerLinkUrl?: string } = {},
): Promise<Buffer> {
  const s = opts.compact ? COMPACT : NORMAL;
  return renderToBuffer(buildResumeDocument(profile, identity, footer, publicUrl, s, opts.footerLinkUrl));
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
  // Names the responsible agent (§24.73): "the tailor-resume agent" reads
  // unambiguously as an AI author even out of context, where the on-screen ✦
  // marker can't travel. (No ✦ glyph in the PDF — Inter doesn't ship the
  // dingbat; the wording carries the signal.)
  const where = host ? ` — part of the same AI system running my live job search at ${host}` : '';
  const when = footerDate(isoDate);
  const gen = when ? ` Generated ${when};` : '';
  return `Auto-tailored for the ${r} role at ${c} by the tailor-resume agent${where}.${gen} All content reflects real experience.`;
}
