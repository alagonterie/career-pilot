/**
 * src/modules/portal/tailored-resume.ts — the mechanical honesty guardrail for
 * the Tier-2 tailored résumé (STRATEGY §24.72 D5 / 9.4b-r2).
 *
 * The sandbox emits a tailored `WorkProfile` (via the read-only
 * `emit_tailored_resume` tool); this validates it against the candidate's MASTER
 * profile so honesty is enforced in CODE, not just asked for in the prompt:
 *
 *  - identity (name / title / links) is taken from the master — never the agent;
 *  - every experience entry's COMPANY must exist in the master (an invented
 *    employer is an unfixable fabrication → REJECT, so the agent retries); the
 *    matched entry's role + period are forced from the master (rephrased titles
 *    or dates are corrected, not trusted);
 *  - education is taken from the master verbatim (never tailored);
 *  - a QUALITY FLOOR keeps the gift from being a worse subset of the master:
 *    skills + skill groups are always the master's full set (subsetting them
 *    looks thin, not sharp); the bio falls back to the master's summary when the
 *    agent leaves it empty/stub OR cites a number not in the master (an
 *    unverifiable metric — honesty for the one free-prose field); projects fall
 *    back to the master's when dropped.
 *
 * Tailoring is thus ENHANCEMENT — a role-specific summary + experience-bullet
 * selection/ordering — over a complete master, never a strip-down. The agent
 * keeps freedom over the summary + which bullets to feature. Pure + testable.
 */
import { projectWorkProfile, type WorkProfile } from './profile.js';

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Digit-number tokens in a string (comma-normalized), for the bio honesty check
 *  — e.g. "850×, 22,000×, 137ns, 60%" → ["850","22000","137","60"]. Units and
 *  word-numbers are ignored; only the digit content is compared. */
function numberTokens(text: string): string[] {
  return (text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map((m) => m.replace(/,/g, ''));
}

/** Content tokens (length-3+, alphanumeric) for fuzzy bullet matching. */
function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2),
  );
}

/** Share of `a`'s tokens that also appear in `b` (0..1) — directional overlap. */
function overlapCoeff(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / a.size;
}

const BULLET_MATCH_THRESHOLD = 0.5;

/**
 * Snap each tailored bullet to the master bullet it most resembles (≥ half its
 * words shared), substituting the MASTER's verbatim text — so the agent picks +
 * orders its real accomplishments but can't reword them into fiction (the
 * "PostgreSQL / 60% latency" failure mode). Bullets that match nothing
 * (genericized or invented) are dropped; if a role ends up empty, fall back to
 * the master's bullets (show the truth, never nothing). Each master bullet is
 * used at most once, so the agent's selection + ordering is preserved.
 */
function snapBullets(tailoredBullets: string[], masterBullets: string[]): string[] {
  const master = masterBullets.map((b) => ({ text: b, tokens: tokens(b) }));
  const used = new Set<number>();
  const out: string[] = [];
  for (const tb of tailoredBullets) {
    const tset = tokens(tb);
    let bestIdx = -1;
    let bestScore = 0;
    master.forEach((m, i) => {
      if (used.has(i)) return;
      const s = overlapCoeff(tset, m.tokens);
      if (s > bestScore) {
        bestScore = s;
        bestIdx = i;
      }
    });
    if (bestIdx >= 0 && bestScore >= BULLET_MATCH_THRESHOLD) {
      out.push(master[bestIdx].text);
      used.add(bestIdx);
    }
  }
  return out.length > 0 ? out : [...masterBullets];
}

export interface TailoredValidation {
  ok: boolean;
  /** The master-anchored tailored profile (identity + employer/role/dates forced,
   *  education from master, invented skills/projects dropped). Set only when ok. */
  profile?: WorkProfile;
  /** Unfixable fabrications (an experience at a company not in the master) — the
   *  tool surfaces these so the agent retries within the master's bounds. */
  errors: string[];
}

/**
 * Validate an emitted tailored résumé against the master `WorkProfile`. Returns
 * the cleaned profile when honest, or `errors` (→ the tool returns `isError`)
 * when it invents an employer.
 */
export function validateTailoredResume(emitted: unknown, master: WorkProfile): TailoredValidation {
  if (!emitted || typeof emitted !== 'object' || Array.isArray(emitted)) {
    return { ok: false, errors: ['The tailored résumé must be a JSON WorkProfile object.'] };
  }
  // The emitted block intentionally OMITS identity (name/title/links) — those are
  // forced from the master, so the sandbox is never asked to supply them. Inject
  // the master's identity BEFORE projecting: `projectWorkProfile` requires a name,
  // so without this a faithful no-name emit (exactly the instructed shape) is
  // rejected, and the gift silently goes missing whenever the agent doesn't
  // happen to also include a name. Anything emitted is re-anchored below anyway.
  const withIdentity = {
    ...(emitted as Record<string, unknown>),
    name: master.name,
    title: master.title,
    links: master.links,
  };
  const tailored = projectWorkProfile(JSON.stringify(withIdentity));
  if (!tailored) {
    return { ok: false, errors: ['The tailored résumé could not be parsed as a WorkProfile.'] };
  }

  const errors: string[] = [];

  // Identity is never tailored — pinned to the master (already injected above).
  tailored.name = master.name;
  tailored.title = master.title;
  tailored.links = master.links;

  // Experience: the company must trace to the master; the matched entry's role +
  // period are forced (rephrased titles/dates corrected). A company NOT in the
  // master is an unfixable fabrication → collect an error (reject the run).
  const byCompany = new Map<string, WorkProfile['experience']>();
  for (const m of master.experience) {
    const k = norm(m.company);
    const list = byCompany.get(k) ?? [];
    list.push(m);
    byCompany.set(k, list);
  }
  const flagged = new Set<string>();
  tailored.experience = tailored.experience.map((e) => {
    const candidates = byCompany.get(norm(e.company));
    if (!candidates || candidates.length === 0) {
      const key = norm(e.company);
      if (!flagged.has(key)) {
        flagged.add(key);
        errors.push(`Experience at "${e.company}" is not in the master résumé — only real employers may appear.`);
      }
      return e;
    }
    // Prefer a role match when a company has multiple stints; else the sole entry.
    const m = candidates.find((c) => norm(c.role) === norm(e.role)) ?? candidates[0];
    // Force employer/role/dates from the master; snap bullets to the master's
    // verbatim wording (selection + ordering kept; rewording into fiction can't).
    return { company: m.company, role: m.role, period: m.period, bullets: snapBullets(e.bullets, m.bullets) };
  });

  // Education is not tailored — take the master's list verbatim.
  tailored.education = [...master.education];

  // QUALITY FLOOR (the "worse-than-master" fix): tailoring must ENHANCE (a
  // role-specific summary + bullet selection/ordering), never STRIP. The agent
  // routinely emits a skeleton — empty bio, no projects, a couple of skills —
  // which the old "filter to master" logic faithfully rendered as a strict
  // downgrade of the master. So for the sections that shouldn't be subset, floor
  // them at the master:

  // Bio (the summary) is the heart of the tailoring but also the one FREE-PROSE
  // field the snapping can't anchor — the agent can slip an invented metric in
  // (e.g. a fabricated "60%" latency cut). Two floors, both falling back to the
  // master's (honest, strong) summary: (1) empty/stub; (2) it cites a number that
  // appears NOWHERE in the master résumé. The candidate's real metrics live
  // densely in the master, so an honest role-bio passes untouched; only an
  // unverifiable number trips it. Honesty enforced in code, same as the bullets.
  const masterNumbers = new Set(
    numberTokens(
      [
        master.title,
        ...master.bio,
        ...master.lookingFor,
        ...master.education,
        ...master.skills,
        ...master.experience.flatMap((e) => [e.role, e.company, e.period, ...e.bullets]),
        ...master.projects.flatMap((p) => [p.name, p.description ?? '', ...(p.tags ?? [])]),
      ].join(' '),
    ),
  );
  const bioText = (tailored.bio ?? []).join(' ');
  const bioHasUnverifiedNumber = numberTokens(bioText).some((n) => !masterNumbers.has(n));
  if (bioText.trim().length < 80 || bioHasUnverifiedNumber) tailored.bio = [...master.bio];

  // "What I'm looking for" — keep the agent's (often role-tailored) list; fall
  // back to the master's when empty.
  if (tailored.lookingFor.length === 0) tailored.lookingFor = [...master.lookingFor];

  // Skills are NOT tailored by subsetting — hiding most of a real, curated skill
  // set makes the résumé look thin, not sharp (the role emphasis lives in the bio
  // + bullets). Always present the master's full skills + groups.
  tailored.skills = [...master.skills];
  tailored.skillGroups = master.skillGroups
    ? master.skillGroups.map((g) => ({ ...g, items: [...g.items] }))
    : undefined;

  // Projects: keep the agent's selection (filtered to real projects; tailored
  // descriptions allowed), but never silently drop them — the master's projects
  // are few and relevant, so fall back to ALL of them when the agent emits none.
  const masterProjByName = new Map(master.projects.map((p) => [norm(p.name), p]));
  const keptProjects = tailored.projects
    .filter((p) => masterProjByName.has(norm(p.name)))
    .map((p) => {
      const m = masterProjByName.get(norm(p.name))!;
      return { ...p, name: m.name, href: m.href };
    });
  tailored.projects = keptProjects.length > 0 ? keptProjects : master.projects.map((p) => ({ ...p }));

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, profile: tailored, errors: [] };
}

/** The fence tag the sandbox is asked to use for the tailored-résumé block. */
const TAILORED_TAG = 'tailored-resume-json';

interface FencedBlock {
  /** The full ```…``` span (incl. fences) — what strip removes verbatim. */
  full: string;
  /** The opening fence's info string (e.g. `json`, `tailored-resume-json`, ``). */
  lang: string;
  /** Inner content, after any leading `tailored-resume-json` label line is dropped. */
  inner: string;
  /** Parsed inner JSON when it parses to an object, else null. */
  parsed: Record<string, unknown> | null;
  /** The agent explicitly named the block (fence info OR a leading label line). */
  explicitlyTagged: boolean;
  /** This block is (or may be) the tailored résumé — tagged, OR a json/WorkProfile fence. */
  tailored: boolean;
}

/** First non-blank line of a block body, trimmed (`''` if none). */
function firstNonBlankLine(body: string): string {
  for (const line of body.split('\n')) if (line.trim() !== '') return line.trim();
  return '';
}

/** Drop a leading `tailored-resume-json` label line — the agent sometimes puts
 *  the tag INSIDE a ```json fence instead of on the fence info line. */
function stripLeadingTagLine(body: string): string {
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i < lines.length && lines[i].trim() === TAILORED_TAG) return lines.slice(i + 1).join('\n');
  return body;
}

function parseJsonObject(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s.trim());
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  return null;
}

/** A tailored WorkProfile carries experience and/or the tailoring-only fields —
 *  enough to recognize it even as a bare ```json fence with no tag. */
function isWorkProfileShape(o: Record<string, unknown> | null): boolean {
  return !!o && ('experience' in o || 'bio' in o || 'skillGroups' in o);
}

/**
 * Parse every fenced code block, capturing the fence info string and inner body
 * separately so the tailored-résumé block is recognized however the agent framed
 * it: a tagged ```tailored-resume-json fence, the tag on the ```json info line,
 * the tag on a label line INSIDE a ```json fence, or a bare ```json WorkProfile.
 */
function fencedBlocks(output: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  const re = /```([^\n\r`]*)\r?\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(output)) !== null) {
    const lang = m[1].trim();
    const body = m[2];
    const inner = stripLeadingTagLine(body);
    const parsed = parseJsonObject(inner);
    const explicitlyTagged = lang.includes(TAILORED_TAG) || firstNonBlankLine(body) === TAILORED_TAG;
    const isJsonFence = lang === 'json' || lang.includes(TAILORED_TAG);
    const tailored = explicitlyTagged || (isJsonFence && parsed != null) || isWorkProfileShape(parsed);
    out.push({ full: m[0], lang, inner, parsed, explicitlyTagged, tailored });
  }
  return out;
}

/**
 * Extract the tailored `WorkProfile` the sandbox emits as a fenced block at the
 * end of a run (transport for §24.72 D5 — the guardrail validates it host-side).
 * Robust to the agent's fence-tag variations (the live failure mode was a ```json
 * fence with `tailored-resume-json` on a label line inside). Prefers an explicitly
 * tagged block; falls back to a WorkProfile-shaped json fence. Returns the parsed
 * (unvalidated) object, or null.
 */
export function extractTailoredResumeBlock(output: string): unknown | null {
  if (!output) return null;
  const blocks = fencedBlocks(output);
  const tagged = blocks.filter((b) => b.explicitlyTagged);
  const pool = tagged.length > 0 ? tagged : blocks.filter((b) => b.tailored);
  for (let i = pool.length - 1; i >= 0; i--) if (pool[i].parsed != null) return pool[i].parsed;
  return null;
}

/** Remove the tailored-résumé fence from the run's chat output so the human-facing
 *  share text (the bullets + outreach) doesn't show a raw JSON blob. Mirrors
 *  extract's selection: strips the explicitly-tagged block(s) when present, else
 *  the WorkProfile-shaped json fence — so the leak is removed however it's framed. */
export function stripTailoredResumeBlock(output: string): string {
  if (!output) return output;
  const blocks = fencedBlocks(output);
  const tagged = blocks.filter((b) => b.explicitlyTagged);
  const toRemove = tagged.length > 0 ? tagged : blocks.filter((b) => b.tailored);
  let text = output;
  for (const b of toRemove) text = text.split(b.full).join('');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
