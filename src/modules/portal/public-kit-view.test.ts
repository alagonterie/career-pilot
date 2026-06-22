/**
 * public_kit_view projection (§24.65):
 *   - obfuscated app → safe sections render sanitized, identifying/gap/unknown
 *     sections are SEALED (count + caption, never text)
 *   - public app → every section renders (its own name un-redacted)
 *   - policy flip re-projects BOTH directions
 *   - defense-in-depth: a surviving non-public company name seals the section
 *   - NULL markdown → metadata-only row; vanished kits/apps clear their rows
 *   - the §24.65 hard invariant: no kit title / drive_url / unsanitized company
 *     name ever lands in the projection
 *   - public_pipeline_view.kits_json carries the drawer metadata (all kits, D1)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { upsertInterviewKit } from '../career-pilot/interview-kit-store.js';

import { __resetEntityRedactStateForTests } from './kit-entity-redact.js';
import { type PublicKitSection, upsertPublicKitView } from './public-kit-view.js';
import { upsertPublicPipelineView } from './public-pipeline-view.js';

let db: Database.Database;

beforeEach(() => {
  closeDb();
  db = initTestDb();
  runMigrations(db);
});

const KIT_MD = `## Part 1 — Interviewer operating manual

### Your role
Conduct a realistic technical screen for Senior Platform Engineer at Initech Systems.

### Scoring rubric
- Problem decomposition — strong: names subproblems unprompted.
- Tradeoff reasoning — strong: failure modes first.

### Question themes
- Multi-region failover (JD: "design for regional outage").

### Grounding + caveats
- Series B, $40M raised in April.
- Stack: Go, Kafka.

### Gap notes (probe these honestly)
- JD wants Kubernetes operators; resume shows Helm only.

## Part 2 — Candidate quick-reference

### Recent signal
- Launched the realtime product last month.

### Lean into
- The 40% latency win on the ingestion pipeline.

### Questions to ask
- How is the operator rollout sequenced?
`;

function seedApp(opts: { id: string; company: string; label: string; public_state?: string }): void {
  db.prepare(
    `INSERT INTO applications (id, company_name, obfuscated_label, public_state, role_title, status, created_at)
     VALUES (@id, @company, @label, @public_state, 'Senior Platform Engineer', 'TECH_SCREEN', '2026-06-01T00:00:00Z')`,
  ).run({ id: opts.id, company: opts.company, label: opts.label, public_state: opts.public_state ?? 'obfuscated' });
}

function seedKit(appId: string, round = 'TECH_SCREEN', markdown: string | null = KIT_MD): void {
  upsertInterviewKit(db, {
    application_id: appId,
    round,
    interview_type: 'technical_screen',
    drive_file_id: 'drive-file-123',
    drive_url: 'https://docs.google.com/document/d/drive-file-123/edit',
    title: `Interview Kit — Initech Systems — ${round} — 2026-06-10`,
    interview_at: '2026-06-15T17:00:00Z',
    markdown,
  });
}

function readSections(appId: string, round = 'TECH_SCREEN'): PublicKitSection[] {
  const row = db
    .prepare('SELECT sections_json FROM public_kit_view WHERE application_id = ? AND round = ?')
    .get(appId, round) as { sections_json: string } | undefined;
  expect(row).toBeDefined();
  return JSON.parse(row!.sections_json) as PublicKitSection[];
}

function byId(sections: PublicKitSection[], id: string): PublicKitSection {
  const s = sections.find((x) => x.id === id);
  expect(s, `section ${id}`).toBeDefined();
  return s!;
}

describe('upsertPublicKitView (§24.65)', () => {
  it('obfuscated app: safe sections render sanitized; identifying/gap sections are sealed with counts', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1');
    await upsertPublicKitView(db, 'app-1');

    const sections = readSections('app-1');

    const role = byId(sections, 'your-role');
    expect(role.kind).toBe('content');
    // Pass 2 redacted the company name in the safe body.
    expect(role.body).toContain('[REDACTED:fintech-a]');
    expect(role.body).not.toMatch(/initech/i);

    expect(byId(sections, 'scoring-rubric')).toMatchObject({ kind: 'content', item_count: 2 });
    expect(byId(sections, 'lean-into').kind).toBe('content');

    for (const id of ['question-themes', 'grounding', 'recent-signal', 'questions-to-ask']) {
      const s = byId(sections, id);
      expect(s.kind).toBe('withheld');
      expect(s.body).toBeUndefined();
      expect(s.withheld_reason).toMatch(/sealed/);
      expect(s.item_count).toBeGreaterThan(0);
    }
    expect(byId(sections, 'grounding').withheld_reason).toContain('2 grounding facts');
    expect(byId(sections, 'gap-notes')).toMatchObject({ kind: 'withheld' });
    expect(byId(sections, 'gap-notes').withheld_reason).toMatch(/probed/);
  });

  it('public app: every section renders, its own company name un-redacted', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a', public_state: 'public' });
    seedKit('app-1');
    await upsertPublicKitView(db, 'app-1');

    const sections = readSections('app-1');
    expect(sections.every((s) => s.kind === 'content')).toBe(true);
    expect(byId(sections, 'your-role').body).toContain('Initech Systems');
    expect(byId(sections, 'gap-notes').body).toContain('Kubernetes operators');
  });

  it('re-projects both directions of a policy flip (reveal fills in, un-reveal re-seals)', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1');
    await upsertPublicKitView(db, 'app-1');
    expect(byId(readSections('app-1'), 'gap-notes').kind).toBe('withheld');

    db.prepare(`UPDATE applications SET public_state = 'public' WHERE id = 'app-1'`).run();
    await upsertPublicKitView(db, 'app-1');
    expect(byId(readSections('app-1'), 'gap-notes').kind).toBe('content');

    db.prepare(`UPDATE applications SET public_state = 'obfuscated' WHERE id = 'app-1'`).run();
    await upsertPublicKitView(db, 'app-1');
    expect(byId(readSections('app-1'), 'gap-notes').kind).toBe('withheld');
  });

  it('unknown sections are sealed with a generic title (the authored heading could itself identify)', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1', 'TECH_SCREEN', '### Why Initech Systems is exciting\n- because reasons\n');
    await upsertPublicKitView(db, 'app-1');

    const sections = readSections('app-1');
    expect(sections).toHaveLength(1);
    expect(sections[0].kind).toBe('withheld');
    expect(sections[0].title).toBe('Additional section');
    expect(JSON.stringify(sections)).not.toMatch(/initech/i);
  });

  it('defense-in-depth: a non-public company name surviving sanitization seals a safe section', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    // Another live application whose name survives Pass 2 inside a compound
    // token (word-boundary replace misses "ZorblaxIO"; the substring scan doesn't).
    seedApp({ id: 'app-2', company: 'Zorblax', label: 'ai-infra-a' });
    seedKit('app-1', 'TECH_SCREEN', '### Your role\nDiscuss the ZorblaxIO migration calmly.\n');
    await upsertPublicKitView(db, 'app-1');

    const sections = readSections('app-1');
    expect(sections[0]).toMatchObject({ id: 'your-role', kind: 'withheld' });
    expect(sections[0].withheld_reason).toMatch(/could not verify/);
    expect(JSON.stringify(sections)).not.toMatch(/zorblax/i);
  });

  it('defense-in-depth scans ALIASES too — the legal-name-vs-short-form gap (§24.65 Δ)', async () => {
    // The shape found live on dev during the backfill: company_name is the
    // legal name, the kit prose says the short form. The scan's alias leg is
    // what catches it (here inside a compound token Pass 2's word-boundary
    // replace also misses).
    seedApp({ id: 'app-1', company: 'Advanced Micro Devices, Inc', label: 'misc-a' });
    db.prepare(`UPDATE applications SET company_aliases = '["AMD"]' WHERE id = 'app-1'`).run();
    seedKit('app-1', 'TECH_SCREEN', '### Your role\nDiscuss AMDGPU kernel scheduling tradeoffs.\n');
    await upsertPublicKitView(db, 'app-1');

    const sections = readSections('app-1');
    expect(sections[0]).toMatchObject({ id: 'your-role', kind: 'withheld' });
    expect(JSON.stringify(sections)).not.toMatch(/amd/i);
  });

  it('NULL markdown (pre-§24.65 kit) projects a metadata-only row', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1', 'TECH_SCREEN', null);
    await upsertPublicKitView(db, 'app-1');
    expect(readSections('app-1')).toEqual([]);
  });

  it('clears rows for vanished kits and vanished applications', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1', 'SCREENING');
    seedKit('app-1', 'TECH_SCREEN');
    await upsertPublicKitView(db, 'app-1');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM public_kit_view WHERE application_id = 'app-1'`).get()).toEqual({
      n: 2,
    });

    db.prepare(`DELETE FROM interview_kits WHERE application_id = 'app-1' AND round = 'SCREENING'`).run();
    await upsertPublicKitView(db, 'app-1');
    expect(db.prepare(`SELECT round FROM public_kit_view WHERE application_id = 'app-1'`).all()).toEqual([
      { round: 'TECH_SCREEN' },
    ]);

    db.prepare(`DELETE FROM interview_kits WHERE application_id = 'app-1'`).run();
    db.prepare(`DELETE FROM applications WHERE id = 'app-1'`).run();
    await upsertPublicKitView(db, 'app-1');
    expect(db.prepare(`SELECT COUNT(*) AS n FROM public_kit_view`).get()).toEqual({ n: 0 });
  });

  it('hard invariant: no kit title or drive identifier ever lands in the projection', async () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1');
    await upsertPublicKitView(db, 'app-1');

    const row = db.prepare(`SELECT * FROM public_kit_view WHERE application_id = 'app-1'`).get();
    const flat = JSON.stringify(row);
    expect(flat).not.toContain('drive-file-123');
    expect(flat).not.toContain('docs.google.com');
    expect(flat).not.toContain('Interview Kit —');
    expect(flat).not.toMatch(/initech/i); // obfuscated app → its name appears nowhere
  });
});

describe('public_pipeline_view.kits_json (§24.65 drawer metadata)', () => {
  it('carries all kits incl. archived, with has_content flags and no titles/urls', () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1', 'SCREENING');
    seedKit('app-1', 'TECH_SCREEN', null);
    db.prepare(
      `UPDATE interview_kits SET status = 'archived', archived_at = '2026-06-10T00:00:00Z' WHERE round = 'SCREENING'`,
    ).run();

    upsertPublicPipelineView(db, 'app-1');
    const row = db.prepare(`SELECT kits_json FROM public_pipeline_view WHERE application_id = 'app-1'`).get() as {
      kits_json: string;
    };
    const kits = JSON.parse(row.kits_json) as Array<Record<string, unknown>>;
    expect(kits).toHaveLength(2);
    expect(kits[0]).toMatchObject({ round: 'SCREENING', status: 'archived', has_content: true });
    expect(kits[1]).toMatchObject({ round: 'TECH_SCREEN', status: 'active', has_content: false });
    expect(row.kits_json).not.toContain('docs.google.com');
    expect(row.kits_json).not.toMatch(/initech/i);
  });

  it('stays null for applications with no kits', () => {
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    upsertPublicPipelineView(db, 'app-1');
    const row = db.prepare(`SELECT kits_json FROM public_pipeline_view WHERE application_id = 'app-1'`).get() as {
      kits_json: string | null;
    };
    expect(row.kits_json).toBeNull();
  });
});

// §24.134a — the entity-redaction belt only engages when Portkey is configured
// (key present) AND the pref is on (default). It runs on rendered 'safe'
// sections of a LIVE app. A codename that Pass 2 can't see (it isn't the company
// name/alias) gets redacted; a detector failure SEALS the section (fail-safe).
describe('upsertPublicKitView entity belt (§24.134a)', () => {
  // A 'safe' lean-into section naming a company-specific codename next to the
  // company. Pass 2 redacts the company name but not the codename — that's the
  // gap the belt closes.
  const KIT_WITH_CODENAME = `## Part 1 — Interviewer operating manual

### Your role
Conduct a realistic technical screen for Senior Platform Engineer at Initech Systems.

### Lean into
- Initech Systems's Helios (Rust) proxy layer is exactly your distributed-systems wheelhouse.
`;

  const savedKey = process.env.PORTKEY_API_KEY;
  const savedBypass = process.env.PORTKEY_BYPASS;

  beforeEach(() => {
    __resetEntityRedactStateForTests();
    process.env.PORTKEY_API_KEY = 'pk-test';
    delete process.env.PORTKEY_BYPASS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.PORTKEY_API_KEY;
    else process.env.PORTKEY_API_KEY = savedKey;
    if (savedBypass === undefined) delete process.env.PORTKEY_BYPASS;
    else process.env.PORTKEY_BYPASS = savedBypass;
  });

  function stubDetector(content: string): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content } }] }),
      })) as unknown as typeof fetch,
    );
  }

  it('redacts a codename the deterministic passes miss, keeping generic tech', async () => {
    stubDetector('["Helios"]');
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1', 'TECH_SCREEN', KIT_WITH_CODENAME);
    await upsertPublicKitView(db, 'app-1');

    const lean = byId(readSections('app-1'), 'lean-into');
    expect(lean.kind).toBe('content');
    expect(lean.body).not.toContain('Helios'); // belt caught it
    expect(lean.body).toContain('[AI_REDACTED]');
    expect(lean.body).toContain('Rust'); // generic tech preserved
    expect(lean.body).not.toMatch(/initech/i); // Pass 2 still did its job
  });

  it('seals the section when the detector call fails (fail-safe)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch,
    );
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a' });
    seedKit('app-1', 'TECH_SCREEN', KIT_WITH_CODENAME);
    await upsertPublicKitView(db, 'app-1');

    const lean = byId(readSections('app-1'), 'lean-into');
    expect(lean.kind).toBe('withheld');
    expect(lean.body).toBeUndefined();
    // and the codename certainly never reached the wire
    expect(JSON.stringify(readSections('app-1'))).not.toContain('Helios');
  });

  it('public app does NOT invoke the belt (no key needed; own name revealed)', async () => {
    // belt is gated on !isPublic — a revealed app renders everything verbatim.
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
    seedApp({ id: 'app-1', company: 'Initech Systems', label: 'fintech-a', public_state: 'public' });
    seedKit('app-1', 'TECH_SCREEN', KIT_WITH_CODENAME);
    await upsertPublicKitView(db, 'app-1');

    const lean = byId(readSections('app-1'), 'lean-into');
    expect(lean.kind).toBe('content');
    expect(lean.body).toContain('Helios'); // revealed → verbatim
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
