# Career Pilot Operator Manual — Recovery Procedures

For the moments when something goes sideways. Each section is a standalone procedure — read just the one you need. No prior context required.

You're not going to break this thing. The kill switches exist so you can stop it; the recovery procedures exist so you can restart it. **Default state after a recovery: system back online in shadow mode (`LIVE_MODE=false`).** You flip back to live only when you're satisfied.

---

## Quick reference — which procedure do I need?

| Symptom | Procedure |
|---|---|
| I want to silence the bot for a few hours | [§1 Soft pause](#1-soft-pause-pause--resume) |
| Cost is spiking / unexpected behavior / traffic surge | [§2 Emergency halt](#2-emergency-halt-halt--diagnose--resume) |
| I think something's compromised / agent did something bad | [§3 Killswitch + SSH recovery](#3-killswitch--ssh-recovery) |
| Container crashed mid-task and won't recover | [§4 Container restart](#4-container-restart) |
| Host process died after VM reboot | [§5 Host process recovery](#5-host-process-recovery) |
| Lost my Telegram pairing somehow | [§6 Re-pair Telegram bot](#6-re-pair-telegram-bot) |
| I want to wipe local dev state and start onboarding fresh | [§7 Reset to clean state (DEV ONLY)](#7-reset-to-clean-state-dev-only) |
| Portkey is down or I exhausted the budget | [§8 Portkey bypass to direct Anthropic](#8-portkey-bypass-to-direct-anthropic) |
| Cloudflare Tunnel disconnected | [§9 Cloudflare Tunnel recovery](#9-cloudflare-tunnel-recovery) |
| DB feels corrupt | [§10 DB restore from backup](#10-db-restore-from-backup) |
| I edited an application's obfuscation directly in SQL / a public name is leaking in the audit trail | [§11 Resanitize an application's public audit trail](#11-resanitize-an-applications-public-audit-trail) |

---

## 1. Soft pause (`/pause` → `/resume`)

**When:** You're going into a meeting, an interview, or you want a few hours of silence without stopping the system entirely. Reactive responses to your direct messages still work; the agent just won't proactively ping you.

**Procedure:**
1. In Telegram, send `/pause` to the bot. Optionally: `/pause meeting until 3pm` to set a reason.
2. The bot replies: `⏸ Paused. Reactive responses still work. /resume when ready.`
3. The portal's `/live` page shows `⏸ Proactive paused — meeting until 3pm` as a banner.
4. When done: `/resume`. Bot replies: `▶ Resumed. <N> queued events firing now.`

Queued webhook events (recruiter replies that arrived during the pause) fire in order on resume. None are dropped.

**Recovery time:** seconds.

---

## 2. Emergency halt (`/halt` → diagnose → `/resume`)

**When:** Cost is spiking unexpectedly, traffic surge from a viral moment, agent doing something weird and you want to stop everything *now* without killswitch-level severity.

**Procedure:**
1. In Telegram: `/halt cost spike` (or any short reason).
2. Bot replies: `⏹ Halted. <N> active containers killed. Webhook events queueing.`
3. Within 10 seconds, the portal switches: `hire.example.com` serves a graceful degraded view with banner `⏸ System paused for review — back shortly · reason: cost spike`. Simulator shows `Paused for review — last successful runs browsable below`. Contact form still works.
4. **Diagnose.** Common things to check:
   - Portkey dashboard: what's the cost burn? Which subagent? Which session?
   - `journalctl -u career-pilot -n 200` on the VM: any error patterns?
   - `ncl sessions list`: which sessions were running? Anything unexpected?
   - `gh repo view example/career-pilot --json updatedAt`: was there a recent change that might have caused this?
5. **Fix.** Could be:
   - Tighten a preference (`/set sandbox_daily_cap 2`)
   - Tighten a budget (`/set llm_daily_budget_usd 4`)
   - Patch and redeploy (push a commit, wait for GH Actions to finish)
   - Flip to `LIVE_MODE=false` and resume in shadow (`/setmode shadow`)
6. When fixed: `/resume`. Bot replies: `▶ Resumed in <mode>. <N> queued events firing now.`

**Recovery time:** minutes (depending on diagnosis).

**Tip:** If you halted because of a *cost* concern specifically, consider resuming with `LIVE_MODE=false` first — let the system run in shadow for an hour to confirm the fix worked before flipping back to live.

---

## 3. Killswitch + SSH recovery

**When:** You suspect a credential compromise, the agent did something it shouldn't have done (sent an email you didn't approve, wrote to a system it shouldn't have), or any "this needs to STOP and stay stopped" situation. **`/killswitch` is intentionally hard to recover from** — that's the point.

### Triggering

1. In Telegram: `/killswitch`. The bot posts a confirmation card: `⚠ KILLSWITCH — this will revoke credentials and require manual recovery. Confirm? [YES, KILL] [Cancel]`
2. Tap `YES, KILL`.
3. The bot replies: `🛑 Killswitch engaged. All active sessions killed. OneCLI agent tokens revoked. Portkey budget set to 0. Portal serving static "paused for review" page. Recovery requires SSH.`

What just happened:
- All running containers killed.
- OneCLI's per-agent secret tokens for all career-pilot agents revoked → even if a credential leaked, container can't authenticate to anything.
- Portkey's rate limit / budget on the career-pilot AI Providers flipped to 0 → no LLM calls succeed regardless of credential.
- A flag is written to `system_modes` table marking the killswitch state.
- The Cloudflare Worker reads this on every request and serves a static `Paused for review — the candidate` page instead of the normal portal.

### Recovery

You need SSH access to the VM.

```bash
# 1. SSH in (via gcloud — no separate key needed if IAP is configured)
gcloud compute ssh career-pilot-vm --zone=$(gcloud config get-value compute/zone)

# 2. Once in, become the career-pilot user
sudo -i -u career-pilot
cd /opt/career-pilot

# 3. Run the recovery script
./scripts/recover-from-killswitch.sh

# What the script does:
#   - Prompts you to confirm the all-clear ("I have reviewed the incident: y/N")
#   - Re-issues OneCLI agent tokens for career-pilot + career-pilot-sandbox
#   - Restores Portkey AI Provider budgets to their saved values
#   - Clears the killswitch flag in system_modes
#   - Sets LIVE_MODE=false (always — you re-enable LIVE_MODE manually after observation)
#   - Restarts the career-pilot.service systemd unit
#   - Pings Telegram: "▶ Killswitch cleared. System running in shadow mode."

# 4. Verify the portal: hire.example.com should be back to the normal view
#    with the SHADOW MODE badge visible.
# 5. Observe the system in shadow for at least an hour before considering LIVE_MODE=true.
# 6. When satisfied: in Telegram, /setmode live → /confirm (two-step confirmation)
```

**Recovery time:** 5-20 minutes depending on incident investigation.

**Designed friction:** killswitch is meant to be uncomfortable to recover from. That's the point. You should feel forced to actually look at what happened before bringing things back up.

---

## 4. Container restart

**When:** A NanoClaw agent container has crashed, gone unresponsive, or is in an inconsistent state. Symptoms: agent stops responding to Telegram, `ncl sessions list` shows a session as `running` but `processing_ack` is stale.

**Procedure (from Telegram):**
```
/container restart      ← restarts the current session's container
/container restart --rebuild   ← rebuilds the container image then restarts
```

**Procedure (from SSH if Telegram isn't responsive):**
```bash
sudo -i -u career-pilot
cd /opt/career-pilot

# List running containers
docker ps --filter "name=career-pilot-*"

# Restart the host process — it'll re-spawn containers as needed on next message
sudo systemctl restart career-pilot.service

# Or directly kill and re-spawn a specific session:
ncl groups restart --id career-pilot
```

If session JSONL is intact, the agent resumes with full context. If not, NanoClaw creates a fresh session — you may lose the in-progress turn but persistent state (DB) is unaffected.

**Recovery time:** ~30 seconds.

---

## 5. Host process recovery

**When:** VM rebooted, `career-pilot.service` died, or the host Node process is hung.

**Procedure:**
```bash
# Check status
sudo systemctl status career-pilot.service

# If failed, view recent logs
journalctl -u career-pilot.service -n 100 --no-pager

# Restart
sudo systemctl restart career-pilot.service

# Verify
sudo systemctl status career-pilot.service
# Telegram should respond within ~10 seconds
```

If the service won't start, common causes:
- Migration failure (a new migration file with a syntax error) — `journalctl` will show it
- Port conflict (something else grabbed the API port) — `sudo lsof -i :3001`
- OneCLI proxy not running — `sudo systemctl restart onecli`
- Out of disk space — `df -h` and clean up

**Recovery time:** ~1 minute.

---

## 6. Re-pair Telegram bot

**When:** You changed your Telegram account, the bot was deleted by BotFather, or the pairing was somehow lost.

**Procedure:**
```bash
sudo -i -u career-pilot
cd /opt/career-pilot

# Re-run the channel pairing flow
ncl groups list                              # confirm career-pilot agent group exists
pnpm exec tsx scripts/init-telegram.ts       # interactive: prompts for new bot token + chat ID

# If you also need to create a new bot from scratch:
#   1. Open Telegram, message @BotFather, /newbot, follow prompts
#   2. Save the bot token
#   3. Message your bot once to get your chat ID
#   4. Run the init script above with the new credentials
```

**Recovery time:** ~5 minutes (~3 of those minutes is BotFather).

---

## 7. Reset to clean state (DEV ONLY)

**When:** You're testing the onboarding/bootstrapping flow itself and need to nuke local state to get a fresh "first run" experience.

**WARNING:** This destroys local dev state. NEVER run in production. The script refuses to run if it detects a production-shaped env (e.g., `ENVIRONMENT=production` or hostname matches the prod VM).

**Procedure:**
```bash
# From the repo root
pnpm reset:dev

# What it does (interactive — confirms each step):
#   1. Kills all running career-pilot agent containers
#   2. Stops the career-pilot host process
#   3. Wipes data/v2.db and all session JSONLs
#   4. Clears OneCLI dev vault entries (NOT prod — different vault namespace)
#   5. Preserves: your dev Telegram bot pairing (it's per-account, not per-DB),
#      your .env file, your installed deps, your container image
#   6. Re-applies migrations to create a fresh DB
#   7. Prints "Ready — send /start to your dev bot to re-bootstrap"
```

**Recovery time:** ~30 seconds. Then ~5 minutes to walk through the Telegram onboarding flow if you want to validate it.

---

## 8. Portkey bypass to direct Anthropic

**When:** Portkey is down, rate-limited, or you've exhausted the free-tier budget and don't want to pay $99/mo for Pro right now.

**Procedure:**

The system has a built-in fallback. Set an env var on the host:

```bash
# In .env on the VM
PORTKEY_BYPASS=true
ANTHROPIC_API_KEY=sk-ant-...    # Your raw Anthropic API key
```

```bash
# Reload
sudo systemctl restart career-pilot.service
```

What happens:
- New container spawns set `ANTHROPIC_BASE_URL` to the default Anthropic endpoint (not Portkey).
- The `ANTHROPIC_API_KEY` env injects directly into the container at request time via OneCLI.
- Portkey-derived telemetry (cache rate, etc.) becomes unavailable; the `/live` `LLM TELEMETRY` panel shows `—` instead of numbers.
- Cost-tracking falls back to the SDK's `total_cost_usd` estimate (less authoritative).

**To restore Portkey:**
```bash
# Remove or comment PORTKEY_BYPASS in .env
sudo systemctl restart career-pilot.service
```

**Recovery time:** ~30 seconds.

---

## 9. Cloudflare Tunnel recovery

**When:** The portal's API endpoints stop working (frontend can't reach the backend); `cloudflared` container is unhealthy.

**Procedure:**
```bash
# Check tunnel status
docker logs cloudflared --tail 50

# Common: tunnel token rotated or expired
# Restart the cloudflared container:
docker restart cloudflared

# If that doesn't recover, regenerate the tunnel token:
cloudflared tunnel login                          # opens browser auth
cloudflared tunnel rotate <TUNNEL_NAME>
# Update the rotated token in OneCLI vault:
onecli secrets update cloudflare_tunnel_token --value <new-token>
docker restart cloudflared
```

If DNS is also broken: check Cloudflare dashboard → DNS → CNAME for `api.hire.example.com` should point at `<TUNNEL_UUID>.cfargotunnel.com`.

**Recovery time:** ~5 minutes.

---

## 10. DB restore from backup

**When:** SQLite DB is corrupted, you reverted a bad migration, or you need to roll back to yesterday.

**Procedure:**

Backups run via cron on the host: nightly snapshots to `data/backups/` (kept for 14 days), plus weekly to GCS.

```bash
sudo -i -u career-pilot
cd /opt/career-pilot

# List available backups
ls -lh data/backups/

# Stop the host process
sudo systemctl stop career-pilot.service

# Restore (replace YYYY-MM-DD with the date)
cp data/backups/v2-YYYY-MM-DD.db data/v2.db

# Restart
sudo systemctl start career-pilot.service

# Verify
ncl groups list
```

If even the local backups are gone, GCS has weeklies:
```bash
gsutil ls gs://career-pilot-backups/
gsutil cp gs://career-pilot-backups/v2-WEEK.db data/v2.db
sudo systemctl restart career-pilot.service
```

**Recovery time:** ~2 minutes for local backup; ~5 minutes for GCS.

---

## 11. Resanitize an application's public audit trail

**When:** You changed an application's obfuscation policy *outside* the normal agent flow and the public `public_audit_trail` rows are now stale — most urgently, a real company name is showing publicly that should be obfuscated. Common causes:

- You edited `applications.public_state`, `obfuscated_label`, `company_name`, or `company_aliases` with direct SQL.
- You flipped a company to `obfuscated` that was previously `public` (past rows still hold the real name in plaintext).
- You tightened a sanitizer rule and want past rows re-run.

The agent's normal `update_application` path already re-sanitizes automatically (§24.11 hook). This procedure is only for the out-of-band cases — and note `obfuscated_label` is immutable through the agent path, so an `obfuscated_label` edit *always* needs this script.

**Procedure:**

```bash
sudo -i -u career-pilot
cd /opt/career-pilot

# Re-mirror this application's audit rows from the canonical funnel_events
# truth, applying the current obfuscation policy. Safe to run while the
# host is up.
pnpm exec tsx scripts/resanitize-application.ts --id <application-id>
# Prints: Resanitized application <id> (...): rewrote N row(s), deleted M stale row(s).
```

It deletes the application's existing funnel-category `public_audit_trail` rows and re-mirrors each `funnel_events` row through the sanitizer, so the public projection matches current intent. Truth in `funnel_events` is never touched.

**Recovery time:** seconds. **Note:** this is a host-side operator script with no agent surface — the rewrite-the-audit-trail capability is deliberately kept out of the agent's tool palette.

---

## Appendix: useful commands

```bash
# System status
sudo systemctl status career-pilot.service
sudo systemctl status cloudflared.service
docker ps

# Logs
journalctl -u career-pilot.service -f          # follow host logs
docker logs -f cloudflared                     # follow tunnel logs
ncl sessions list                              # active sessions

# Mode + state
ncl groups config get --id career-pilot
sqlite3 data/v2.db "SELECT * FROM system_modes"

# Cost check
# (URL templates — substitute current values)
curl -s -H "x-portkey-api-key: $PORTKEY_API_KEY" \
  "https://api.portkey.ai/v1/analytics/summary?range=1d" | jq

# Health check from outside
curl https://hire.example.com/api/system-status
```

---

## Designed reassurance

The whole point of this manual: you should feel safe with the kill switches. None of them are one-way doors. The killswitch (§3) is the most severe, and even it has a script-driven recovery that takes 5-20 minutes.

If you find yourself reading this manual while something is broken: pause, breathe, find the right section, follow the steps. The system is designed to be controllable.
