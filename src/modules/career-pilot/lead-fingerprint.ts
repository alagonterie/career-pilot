/**
 * Content fingerprint for `job_leads.content_fingerprint`.
 *
 * Pure module. Given a JobLeadPayload, computes a deterministic 64-bit
 * SimHash over normalized (title + company + location + description) and
 * returns it as a 16-char hex string.
 *
 * The hex storage is deliberate — SQLite has no native popcount, so any
 * Hamming-distance compare (cross-source dedup, deferred to v1.2) runs
 * in application code, not SQL. v1.0 indexes the column for future use
 * but doesn't query against it. See STRATEGY.md §24.5 Risk F.
 *
 * Algorithm: 64-bit SimHash, tokenizing on whitespace + punctuation
 * boundaries, weighting tokens by their MurmurHash3 outputs. Standard
 * approach — see Charikar 2002 (Similarity Estimation Techniques from
 * Rounding Algorithms).
 */
import type { JobLeadPayload } from './scrape-jobs/types.js';

const DESCRIPTION_TRUNCATE = 4000;

/**
 * Normalize a payload for fingerprinting:
 *   1. Lowercase.
 *   2. Strip HTML tags.
 *   3. Collapse whitespace.
 *   4. Truncate description to first 4000 chars.
 *   5. Concatenate title \n company \n location_raw \n description_text.
 */
export function normalizeForFingerprint(payload: JobLeadPayload): string {
  const title = stripAndCollapse(payload.title);
  const company = stripAndCollapse(payload.company);
  const location = stripAndCollapse(payload.location_raw ?? '');
  const rawDescription = payload.description_text ?? stripHtml(payload.description_html ?? '');
  const description = stripAndCollapse(rawDescription).slice(0, DESCRIPTION_TRUNCATE);
  return `${title}\n${company}\n${location}\n${description}`;
}

function stripAndCollapse(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]*>/g, ' ');
}

/**
 * Compute the 64-bit SimHash for a normalized string. Returns a 16-char
 * lowercase hex string (zero-padded).
 */
export function computeFingerprint(payload: JobLeadPayload): string {
  const normalized = normalizeForFingerprint(payload);
  const tokens = tokenize(normalized);
  if (tokens.length === 0) {
    // Empty input — deterministic zero fingerprint. Caller should treat
    // this as "no useful signal" (e.g., a posting with only a title and
    // no other content).
    return '0000000000000000';
  }
  return simhash64(tokens);
}

function tokenize(s: string): string[] {
  return s.split(/[^a-z0-9]+/).filter((t) => t.length >= 2);
}

/**
 * 64-bit SimHash. Each token is hashed with MurmurHash3 (64-bit variant)
 * to two 32-bit halves; the 64-bit signature is built by accumulating
 * +1/-1 votes per bit across all tokens. Final signature: each bit set
 * if its accumulator is positive, else clear.
 */
function simhash64(tokens: string[]): string {
  const accum = new Array<number>(64).fill(0);
  for (const token of tokens) {
    const { hi, lo } = murmur3_64(token);
    for (let i = 0; i < 32; i++) {
      accum[i] += hi & (1 << (31 - i)) ? 1 : -1;
      accum[i + 32] += lo & (1 << (31 - i)) ? 1 : -1;
    }
  }
  // Build 16-char hex from accumulators (MSB first).
  let hex = '';
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0;
    for (let b = 0; b < 4; b++) {
      if (accum[nibble * 4 + b] > 0) v |= 1 << (3 - b);
    }
    hex += v.toString(16);
  }
  return hex;
}

/**
 * MurmurHash3 x86 32-bit — produces two 32-bit hashes from one input by
 * salting with different seeds. Not cryptographic; speed + good
 * distribution for SimHash is all we need.
 */
function murmur3_64(s: string): { hi: number; lo: number } {
  return {
    hi: murmur3_32(s, 0x9747b28c) | 0,
    lo: murmur3_32(s, 0xc2b2ae35) | 0,
  };
}

function murmur3_32(key: string, seed: number): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;
  let h = seed | 0;
  const blocks = Math.floor(key.length / 4);

  for (let i = 0; i < blocks; i++) {
    let k =
      key.charCodeAt(i * 4) |
      (key.charCodeAt(i * 4 + 1) << 8) |
      (key.charCodeAt(i * 4 + 2) << 16) |
      (key.charCodeAt(i * 4 + 3) << 24);
    k = Math.imul(k, c1) | 0;
    k = (k << 15) | (k >>> 17) | 0;
    k = Math.imul(k, c2) | 0;
    h ^= k;
    h = (h << 13) | (h >>> 19) | 0;
    h = (Math.imul(h, 5) + 0xe6546b64) | 0;
  }

  // Tail
  let k = 0;
  const tailIndex = blocks * 4;
  const tailLength = key.length - tailIndex;
  if (tailLength >= 3) k ^= key.charCodeAt(tailIndex + 2) << 16;
  if (tailLength >= 2) k ^= key.charCodeAt(tailIndex + 1) << 8;
  if (tailLength >= 1) {
    k ^= key.charCodeAt(tailIndex);
    k = Math.imul(k, c1) | 0;
    k = (k << 15) | (k >>> 17) | 0;
    k = Math.imul(k, c2) | 0;
    h ^= k;
  }

  h ^= key.length;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) | 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) | 0;
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * Hamming distance between two hex fingerprints. Used by the deferred
 * cross-source dedup background job (v1.2+); not called in v1.0 but
 * exposed for testing + future use.
 */
export function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) throw new Error(`fingerprint length mismatch: ${a.length} vs ${b.length}`);
  let total = 0;
  for (let i = 0; i < a.length; i++) {
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    total += popcount4(xor);
  }
  return total;
}

function popcount4(n: number): number {
  // n is 0-15; precomputed nibble popcount
  return [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4][n & 0xf];
}
