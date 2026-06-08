import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  isRecruiterSimEnv,
  loadState,
  readRealSeedJobs,
  reconcileState,
  saveState,
  seedApplicationRow,
  simIndustryFromRole,
} from './runner.js';
import type { SeedApplicationIntent, SimApp, SimState } from './types.js';

function appsDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE applications (
      id TEXT PRIMARY KEY, company_name TEXT NOT NULL, company_aliases TEXT,
      obfuscated_label TEXT NOT NULL, public_state TEXT NOT NULL DEFAULT 'obfuscated',
      role_title TEXT NOT NULL, job_url TEXT, jd_text TEXT, jd_analyzed TEXT,
      status TEXT NOT NULL, win_confidence INTEGER, applied_at TEXT, last_activity_at TEXT,
      created_at TEXT NOT NULL
    );`);
  return db;
}

function fakeApp(id: string): SimApp {
  return {
    appId: id,
    company: 'Meridian Labs',
    role: 'Backend Engineer',
    obfuscatedLabel: 'Series B startup',
    fromName: 'Meridian Labs Talent',
    fromAddress: 'talent@meridianlabs.example',
    threadId: null,
    lastMessageId: null,
    stageIndex: 0,
    status: 'active',
    outcome: null,
    createdAtMs: 0,
    nextFireAtMs: 0,
    realCursorMs: 0,
  };
}

const seedIntent: SeedApplicationIntent = {
  type: 'seed_application',
  appId: 'sim-acme',
  companyName: 'Meridian Labs',
  obfuscatedLabel: 'Series B startup',
  roleTitle: 'Backend Engineer',
  jdText: 'Own backend services and APIs; Go/Rust + PostgreSQL.',
  appliedAtMs: Date.UTC(2026, 4, 20),
};

const tmpFiles: string[] = [];
function tmpFile(): string {
  const f = path.join(os.tmpdir(), `recruiter-sim-${Math.random().toString(36).slice(2)}.json`);
  tmpFiles.push(f);
  return f;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.unlinkSync(f);
    } catch {
      /* ignore */
    }
  }
});

describe('recruiter-sim runner helpers', () => {
  it('seedApplicationRow inserts an obfuscated, applied row and is idempotent', () => {
    const db = appsDb();
    seedApplicationRow(db, seedIntent);
    seedApplicationRow(db, seedIntent); // INSERT OR IGNORE — no duplicate / no throw
    const rows = db.prepare('SELECT * FROM applications WHERE id = ?').all(seedIntent.appId) as Array<{
      status: string;
      public_state: string;
      company_name: string;
      jd_text: string | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('applied');
    expect(rows[0].public_state).toBe('obfuscated');
    expect(rows[0].company_name).toBe('Meridian Labs');
    expect(rows[0].jd_text).toContain('backend services'); // the seeded JD drives fit scoring
  });

  it('reconcileState drops sim apps whose application row is gone (post reset:dev)', () => {
    const db = appsDb();
    seedApplicationRow(db, seedIntent);
    const state: SimState = { apps: [fakeApp('sim-acme'), fakeApp('sim-vanished')], lastSeedAtMs: 5 };
    const reconciled = reconcileState(db, state);
    expect(reconciled.apps.map((a) => a.appId)).toEqual(['sim-acme']);
    expect(reconciled.lastSeedAtMs).toBe(5);
  });

  it('loadState/saveState round-trips and tolerates a missing/corrupt file', () => {
    const file = tmpFile();
    expect(loadState(file)).toEqual({ apps: [], lastSeedAtMs: 0 }); // missing → empty
    const state: SimState = { apps: [fakeApp('sim-1')], lastSeedAtMs: 42 };
    saveState(file, state);
    expect(loadState(file)).toEqual(state);
    fs.writeFileSync(file, '{ not json');
    expect(loadState(file)).toEqual({ apps: [], lastSeedAtMs: 0 }); // corrupt → empty
  });

  it('isRecruiterSimEnv is true only for ENVIRONMENT=dev', () => {
    const saved = process.env.ENVIRONMENT;
    try {
      process.env.ENVIRONMENT = 'dev';
      expect(isRecruiterSimEnv()).toBe(true);
      process.env.ENVIRONMENT = 'production';
      expect(isRecruiterSimEnv()).toBe(false);
      delete process.env.ENVIRONMENT;
      expect(isRecruiterSimEnv()).toBe(false);
    } finally {
      if (saved === undefined) delete process.env.ENVIRONMENT;
      else process.env.ENVIRONMENT = saved;
    }
  });
});

describe('recruiter-sim real-jobs source (D16)', () => {
  it('simIndustryFromRole maps roles to a descriptive, non-empty industry slug', () => {
    expect(simIndustryFromRole('Senior Software Engineer - Infrastructure', '')).toBe('infra');
    expect(simIndustryFromRole('ML Engineer', 'LLM and deep learning systems')).toBe('ai');
    expect(simIndustryFromRole('Senior Backend Engineer', 'APIs and services')).toBe('swe');
  });

  it('readRealSeedJobs returns recent open leads — one per company, excluding closed + in-flight', () => {
    const db = new Database(':memory:');
    db.exec(
      `CREATE TABLE job_leads (id TEXT PRIMARY KEY, company TEXT NOT NULL, title TEXT NOT NULL,
        description_text TEXT, closed_at TEXT, first_seen_at TEXT NOT NULL);`,
    );
    const ins = db.prepare(
      'INSERT INTO job_leads (id, company, title, description_text, closed_at, first_seen_at) VALUES (?,?,?,?,?,?)',
    );
    ins.run('l1', 'GEICO', 'Senior Backend Engineer', 'Build infra', null, '2026-06-08T10:00:00Z');
    ins.run('l2', 'GEICO', 'Platform Engineer', 'Infra', null, '2026-06-08T09:00:00Z'); // dup company → deduped
    ins.run('l3', 'NVIDIA', 'AI Infra Engineer', 'CUDA', null, '2026-06-08T08:00:00Z');
    ins.run('l4', 'Stripe', 'Backend', 'Payments', '2026-06-07T00:00:00Z', '2026-06-08T07:00:00Z'); // closed
    ins.run('l5', 'InFlightCo', 'Engineer', 'x', null, '2026-06-08T06:00:00Z'); // already in flight

    const out = readRealSeedJobs(db, new Set(['inflightco']));
    const companies = out.map((j) => j.company);
    expect(companies).toContain('GEICO');
    expect(companies).toContain('NVIDIA');
    expect(companies).not.toContain('Stripe'); // closed
    expect(companies).not.toContain('InFlightCo'); // in flight
    expect(companies.filter((c) => c === 'GEICO')).toHaveLength(1); // one per company
    expect(out.every((j) => j.role.length > 0)).toBe(true);
  });
});
