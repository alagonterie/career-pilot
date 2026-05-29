/**
 * Unit + integration tests for the Phase 4 §24.10 sanitizer.
 *
 * Pass 1 is pure-function regex; no DB needed. Pass 2 + `sanitize`
 * touch an in-memory central DB with the applications table seeded.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';

import { applyPass1, applyPass2, applyPass3, sanitize } from './sanitizer.js';

describe('sanitizer Pass 1 — regex patterns', () => {
  describe('emails', () => {
    it('redacts a simple email', () => {
      expect(applyPass1('contact alice@example.com today')).toBe(
        'contact [EMAIL_REDACTED] today',
      );
    });

    it('redacts plus-addressed + cross-TLD emails', () => {
      const t = 'recruiter+job@acme.co.uk and bob@anthropic.org';
      expect(applyPass1(t)).toBe(
        '[EMAIL_REDACTED] and [EMAIL_REDACTED]',
      );
    });

    it('leaves bare @mention untouched', () => {
      expect(applyPass1('cc @jane on this thread')).toBe('cc @jane on this thread');
    });
  });

  describe('phones', () => {
    it('redacts NA-style numbers in several shapes', () => {
      expect(applyPass1('call (555) 123-4567 or 555.987.6543 or +1-555-111-2222')).toBe(
        'call [PHONE_REDACTED] or [PHONE_REDACTED] or [PHONE_REDACTED]',
      );
    });

    it('redacts an international number', () => {
      expect(applyPass1('Sarah at +442012345678 confirmed')).toBe(
        'Sarah at [PHONE_REDACTED] confirmed',
      );
    });

    it('leaves year-like sequences untouched', () => {
      expect(applyPass1('on 2026-05-28 we shipped; 2024 was earlier')).toBe(
        'on 2026-05-28 we shipped; 2024 was earlier',
      );
    });

    it('leaves room numbers / short hyphenated codes untouched', () => {
      expect(applyPass1('meet in room 123-A at building B-2')).toBe(
        'meet in room 123-A at building B-2',
      );
    });
  });

  describe('SSN-like', () => {
    it('redacts the canonical 3-2-4 shape', () => {
      expect(applyPass1('SSN 123-45-6789 on the form')).toBe(
        'SSN [SSN_REDACTED] on the form',
      );
    });

    it('does not match a 3-3-4 phone shape as SSN', () => {
      // Phone format 555-123-4567 should be PHONE not SSN
      expect(applyPass1('555-123-4567')).toBe('[PHONE_REDACTED]');
    });
  });

  describe('monetary', () => {
    it('redacts comma-grouped amounts', () => {
      expect(applyPass1('offer is $180,000 base plus equity')).toBe(
        'offer is [AMOUNT_REDACTED] base plus equity',
      );
    });

    it('redacts K/M suffix amounts', () => {
      expect(applyPass1('$220k base, $2.5M total over 4 years')).toBe(
        '[AMOUNT_REDACTED] base, [AMOUNT_REDACTED] total over 4 years',
      );
    });

    it('redacts plain dollar amounts with optional cents', () => {
      expect(applyPass1('charged $50.25 yesterday and $9 today')).toBe(
        'charged [AMOUNT_REDACTED] yesterday and [AMOUNT_REDACTED] today',
      );
    });

    it('leaves bare 100k (no $) and lone $ untouched', () => {
      expect(applyPass1('scaled to 100k users and the $ symbol')).toBe(
        'scaled to 100k users and the $ symbol',
      );
    });
  });

  describe('URL query-param PII', () => {
    it('strips recruiter_id and email values from a URL query', () => {
      const t = 'apply at https://boards.greenhouse.io/x/jobs/42?recruiter_id=jdoe&email=foo@bar.com&utm=src';
      const out = applyPass1(t);
      expect(out).toContain('recruiter_id=[REDACTED]');
      expect(out).toContain('email=[REDACTED]');
      expect(out).toContain('utm=src');
    });

    it('leaves a clean URL alone', () => {
      const t = 'see https://acme.com/jobs/12345 for the role';
      expect(applyPass1(t)).toBe(t);
    });
  });
});

describe('sanitizer Pass 2 — company name + alias replacement', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  function seedApp(opts: {
    id: string;
    company_name: string;
    company_aliases?: string | null;
    obfuscated_label: string;
    public_state?: string;
  }): void {
    db.prepare(
      `INSERT INTO applications (
         id, company_name, company_aliases, obfuscated_label, public_state,
         role_title, status, created_at
       ) VALUES (
         @id, @company_name, @company_aliases, @obfuscated_label, @public_state,
         'Senior Engineer', 'BOOKMARKED', '2026-05-28T00:00:00Z'
       )`,
    ).run({
      id: opts.id,
      company_name: opts.company_name,
      company_aliases: opts.company_aliases ?? null,
      obfuscated_label: opts.obfuscated_label,
      public_state: opts.public_state ?? 'obfuscated',
    });
  }

  it('replaces a single company name', () => {
    seedApp({ id: 'app-1', company_name: 'Anthropic', obfuscated_label: 'ai-infra-a' });
    expect(applyPass2('met with the Anthropic team', db)).toBe(
      'met with the [REDACTED:ai-infra-a] team',
    );
  });

  it('replaces all aliases from the company_aliases JSON array', () => {
    seedApp({
      id: 'app-1',
      company_name: 'Anthropic',
      company_aliases: JSON.stringify(['Claude', 'PBC']),
      obfuscated_label: 'ai-infra-a',
    });
    expect(applyPass2('Claude / Anthropic / PBC all match', db)).toBe(
      '[REDACTED:ai-infra-a] / [REDACTED:ai-infra-a] / [REDACTED:ai-infra-a] all match',
    );
  });

  it('is case-insensitive and word-bounded', () => {
    seedApp({ id: 'app-1', company_name: 'Anthropic', obfuscated_label: 'ai-infra-a' });
    // Case variants redact; 'Anthropics' (longer word) does NOT.
    expect(applyPass2('ANTHROPIC and anthropic but not Anthropics', db)).toBe(
      '[REDACTED:ai-infra-a] and [REDACTED:ai-infra-a] but not Anthropics',
    );
  });

  it('handles company names with regex special chars', () => {
    seedApp({ id: 'app-1', company_name: 'Microsoft (Bing)', obfuscated_label: 'search-a' });
    expect(applyPass2('the Microsoft (Bing) team', db)).toBe(
      'the [REDACTED:search-a] team',
    );
  });

  it('skips applications with public_state=public', () => {
    seedApp({ id: 'app-1', company_name: 'Anthropic', obfuscated_label: 'ai-infra-a', public_state: 'public' });
    expect(applyPass2('met with the Anthropic team', db)).toBe(
      'met with the Anthropic team',
    );
  });

  it('skips applications with empty obfuscated_label defensively', () => {
    // Bypass the NOT NULL constraint by inserting via raw SQL with empty string
    db.prepare(
      `INSERT INTO applications (id, company_name, company_aliases, obfuscated_label, public_state, role_title, status, created_at)
       VALUES ('app-1', 'Anthropic', NULL, '', 'obfuscated', 'Senior Engineer', 'BOOKMARKED', '2026-05-28T00:00:00Z')`,
    ).run();
    expect(applyPass2('met with the Anthropic team', db)).toBe(
      'met with the Anthropic team',
    );
  });

  it('redacts both companies in a multi-application payload', () => {
    seedApp({ id: 'app-1', company_name: 'Anthropic', obfuscated_label: 'ai-infra-a' });
    seedApp({ id: 'app-2', company_name: 'Stripe', obfuscated_label: 'fintech-a' });
    expect(applyPass2('comparing Anthropic vs Stripe', db)).toBe(
      'comparing [REDACTED:ai-infra-a] vs [REDACTED:fintech-a]',
    );
  });

  it('tolerates malformed company_aliases JSON', () => {
    seedApp({
      id: 'app-1',
      company_name: 'Anthropic',
      company_aliases: 'not-valid-json',
      obfuscated_label: 'ai-infra-a',
    });
    // company_name still replaces; bad alias JSON silently ignored.
    expect(applyPass2('met with Anthropic', db)).toBe(
      'met with [REDACTED:ai-infra-a]',
    );
  });
});

describe('sanitizer Pass 3 — no-op stub', () => {
  it('returns text unchanged', () => {
    expect(applyPass3('hello world', {})).toBe('hello world');
  });
});

describe('sanitize() — full pipeline', () => {
  let db: Database.Database;

  beforeEach(() => {
    closeDb();
    db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => {
    closeDb();
  });

  it('runs Pass 1 + Pass 2 + Pass 3 in order on the same text', () => {
    db.prepare(
      `INSERT INTO applications (id, company_name, company_aliases, obfuscated_label, public_state, role_title, status, created_at)
       VALUES ('app-1', 'Acme Corp', '["AcmeCo"]', 'fintech-a', 'obfuscated', 'Senior Engineer', 'BOOKMARKED', '2026-05-28T00:00:00Z')`,
    ).run();
    const raw =
      'Recruiter Jane Doe from Acme Corp emailed at jane@acme.com about the $220k offer';
    const out = sanitize(raw, { db });
    expect(out).toContain('[REDACTED:fintech-a]');
    expect(out).toContain('[EMAIL_REDACTED]');
    expect(out).toContain('[AMOUNT_REDACTED]');
    expect(out).not.toContain('Acme Corp');
    expect(out).not.toContain('jane@acme.com');
    expect(out).not.toContain('$220k');
    // Recruiter name "Jane Doe" survives — 4.1 doesn't catch context-dependent
    // names; Sub-milestone 4.2 (Pass 3) will.
    expect(out).toContain('Jane Doe');
  });
});
