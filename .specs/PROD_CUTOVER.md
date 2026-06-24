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
- [ ] Launch-state polish + the concluded-mode `/admin` toggle built + owner-verified on dev: the cold-start reads fresh-not-broken on an empty pipeline (no perpetual skeleton); `site_lifecycle_state` flips `/` + `/pipeline` into the anonymized retrospective (§24.136 A5 / §24.149).
- [ ] `dev` branch green in CI; dev box healthy (`pnpm health --json` all-ok).

---

## 1. External lead-time items — START EARLY (in parallel with everything)

These have an external clock; kick them off first.

- [ ] **Gmail consent screen → Production** (Google Cloud Console). The dev box has run on a Testing-mode screen with a 7-day refresh-token lifetime → Gmail dies weekly without this. **Path A — self-use, unverified** (decided §24.148; confirmed vs. Google's docs): the Gmail scopes are *restricted*, but verification is NOT required to operate self-use — publish to Production, accept the one-time "unverified app" warning, and the 100-user cap is moot. **No Google review, no CASA assessment, no cost — so there is no "review lag" to start early for; it's a ~5-min Console action that can be done any time (and fixes the dev box's weekly death too, same project).**
  - Scope set (Console → Data Access): `gmail.modify` (restricted) + `calendar.events.owned` (sensitive) + `drive.file` (non-sensitive) + `openid`/`userinfo.email`/`userinfo.profile` (sign-in). For self-use, the per-scope justification boxes + the "what features" dropdown + the demo-video field on the Data Access page are left **BLANK** (verification not pursued).
  - Consent-screen branding: privacy-policy URL = `https://hire.<DOMAIN>/privacy`, terms-of-service URL = `https://hire.<DOMAIN>/terms` (both built, §24.148); homepage = `https://hire.<DOMAIN>`; authorized domain = `<DOMAIN>` (verify in Search Console if it asks).
  - Steps: OAuth consent screen → **Publish app / set status to In production** → re-authorize the career account once (Advanced → continue, through the unverified warning) → drop the fresh non-expiring refresh token into OneCLI (`onecli apps ...`).
  - Verify after publish: the prod Gmail token no longer expires on the 7-day clock (re-check ~8 days later, or confirm token metadata).
  - (Only if you later want NO warning / multi-user: full verification = Path B, brand review + a paid annual CASA security assessment + weeks of Google review. Not needed for self-use.)
- [ ] **Domain / DNS readiness** — confirm `hire.<DOMAIN>` + `api.hire.<DOMAIN>` are available to point (Cloudflare zone holds the apex). `TODO:` record the zone + the records to add (§2).

---

## 2. Prod infra stand-up

> Most of this is "apply the dev posture to a prod environment." Cross-ref the dev wiring: `bootstrap-vm.sh`, `provision-backend.ts`, `deploy-backend.yml`, `deploy-frontend.yml`, `cloudflare.tf`, `infra/tunnel.tf`, `infra/waf.tf`, `frontend/wrangler.jsonc`, `src/modules/portal/access-jwt.ts`, `frontend/src/routes/api/$.ts`.

### 2.1 Backend service (the VM) — SAME VM as dev (§24.165 D1)
- [x] Decided: **same VM** as dev (cost; dev goes quiet post-launch). Per-checkout isolation is automatic — the prod checkout at `/opt/career-pilot` derives its unit/image/DB from the path; distinct ports **3004 portal / 3003 webhook** (clear of dev's 3002/3001).
- [ ] Provision the prod backend service via the new `deploy-backend-prod.yml` (tag / `workflow_dispatch`; `CP_ENVIRONMENT=production CP_ALLOW_PRODUCTION=1`; binds `127.0.0.1` only — no inbound ports; the tunnel dials out).
- [ ] Post-launch: put **dev into system-pause** (RECOVERY.md) so it stops spawning containers — bounds the shared 4 GB (§24.165 D1).
- [ ] The upgrade-state marker is stamped by the bootstrap step (§24.126 tripwire) for the prod checkout.

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

- [ ] Create the **two path-scoped** owner-only **Cloudflare Access apps** on `/admin` + `/api/admin` (owner email only) — Terraform `cloudflare.tf`. The public host is otherwise **open**; these are the PRIMARY admin gate (§24.165 D3).
- [ ] Confirm `src/modules/portal/access-jwt.ts` validates the Access-JWT (issuer = the team domain; **`aud` = the _api_ app AUD** — the Worker re-auths to the tunnel with the api service token, so the assertion at the loopback is the api app's; the *admin* app gates at the edge, §24.165 D4); fail-closed (forged/missing → reject). Set `CF_ACCESS_TEAM` + `CF_ACCESS_AUD` in the prod `.env`; flip `origin_jwt_validation_enabled`.
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

- [ ] **Quiet observation window = the pipeline warm-up window** (§24.149 D5) — prod is up but the link goes nowhere yet. Watch for: stuck queues, dead recurrence chains, auth-failure streaks, budget burn, any leak in `public_*` views. `TODO:` set the window length. **Use it to warm the pipeline honestly:** the real agent does its private/reversible work (scrape, research, draft, build pipeline rows) so by publish time the pipeline is genuinely populated — **no fake data** (§24.149 D1), just the real search run a few days ahead of the link. Keep **irreversible outreach sends gated** (the `draft`-only path / approval gate) until you're confident in the prod system. Note: *recent outcomes* are the slowest to fill (replies/interviews take real-world weeks) — confirm that surface reads fresh-not-empty.
- [ ] **Go/no-go checklist:**
  - [ ] §6 all green + recorded.
  - [ ] Cost telemetry sane (no runaway sim/agent spend); caps confirmed enforced.
  - [ ] No real-identity leak anywhere public; anonymization holding on the pipeline/kits.
  - [ ] Cold-start reads fresh-not-broken (empty/early states honest; no perpetual skeleton); `site_lifecycle_state` = `active` (§24.149).
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

*Cross-refs: `STRATEGY.md §24.136` (plan/decisions), `§24.70` (abuse layer), `§24.74` (attribution + `/admin`), `§24.71`/`§24.72` (identity / résumé), `§24.149` (launch-state / lifecycle / warm-up window), `RECOVERY.md` (ops + kill switches), `CLOUDFLARE_PATTERNS.md` (edge posture).*
