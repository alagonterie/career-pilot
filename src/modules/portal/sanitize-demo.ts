/**
 * src/modules/portal/sanitize-demo.ts — the `/live` ANONYMIZATION DEMO data
 * source (PORTAL §5.2, STRATEGY §24.33).
 *
 * Faithfulness is the whole point: the demo runs the REAL sanitizer over
 * SYNTHETIC samples so it can never drift from the pipeline actually protecting
 * the candidate's data — all three tiers (§24.134d):
 *   - Pass 1 (`applyPass1`) — deterministic PII regex;
 *   - Pass 2 (`redactCompanies`) — the company → `[REDACTED:<label>]` swap;
 *   - the AI judgment pass — the §24.134a entity belt. Its DETECTION is an LLM
 *     call, so for this pure, per-view, free public endpoint the synthetic
 *     sample carries the codenames the belt would catch (`ai_terms`) and the
 *     REAL `applyEntityRedactions` produces the `[AI_REDACTED]` output. Honest:
 *     the redaction function is the production one; only the (authored) detection
 *     stands in for the model on a synthetic sample.
 * Safety: (1) server-authored SYNTHETIC input only — fake emails/phones/$/URLs +
 * a *synthetic* company + *fictional* codenames; (2) company obfuscation runs
 * against a synthetic mapping, never the real `applications` table. Pure, no DB,
 * no throws — safe for the public `POST /api/sanitize-demo` endpoint.
 */
import { applyEntityRedactions } from './kit-entity-redact.js';
import { applyPass1, redactCompanies, type CompanyRedaction } from './sanitizer.js';

interface DemoSample {
  raw: string;
  company: CompanyRedaction;
  /** Fictional product codenames the AI judgment pass would redact (§24.134d). */
  ai_terms: string[];
}

// Synthetic only. Every value here is fictional (the companies are the same
// placeholder names used across the generic public repo); no real PII or real
// applications data ever appears.
const SAMPLES: DemoSample[] = [
  {
    raw: [
      'Tailored resume for Globex using JD at https://globex.com/careers/884?recruiter_id=4471',
      'Recruiter Sarah B (sarah.briggs@globex.com, mobile (415) 555-0142) asked for a call.',
      'The role owns Borealis, their internal data-mesh platform. They floated $185,000 base + equity.',
    ].join('\n'),
    company: { company_name: 'Globex', company_aliases: '["Globex Corp"]', obfuscated_label: 'saas-demo' },
    ai_terms: ['Borealis'],
  },
  {
    raw: [
      'Drafted outreach to Initech hiring manager dev.lead@initech.io.',
      'Referral bonus mentioned: $7.5k. Call them at +1 212-555-0193.',
      'Role centers on Quicksilver, their real-time ledger engine. JD: https://initech.io/jobs?applicant_id=jane-7782',
    ].join('\n'),
    company: { company_name: 'Initech', company_aliases: '["Initech Systems"]', obfuscated_label: 'fintech-demo' },
    ai_terms: ['Quicksilver'],
  },
  {
    raw: [
      'Hooli recruiter emailed talent@hooli.xyz about a staff role on the Helios inference stack.',
      'Comp band quoted as $240,000. SSN on the form was 412-55-9087 (do not store).',
      'Scheduling link: https://hooli.xyz/book?email=jane.doe@example.com',
    ].join('\n'),
    company: { company_name: 'Hooli', company_aliases: '["Hooli XYZ"]', obfuscated_label: 'ai-demo' },
    ai_terms: ['Helios'],
  },
];

export interface SanitizeDemoResult {
  raw: string;
  sanitized: string;
  /** Count of redaction markers in the sanitized output. */
  redactions: number;
  /** The (clamped) sample index served. */
  sample: number;
  /** Total samples available, for the "show another" control. */
  total: number;
}

// Every marker the pipeline emits — Pass-1 fixed tokens, Pass-2 `[REDACTED:<label>]`,
// and the §24.134d AI-judgment `[AI_REDACTED]`.
const REDACTION_MARKER_RE =
  /\[(?:AI_REDACTED|EMAIL_REDACTED|PHONE_REDACTED|SSN_REDACTED|AMOUNT_REDACTED|REDACTED(?::[^\]]*)?)\]/g;

/**
 * Run the real sanitizer over one synthetic sample. `index` is clamped into
 * range (and floored), so any input is safe; defaults to the first sample.
 */
export function buildSanitizeDemo(index = 0): SanitizeDemoResult {
  const total = SAMPLES.length;
  const i = Number.isFinite(index) ? Math.max(0, Math.min(total - 1, Math.floor(index))) : 0;
  const { raw, company, ai_terms } = SAMPLES[i];
  // The real three-tier pipeline: Pass 1 (PII) → Pass 2 (company) → the AI
  // judgment pass (its authored detection for this synthetic sample, the real
  // `applyEntityRedactions` for the output).
  const sanitized = applyEntityRedactions(redactCompanies(applyPass1(raw), [company]), ai_terms);
  const redactions = (sanitized.match(REDACTION_MARKER_RE) ?? []).length;
  return { raw, sanitized, redactions, sample: i, total };
}
