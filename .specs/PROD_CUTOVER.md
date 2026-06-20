# PROD_CUTOVER.md — Production cutover + soft-launch runbook

The step-by-step operator checklist for the first public release. The **plan + decisions** live in `STRATEGY.md §24.136`; this is the **runbook** you execute against (twin of `RECOVERY.md`). Keep it open during the cutover; check boxes as you go; fill the `TODO:`/`<…>` placeholders with the real values at execution time (this is a deliberately unfilled skeleton until then).

**Placeholders.** This is a tracked spec file → no personal identifiers (per the project's no-personal-data rule). Real domain/name/secrets are runtime values, set in the GH env / box DB / Cloudflare, never written here. Use `hire.<DOMAIN>` (the public Worker host) and `api.hire.<DOMAIN>` (the tunnel ingress, Worker-only).

**Golden rules.**
- **Gate before route** — do not publish the link until §6 (live-verify) is green and §7 (go/no-go) passes.
- **Real identity is DB-only** — the master résumé / `candidate_profile` is seeded into the box DB, never committed (§24.136 D6).
- **Fail-closed stays closed until intended** — `admin_api_enabled` and the Turnstile swap flip on purpose, verified, not by accident.
- Every destructive step has a rollback (§8) — know it before you run the step.

---

## 0. Pre-flight — Phase A must be green (gate)

Do not start Phase B until all of these are true on `dev`:

- [ ] `/admin` control-center built + owner-verified on dev (panels + the included knob set; §24.136 A1).
- [ ] Version/release tooling merged; dev footer shows `dev · <sha>`; a test `v*` tag cut a GitHub Release from `CHANGELOG.md` (§24.136 A2).
- [ ] Security: threat-model doc written, `/security-review` findings triaged (fixed or accepted), sandbox prompt-injection red-team done (§24.136 A3).
- [ ] Master résumé finalized; real `candidate_profile` staged + rendering correctly on dev (`/work` + PDF + a tailoring run); `git grep` clean of real-identity strings (§24.136 A4 / D6).
- [ ] `dev` branch green in CI; dev box healthy (`pnpm health --json` all-ok).

---

## 1. External lead-time items — START EARLY (in parallel with everything)

These have an external clock; kick them off first.

- [ ] **Gmail consent screen → Production** (Google Cloud Console). The dev box has run on a Testing-mode screen with a 7-day refresh-token lifetime → prod Gmail dies weekly without this. Publish the OAuth consent screen to **Production**.
  - Verify the scope set is the production scope set (`gmail.readonly` / `gmail.modify` / `gmail.send`, + Calendar/Drive if wired).
  - `TODO:` note whether Google requires verification for the sensitive scopes (review lag) vs. self-use exemption for the owner's own account.
  - Verify after publish: the prod Gmail token no longer expires on the 7-day clock.
- [ ] **Domain / DNS readiness** — confirm `hire.<DOMAIN>` + `api.hire.<DOMAIN>` are available to point (Cloudflare zone holds the apex). `TODO:` record the zone + the records to add (§2).

---

## 2. Prod infra stand-up

> Most of this is "apply the dev posture to a prod environment." Cross-ref the dev wiring: `bootstrap-vm.sh`, `provision-backend.ts`, `deploy-backend.yml`, `deploy-frontend.yml`, `cloudflare.tf`, `infra/tunnel.tf`, `infra/waf.tf`, `frontend/wrangler.jsonc`, `src/modules/portal/access-jwt.ts`, `frontend/src/routes/api/$.ts`.

### 2.1 Backend service (the VM)
- [ ] Decide prod-on-same-VM vs. separate VM. `TODO:` record the choice + rationale (cost vs. blast-radius).
- [ ] Provision the prod backend service (binds `127.0.0.1` only — no inbound ports; the tunnel dials out).
- [ ] Stamp the upgrade-state marker (§24.126 tripwire) for the prod service.

### 2.2 Tunnel
- [ ] Stand up the prod `cloudflared` tunnel → `api.hire.<DOMAIN>` ingress (Worker-only; never browser-direct — D12).
- [ ] `TODO:` prod tunnel token → GH env secret (note: never pipe to `gh secret set`; use `--body` of a trimmed value — [[feedback_gh_secret_no_pipe]]).

### 2.3 DNS + Worker route
- [ ] Add DNS: `hire.<DOMAIN>` (Worker) + `api.hire.<DOMAIN>` (tunnel).
- [ ] Deploy the frontend Worker to the prod route (`deploy-frontend.yml` prod env / `wrangler.jsonc` prod block).
- [ ] Confirm the browser talks ONLY to the Worker; the Worker proxies `/api/*` (JSON + SSE) to the tunnel with the Access service token.

### 2.4 Cloudflare Access
- [ ] The public site (`hire.<DOMAIN>`) is **open** (no Access on the site itself — it's the public showcase).
- [ ] The Worker→backend service token is wired (the Worker is the authenticated caller of `api.hire.<DOMAIN>`).
- [ ] `/admin*` Access app — see §5 (owner-only).

### 2.5 Terraform edge posture (the §24.70 Commit-4 apply — never live-applied)
- [ ] `terraform plan -var environment=prod` → review (WAF managed ruleset, the 1 custom rule on `/api/{simulator,contact}`, the 1 rate-limit rule).
- [ ] `terraform apply -var environment=prod`.
- [ ] **Bot Fight Mode ON at the public frontend host, OFF at the api/tunnel host** (it can't be scoped + would break the Worker→backend service-token headers — §24.70 D6).

### 2.6 Turnstile (real widget)
- [ ] Create the real prod Turnstile widget (Cloudflare dashboard) → site key + secret key.
- [ ] Swap the dev always-pass **test** keys (§24.70 D5) for the real ones: `TURNSTILE_SECRET` (Worker secret) + `VITE_TURNSTILE_SITE_KEY` (frontend build) for the prod env.
- [ ] Set the expected hostname var (`TURNSTILE_HOSTNAME` = `hire.<DOMAIN>`).

---

## 3. Prod secrets & vars (GH env: prod)

Fill the real values into the **prod** GH environment (never here). Checklist:

| Key | Kind | Notes |
|---|---|---|
| `PORTAL_PUBLIC_URL` / `CP_PORTAL_PUBLIC_URL` | var | `https://hire.<DOMAIN>` (drives attribution `/r/<code>` minting + the résumé-PDF footer — §24.74) |
| `VISIT_IP_HASH_SALT` | secret | a **distinct** random salt (not the dev salt) |
| `TURNSTILE_SECRET` | secret | the real prod Turnstile secret |
| `VITE_TURNSTILE_SITE_KEY` | var | the real prod Turnstile site key |
| Access service token (id + secret) | secret | Worker→backend auth |
| prod tunnel token | secret | §2.2 |
| `VITE_APP_VERSION` | var/CI | injected = the `v*` tag (prod); CI sets it at build (§24.136 D4) |
| `VITE_*` identity/deploy vars | var | per [[identity_ssr_principle]] — build-time deploy identity, personal-data-free defaults |
| `admin_api_enabled` | DB pref | stays **off** until §5 |

- [ ] All prod secrets set + verified present (`gh ... ` / Cloudflare / box `.env` via `bootstrap-vm.sh` regen — don't hand-edit box `.env`).

---

## 4. Identity seed (the real candidate_profile)

- [ ] Seed the finalized master résumé + basics into the **prod** box `candidate_profile` (DB-only — onboarding flow or a one-off script; never a tracked file — §24.136 D6).
- [ ] Verify `/work` composes correctly, `GET /api/resume.pdf` renders, the hero/footer identity is the real one (not the `Jane Doe` placeholder).
- [ ] `git grep` the repo once more — zero real-identity strings landed in tracked files.

---

## 5. `/admin` prod gate

- [ ] Create the prod `/admin*` + `/api/admin/*` **Cloudflare Access app** (owner email only) — Terraform.
- [ ] Confirm `src/modules/portal/access-jwt.ts` validates the Access-JWT (issuer = the team domain; `aud` = the admin app AUD); fail-closed (forged/missing assertion → reject).
- [ ] Flip `admin_api_enabled` → on (prod DB pref).
- [ ] Verify: owner reaches `/admin` (through Access); a non-owner / no-Access request → blocked + the API 404s when the flag/JWT is absent.

---

## 6. Live verification — recorded, not skipped (§24.70 / §24.71 / §24.74)

These need the public surface to mean anything. **Record each result** (don't just tick).

- [ ] **Turnstile** — a real challenge from a real browser on `/contact` + `/simulator`; siteverify passes for a human, blocks a missing/invalid token.
- [ ] **Bot Fight Mode** — live on the frontend host; api host unaffected (service-token calls still flow).
- [ ] **Abuse simulation** — hammer the prod simulator: per-IP daily cap → 429 after the limit; global $-budget → 429 after the ceiling; Workers RL → 429 on burst. `wrangler tail` shows the guard decisions.
- [ ] **Origin-JWT** — a forged `Cf-Access-Jwt-Assertion` to the backend is rejected.
- [ ] **Non-gated paths stay live** — `/api/funnel`, SSE panels don't go "offline"; the `/r/<code>` redirect lands + records a visit.
- [ ] **End-to-end smoke** — `pnpm health --json` all-ok on prod; a real owner Telegram round-trip; a contact submission pings the owner; a simulator run completes.

---

## 7. Soft launch (Phase 10) + go/no-go

- [ ] **Quiet observation window** — prod is up but the link goes nowhere yet. Watch for: stuck queues, dead recurrence chains, auth-failure streaks, budget burn, any leak in `public_*` views. `TODO:` set the window length.
- [ ] **Go/no-go checklist:**
  - [ ] §6 all green + recorded.
  - [ ] Cost telemetry sane (no runaway sim/agent spend); caps confirmed enforced.
  - [ ] No real-identity leak anywhere public; anonymization holding on the pipeline/kits.
  - [ ] Gmail prod token stable (consent screen published; no 7-day death).
  - [ ] Rollback (§8) rehearsed / understood.
- [ ] **Publish** — the link goes out (résumé footer / outreach / wherever). `TODO:` record where + when (attribution will track it).

---

## 8. Rollback

- [ ] **Kill switches** — `simulator_enabled` off (stops the money-spend path); system pause/shadow-mode (RECOVERY.md). The abuse layer + the `$`-budget are the backstops if a switch lags.
- [ ] **DNS / Worker** — revert the Worker route / DNS to take the public surface down fast without touching the backend.
- [ ] **Terraform** — `terraform apply` the prior state if the edge posture misbehaves.
- [ ] **Identity** — the seed is DB-only and reversible; no repo change to revert.
- [ ] Full operator recovery: `RECOVERY.md`.

---

*Cross-refs: `STRATEGY.md §24.136` (plan/decisions), `§24.70` (abuse layer), `§24.74` (attribution + `/admin`), `§24.71`/`§24.72` (identity / résumé), `RECOVERY.md` (ops + kill switches), `CLOUDFLARE_PATTERNS.md` (edge posture).*
