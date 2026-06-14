# Cloudflare Protection — Canonical Patterns for Career Pilot

Cribsheet. Sourced from May 2026 Cloudflare docs and the research pass. Referenced by STRATEGY.md §13 (infrastructure), §10 (public API), and **§24.70 (the abuse-hardening build, Phase 9.4a)**.

> **⚠️ Reconciliation (STRATEGY §24.70 / §24.39 D12, 2026-06-14).** This cribsheet predates two architecture shifts. The *patterns* below are still the canonical primitives, but read these corrections first:
> - **The browser talks ONLY to the Worker (§24.39 D12).** All `/api/*` — JSON *and* SSE — proxies through the Worker BFF (`frontend/src/routes/api/$.ts`) to the tunnel; there is no browser-direct `api.hire.*`. The "SSE direct on api.hire" framing in §1/§8/§9 is historical — the Worker proxy is the live path, and the place edge protection attaches.
> - **Turnstile siteverify + Workers RL + the DO caps live in the WORKER, not Express (corrects §2).** The Worker is the only thing that sees a raw visitor request before the tunnel; `guardPublicMutation` in `$.ts` verifies `POST /api/{contact,simulator}` and blind-forwards the rest. Express's `checkSimulatorAllowed()` stays a defense-in-depth `simulator_enabled` kill switch.
> - **Authenticated Origin Pulls / mTLS (§5 Layer 3) is INAPPLICABLE to our cloudflared tunnel** — the VM has no inbound origin to pull from (loopback-bind + outbound tunnel *is* the "only Cloudflare reaches the origin" guarantee). The real Layer-3 is **origin Access-JWT validation in Express** (`Cf-Access-Jwt-Assertion` vs the team JWKS, `aud` = the api app). §5 Layers 1–2 stand.

---

## 1. Subdomain architecture (locked)

```
hire.example.com                    → Cloudflare Worker (TanStack Start)
                                          static assets, SSR pages, /api/contact, /api/sandbox
api.hire.example.com                → Cloudflare Tunnel → Express on GCP VM
                                          /api/funnel, /api/activity, /api/telemetry,
                                          /api/activity/stream, /api/simulator/*, etc.
```

**Why split:** Worker handles short-lived requests with edge caching + Turnstile + WAF. Tunnel direct handles long-lived streams (SSE) without burning Worker subrequest quota or CPU budget.

**Why this works on Cloudflare:** Sub-sub-domains are first-class. Just a CNAME from `api.hire` to `<tunnel-uuid>.cfargotunnel.com`. Verified per [Cloudflare's docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/routing-to-tunnel/).

**CORS** between the two hosts is explicit:

```typescript
// In Express on the VM
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://hire.example.com");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Turnstile-Token");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  next();
});
```

Local dev origin (`http://localhost:5173`) added via env var when `ENVIRONMENT=development`.

---

## 2. Turnstile (CAPTCHA)

Used on `/api/contact` (form submit) and `/api/simulator` (sandbox run start).

> **§24.70 placement:** siteverify runs in the **Worker proxy** (`$.ts` `guardPublicMutation`), not Express — see the reconciliation banner. The Express snippet below shows the verification *logic*; under D12 the call site is the Worker (the token rides the `x-turnstile-token` header the widget sets).

### Frontend (TanStack Start client island)

```tsx
import { Turnstile } from "@marsidev/react-turnstile";

function ContactForm() {
  const [token, setToken] = useState<string | null>(null);

  async function submit(values: ContactInput) {
    if (!token) return;
    await fetch("/api/contact", {
      method: "POST",
      headers: { "x-turnstile-token": token, "content-type": "application/json" },
      body: JSON.stringify(values),
    });
  }

  return (
    <form onSubmit={...}>
      {/* ... fields ... */}
      <Turnstile
        siteKey={import.meta.env.VITE_TURNSTILE_SITE_KEY}
        onSuccess={setToken}
        options={{ appearance: "interaction-only" }}   // invisible default
      />
      <button disabled={!token}>Send</button>
    </form>
  );
}
```

Site key is public (safe to expose). Secret key lives in OneCLI vault on the Express side.

### Backend verification (Express server function or route handler)

```typescript
import { v4 as uuidv4 } from "uuid";

async function verifyTurnstile(token: string, ip: string, action: string): Promise<boolean> {
  const idempotencyKey = uuidv4();   // for retry safety
  const body = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET!,
    response: token,
    remoteip: ip,
    idempotency_key: idempotencyKey,
  });
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body,
  });
  const data = await r.json();
  // Verify hostname + action server-side; never trust client
  return data.success
    && data.hostname === "hire.example.com"
    && data.action === action;
}

app.post("/api/contact", async (req, res) => {
  const ok = await verifyTurnstile(
    req.headers["x-turnstile-token"] as string,
    req.ip,
    "contact_submit"
  );
  if (!ok) return res.status(403).json({ error: "turnstile_failed" });
  // ... process the submission
});
```

**Free tier limits:** 20 widgets per Cloudflare account, unlimited `siteverify` calls. We use 2 widgets (contact + simulator).

**Token rules (don't forget):**
- 5-minute TTL. Don't gate multi-step flows on a single token.
- Single-use. Retries with the same token return `timeout-or-duplicate`. Use `idempotency_key` to make retries safe.
- 2048-char max.

**Mode:** `interaction-only` (invisible by default; widget only renders if Cloudflare's risk engine flags). For known suspicious sessions, re-render with `appearance: "always"`.

Source: [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/).

---

## 3. Workers Rate Limiting (cheap front line)

Cloudflare's Workers Rate Limiting API. Free on the Workers free plan. Periods limited to **10 seconds or 60 seconds only** (no daily windows — for that we need Durable Objects, §4).

```jsonc
// wrangler.toml
[[unsafe.bindings]]
type = "ratelimit"
name = "SANDBOX_BURST"
namespace_id = "1001"
simple = { limit = 5, period = 60 }

[[unsafe.bindings]]
type = "ratelimit"
name = "CONTACT_BURST"
namespace_id = "1002"
simple = { limit = 3, period = 60 }
```

```typescript
// In a Worker route handler / TanStack server function
const { success } = await env.SANDBOX_BURST.limit({ key: clientIp });
if (!success) {
  return new Response("Rate limited (burst). Try again in a minute.", { status: 429 });
}
```

**What this catches:** 60-second bursts (someone scripting a flood). Layered with Turnstile and the DO daily cap below.

Source: [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

---

## 4. Durable Objects for daily caps

Workers RL can't do 24-hour windows. Durable Objects give us strongly-consistent counters that reset on cron. Two DOs:

### `IpDailyCounter` — per-IP daily cap on sandbox runs

```typescript
// Each instance keyed by IP address
export class IpDailyCounter implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/increment") {
      let count = (await this.state.storage.get<number>("count")) ?? 0;
      count += 1;
      await this.state.storage.put("count", count);
      // Schedule midnight reset (UTC) if not already
      const next = await this.state.storage.getAlarm();
      if (next === null) {
        const tomorrow = new Date();
        tomorrow.setUTCHours(24, 0, 0, 0);
        await this.state.storage.setAlarm(tomorrow.getTime());
      }
      return Response.json({ count, limit: 10, allowed: count <= 10 });
    }
    // ... GET, etc.
  }

  async alarm() {
    await this.state.storage.delete("count");
  }
}
```

```typescript
// In wrangler.toml
[[durable_objects.bindings]]
name = "IP_DAILY_COUNTER"
class_name = "IpDailyCounter"

[[migrations]]
tag = "v1"
new_classes = ["IpDailyCounter"]
```

### `GlobalBudgetCounter` — $5/day total cap on sandbox compute

```typescript
export class GlobalBudgetCounter implements DurableObject {
  // Single instance keyed by literal string "GLOBAL"
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/check") {
      const cents = (await this.state.storage.get<number>("cents")) ?? 0;
      const dailyCapCents = 500;   // $5
      return Response.json({ cents, dailyCapCents, allowed: cents < dailyCapCents });
    }
    if (url.pathname === "/charge") {
      const { amountCents } = await req.json();
      let cents = (await this.state.storage.get<number>("cents")) ?? 0;
      cents += amountCents;
      await this.state.storage.put("cents", cents);
      // schedule alarm as in IpDailyCounter
      return Response.json({ cents });
    }
    // ...
  }
  async alarm() {
    await this.state.storage.delete("cents");
  }
}
```

**Usage in the sandbox-start path:**

```typescript
// 1. Check global budget (cheapest check)
const global = await env.GLOBAL_BUDGET.idFromName("GLOBAL").get();
const globalCheck = await global.fetch("https://internal/check");
if (!(await globalCheck.json()).allowed) {
  return Response.json({ error: "daily_budget_exceeded", retryAt: tomorrowUtc() }, { status: 429 });
}

// 2. Check per-IP daily
const ipCounter = await env.IP_DAILY_COUNTER.idFromName(clientIp).get();
const ipCheck = await ipCounter.fetch("https://internal/increment");
const { allowed } = await ipCheck.json();
if (!allowed) {
  return Response.json({ error: "per_ip_daily_cap", retryAt: tomorrowUtc() }, { status: 429 });
}

// 3. Forward to api.hire (Tunnel) to actually spin up the sandbox session
// 4. After the session completes, the backend reports actual cost back to GlobalBudgetCounter via /charge
```

Source: [Durable Objects docs](https://developers.cloudflare.com/durable-objects/) + [alarms](https://developers.cloudflare.com/durable-objects/api/alarms/).

---

## 5. Cloudflare Tunnel — triple defense at the origin

Three layers protect the Express server from anything that isn't legitimately our Worker:

### Layer 1: Cloudflare Access (free for ≤50 users)

In Cloudflare Zero Trust dashboard → Access → Applications → "Add an application" pointing at `api.hire.example.com`. Add a Service Auth policy.

```typescript
// In the Worker — sending requests to api.hire.*
const r = await fetch("https://api.hire.example.com/api/funnel", {
  headers: {
    "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
    "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
  },
});
```

Cloudflare Access rejects anything without those headers at the edge. The Worker's secrets are configured via `wrangler secret put CF_ACCESS_CLIENT_ID`.

### Layer 2: JWT validation at origin

Even if a request makes it through Access, validate the `Cf-Access-Jwt-Assertion` header at the origin (defense in depth):

```typescript
// In Express (career-pilot host)
import { jwtVerify, createRemoteJWKSet } from "jose";

const JWKS = createRemoteJWKSet(
  new URL(`https://${process.env.CF_ACCESS_TEAM}.cloudflareaccess.com/cdn-cgi/access/certs`)
);

app.use(async (req, res, next) => {
  const token = req.headers["cf-access-jwt-assertion"] as string;
  if (!token) return res.status(403).end();
  try {
    await jwtVerify(token, JWKS, {
      issuer: `https://${process.env.CF_ACCESS_TEAM}.cloudflareaccess.com`,
      audience: process.env.CF_ACCESS_AUD,
    });
    next();
  } catch {
    return res.status(403).end();
  }
});
```

Keys rotate every 6 weeks with 7-day overlap — never hard-code; always fetch from the JWKS endpoint.

### Layer 3: Authenticated Origin Pulls (mTLS)

> **§24.70: N/A for our cloudflared-tunnel topology.** There is no public origin for Cloudflare to pull from — the VM binds `127.0.0.1` only and the tunnel dials outbound, so the tunnel + loopback-bind already *are* the "only Cloudflare reaches the origin" guarantee. The real Layer-3 defense-in-depth is **origin Access-JWT validation in Express** (Layer 2 above). AOP applies only to a directly-reachable origin (a model we don't use). Kept here for reference.

In Cloudflare dashboard → SSL/TLS → Origin Server → Authenticated Origin Pulls (zone-level, free). Toggle on.

Configure Express (via reverse proxy or directly via `https.createServer`) to require a client cert and verify it's Cloudflare's. Defense-in-depth: even if our tunnel address leaks, anything not from Cloudflare can't even complete the TLS handshake.

Source: [Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/).

---

## 6. WAF / Bot Fight Mode posture

**Free tier configuration:**

| Setting | `hire.example.com` | `api.hire.example.com` |
|---|---|---|
| Cloudflare Free Managed Ruleset | **ON** (default) | **ON** (default) |
| Bot Fight Mode | **ON** (catches obvious bots before Worker logic) | **OFF** (would break our Worker→backend signed headers) |
| Custom WAF rule (1 allowed on free) | Spend on: `/api/sandbox/* AND missing valid Turnstile cookie → JS Challenge` | — |
| Rate limiting rule (1 allowed on free, 10s windows only) | Combined with Workers RL above | — |

**Bot Fight Mode caveat:** Cannot be customized or bypassed via custom rules. If it kills a legit caller, the only option is to disable it. Hence: ON at apex, OFF at api.

Source: [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/), [WAF managed rulesets](https://developers.cloudflare.com/waf/managed-rules/).

---

## 7. Cloudflare Web Analytics

Free, no cookies, GDPR/CCPA-clean. Use **mode (a)** — JS beacon snippet in TanStack Start root layout (works even though `hire.example.com` is orange-clouded; mode (b) automatic would also work but explicit is clearer):

```tsx
// routes/__root.tsx
<script
  defer
  src="https://static.cloudflareinsights.com/beacon.min.js"
  data-cf-beacon={JSON.stringify({ token: "<your-token-from-cf-dashboard>" })}
/>
```

Tracks: page views, unique visitors (privacy-preserving estimate), referrers, country, browser, OS, Core Web Vitals. **Doesn't track:** individual sessions, custom events, conversion funnels. For event-level telemetry (e.g. "simulator runs initiated"), we rely on our own SSE-fed `/live` activity stream → `public_audit_trail`.

Source: [Web Analytics](https://developers.cloudflare.com/web-analytics/).

---

## 8. SSE through the Worker (yes, it works)

Cloudflare Workers support SSE responses with no fixed wall-clock duration. CPU time is what's metered (10ms free, 5min paid), and `fetch()` waits do NOT count toward CPU time. So a long-running SSE stream that mostly idles between LLM tokens fits well within the free tier.

```typescript
// Worker (TanStack Start API route)
export async function GET({ request, params }: { request: Request; params: { id: string } }) {
  const upstream = await fetch(
    `https://api.hire.example.com/api/simulator/${params.id}/stream`,
    {
      headers: {
        "CF-Access-Client-Id": env.CF_ACCESS_CLIENT_ID,
        "CF-Access-Client-Secret": env.CF_ACCESS_CLIENT_SECRET,
      },
    }
  );

  // Pipe the upstream SSE body straight through
  return new Response(upstream.body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
```

**Why we still chose to expose SSE direct on `api.hire.*`** (per §1):
- Avoid burning the Worker's 50-subrequest cap on free plan (every Worker invocation can make 50 outbound fetches; an SSE stream is one of them but holds it for minutes)
- Browser → backend latency is lower without the Worker in the middle

But the Worker proxy fallback works if we ever need to add edge-layer protection to streams.

Source: [Workers SSE / streams](https://developers.cloudflare.com/workers/runtime-apis/streams/), [Cloudflare Agents HTTP + SSE](https://developers.cloudflare.com/agents/api-reference/http-sse/).

---

## 9. Sandbox abuse protection — layered defense

In execution order, cheapest first:

1. **Cloudflare Bot Fight Mode** at apex (free, auto)
2. **Turnstile invisible token required** to start a sandbox run (free, auto-verify on backend)
3. **Workers Rate Limit** (60s burst, ~5 runs/min/IP) — Workers RL binding
4. **Durable Object: per-IP daily cap** (10 runs/IP/day, midnight UTC reset)
5. **Durable Object: global $ budget** ($5/day cap, midnight UTC reset)
6. **Suspicious-signal escalation:** ASN-on-Hetzner/OVH/DigitalOcean, missing `Sec-Ch-Ua`, headless UA, no Referer → re-prompt managed Turnstile challenge
7. **Geographic throttling:** lower per-IP daily cap for ASNs in the top-abuse list (Cloudflare gives `request.cf.asn` and `request.cf.country` free in the Worker)
8. **Backend output cap:** hard `max_tokens` + `maxBudgetUsd: 0.10` per simulator run (so even successful abuse caps at $0.04-0.10 per run)
9. **No account required.** $5/day cap is the real backstop. If sandbox abuse becomes endemic, add magic-link email gating (see V2_IDEAS.md item 8).

---

## 10. Quick reference card

```
Domain split:
  hire.example.com         → Worker (TanStack Start)
  api.hire.example.com     → Tunnel → Express
                                  (CF Access service-auth + origin JWT + AOP mTLS)

Free-tier limits to know:
  Turnstile: 20 widgets per account, unlimited siteverify
  Workers RL binding: 10s or 60s windows only
  Workers bundle: 3 MiB compressed
  WAF custom rules: 1 on free
  Rate limit rules: 1 on free (10s window)
  Durable Object storage: 1 GB free
  Cloudflare Access: free for ≤50 users

Layers (cheapest first):
  Bot Fight Mode (apex) → Turnstile → Workers RL → DO daily caps → DO budget → suspicious signal → geo → backend output cap
```

---

## 11. URLs to keep handy

- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/)
- [Workers Rate Limiting binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
- [Durable Objects](https://developers.cloudflare.com/durable-objects/)
- [DO alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Workers platform limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Workers SSE / streams](https://developers.cloudflare.com/workers/runtime-apis/streams/)
- [Access JWT validation at origin](https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/)
- [Authenticated Origin Pulls](https://developers.cloudflare.com/ssl/origin-configuration/authenticated-origin-pull/)
- [WAF managed rulesets](https://developers.cloudflare.com/waf/managed-rules/)
- [Bot Fight Mode](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/)
- [Web Analytics](https://developers.cloudflare.com/web-analytics/)
- [@marsidev/react-turnstile](https://github.com/marsidev/react-turnstile)
