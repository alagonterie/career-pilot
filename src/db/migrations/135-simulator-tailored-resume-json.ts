/**
 * Migration 135 — simulator_runs.tailored_resume_json (STRATEGY.md §24.72 / 9.4b-r2).
 *
 * Tier 2 (the tailored résumé): the sandbox emits a STRUCTURED tailored
 * `WorkProfile` (via the read-only `emit_tailored_resume` tool, validated against
 * the candidate's master profile by the mechanical honesty guardrail), stashed
 * here so `GET /api/simulator/results/<id>/resume.pdf` renders it through the
 * Tier-1 PDF engine. Nullable + additive: pre-r2 rows — and runs where the agent
 * never emitted a valid tailored profile — simply have no downloadable résumé.
 *
 * Schema reference: STRATEGY.md §24.72 (9.4b-r2 build plan).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration135: Migration = {
  version: 135,
  name: 'career-pilot-simulator-tailored-resume-json',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE simulator_runs ADD COLUMN tailored_resume_json TEXT;`);
  },
};
