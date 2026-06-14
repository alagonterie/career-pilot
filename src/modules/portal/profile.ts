/**
 * src/modules/portal/profile.ts — the public `/work` profile projection
 * (STRATEGY.md §24.71 / Phase 9.4b-1).
 *
 * `GET /api/profile` serves the candidate's resume/portfolio content for the
 * `/work` page + the landing hero. Per §24.71 D1 the agent COMPOSES that page at
 * write-time into the frontend's `WorkProfile` shape and persists it as
 * `candidate_profile.work_profile_json`; this module projects that blob
 * deterministically at read-time — no LLM, no per-visitor cost (the §24.70
 * vector). When the blob is absent or malformed we return `profile: null`, and
 * the frontend falls back to its typed placeholder (the de-`Jane Doe` win lands
 * the moment the blob is populated — by the composer, or hand-seeded in 9.4b-1).
 *
 * This file reads ONLY `candidate_profile` (already host-private) and emits ONLY
 * the resume-grade view the owner intends for the public page — it carries no
 * private negotiation state (comp floor, gmail, etc.).
 *
 * The projector is tolerant: a partial seed (missing arrays) still renders, with
 * unset sections degrading per PORTAL §12 rather than erroring. It is pure +
 * exported for tests.
 */
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';

export interface ExperienceEntry {
  role: string;
  company: string;
  period: string;
  bullets: string[];
}

export interface ProjectEntry {
  name: string;
  description: string;
  href?: string;
  tags?: string[];
}

export interface WritingEntry {
  title: string;
  venue?: string;
  href?: string;
}

export interface SocialLinks {
  github?: string;
  linkedin?: string;
  x?: string;
  blog?: string;
}

/** Mirrors the frontend `WorkProfile` (frontend/src/lib/work-profile.ts) — the
 *  agent's compose OUTPUT contract (§24.71 D2). Kept structurally identical so
 *  the projection is a verbatim hand-off. */
export interface WorkProfile {
  name: string;
  title: string;
  bio: string[];
  lookingFor: string[];
  experience: ExperienceEntry[];
  projects: ProjectEntry[];
  writing?: WritingEntry[];
  skills: string[];
  education: string[];
  links: SocialLinks;
}

export interface ProfileResponse {
  /** The composed page, or null when not configured (→ frontend placeholder). */
  profile: WorkProfile | null;
  /** Provenance for the §24.71 D4 on-page marker (9.4b-2). Null when no blob. */
  generated_at: string | null;
  source: string | null;
}

interface WorkPageRow {
  work_profile_json: string | null;
  work_profile_generated_at: string | null;
  work_profile_source: string | null;
}

/** A JSON object, narrowed. */
type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}

/** Keep only the string members of an array; non-arrays → []. */
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}

/** An optional string — emitted only when it's a non-empty string. */
function optString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function projectExperience(v: unknown): ExperienceEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).map((e) => ({
    role: asString(e.role),
    company: asString(e.company),
    period: asString(e.period),
    bullets: asStringArray(e.bullets),
  }));
}

function projectProjects(v: unknown): ProjectEntry[] {
  if (!Array.isArray(v)) return [];
  return v.filter(isObject).map((p) => {
    const entry: ProjectEntry = {
      name: asString(p.name),
      description: asString(p.description),
    };
    const href = optString(p.href);
    if (href) entry.href = href;
    const tags = asStringArray(p.tags);
    if (tags.length > 0) entry.tags = tags;
    return entry;
  });
}

function projectWriting(v: unknown): WritingEntry[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const entries = v.filter(isObject).map((w) => {
    const entry: WritingEntry = { title: asString(w.title) };
    const venue = optString(w.venue);
    if (venue) entry.venue = venue;
    const href = optString(w.href);
    if (href) entry.href = href;
    return entry;
  });
  return entries.length > 0 ? entries : undefined;
}

function projectLinks(v: unknown): SocialLinks {
  if (!isObject(v)) return {};
  const links: SocialLinks = {};
  const github = optString(v.github);
  if (github) links.github = github;
  const linkedin = optString(v.linkedin);
  if (linkedin) links.linkedin = linkedin;
  const x = optString(v.x);
  if (x) links.x = x;
  const blog = optString(v.blog);
  if (blog) links.blog = blog;
  return links;
}

/**
 * Pure projection: a stored `work_profile_json` string → a `WorkProfile`, or
 * null when absent/malformed/nameless. Tolerant — missing fields coerce to safe
 * defaults so a partial seed renders (unset sections degrade per PORTAL §12).
 * The one hard requirement is a non-empty `name` (without it there is no page).
 * Exported for tests.
 */
export function projectWorkProfile(raw: string | null): WorkProfile | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.warn('candidate_profile.work_profile_json: malformed JSON, falling back to placeholder', { err });
    return null;
  }
  if (!isObject(parsed)) return null;
  const name = asString(parsed.name).trim();
  if (!name) return null;

  const profile: WorkProfile = {
    name,
    title: asString(parsed.title),
    bio: asStringArray(parsed.bio),
    lookingFor: asStringArray(parsed.lookingFor),
    experience: projectExperience(parsed.experience),
    projects: projectProjects(parsed.projects),
    skills: asStringArray(parsed.skills),
    education: asStringArray(parsed.education),
    links: projectLinks(parsed.links),
  };
  const writing = projectWriting(parsed.writing);
  if (writing) profile.writing = writing;
  return profile;
}

/**
 * Read the single `candidate_profile` row's work-page columns and project them.
 * Tolerant of a pre-migration-133 DB (the columns/table may not exist in a bare
 * test fixture) — falls back to the empty/null response, never throws.
 */
export function getPublicProfile(): ProfileResponse {
  let row: WorkPageRow | undefined;
  try {
    row = getDb()
      .prepare(
        `SELECT work_profile_json, work_profile_generated_at, work_profile_source
           FROM candidate_profile WHERE id = 1`,
      )
      .get() as WorkPageRow | undefined;
  } catch (err) {
    log.warn('getPublicProfile: candidate_profile read failed, serving empty profile', { err });
    return { profile: null, generated_at: null, source: null };
  }
  if (!row) return { profile: null, generated_at: null, source: null };

  const profile = projectWorkProfile(row.work_profile_json);
  return {
    profile,
    generated_at: profile ? row.work_profile_generated_at : null,
    source: profile ? row.work_profile_source : null,
  };
}
