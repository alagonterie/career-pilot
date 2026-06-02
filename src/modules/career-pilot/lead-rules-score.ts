/**
 * Deterministic rules-score for `job_leads.rules_score`.
 *
 * Pure function. Given a JobLeadPayload + candidate profile, returns a
 * 0-100 integer score + structured reasons (stored as JSON in
 * `rules_score_reasons` for explainability).
 *
 * Spec: STRATEGY.md §24.5 + .specs/research/PHASE_2_5_JOB_BOARDS.md
 * "Rules-score formula (concrete v1 default)".
 *
 * The components are deliberately gentle and configurable. v1.0 hardcodes
 * the defaults; v1.1+ wires them through `config/defaults.json` per the
 * four-tier config model (STRATEGY.md §20).
 */
import type { JobLeadPayload, Source } from '../../scrape-jobs/types.js';

export interface CandidateProfileForScoring {
  target_roles: string[];
  skills: string[];
  comp_floor_usd?: number;
  acceptable_regions: Array<'US' | 'EU' | 'GLOBAL'>;
  acceptable_cities: string[];
  remote_ok: boolean;
  negative_keywords: string[];
}

export interface RulesScoreResult {
  score: number; // 0-100
  reasons: Record<string, unknown>;
}

const SOURCE_MULTIPLIERS: Record<Source, number> = {
  greenhouse: 1.1,
  lever: 1.1,
};

export function computeRulesScore(payload: JobLeadPayload, profile: CandidateProfileForScoring): RulesScoreResult {
  const reasons: Record<string, unknown> = {};
  let score = 0;

  // Hard negative filter — short-circuit.
  const negativeHaystack = `${payload.title} ${(payload.description_text ?? '').slice(0, 2000)}`.toLowerCase();
  const negHits = profile.negative_keywords.filter((kw) => negativeHaystack.includes(kw.toLowerCase()));
  if (negHits.length > 0) {
    reasons.neg_flag = { hits: negHits, effect: 'drop' };
    return { score: 0, reasons };
  }

  // Keyword match: target_roles + skills against title + description (first 2000 chars).
  const keywords = [...profile.target_roles, ...profile.skills];
  const titleLower = payload.title.toLowerCase();
  const descLower = (payload.description_text ?? '').slice(0, 2000).toLowerCase();
  let titleHits = 0;
  let descHits = 0;
  const matchedTerms: string[] = [];
  for (const kw of keywords) {
    const kwLower = kw.toLowerCase();
    if (titleLower.includes(kwLower)) {
      titleHits += 1;
      matchedTerms.push(kw);
    } else if (descLower.includes(kwLower)) {
      descHits += 1;
      matchedTerms.push(kw);
    }
  }
  const kwScore = Math.min(30, 15 * titleHits + 3 * descHits);
  reasons.keyword_match = {
    score: kwScore,
    title_hits: titleHits,
    desc_hits: descHits,
    matched: matchedTerms.slice(0, 10),
  };
  score += kwScore;

  // Compensation floor.
  let compScore: number;
  if (payload.comp_min_usd == null && payload.comp_max_usd == null) {
    compScore = 5; // unknown — half credit, absence is common
  } else if (profile.comp_floor_usd == null) {
    compScore = 10; // no floor set — give partial credit for having any comp data
  } else {
    const effective = payload.comp_max_usd ?? payload.comp_min_usd ?? 0;
    compScore = effective >= profile.comp_floor_usd ? 20 : 0;
  }
  reasons.comp = {
    score: compScore,
    comp_min_usd: payload.comp_min_usd ?? null,
    comp_max_usd: payload.comp_max_usd ?? null,
    floor: profile.comp_floor_usd ?? null,
  };
  score += compScore;

  // Location.
  let locScore = 0;
  const locInfo: Record<string, unknown> = { is_remote: payload.is_remote, remote_region: payload.remote_region };
  if (payload.is_remote === true && profile.remote_ok) {
    if (payload.remote_region && profile.acceptable_regions.includes(payload.remote_region)) {
      locScore = 15;
    } else {
      locScore = 8;
    }
  } else if (payload.location_raw && profile.acceptable_cities.length > 0) {
    const locLower = payload.location_raw.toLowerCase();
    if (profile.acceptable_cities.some((c) => locLower.includes(c.toLowerCase()))) {
      locScore = 15;
      locInfo.matched_city = profile.acceptable_cities.find((c) => locLower.includes(c.toLowerCase()));
    }
  }
  locInfo.score = locScore;
  reasons.location = locInfo;
  score += locScore;

  // Recency. We use source_posted_at if available, else fall back to "now" — postings
  // without a posted_at are typically the freshest available signal.
  const postedAt = payload.source_posted_at ? new Date(payload.source_posted_at).getTime() : Date.now();
  const ageHours = (Date.now() - postedAt) / (1000 * 60 * 60);
  let recScore: number;
  if (ageHours <= 24) recScore = 15;
  else if (ageHours <= 168) recScore = 10;
  else if (ageHours <= 720) recScore = 5;
  else recScore = 0;
  reasons.recency = { score: recScore, age_hours: Math.floor(ageHours) };
  score += recScore;

  // Source-tier multiplier (gentle bias toward higher-signal sources).
  const mult = SOURCE_MULTIPLIERS[payload.source] ?? 1.0;
  const final = Math.min(100, Math.max(0, Math.floor(score * mult)));
  reasons.source_mult = { source: payload.source, multiplier: mult };

  return { score: final, reasons };
}

/**
 * Build a CandidateProfileForScoring from raw candidate_profile row +
 * defaults. The DB stores JSON-encoded strings for target_roles,
 * location_pref, skills — this helper parses them safely.
 */
export function profileFromRow(row: Record<string, unknown> | null): CandidateProfileForScoring {
  if (!row) {
    return {
      target_roles: [],
      skills: [],
      comp_floor_usd: undefined,
      acceptable_regions: ['US', 'GLOBAL'],
      acceptable_cities: [],
      remote_ok: true,
      negative_keywords: defaultNegativeKeywords(),
    };
  }

  const target_roles = parseJsonArray(row.target_roles);
  const skills = parseJsonArray(row.skills);
  const locationPref = parseJsonObject(row.location_pref);
  const remote_ok = typeof locationPref.remote === 'boolean' ? locationPref.remote : true;
  const acceptable_cities = Array.isArray(locationPref.hybrid_cities) ? locationPref.hybrid_cities : [];

  return {
    target_roles,
    skills,
    comp_floor_usd: typeof row.comp_floor === 'number' ? row.comp_floor : undefined,
    acceptable_regions: ['US', 'GLOBAL'], // v1.0 default; configurable later
    acceptable_cities,
    remote_ok,
    negative_keywords: defaultNegativeKeywords(),
  };
}

/**
 * Default negative-keyword list. These are role-title patterns that
 * almost always indicate off-target postings for a senior IC software
 * engineer. v1.1+ moves these to a configurable preference.
 */
function defaultNegativeKeywords(): string[] {
  return [
    'sales',
    'marketing',
    'recruiter',
    'recruiting',
    'customer success',
    'account executive',
    'business development',
    'legal counsel',
    'paralegal',
    'controller',
    'accountant',
    'financial analyst',
    'people operations',
    'people ops',
    'office manager',
    'executive assistant',
  ];
}

function parseJsonArray(v: unknown): string[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function parseJsonObject(v: unknown): Record<string, unknown> {
  if (typeof v !== 'string') return {};
  try {
    const parsed = JSON.parse(v);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
