/**
 * LLM rank-at-draw-time for the daily-briefing flow (Phase 3.1 §24.6
 * component 3 — container-side variant).
 *
 * Architectural finding during Phase 3.1 e2e: NanoClaw routes all LLM
 * calls container-side through the OneCLI gateway (HTTPS_PROXY +
 * cert injection). Host-side LLM auth was never built and shouldn't be —
 * adding it would fight the architecture. So rank_leads lives container-
 * side too: the MCP tool body does the Haiku call directly, leaning on
 * the same OneCLI-gated outbound path that the orchestrator's own SDK
 * calls use.
 *
 * The host-side action handlers split into:
 *   - get_lead_summaries_for_ranking (read leads by ids)
 *   - write_llm_scores (UPDATE job_leads after the Haiku call returns)
 *
 * Pure helpers (`buildRankingPrompt`, `parseRankingResponse`,
 * `computeBriefHash`) are exported for unit testing.
 */

export interface JobLeadForRanking {
  id: string;
  source: string;
  title: string;
  company: string;
  location_raw?: string | null;
  workplace_type?: string | null;
  description_text?: string | null;
  rules_score?: number | null;
}

export interface RankedLead {
  id: string;
  llm_score: number;
  rank: number;
}

export class RankLeadsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RankLeadsError';
    this.code = code;
  }
}

const SNIPPET_CHARS = 280;
const SYSTEM_PROMPT =
  "You score job postings against a candidate brief and return JSON only. " +
  "Be calibrated: 90+ for excellent matches, 70-89 strong, 40-69 moderate, " +
  "20-39 weak, <20 poor fit. Don't anchor on any single dimension — balance " +
  "role-type fit, technical skills, comp signal, and location.";

export function buildRankingPrompt(leads: JobLeadForRanking[], brief: string): string {
  const lines: string[] = [];
  lines.push(
    "Score each posting below 0-100 against the candidate's brief. Higher = better fit.",
  );
  lines.push('');
  lines.push('# Candidate brief');
  lines.push('');
  lines.push(brief.trim());
  lines.push('');
  lines.push(`# Postings (${leads.length})`);
  lines.push('');
  for (const lead of leads) {
    const desc = (lead.description_text ?? '').replace(/\s+/g, ' ').trim();
    const snippet = desc.length > SNIPPET_CHARS ? desc.slice(0, SNIPPET_CHARS - 1) + '…' : desc;
    const locParts = [lead.location_raw, lead.workplace_type].filter((s): s is string => !!s);
    const loc = locParts.length > 0 ? ' | ' + locParts.join(' · ') : '';
    lines.push(`- id=${lead.id} | ${lead.title} @ ${lead.company}${loc}`);
    if (snippet) lines.push(`  ${snippet}`);
  }
  lines.push('');
  lines.push('Return JSON only, no commentary or markdown fences:');
  lines.push('{"leads":[{"id":"<id>","llm_score":<0-100>},...]}');
  return lines.join('\n');
}

export function parseRankingResponse(text: string, requestedIds: string[]): RankedLead[] {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?\s*\n?/i, '')
    .replace(/\n?```\s*$/, '')
    .trim();

  let parsed: { leads?: Array<{ id?: unknown; llm_score?: unknown }> };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new RankLeadsError('PARSE_ERROR', 'response was not valid JSON');
  }
  if (!parsed || !Array.isArray(parsed.leads)) {
    throw new RankLeadsError('PARSE_ERROR', 'response missing `leads` array');
  }

  const requestedSet = new Set(requestedIds);
  const seen = new Set<string>();
  const valid: Array<{ id: string; llm_score: number }> = [];
  for (const item of parsed.leads) {
    if (typeof item.id !== 'string' || !requestedSet.has(item.id)) continue;
    if (typeof item.llm_score !== 'number' || !Number.isFinite(item.llm_score)) continue;
    if (item.llm_score < 0 || item.llm_score > 100) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    valid.push({ id: item.id, llm_score: Math.round(item.llm_score) });
  }

  if (valid.length === 0) {
    throw new RankLeadsError('NO_VALID_SCORES', 'no usable lead scores in response');
  }

  valid.sort((a, b) => b.llm_score - a.llm_score);
  return valid.map((v, i) => ({ id: v.id, llm_score: v.llm_score, rank: i + 1 }));
}

/**
 * Stable 16-char hex digest of the brief, used as the cache key on
 * `job_leads.llm_scored_brief_hash`. Whitespace-normalized so cosmetic
 * edits don't trigger a re-score. Not a cryptographic hash.
 */
export function computeBriefHash(brief: string): string {
  const normalized = brief.replace(/\s+/g, ' ').trim();
  let h = 0xcbf29ce484222325n;
  const PRIME = 0x100000001b3n;
  const MASK = 0xffffffffffffffffn;
  for (let i = 0; i < normalized.length; i++) {
    h = (h ^ BigInt(normalized.charCodeAt(i))) & MASK;
    h = (h * PRIME) & MASK;
  }
  return h.toString(16).padStart(16, '0');
}

interface HaikuResponse {
  content?: Array<{ type: string; text?: string }>;
}

/**
 * One-shot Haiku call. Routes through OneCLI's HTTPS_PROXY (set in the
 * container env by `applyContainerConfig`), which intercepts outbound to
 * api.anthropic.com and injects the registered Anthropic credential.
 *
 * `x-api-key: placeholder` is a stand-in — OneCLI overwrites it with the
 * real key on the wire. ANTHROPIC_BASE_URL is honored if set (e.g.,
 * Ollama test mode points it at the local Ollama Anthropic shim).
 */
async function callHaiku(systemPrompt: string, userPrompt: string): Promise<string> {
  const baseUrl = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const model = process.env.HAIKU_MODEL || 'claude-haiku-4-5-20251001';

  const res = await fetch(`${baseUrl}/v1/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY || 'placeholder',
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new RankLeadsError(
      'HAIKU_HTTP_ERROR',
      `Haiku call failed: ${res.status} ${res.statusText}${errText ? ' — ' + errText.slice(0, 200) : ''}`,
    );
  }

  const data = (await res.json()) as HaikuResponse;
  const block = data.content?.find((c) => c.type === 'text');
  if (!block?.text) throw new RankLeadsError('HAIKU_EMPTY', 'Haiku returned empty content');
  return block.text;
}

export async function rankLeads(
  leads: JobLeadForRanking[],
  brief: string,
): Promise<RankedLead[]> {
  if (leads.length === 0) {
    throw new RankLeadsError('BAD_ARGS', 'leads is empty');
  }
  if (!brief.trim()) {
    throw new RankLeadsError('BAD_ARGS', 'brief is empty');
  }
  const userPrompt = buildRankingPrompt(leads, brief);
  const text = await callHaiku(SYSTEM_PROMPT, userPrompt);
  const requestedIds = leads.map((l) => l.id);
  return parseRankingResponse(text, requestedIds);
}
