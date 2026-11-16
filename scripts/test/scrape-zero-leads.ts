/**
 * scripts/test/scrape-zero-leads.ts — the Tier-4 scrape flow's "zero keepers"
 * rule (STRATEGY.md §24.200 DoD (a)), kept pure so it is unit-tested.
 *
 * The flow passes with "at least one lead recorded, or a `rejected` count that
 * explains zero keepers". A search `rejected` count explains zero rows only when
 * the subagent made NO record_job_lead call, or when every call it made was a
 * deliberate host refusal (`recorded:false`). Record calls that should have
 * written rows and did not are a broken writer, and a rejected count elsewhere in
 * the run must not excuse them.
 */

/** The marker `formatRecordJobLeadResult` puts in a refusal's tool_result text. */
export const RECORD_REFUSAL_MARKER = 'job_lead not recorded:';

export function zeroLeadsExplainedByRejects(input: {
  searchRejectedTotal: number;
  recordCalls: number;
  recordRefusals: number;
}): boolean {
  if (input.searchRejectedTotal <= 0) return false;
  return input.recordCalls === 0 || input.recordRefusals >= input.recordCalls;
}
