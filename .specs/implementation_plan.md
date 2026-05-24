# Implementation Plan: Career Pilot Agent System

## Product Purpose & Motivation

This project is an autonomous, agentic system designed to manage and optimize the job-hunting pipeline for any software engineer. The codebase is fully generic and parameterized. Any developer can fork the repository, set up their credentials, and run it.

### The Problem
Finding and applying to software engineering roles is a time-consuming, manual process. It requires scanning job boards, filtering for relevance, rewriting resume bullet points to align with job descriptions, writing personalized outreach emails to recruiters, tracking application stages, and preparing for technical/architectural interviews. 

### The Vision
We are building a highly autonomous, cloud-hosted agent system (powered by a customized NanoClaw instance) that acts as a **private, executive job-hunting assistant**. 
- It works 24/7 in the background, identifying leads, preparing custom application materials, and drafting outreach messages.
- It interfaces with the user via a single, conversational messaging channel (Telegram) using **natural language only** (no rigid slash commands), and proactively alerts the candidate when their attention is required (e.g., when a high-relevance job is ready to be reviewed, or an interview is scheduled).
- It integrates with Google Workspace (Gmail and Calendar) to automatically track applications and prepare interview prep materials.

### Conversational Onboarding (Bootstrapping)
Upon first startup, the system is empty of any candidate specifics. It initiates a natural-language bootstrapping sequence over Telegram, prompting the user for:
- Full Name
- Target Job Keywords & Preferences
- Location Preferences (Remote/Hybrid/Onsite)
- Master Resume Content
- Deployment Domain

These parameters are saved in a localized SQLite database, meaning **no personal data is hardcoded in the codebase**.

### The Showcase Value (Public Recruiter Portal)
The entire codebase and configuration live in a **public GitHub repository** and a public portal. The portal features a secure, sanitized, real-time "Behind the Scenes" pipeline view of what the agents are doing. To make the site highly engaging and viral, it integrates **gamification elements**:
- **The Funnel "Horse Race":** A dynamic visualization showing anonymized application competitors ("Series-B AI Startup A", "Fintech Unicorn B") advancing through hiring stages in real-time.
- **Interactive Pitch Playground:** A widget where recruiters input their own company details and receive a simulated, on-the-fly tailored resume bullet-point set and cold outreach pitch, proving the system's runtime capability.
- **Live Status & Telemetry:** Neon stats, active model configurations, and total Portkey API caching metrics, showcasing Jane's engineering expertise responsibly.

---

## Detailed Component Specifications & Feasibility

Given the complexity of provisioning cloud infrastructure, building containerized agents, and deploying a modern Web dashboard, this plan is split into dedicated design and feasibility documents:

*   [Feasibility Analysis Document](file:///C:/Projects/career-pilot/.specs/feasibility_analysis.md)
    - Critical engineering reviews addressing Telegram bot long polling, headless Google API OAuth redirection, job site bot protection, and privacy protection (Double-Pass Obfuscation Engine).
*   [Backend Design Document](file:///C:/Projects/career-pilot/.specs/component_backend.md)
    - Details of the customized NanoClaw Host Orchestrator, SQLite schemas, the natural-language bootstrapping flow, secure file-based IPC to isolate containers, Google Workspace synchronizers, Telegram event loop, and Docker GPU pass-through configuration.
*   [Frontend Design Document](file:///C:/Projects/career-pilot/.specs/component_frontend.md)
    - Specifications for the Next.js Recruiter Portal, gamified elements (Funnel Race, Pitch Simulator, Telemetry, and Status Header), deployment to Cloudflare Workers via `@opennextjs/cloudflare`, HSL styling rules, and SEO setups.
*   [Infrastructure Design Document](file:///C:/Projects/career-pilot/.specs/component_infrastructure.md)
    - Provisioning rules for GCP VM (Container-Optimized OS), Cloudflare DNS configurations, and keyless GitHub Actions workflows using Workload Identity Federation, driven entirely by repo secrets and variables to avoid hardcoded domain strings.

---

## Technical Stack & Model Version Grounding

### OpenRouter & Model Identifiers
Our AI configurations target these specific OpenRouter endpoints:
- **High-Reasoning/Tailoring Agent:** `anthropic/claude-sonnet-4-6` or `anthropic/claude-opus-4-7`.
- **Fast-Scraping/Summarizer Agent:** `google/gemini-3.5-flash` (optimized for fast tool invocation and analysis).

### Portkey Integration & Model Catalog
Portkey acts as our AI Gateway. The backend points to Portkey's OpenAI-compatible gateway.
- **Credential Security via Model Catalog:** We configure OpenRouter as a provider within Portkey's Model Catalog. This stores the OpenRouter API key securely in Portkey's vault. The backend VM only requires a `PORTKEY_API_KEY` to connect, completely eliminating the need to deploy or store the `OPENROUTER_API_KEY` on the VM or pass it in code headers.
- **Model Mapping:** We reference models using the Portkey Model Catalog slug format: e.g. `@openrouter-catalog/google/gemini-3.5-flash`.
- **Semantic Caching:** Portkey applies Semantic Caching to avoid duplicate LLM calls during developer testing, saving token cost and logging traces.
- Fallback: If `PORTKEY_API_KEY` is not set, Vercel AI SDK routes directly to OpenRouter or local Ollama.

### Automated Local Ollama Setup (GPU-accelerated Developer Sandbox)
To enable unlimited, zero-cost E2E pipeline testing without triggering LLM fees or cloud provider costs:
1. We run Ollama inside a local Docker container via our development `docker-compose.yml` (omitted in production `docker-compose.prod.yml`).
2. Windows GPU acceleration (NVIDIA) is configured inside local Docker Compose via WSL2 GPU pass-through, leveraging the developer's physical GPU.
3. The root onboarding script automatically verifies the Ollama container is up and triggers `docker exec -it ollama ollama pull llama3.2` to load local models automatically.

### Zero-Manual Developer Onboarding (Husky + lint-staged)
We will automate code formatting, linting, and Git hooks:
- **Husky & lint-staged** are configured at the repository root.
- A `prepare` script is added to the root `package.json` (`"prepare": "husky"`). When any developer clones the repo and runs `npm install`, Husky Git hooks are automatically installed and bound.
- A pre-commit hook is set up to run `npx lint-staged` executing `eslint --fix` and `prettier --write` on all staged files.

---

## Directory Structure

```text
career-pilot/
├── .github/
│   └── workflows/
│       ├── deploy-frontend.yml     # Next.js -> Cloudflare Workers
│       └── deploy-backend.yml      # Backend -> GCP Compute VM (COS)
├── .husky/                         # Git hooks directory (auto-configured)
│   └── pre-commit                  # Pre-commit hook executing lint-staged
├── scripts/
│   ├── setup-local.ps1             # Local development setup script for Windows
│   └── setup-local.sh              # Local development setup script for macOS/Linux
├── backend/                        # Orchestrator & Containerized Agents
│   ├── src/
│   │   ├── host.ts                 # Main orchestrator host
│   │   ├── gateway/llm.ts          # Vercel AI SDK + Portkey + OpenRouter wrapper
│   │   ├── channels/telegram.ts    # Telegram bot interaction logic
│   │   ├── database/sqlite.ts      # Sanitized audit trail and jobs DB
│   │   └── api/                    # Secure express endpoints for frontend logs
│   ├── agents/                     # Specialized agent scripts (Dockerfiles)
│   │   ├── job-hunter/
│   │   ├── market-intelligence/
│   │   ├── resume-tailor/
│   │   ├── app-tracker/
│   │   ├── cold-outreach/
│   │   └── interview-prep/
│   ├── docker-compose.yml
│   └── README.md
├── frontend/                       # Recruiter-facing Next.js 14/15 App
│   ├── src/
│   │   ├── app/                    # App Router pages (Home, Dashboard)
│   │   ├── components/             # Dynamic dashboard charts & animated logs
│   │   └── utils/api.ts            # Client to fetch sanitized audit logs from VM
│   ├── package.json
│   └── README.md
├── iac/                            # Terraform configurations
│   ├── provider.tf                 # Google and Cloudflare providers
│   ├── main.tf                     # GCP VPC, Subnet, VM Instance, Firewalls
│   ├── cloudflare.tf               # DNS CNAME/A records for hire.mydomain.com
│   ├── variables.tf
│   └── outputs.tf
├── .gitignore
├── .lintstagedrc.json              # Configures eslint/prettier on pre-commit
├── package.json                    # Root package.json managing Husky
├── CLAUDE.md                       # Comprehensive guide to build, test, and run
│── README.md                       # Project explanation and architecture
```

---

## Verification Plan

### Automated Verification
- **Formatting & Linting Check:** Running `npm run lint` and `npm run format` from the root to verify Husky and lint-staged behavior.
- **Terraform verification:** Executing `terraform validate` and `terraform plan` in the `iac/` directory.
- **Ollama container check:** Verifying the container launches and replies with `llama3.2` loading verification via local endpoint.

### Manual Verification
- Run the setup script `./scripts/setup-local.ps1` and verify the entire environment (Docker, SQLite, Ollama, TypeScript build) initializes without error.
- Verify Telegram bot messaging endpoints handle the onboarding survey correctly.
- Test the recruiter UI and confirm the audit logs render correctly from the SQLite database.
