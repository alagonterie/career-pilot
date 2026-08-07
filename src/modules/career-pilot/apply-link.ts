/**
 * src/modules/career-pilot/apply-link.ts — apply-link directness ranking
 * (STRATEGY.md §24.190).
 *
 * MIRROR: this is the host twin of the same logic in
 * `container/agent-runner/src/career-pilot/serpapi-search.ts`. The container is a
 * separate dependency tree so the code is duplicated rather than imported — the
 * same arrangement `GoogleJobPayload` has with `JobLeadPayload`. The host copy
 * exists so the backfill script (and any future re-classification) can re-derive
 * links from stored `raw_payload.apply_options` without a container round-trip.
 * Keep the two in step; both are unit-tested against the same cases.
 *
 * Why rank at all: Google returns `apply_options` in ITS order, which is not a
 * directness order. Taking `[0]` meant a posting that surfaced via an aggregator
 * got stored with the aggregator's URL — and those routinely gate the real
 * application behind an account. The same signal doubles as a trust marker for
 * the company name, which is least reliable on a reposted listing.
 *
 * The ranking ALLOW-LISTS the good rather than deny-listing the bad: aggregators
 * are an endless churning long tail, while applicant-tracking systems are a
 * short, stable, enumerable set.
 */

/** Host suffixes of applicant-tracking systems / company-careers platforms. */
const ATS_HOST_SUFFIXES = [
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'myworkdayjobs.com',
  'workday.com',
  'smartrecruiters.com',
  'workable.com',
  'jobvite.com',
  'icims.com',
  'taleo.net',
  'bamboohr.com',
  'breezy.hr',
  'teamtailor.com',
  'recruitee.com',
  'personio.de',
  'join.com',
  'rippling.com',
  'workatastartup.com',
  'applytojob.com',
  'paylocity.com',
  'ultipro.com',
  'successfactors.com',
  'eightfold.ai',
  'gem.com',
  'polymer.co',
];

export type ApplyLinkKind = 'company' | 'ats' | 'aggregator' | 'unknown';

export interface ApplyOption {
  title?: string;
  link?: string;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

function isAtsHost(host: string): boolean {
  return ATS_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

/** Company name → a comparable token ("Socket.dev" → "socket"). */
function companyToken(company: string): string {
  return company
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|gmbh|sa|bv|plc)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Does this host look like the hiring company's own? Compares each host label
 *  against the company token, so `careers.socket.dev` and `socket.dev` both match
 *  "Socket.dev" while `jobleads.com` does not. */
function isCompanyHost(host: string, company: string): boolean {
  const token = companyToken(company);
  if (token.length < 3) return false;
  return host
    .split('.')
    .some((label) => label.length >= 3 && (label === token || token.startsWith(label) || label.startsWith(token)));
}

export function classifyApplyLink(url: string, company: string): ApplyLinkKind {
  const host = hostOf(url);
  if (!host) return 'unknown';
  if (isAtsHost(host)) return 'ats';
  if (isCompanyHost(host, company)) return 'company';
  return 'unknown';
}

const KIND_RANK: Record<ApplyLinkKind, number> = { company: 3, ats: 2, unknown: 1, aggregator: 0 };

/**
 * Pick the most direct apply link available: the company's own site, then a known
 * ATS, then whatever is left. `fallback` (Google's `source_link`/`share_link`) is
 * ranked alongside the options rather than used only as a last resort — it is
 * frequently the most direct link of the lot. Pure.
 */
export function pickApplyLink(
  options: ApplyOption[] | undefined,
  company: string,
  fallback: string | null,
): { url: string | null; kind: ApplyLinkKind } {
  // `fallback` (Google's source_link) goes FIRST so that when it ties with an
  // apply option on directness — commonly the same ATS page — the canonical,
  // un-tracked URL wins over the `?utm_source=google_jobs_apply` variant. It only
  // ever wins a tie; a genuinely more direct option still outranks it.
  const candidates: string[] = [];
  if (fallback) candidates.push(fallback);
  for (const o of options ?? []) if (o?.link) candidates.push(o.link);
  if (candidates.length === 0) return { url: null, kind: 'unknown' };

  let best = candidates[0];
  let bestKind = classifyApplyLink(best, company);
  for (const url of candidates.slice(1)) {
    const kind = classifyApplyLink(url, company);
    if (KIND_RANK[kind] > KIND_RANK[bestKind]) {
      best = url;
      bestKind = kind;
    }
  }
  // Nothing recognizable anywhere => the posting only reached us via a reposter.
  // Say so, rather than leaving it indistinguishable from a direct link.
  if (bestKind === 'unknown') return { url: best, kind: 'aggregator' };
  return { url: best, kind: bestKind };
}
