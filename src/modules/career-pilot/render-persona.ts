/**
 * Render-persona host hook (career-pilot).
 *
 * Reads the single `candidate_profile` row from `data/v2.db` and writes a
 * markdown file at `groups/career-pilot/.claude-host-fragments/candidate.md`.
 * The composer (`src/claude-md-compose.ts`) picks the file up on its next
 * spawn and includes it as `@./.claude-host-fragments/candidate.md` in the
 * composed `CLAUDE.md` — see [.specs/NANOCLAW_INTERNALS.md §4](../../../.specs/NANOCLAW_INTERNALS.md)
 * for the composer extension and [.specs/STRATEGY.md §4](../../../.specs/STRATEGY.md)
 * for the hook contract + field-mapping spec.
 *
 * Called from `src/container-runner.ts:buildMounts()` *before*
 * `composeGroupClaudeMd()` so the host-fragment file is on disk when the
 * composer scans `.claude-host-fragments/`.
 *
 * Idempotent: same `candidate_profile` row → byte-identical `candidate.md`.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import type { AgentGroup } from '../../types.js';
import { projectWorkProfile, type WorkProfile } from '../portal/profile.js';

import { readProactiveGateConfig } from './quiet-hours.js';

/** Mirror of the `candidate_profile` table row. All fields nullable except `id`/`updated_at`. */
export interface CandidateProfile {
  id: 1;
  full_name: string | null;
  display_name: string | null;
  bio: string | null;
  target_roles: string | null; // JSON array as text
  location_pref: string | null; // JSON object as text
  comp_floor: number | null;
  master_resume: string | null;
  skills: string | null; // JSON array as text
  github_url: string | null;
  linkedin_url: string | null;
  x_url: string | null;
  website_url: string | null;
  search_goals: string | null; // the candidate's job-search goals (§24.101) — rendered into the owner persona's ## Goals
  headshot_path: string | null; // excluded (portal styling)
  brand_color_hsl: string | null; // excluded (portal styling)
  gmail_account: string | null; // Phase 2.3 (migration 108) — owner's Gmail address; OAuth refresh token lives in OneCLI vault
  protected_terms: string | null; // §24.134d (migration 141) — JSON array; the candidate's own employers/projects kept un-redacted on public kits. DERIVED from the résumé (not an onboarding step).
  work_profile_json: string | null; // migration 133 — the AI-composed /work-page WorkProfile (the canonical résumé source the download/tailored-PDF/honesty-floor all use); the public sandbox tailor reads THIS, not the thin master_resume (§24.145).
  updated_at: string;
}

const ONBOARDING_SENTINEL = [
  '# Onboarding mode (overrides other persona guidance this session)',
  '',
  "No candidate profile yet. Before anything else, onboard the candidate. The persona's",
  '"First contact: jump in" rule does NOT apply here — it\'s for returning users with',
  'a populated profile.',
  '',
  '**This turn, you do exactly one thing:** ask for their full name. One short sentence.',
  'No greeting menu, no capability list, no offering help.',
  '',
  'After they answer, call `update_profile_field` with `field="full_name"`,',
  '`value=<their answer>`. Then move on to the next field next turn.',
  '',
  'Onboarding order (one field per turn): full_name → target_roles → comp_floor →',
  'location_pref → master_resume (paste) → bio → search_goals',
  '',
  'Example first turn: "Hey — let\'s set you up. What\'s your full name?"',
  '',
].join('\n');

/**
 * Pure render: given a candidate profile (or null), produce the markdown
 * content for `candidate.md`. No filesystem, no DB. Test entrypoint.
 *
 * Returns the onboarding sentinel string when the profile is null or every
 * agent-relevant field is null/empty. Otherwise renders the populated
 * sections only — null fields are silently skipped.
 */
export function renderPersona(
  profile: CandidateProfile | null,
  quietHours?: { window: string; tz: string } | null,
): string {
  if (!profile) return ONBOARDING_SENTINEL;

  const targetRoles = parseJsonArray(profile.target_roles, 'target_roles');
  const skills = parseJsonArray(profile.skills, 'skills');
  const locationPref = parseLocationPref(profile.location_pref);

  const hasAnyContent =
    profile.full_name ||
    profile.bio ||
    targetRoles.length > 0 ||
    profile.comp_floor != null ||
    profile.master_resume ||
    skills.length > 0 ||
    profile.github_url ||
    profile.linkedin_url ||
    profile.x_url ||
    profile.website_url;
  if (!hasAnyContent) return ONBOARDING_SENTINEL;

  const sections: string[] = [];

  if (profile.full_name) {
    sections.push(`# ${profile.full_name}`);
  }

  if (profile.display_name && profile.display_name !== profile.full_name) {
    sections.push(`> ${profile.display_name}`);
  }

  if (profile.bio) {
    sections.push('## Background', profile.bio.trim());
  }

  if (targetRoles.length > 0) {
    sections.push('## Target roles', targetRoles.map((r) => `- ${r}`).join('\n'));
  }

  const locationSection = renderLocationSection(locationPref);
  if (locationSection) {
    sections.push(locationSection);
  }

  // The candidate's job-search goals (§24.101) — agent-facing so the owner agent
  // prioritizes toward them. Owner persona only; the public sandbox candidate
  // (renderSandboxCandidate) omits it — private goals don't belong in the demo.
  if (profile.search_goals) {
    sections.push('## Goals', profile.search_goals.trim());
  }

  if (profile.comp_floor != null) {
    sections.push('## Comp', `${formatUsd(profile.comp_floor)}/year floor`);
  }

  if (profile.master_resume) {
    sections.push('## Master resume', profile.master_resume.trim());
  }

  if (skills.length > 0) {
    sections.push('## Skills', skills.map((s) => `- ${s}`).join('\n'));
  }

  const links: string[] = [];
  if (profile.github_url) links.push(`- [GitHub](${profile.github_url})`);
  if (profile.linkedin_url) links.push(`- [LinkedIn](${profile.linkedin_url})`);
  if (profile.x_url) links.push(`- [X](${profile.x_url})`);
  if (profile.website_url) links.push(`- [Website](${profile.website_url})`);
  if (links.length > 0) {
    sections.push('## Links', links.join('\n'));
  }

  // Quiet hours (§24.52): the configured proactive-quiet window, so the agent's
  // own judgment for the host-ungated triggers (pipeline-scribe same-day push,
  // catch-up) uses the real value rather than a hardcoded default. The host
  // separately hard-gates killer-match on the same preference. Empty ⇒ omitted.
  if (quietHours && quietHours.window.trim()) {
    const zone = quietHours.tz.trim() || 'system zone';
    sections.push(
      '## Quiet hours',
      `${quietHours.window.trim()} (${zone}) — no proactive pings during this window; outside it, reach out normally.`,
    );
  }

  return sections.join('\n\n') + '\n';
}

/**
 * Sandbox sentinel (§24.54): the public simulator must never run the owner
 * onboarding flow. With no profile it pitches a clearly-disclosed generic
 * profile instead of asking the visitor for anything.
 */
const SANDBOX_NO_PROFILE_SENTINEL = [
  '# Candidate profile (not configured in this environment)',
  '',
  'No candidate profile is loaded. Run the pitch flow with a clearly-labeled',
  'GENERIC senior software engineer profile and disclose that in the deliverable',
  '("illustrative profile — the live system uses the real resume"). Never ask',
  'the visitor for profile data.',
  '',
].join('\n');

/**
 * Pure render for the PUBLIC simulator's candidate fragment (§24.54): the
 * resume-grade subset only — name, bio, target roles, location, master
 * resume, skills, links. Excludes comp floor (private negotiation state) and
 * quiet hours / ops content (owner-agent concerns). Test entrypoint.
 */
export function renderSandboxCandidate(profile: CandidateProfile | null): string {
  if (!profile) return SANDBOX_NO_PROFILE_SENTINEL;

  const targetRoles = parseJsonArray(profile.target_roles, 'target_roles');
  const skills = parseJsonArray(profile.skills, 'skills');
  const locationPref = parseLocationPref(profile.location_pref);
  // §24.145: the canonical résumé source. The composed /work-page WorkProfile is
  // what the Experience-page download, the tailored PDF, AND the honesty floor all
  // use — so the sandbox tailor reads it too (instead of the thinner, possibly
  // inconsistent master_resume) and only ever cites figures the floor can verify.
  // Falls back to master_resume when no /work page has been composed yet.
  const workProfile = projectWorkProfile(profile.work_profile_json);

  const hasAnyContent =
    profile.full_name ||
    profile.bio ||
    targetRoles.length > 0 ||
    workProfile ||
    profile.master_resume ||
    skills.length > 0 ||
    profile.github_url ||
    profile.linkedin_url ||
    profile.x_url ||
    profile.website_url;
  if (!hasAnyContent) return SANDBOX_NO_PROFILE_SENTINEL;

  const sections: string[] = [];

  if (profile.full_name) {
    sections.push(`# ${profile.full_name}`);
  }

  if (profile.display_name && profile.display_name !== profile.full_name) {
    sections.push(`> ${profile.display_name}`);
  }

  if (profile.bio) {
    sections.push('## Background', profile.bio.trim());
  }

  if (targetRoles.length > 0) {
    sections.push('## Target roles', targetRoles.map((r) => `- ${r}`).join('\n'));
  }

  const locationSection = renderLocationSection(locationPref);
  if (locationSection) {
    sections.push(locationSection);
  }

  // §24.145: prefer the composed WorkProfile (the canonical source) so the tailor
  // reads the same rich content the floor + PDFs use; fall back to master_resume.
  if (workProfile) {
    sections.push('## Master resume', workProfileToMarkdown(workProfile));
  } else if (profile.master_resume) {
    sections.push('## Master resume', profile.master_resume.trim());
  }

  if (skills.length > 0) {
    sections.push('## Skills', skills.map((s) => `- ${s}`).join('\n'));
  }

  // Approved figures (§24.72 honesty): the ONLY numbers the agent may cite, drawn
  // from the real résumé. The bio is mechanically re-checked against this set
  // host-side, but the cold-outreach email is free prose — this list curbs an
  // invented or unverifiable metric at the source for BOTH. §24.145: when a
  // composed WorkProfile exists, derive the list from IT (mirroring the floor's
  // masterNumbers exactly) so the allow-list and the floor agree by construction.
  const figures = workProfile ? approvedFiguresFromWorkProfile(workProfile) : approvedFigures(profile);
  if (figures.length > 0) {
    sections.push(
      '## Approved figures (honesty)',
      [
        'Every number or metric you cite — in the tailored résumé summary AND the',
        'cold-outreach email — must be one of these real figures from my résumé.',
        'Never invent, round, or approximate a metric (never write e.g. "60% faster"',
        'unless that exact number is below). When unsure, describe the impact in',
        'words, not a made-up number.',
        '',
        figures.join(' · '),
      ].join('\n'),
    );
  }

  const links: string[] = [];
  if (profile.github_url) links.push(`- [GitHub](${profile.github_url})`);
  if (profile.linkedin_url) links.push(`- [LinkedIn](${profile.linkedin_url})`);
  if (profile.x_url) links.push(`- [X](${profile.x_url})`);
  if (profile.website_url) links.push(`- [Website](${profile.website_url})`);
  if (links.length > 0) {
    sections.push('## Links', links.join('\n'));
  }

  return sections.join('\n\n') + '\n';
}

/** Distinct digit-number tokens (comma-normalized) in a blob of text — the honesty
 *  allow-list primitive. Mirrors the bio check's token extraction in
 *  tailored-resume.ts so the sandbox allow-list and the host floor agree. */
function distinctDigitTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = m.replace(/,/g, '');
    if (!seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** Approved figures from the candidate_profile text fields — the master_resume
 *  fallback path, used when no composed WorkProfile exists yet. */
function approvedFigures(profile: CandidateProfile): string[] {
  return distinctDigitTokens(
    [profile.master_resume ?? '', profile.bio ?? '', profile.skills ?? '', profile.target_roles ?? ''].join(' '),
  );
}

/** Approved figures from the composed WorkProfile (§24.145) — mirrors
 *  validateTailoredResume's `masterNumbers` field-for-field, so the sandbox's
 *  allow-list and the host honesty floor are derived from the SAME content and a
 *  number the model reads here is one the floor will verify. */
function approvedFiguresFromWorkProfile(wp: WorkProfile): string[] {
  return distinctDigitTokens(
    [
      wp.title,
      ...wp.bio,
      ...wp.lookingFor,
      ...wp.education,
      ...wp.skills,
      ...wp.experience.flatMap((e) => [e.role, e.company, e.period, ...e.bullets.map((b) => b.text)]),
      ...wp.projects.flatMap((p) => [p.name, p.description ?? '', ...(p.tags ?? [])]),
    ].join(' '),
  );
}

/** Render the composed WorkProfile (the canonical résumé source — §24.145) into
 *  the `## Master resume` body the sandbox tailor reads, so it sees the SAME rich
 *  content the /work download + the tailored PDF + the honesty floor use. */
function workProfileToMarkdown(wp: WorkProfile): string {
  const parts: string[] = [];
  if (wp.bio.length > 0) parts.push(wp.bio.join('\n\n'));
  if (wp.experience.length > 0) {
    parts.push('### Experience');
    for (const e of wp.experience) {
      const head = [e.role, e.company].filter((s) => s).join(' — ');
      parts.push(e.period ? `**${head}** (${e.period})` : `**${head}**`);
      if (e.bullets.length > 0) parts.push(e.bullets.map((b) => `- ${b.text}`).join('\n'));
    }
  }
  if (wp.projects.length > 0) {
    parts.push('### Projects');
    parts.push(wp.projects.map((p) => `- **${p.name}**${p.description ? ` — ${p.description}` : ''}`).join('\n'));
  }
  if (wp.education.length > 0) {
    parts.push('### Education', wp.education.map((ed) => `- ${ed}`).join('\n'));
  }
  return parts.join('\n\n');
}

interface LocationPref {
  type?: string[];
  preferred_cities?: string[];
}

/**
 * The persona `## Location` block from the canonical `location_pref` schema
 * (§24.100): `type` (the accepted arrangements — remote/hybrid/onsite) +
 * `preferred_cities`. Returns null when there's nothing to say, so a bare
 * `## Location` header never renders (the old `{remote, hybrid_cities}` reader
 * pushed an empty header when neither key was present — the agent then saw a
 * heading with no location guidance under it).
 */
function renderLocationSection(pref: LocationPref | null): string | null {
  if (!pref) return null;
  const lines: string[] = ['## Location'];
  const types = Array.isArray(pref.type) ? pref.type.filter((t): t is string => typeof t === 'string') : [];
  const cities = Array.isArray(pref.preferred_cities)
    ? pref.preferred_cities.filter((c): c is string => typeof c === 'string')
    : [];
  if (types.length > 0) {
    lines.push(`- Open to: ${types.join(', ')}`);
  }
  if (cities.length > 0) {
    lines.push('- Preferred cities:');
    for (const city of cities) {
      lines.push(`  - ${city}`);
    }
  }
  return lines.length > 1 ? lines.join('\n') : null;
}

function parseLocationPref(raw: string | null): LocationPref | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as LocationPref;
  } catch (err) {
    log.warn('candidate_profile.location_pref: malformed JSON, skipping section', { err });
    return null;
  }
}

function parseJsonArray(raw: string | null, fieldName: string): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      log.warn(`candidate_profile.${fieldName}: not an array, skipping`, { raw });
      return [];
    }
    return parsed.filter((v): v is string => typeof v === 'string');
  } catch (err) {
    log.warn(`candidate_profile.${fieldName}: malformed JSON, skipping`, { err });
    return [];
  }
}

const USD_FMT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

function formatUsd(n: number): string {
  return USD_FMT.format(n);
}

/**
 * Read the candidate_profile row and write `candidate.md` into the group's
 * `.claude-host-fragments/` directory. Called from `container-runner.ts`
 * before `composeGroupClaudeMd()`.
 *
 * Throws on disk write failure (the spawn will then fail at buildMounts and
 * host-sweep retries from `messages_in`). The DB read is tolerant — a
 * missing/empty row triggers the onboarding sentinel.
 */
export function renderPersonaForGroup(group: AgentGroup): void {
  const profile = readCandidateProfile();
  let quietHours: { window: string; tz: string } | null = null;
  if (profile) {
    try {
      const cfg = readProactiveGateConfig(getDb());
      quietHours = { window: cfg.quietHours, tz: cfg.quietHoursTz };
    } catch (err) {
      log.warn('render-persona: quiet-hours config read failed, omitting the section', { err });
    }
  }
  const body = renderPersona(profile, quietHours);
  writeCandidateFragment(group, body);
}

/**
 * Sandbox variant of the spawn hook (§24.54): write the PUBLIC candidate
 * subset into the sandbox group's `.claude-host-fragments/candidate.md` so
 * tailor-resume/draft-outreach have the resume-grade facts a live run needs.
 * Called from `container-runner.ts` for the `career-pilot-sandbox` folder.
 */
export function renderSandboxCandidateForGroup(group: AgentGroup): void {
  const profile = readCandidateProfile();
  writeCandidateFragment(group, renderSandboxCandidate(profile));
}

function writeCandidateFragment(group: AgentGroup, body: string): void {
  const fragmentsDir = path.join(GROUPS_DIR, group.folder, '.claude-host-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  const outPath = path.join(fragmentsDir, 'candidate.md');
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  fs.writeFileSync(tmpPath, body);
  fs.renameSync(tmpPath, outPath);

  log.debug('Rendered candidate.md', {
    group: group.folder,
    bytes: body.length,
  });
}

export function readCandidateProfile(): CandidateProfile | null {
  try {
    const row = getDb().prepare('SELECT * FROM candidate_profile WHERE id = 1').get() as CandidateProfile | undefined;
    return row ?? null;
  } catch (err) {
    // The `candidate_profile` table only exists after migration 105 runs.
    // If we're called before migrations (shouldn't happen — index.ts runs
    // migrations before any spawn path), or in a test fixture without the
    // schema, fall back to onboarding-mode rendering.
    log.warn('candidate_profile read failed, falling back to onboarding sentinel', { err });
    return null;
  }
}
