/**
 * src/modules/portal/killswitch-external.ts — the /killswitch external tail.
 *
 * Sub-milestone 5.4b (STRATEGY.md §24.18). After the local hard-stop
 * (setPauseState('killswitch') + kill containers + the spawn gate blocking new
 * ones), /killswitch attempts two defense-in-depth external revocations:
 *
 *   1. revokeOneCliAgentTokens — revoke the per-agent OneCLI tokens so a leaked
 *      credential can't authenticate to anything.
 *   2. zeroPortkeyBudget — flip the Portkey AI-Provider budget to 0 so no LLM
 *      call succeeds regardless of credential.
 *
 * Both are NOT_WIRED today, verified 2026-05-29 against primary sources:
 *   - The @onecli-sh/sdk public surface is getContainerConfig +
 *     applyContainerConfig only — there is NO token-revoke method. Real revoke
 *     needs the OneCLI Cloud admin API / `onecli` CLI (deploy-phase).
 *   - The Portkey client we have (portkey-analytics.ts) is analytics-only;
 *     budget is a separate admin API requiring an admin key we don't configure.
 *
 * Contract (per §24.18): each call is BEST-EFFORT — it never throws, logs a
 * loud NOT_WIRED line when the admin client/credential is absent, and returns a
 * structured status so the killswitch reply can state honestly what was and was
 * not revoked. The local hard-stop already halts the system; these are
 * belt-and-suspenders for the credential-compromise case. Recovery is the
 * manual runbook (RECOVERY.md §3) until these are wired at deploy.
 */
import { log } from '../../log.js';

export interface ExternalRevocationResult {
  /** Which external system this targets. */
  name: 'onecli' | 'portkey';
  /** True once a real admin client/credential is configured (deploy-phase). */
  wired: boolean;
  /** True only when a wired call actually succeeded. */
  ok: boolean;
  /** Human-readable status for logs + the killswitch reply. */
  detail: string;
}

/**
 * Revoke the OneCLI per-agent tokens for the given agent identifiers. NOT_WIRED
 * today — the SDK exposes no revoke. When wired (deploy), implement against the
 * OneCLI admin API and set wired/ok accordingly.
 */
export async function revokeOneCliAgentTokens(agentIds: string[]): Promise<ExternalRevocationResult> {
  // Future: gate on an admin client/credential (e.g. ONECLI_ADMIN_API_KEY) and
  // call the revoke endpoint per agent id. Until then, this is a no-op seam.
  const detail = `NOT_WIRED: OneCLI token revoke unavailable (SDK has no revoke method). Manually rotate tokens for ${agentIds.length} agent(s) per RECOVERY.md §3.`;
  log.error('killswitch external revoke NOT_WIRED', { step: 'onecli', agentIds, detail });
  return { name: 'onecli', wired: false, ok: false, detail };
}

/**
 * Set the Portkey AI-Provider budget to 0 so no LLM call succeeds. NOT_WIRED
 * today — only the analytics API is reachable; budget needs the admin API.
 */
export async function zeroPortkeyBudget(): Promise<ExternalRevocationResult> {
  // Future: gate on a Portkey admin key + call the budget/limit admin endpoint.
  const detail =
    'NOT_WIRED: Portkey budget→0 unavailable (no admin API configured). Manually set the AI-Provider budget to 0 per RECOVERY.md §3.';
  log.error('killswitch external revoke NOT_WIRED', { step: 'portkey', detail });
  return { name: 'portkey', wired: false, ok: false, detail };
}

/** One-line summary of the external tail for the killswitch reply. */
export function summarizeExternal(results: ExternalRevocationResult[]): string {
  return results
    .map((r) => {
      if (!r.wired) return `${r.name}: NOT_WIRED (manual rotation required)`;
      return `${r.name}: ${r.ok ? 'revoked' : 'FAILED — rotate manually'}`;
    })
    .join('; ');
}
