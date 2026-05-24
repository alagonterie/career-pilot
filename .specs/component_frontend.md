# Component Design: Next.js Recruiter Portal & Cloudflare Deployment

This document details the frontend architecture for the recruiter-facing application. The app serves as both a resume portal for the candidate and a real-time monitor displaying the pipeline operations of their background AI agents.

---

## 1. Next.js App Router Structure

The frontend is constructed using Next.js 14/15 App Router structure and deployed on Cloudflare Workers.

```text
frontend/
├── src/
│   ├── app/
│   │   ├── layout.tsx             # Root layout with font-face and SEO tags
│   │   ├── page.tsx               # Main recruiter landing page & portfolio
│   │   ├── pipeline/
│   │   │   └── page.tsx           # Real-time agent monitoring dashboard
│   │   └── api/
│   │       ├── logs/
│   │       │   └── route.ts       # Server-side proxy fetching sanitized logs from GCP
│   │       └── simulate/
│   │           └── route.ts       # Interactive simulation route for recruiter testing
│   ├── components/
│   │   ├── StatusHeader.tsx       # Live "Hired yet?" Status Tracker
│   │   ├── FunnelRace.tsx         # Gamified candidate application pipeline
│   │   ├── RecruiterSimulator.tsx # Interactive outreach & tailoring playground
│   │   ├── TelemetryGrid.tsx      # Agent performance statistics (gauges)
│   │   ├── LogConsole.tsx         # Streaming CLI-like terminal logs
│   │   └── Charts.tsx             # Canvas-based charts showing market trends
│   └── styles/
│       └── globals.css            # Base stylesheet containing design variables
├── wrangler.jsonc                 # Cloudflare configuration file
├── open-next.config.ts            # OpenNext adaptor mapping
├── next.config.ts                 # Next.js configurations
└── package.json
```

---

## 2. Environment Variables & Non-Hardcoded Configurations

To ensure the repository is fully generic and shareable, **no personal candidate information (name, title, social links, resume content, or domains) is hardcoded in the frontend code**. Instead, all views read from Cloudflare variables or Next.js environment variables.

### Build-Time Environment Variables
When compiling the Next.js app, the build script injects these environment variables from GitHub Actions:
- `NEXT_PUBLIC_CANDIDATE_NAME`: Full name of the candidate (e.g. *Alexander LaGonterie*).
- `NEXT_PUBLIC_CANDIDATE_TITLE`: Candidate's professional title (e.g. *Senior Software Engineer*).
- `NEXT_PUBLIC_API_URL`: The URL of the backend VM hosting the database logs (e.g. *https://api.mydomain.com*).
- `NEXT_PUBLIC_GITHUB_URL`: URL to the candidate's GitHub profile.
- `NEXT_PUBLIC_LINKEDIN_URL`: URL to the candidate's LinkedIn profile.

---

## 3. UI Design System & Gamified Recruiter Features

To drive virality and engagement, the portal incorporates a premium, gamified developer aesthetic:

### A. Dynamic "Hired yet?" Status Header (`StatusHeader.tsx`)
A prominent hero element at the top of the viewport indicating the candidate's status:
- **Available State:** Displays a pulsing neon-green aura, showing `🟢 OPEN FOR OFFERS: ACTIVE NEGOTIATIONS`.
- **Hired State:** If the database registers a status of `HIRED`, the portal automatically locks, triggers a client-side confetti animation, and displays a sleek digital trophy: `🏆 TARGET SECURED: HIRED BY [OBFUSCATED TECH CO]`.

### B. The Funnel "Horse Race" (`FunnelRace.tsx`)
Instead of a static list of applications, we render a horizontal "race track" using CSS grid and SVG icons.
- Real-time applications are loaded as obfuscated competitor tokens (e.g., *"Competitor: FinTech Unicorn A"*, *"Competitor: Web3 Startup B"*).
- The competitor tokens progress across vertical lanes corresponding to interview stages:
  `[ Applied ] ---> [ Tech Screen ] ---> [ System Design ] ---> [ Final Rounds ] ---> [ Offer Received ]`
- Hovering over a competitor token opens a tooltip showing their stats (e.g., *"Date Applied: May 24"*, *"Current Lead Agent: Coach"*, *"Win Confidence: 74%"*).

### C. Interactive Pitch Simulator (`RecruiterSimulator.tsx`)
A core interactive widget designed to show off the backend capabilities in a safe sandboxed environment.
1. The visiting recruiter inputs their company name, URL, and a target job description.
2. They click *"Simulate Application"*.
3. The frontend triggers `/api/simulate`, sending a request to the backend. The backend runs a fast sandboxed cycle of the **Resume Tailor** and **Cold Outreach** agents using a cached resume profile.
4. Within seconds, the recruiter receives:
   - A tailored bullet-point diff showing how the candidate's experience aligns with their specific role.
   - A highly personalized cold email pitch customized for their engineering team.
5. This is done on-the-fly and does not write to the persistent application database, serving as a zero-risk, high-impact demonstration of Alexander's AI engineering skills.

### D. Agent Telemetry Grid (`TelemetryGrid.tsx`)
Displays dials, neon counters, and server metrics showing the system's operational intensity:
- **Scanned Jobs Count:** Cumulative number of jobs processed.
- **Resumes Tailored:** Total custom CV runs.
- **Portkey Cache Performance:** Percentage of LLM queries served from cache (saving candidate api costs).
- **Ollama Status:** Live connection ping and loaded model configuration (e.g. `llama3.2:3b`).

---

## 4. CSS Design Rules (`globals.css`)
```css
:root {
  --bg-primary: 220 20% 5%;
  --bg-secondary: 220 20% 8%;
  --border-color: 220 15% 15%;
  
  --text-primary: 0 0% 98%;
  --text-secondary: 220 10% 70%;
  
  --brand-primary: 260 85% 60%;    /* Cyber Purple */
  --brand-secondary: 190 90% 50%;  /* Neon Cyan */
  --accent-success: 140 70% 50%;   /* Emerald Green */
  
  --glass-bg: rgba(10, 12, 16, 0.7);
  --glass-border: rgba(255, 255, 255, 0.08);
}

body {
  background-color: hsl(var(--bg-primary));
  color: hsl(var(--text-primary));
  font-family: 'Outfit', -apple-system, BlinkMacSystemFont, sans-serif;
  overflow-x: hidden;
}

/* Premium Glassmorphism Card Utility */
.glass-card {
  background: var(--glass-bg);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.37);
  transition: transform 0.3s cubic-bezier(0.25, 0.8, 0.25, 1), border-color 0.3s ease;
}

.glass-card:hover {
  transform: translateY(-4px);
  border-color: hsla(var(--brand-secondary), 0.4);
}

/* Lane Animations for the Funnel Race */
@keyframes pulseGlow {
  0%, 100% { box-shadow: 0 0 5px hsla(var(--brand-secondary), 0.4); }
  50% { box-shadow: 0 0 15px hsla(var(--brand-secondary), 0.8); }
}

.competitor-token {
  animation: pulseGlow 2s infinite ease-in-out;
  border-radius: 50%;
  transition: all 0.5s ease-in-out;
}
```

---

## 5. Cloudflare Deployment via `@opennextjs/cloudflare`

Deploys to **Cloudflare Workers** utilizing the `@opennextjs/cloudflare` adapter to compile the Next.js App Router for the V8 runtime.

### Configuration Requirements (`wrangler.jsonc`)
The Cloudflare Worker configuration must include:
- `compatibility_date`: Set to `"2025-04-01"` or later to ensure support for modern web standards and runtime APIs.
- `compatibility_flags`: Must include `["nodejs_compat"]` to enable Node.js API polyfills and compatibility modules without manual bundling.

### Bundle Size Limits & Optimization (Workers Free Plan)
Cloudflare Workers Free Plan enforces a strict compressed (gzipped) bundle size limit of **3 MiB** (10 MiB on the Paid Plan). To stay within this budget:
1. **Analyze Bundle Bloat:** Run `npx @opennextjs/cloudflare build` and use ESBuild Bundle Analyzer on `.open-next/server-functions/default/handler.mjs.meta.json`.
2. **Avoid Heavy Server SDKs:** Do not import heavy Node.js SDKs (e.g. native databases or file utilities) inside the Server Components or API routes. Forward requests to the backend VM REST APIs using lightweight `fetch` instead.
3. **Data Assets Separation:** Move large JSON files or static i18n profiles to the public folder or retrieve them at runtime using Worker bindings rather than bundling them into the server build.

### Request Context Isolation (Preventing I/O Reuse Errors)
To prevent the `Error: Cannot perform I/O on behalf of a different request` error:
- Do not instantiate HTTP clients, authentication helpers, or API wrappers in the global scope.
- Initialize all stateful I/O resources **strictly inside the request handler function** (e.g. within `GET` or `POST` functions in Next.js route handlers) to ensure they belong to the correct event context.

---

## 6. SEO Best Practices
Renders metadata objects dynamically using the injected candidate credentials. Integrates unique, browser-testable `id` properties on all buttons and input panels to facilitate integration testing.
