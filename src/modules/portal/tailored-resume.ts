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
 *  - skills + projects are FILTERED to the master's set (selection/ordering is
 *    legitimate tailoring; an invented skill/project is dropped).
 *
 * The agent keeps full freedom over what to feature, the ordering, and the
 * bullet/summary PROSE — only the structural skeleton is locked. Pure + testable.
 */
import { projectWorkProfile, type WorkProfile } from './profile.js';

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
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
  const tailored = projectWorkProfile(JSON.stringify(emitted ?? null));
  if (!tailored) {
    return { ok: false, errors: ['The tailored résumé must be a WorkProfile object with at least a name.'] };
  }

  const errors: string[] = [];

  // Identity is never tailored — take it from the master verbatim.
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
    return { ...e, company: m.company, role: m.role, period: m.period };
  });

  // Education is not tailored — take the master's list verbatim.
  tailored.education = [...master.education];

  // Skills: filter to the master's set (selecting/ordering relevant skills is
  // legitimate; an invented skill is dropped). Preserve the agent's ordering.
  const masterSkills = new Set(master.skills.map(norm));
  tailored.skills = tailored.skills.filter((s) => masterSkills.has(norm(s)));

  // Projects: filter to the master's set by name; force name + link from the
  // master, keep the agent's (tailored) description + tags.
  const masterProjByName = new Map(master.projects.map((p) => [norm(p.name), p]));
  tailored.projects = tailored.projects
    .filter((p) => masterProjByName.has(norm(p.name)))
    .map((p) => {
      const m = masterProjByName.get(norm(p.name))!;
      return { ...p, name: m.name, href: m.href };
    });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, profile: tailored, errors: [] };
}

/**
 * Extract the tailored `WorkProfile` the sandbox emits as a fenced block at the
 * end of a run (transport for §24.72 D5 — the guardrail validates it host-side).
 * Prefers an explicitly tagged ```tailored-resume-json fence; falls back to the
 * last ```json block. Returns the parsed (unvalidated) object, or null.
 */
export function extractTailoredResumeBlock(output: string): unknown | null {
  if (!output) return null;
  const tagged = [...output.matchAll(/```tailored-resume-json\s*\n([\s\S]*?)```/g)];
  const fences = tagged.length > 0 ? tagged : [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (fences.length === 0) return null;
  try {
    return JSON.parse(fences[fences.length - 1][1].trim());
  } catch {
    return null;
  }
}

/** Remove the tailored-résumé fence from the run's chat output so the human-facing
 *  share text (the bullets + outreach) doesn't show a raw JSON blob. */
export function stripTailoredResumeBlock(output: string): string {
  return output
    .replace(/```tailored-resume-json\s*\n[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
