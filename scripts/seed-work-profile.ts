/**
 * scripts/seed-work-profile.ts — hand-seed `candidate_profile` from a JSON file
 * (STRATEGY §24.157 / the A4 master-résumé seed).
 *
 * The JSON (REAL PII — never committed) is `{ identity, work_profile }`:
 *   - `work_profile` → `candidate_profile.work_profile_json` (source='seed') — the
 *     blob the §24.71 projector + the §24.72 résumé PDF + `/experience` render.
 *   - `identity` → the canonical identity columns (public_email/github/linkedin/
 *     x/website) that drive the PDF contact line + the sitewide footer socials.
 *
 * Opens the DB by explicit path (the `scripts/q.ts` convention) and runs
 * migrations first (idempotent — a no-op on the up-to-date box, schema-building
 * on a fresh/stale DB), so it's safe to point at the dev box now and prod later
 * with the SAME json file (no drift). Source='seed' deliberately: the
 * `/experience` "composed by my agent" marker stays honest (§24.71 D4) until the
 * orchestrator genuinely re-composes it.
 *
 * Usage: pnpm exec tsx scripts/seed-work-profile.ts <db-path> <work-profile.json>
 */
import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';

import { runMigrations } from '../src/db/migrations/index.js';

const [dbPath, jsonPath] = process.argv.slice(2);
if (!dbPath || !jsonPath) {
  console.error('Usage: pnpm exec tsx scripts/seed-work-profile.ts <db-path> <work-profile.json>');
  process.exit(1);
}

const parsed = JSON.parse(readFileSync(jsonPath, 'utf8')) as {
  identity?: Record<string, string | null | undefined>;
  work_profile?: { name?: unknown };
};
const identity = parsed.identity ?? {};
const wp = parsed.work_profile;
if (!wp || typeof wp.name !== 'string' || !wp.name.trim()) {
  console.error('JSON must carry a non-empty work_profile.name');
  process.exit(1);
}

const db = new Database(dbPath);
runMigrations(db);

const now = new Date().toISOString();
const blob = JSON.stringify(wp);

db.prepare(
  `INSERT INTO candidate_profile (id, work_profile_json, work_profile_source, work_profile_generated_at,
                                  public_email, github_url, linkedin_url, x_url, website_url, updated_at)
   VALUES (1, @blob, 'seed', @now, @email, @github, @linkedin, @x, @website, @now)
   ON CONFLICT(id) DO UPDATE SET
     work_profile_json = @blob, work_profile_source = 'seed', work_profile_generated_at = @now,
     public_email = @email, github_url = @github, linkedin_url = @linkedin,
     x_url = @x, website_url = @website, updated_at = @now`,
).run({
  blob,
  now,
  email: identity.public_email ?? null,
  github: identity.github_url ?? null,
  linkedin: identity.linkedin_url ?? null,
  x: identity.x_url ?? null,
  website: identity.website_url ?? null,
});

console.log(
  `Seeded candidate_profile id=1 -> ${(wp as { name: string }).name} · ` +
    `${blob.length}B work_profile_json · source=seed @ ${now}`,
);
