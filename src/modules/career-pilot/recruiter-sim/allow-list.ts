/**
 * Recruiter-sim self-only allow-list (Sub-milestone 9.3b, STRATEGY.md §24.40 D14).
 *
 * The load-bearing safety guard: the sim may target ONLY the single dev mailbox
 * (and its `+tag` / dot variants). Nothing in dev is ever external — this
 * enforces it in code, re-checked immediately before any Gmail API call.
 */

/**
 * Normalize a Gmail address for comparison: strip a `+tag`, lowercase, and (for
 * gmail.com / googlemail.com) drop dots in the local part — Gmail treats
 * `a.b@gmail.com`, `ab+x@gmail.com`, and `ab@gmail.com` as the same mailbox.
 */
export function canonicalizeGmail(addr: string): string {
  const trimmed = addr.trim().toLowerCase();
  const at = trimmed.lastIndexOf('@');
  if (at < 0) return trimmed;
  let local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus >= 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

/** True iff `target` resolves to the dev account itself (a `+tag` / dot variant counts). */
export function isSelfTarget(target: string, devAccount: string): boolean {
  return canonicalizeGmail(target) === canonicalizeGmail(devAccount);
}

/**
 * Throw if `target` is anything other than the dev account. The runner calls
 * this immediately before any Gmail API call — refuse before the request leaves.
 */
export function assertSelfOnly(target: string, devAccount: string): void {
  if (!isSelfTarget(target, devAccount)) {
    throw new Error(
      `recruiter-sim: refusing to target "${target}" — the self-only allow-list permits "${devAccount}" only`,
    );
  }
}
