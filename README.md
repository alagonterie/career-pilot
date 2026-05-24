# Career Pilot ✈️

Career Pilot is an autonomous, agentic system designed to manage, optimize, and execute the job-hunting pipeline for software engineers. 

The entire codebase is **fully generic, parameterized, and self-contained**. Any developer can fork this repository, configure their credentials, and run it. **No personal candidate details, domain names, or target application information are hardcoded.**

---

## 🛠️ System Architecture

The project consists of three main components:
1. **Frontend (Next.js App Router):** A gamified recruiter portal featuring a pipeline "Horse Race" showing active applications (fully anonymized), a simulated recruiter sandbox playground, and active agent telemetry. Deployed to **Cloudflare Workers**.
2. **Backend (Node.js Host + Containerized Agents):** Runs on a **GCP Compute VM (Container-Optimized OS)**. Uses a SQLite database for application tracking and spawns isolated Docker container agents (using a custom NanoClaw setup) for specific pipeline tasks (e.g. resume tailoring, outreach, scraping).
3. **Secure Network Bridge (Cloudflare Tunnel):** A `cloudflared` container runs on the VM to route API traffic securely back to the Cloudflare network without exposing any public HTTP ports on the VM.

---

## 🔒 Generic Design & Zero-Hardcoding Principles

To ensure anyone can reuse this project:
- **Conversational Onboarding (Bootstrapping):** On first run, the backend detects if it is unbootstrapped and prompts the user over Telegram for their Full Name, preferences, target keywords, location preferences, and master resume. These details are stored in SQLite and never committed to Git.
- **Environment Injected Frontend:** The Next.js frontend reads candidate details (name, title, LinkedIn, GitHub, API urls) dynamically from Next.js build-time environment variables injected during the GitHub Actions deployment workflow.
- **Fully Parameterized IaC:** Terraform configuration (`iac/`) exposes variables for GCP Project IDs, domains, zones, and Cloudflare credentials.

---

## 🚀 Setup & Deployment Guide

### 1. Local Prerequisites
- Docker & WSL2 (with Nvidia GPU drivers if using local Ollama GPU acceleration)
- Node.js 20+
- GCP CLI (`gcloud`) & Terraform CLI

### 2. Local Initialization
Run the bootstrapping script to automatically set up Git hooks, install packages, and verify Docker containers:
```bash
# Windows
./scripts/setup-local.ps1

# Linux/macOS
./scripts/setup-local.sh
```

### 3. Google Workspace OAuth Setup
To enable Gmail and Calendar integration:
1. Create a project in the GCP Console and enable the Gmail API and Google Calendar API.
2. Configure the OAuth Consent Screen (requested scopes: `gmail.readonly`, `calendar.events.readonly`) and download the credentials JSON file to `backend/config/google-credentials.json` (this file is `.gitignored`).
3. Run the offline authentication CLI tool to generate the refresh tokens:
   ```bash
   npm run auth:google
   ```

### 4. Cloud Infrastructure Deployment (Terraform)
1. Initialize and apply the configurations in the `iac/` folder:
   ```bash
   cd iac/
   terraform init
   terraform apply -var-file="secrets.tfvars"
   ```
2. Terraform will output the Cloudflare Tunnel token and VM configuration, which are then added to GitHub Secrets.

### 5. CI/CD Workflows (GitHub Actions)
- On pushing to the `main` branch, two parallel GitHub workflows will trigger:
  - **Frontend Deploy (`deploy-frontend.yml`):** Compiles Next.js using the `@opennextjs/cloudflare` adapter and deploys it to Cloudflare Workers.
  - **Backend Deploy (`deploy-backend.yml`):** Authenticates via Workload Identity Federation (passwordless), copies backend files via `gcloud compute scp`, and restarts the Docker Compose stack using the `/opt/bin/docker-compose` binary on GCP Container-Optimized OS.

---

## 📁 Repository Directory Structure

For detail on component implementations, see the corresponding design specification documents in the `.specs/` folder:
- 📑 [Implementation Plan](file:///C:/Projects/career-pilot/.specs/implementation_plan.md) — High-level project specifications.
- 📑 [Backend Component Design](file:///C:/Projects/career-pilot/.specs/component_backend.md) — NanoClaw Host Orchestrator, SQLite, IPC schemas.
- 📑 [Frontend Component Design](file:///C:/Projects/career-pilot/.specs/component_frontend.md) — Next.js layout, CSS globals, Cloudflare Worker details.
- 📑 [Infrastructure Component Design](file:///C:/Projects/career-pilot/.specs/component_infrastructure.md) — Terraform, GitHub Actions, cloud-init user-data.
- 📑 [Feasibility Analysis](file:///C:/Projects/career-pilot/.specs/feasibility_analysis.md) — Portkey integration, Worker limits, failover rules.
- 📑 [Verification Playbook](file:///C:/Projects/career-pilot/.specs/verification_playbook.md) — Test scripts and validation checks.
