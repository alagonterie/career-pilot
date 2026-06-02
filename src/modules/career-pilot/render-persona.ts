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
  why_this_exists: string | null; // excluded from agent context (portal-only)
  headshot_path: string | null; // excluded (portal styling)
  brand_color_hsl: string | null; // excluded (portal styling)
  gmail_account: string | null; // Phase 2.3 (migration 108) — owner's Gmail address; OAuth refresh token lives in OneCLI vault
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
  'master_resume (paste) → bio → why_this_exists',
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
export function renderPersona(profile: CandidateProfile | null): string {
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

  if (locationPref) {
    const lines: string[] = ['## Location'];
    if (typeof locationPref.remote === 'boolean') {
      lines.push(`- Remote: ${locationPref.remote ? 'yes' : 'no'}`);
    }
    if (locationPref.hybrid_cities && locationPref.hybrid_cities.length > 0) {
      lines.push('- Hybrid cities:');
      for (const city of locationPref.hybrid_cities) {
        lines.push(`  - ${city}`);
      }
    }
    sections.push(lines.join('\n'));
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

  return sections.join('\n\n') + '\n';
}

interface LocationPref {
  remote?: boolean;
  hybrid_cities?: string[];
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
  const body = renderPersona(profile);

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
    onboarding: profile === null,
  });
}

function readCandidateProfile(): CandidateProfile | null {
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
