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
import { type BulletItem, type ExperienceEntry, projectWorkProfile, type WorkProfile } from './profile.js';

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
 * Group-aware snapping (§24.161). Each tailored bullet is matched to the master
 * bullet it most resembles (≥ half its words shared), and the MASTER's verbatim
 * text + grouping are what render — so the agent picks its real accomplishments
 * but can't reword them into fiction (the "PostgreSQL / 60% latency" failure
 * mode) NOR scramble an intro→detail pair. The agent keeps two freedoms:
 * SELECTION (which bullets) and GROUP-LEVEL ORDER (which topic leads — inferred
 * from first-appearance). The master owns the order WITHIN a group, and groups
 * are ATOMIC: matching any member pulls in the whole group, in master order
 * (singletons are their own group of one). Falls back to the full master list
 * when nothing matches (show the truth, never nothing).
 */
function snapBullets(tailoredBullets: BulletItem[], masterBullets: BulletItem[]): BulletItem[] {
  const master = masterBullets.map((b) => ({ item: b, tokens: tokens(b.text) }));
  // Group key per master index: the explicit `group`, else a unique singleton key.
  const keyAt = (i: number): string => master[i].item.group ?? `__single_${i}`;
  // Each group's member indices, in the master's authored (intra-group) order.
  const members = new Map<string, number[]>();
  master.forEach((_, i) => {
    const k = keyAt(i);
    const list = members.get(k);
    if (list) list.push(i);
    else members.set(k, [i]);
  });

  // Snap each tailored bullet to a master bullet (each used at most once),
  // recording the group it selects in the order the agent first reaches it.
  const used = new Set<number>();
  const seen = new Set<string>();
  const groupOrder: string[] = [];
  for (const tb of tailoredBullets) {
    const tset = tokens(tb.text);
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
      used.add(bestIdx);
      const k = keyAt(bestIdx);
      if (!seen.has(k)) {
        seen.add(k);
        groupOrder.push(k);
      }
    }
  }

  // Emit each selected group in the agent's group-order, expanded ATOMICALLY to
  // all its members in master order (the verbatim master items).
  const out: BulletItem[] = [];
  for (const k of groupOrder) for (const i of members.get(k)!) out.push(master[i].item);
  return out.length > 0 ? out : masterBullets.map((b) => ({ ...b }));
}

export interface TailoredValidation {
  ok: boolean;
  /** The master-anchored tailored profile (identity + employer/role/dates forced,
   *  education from master, invented skills/projects dropped). Set only when ok. */
  profile?: WorkProfile;
  /** Unfixable fabrications (an experience at a company not in the master) — the
   *  tool surfaces these so the agent retries within the master's bounds. */
  errors: string[];
  /** §24.143 telemetry — how the bio was resolved: the agent's tailored bio was
   *  kept (`tailored`), or fell back to the master because it was a stub
   *  (`fallback_stub`) or cited a number absent from the master
   *  (`fallback_unverified_number` — the silent-revert that makes a "tailored"
   *  résumé read as the master). Set on every non-early return; the caller logs
   *  the non-`tailored` cases so the floor's frequency + cause are visible. */
  bioOutcome?: 'tailored' | 'fallback_stub' | 'fallback_unverified_number';
  /** The bio number tokens absent from the master (the fabrication audit detail),
   *  set only when bioOutcome is `fallback_unverified_number`. */
  bioUnverifiedNumbers?: string[];
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
  // `focus` is part of the title identity (§24.158/§24.161 D2) — force it too, so
  // the tailored title reads `title · focus` like the master (not a barer title).
  tailored.name = master.name;
  tailored.title = master.title;
  tailored.links = master.links;
  if (master.focus) tailored.focus = master.focus;
  else delete tailored.focus;

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
    // Force employer/role/dates AND the structural lines (descriptor/titles) from
    // the master — stable facts the agent tailors emphasis around, not content
    // (§24.161 D2). Snap bullets to the master's verbatim wording + grouping.
    const anchored: ExperienceEntry = {
      company: m.company,
      role: m.role,
      period: m.period,
      bullets: snapBullets(e.bullets, m.bullets),
    };
    if (m.descriptor) anchored.descriptor = m.descriptor;
    if (m.titles) anchored.titles = m.titles;
    return anchored;
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
        ...master.experience.flatMap((e) => [e.role, e.company, e.period, ...e.bullets.map((b) => b.text)]),
        ...master.projects.flatMap((p) => [p.name, p.description ?? '', ...(p.tags ?? [])]),
      ].join(' '),
    ),
  );
  const bioText = (tailored.bio ?? []).join(' ');
  const bioUnverifiedNumbers = numberTokens(bioText).filter((n) => !masterNumbers.has(n));
  let bioOutcome: TailoredValidation['bioOutcome'] = 'tailored';
  if (bioText.trim().length < 80) {
    bioOutcome = 'fallback_stub';
    tailored.bio = [...master.bio];
  } else if (bioUnverifiedNumbers.length > 0) {
    bioOutcome = 'fallback_unverified_number';
    tailored.bio = [...master.bio];
  }

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

  const bioTelemetry =
    bioOutcome === 'fallback_unverified_number' ? { bioOutcome, bioUnverifiedNumbers } : { bioOutcome };
  if (errors.length > 0) return { ok: false, errors, ...bioTelemetry };
  return { ok: true, profile: tailored, errors: [], ...bioTelemetry };
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
