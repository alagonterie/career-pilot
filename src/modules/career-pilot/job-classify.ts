/**
 * src/modules/career-pilot/job-classify.ts — the deferred `analyze_jd` (§6.2),
 * landed host-side as a best-effort label fallback.
 *
 * The public "company handle" (`<industry>-<letter>`) is derived from
 * `jd_analyzed.role_category`. `analyze_jd` was never built as a tool, so the
 * agent is meant to fill that field itself — and on a quick "I applied to X" add
 * it often doesn't, dropping the handle to a generic `misc-<letter>`. When that
 * happens this classifies the COMPANY's industry/domain from the JD into a short
 * slug (`health`, `fintech`, `devtools`, …) so the handle stays meaningful.
 *
 * Routes through Portkey (Haiku) exactly like the win-confidence scorer; reuses
 * the same host model knob. Best-effort — returns null with no PORTKEY_API_KEY,
 * under PORTKEY_BYPASS, or on any failure (the caller then keeps `misc`). Never
 * throws. Records a request_telemetry row via the shared host fetch helper.
 */
import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { callPortkeyChat, portkeyConfigured } from '../../llm-fetch.js';
import { log } from '../../log.js';

// Reuse the win-confidence host-Haiku model knob (same tier + host-pipeline
// surface); HAIKU_MODEL is the hardcoded fallback when the knob is unset.
const HAIKU_MODEL = 'claude-haiku-4-5';

/**
 * A short, slugified industry/domain for the obfuscated company handle (e.g.
 * `health`, `fintech`), or null when classification is unavailable/fails.
 */
export async function classifyJobIndustry(jdText: string, roleTitle?: unknown): Promise<string | null> {
  const jd = (jdText ?? '').trim();
  if (!jd || !portkeyConfigured()) return null;
  const title = typeof roleTitle === 'string' ? roleTitle.trim() : '';
  const prompt = [
    "Classify the COMPANY's industry/domain for an anonymized job-pipeline handle.",
    'Answer with ONE short lowercase slug (letters + single hyphens, ~1-2 words), favouring the',
    'company/product DOMAIN over the role. Examples: health, fintech, ecommerce, devtools, gaming,',
    'edtech, logistics, security, biotech, insurance, govtech, media, hr-tech, real-estate, ai.',
    'Reply with ONLY the slug — no prose, no punctuation, no quotes.',
    '',
    title ? `Role title: ${title}` : '',
    `Job description:\n${jd.slice(0, 1500)}`,
  ]
    .filter(Boolean)
    .join('\n');
  try {
    const res = await callPortkeyChat({
      surface: 'job-classify',
      messages: [{ role: 'user', content: prompt }],
      maxTokens: 16,
      model: getConfig<string>(getDb(), 'win_confidence_model') || HAIKU_MODEL,
      traceId: `job-classify-${Date.now()}`,
    });
    const slug = res.text
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 24);
    return slug && slug !== 'misc' ? slug : null;
  } catch (err) {
    log.warn('classifyJobIndustry failed — handle stays misc', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
