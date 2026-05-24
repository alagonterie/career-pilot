# CLAUDE.md Developer Cheat Sheet

This document contains standard commands and guidelines for building, running, testing, and formatting code in the **career-pilot** project.

---

## 🚀 Commands

### Root Commands
- **Install Dependencies:** `npm install` (Installs root dev tools like Husky and lint-staged)
- **Format Code:** `npm run format` (Runs Prettier root-wide)
- **Lint Code:** `npm run lint` (Runs ESLint root-wide)

### Frontend Commands (`frontend/`)
- **Install Frontend Deps:** `cd frontend && npm install`
- **Development Server:** `cd frontend && npm run dev`
- **Build (Cloudflare OpenNext):** `cd frontend && npx @opennextjs/cloudflare build`
- **Local Deployment Preview:** `cd frontend && npx wrangler dev`

### Backend Commands (`backend/`)
- **Install Backend Deps:** `cd backend && npm install`
- **Run Backend Orchestrator (Dev):** `cd backend && npm run start:dev`
- **Compile TypeScript:** `cd backend && npm run build`
- **Start Production Backend:** `cd backend && npm start`

### Docker & Ollama local setup
- **Start Local Containers (Ollama/SQLite IPC volume):** `cd backend && docker compose up -d`
- **Pull Local Llama model:** `docker exec -it ollama ollama pull llama3.2`
- **View Container Logs:** `cd backend && docker compose logs -f`

---

## 🧪 Testing & Verification Scripts

Refer to [verification_playbook.md](file:///C:/Projects/career-pilot/.specs/verification_playbook.md) for more details.
- **Run Bootstrapping Simulation:** `npx tsx backend/scratch/test-onboarding.ts`
- **Run Sanitization Pipeline Test:** `npx tsx backend/scratch/test-sanitizer.ts`

---

## 🎨 Code Style & Quality Guidelines

- **TypeScript:** Strict type checking (`strict: true` in `tsconfig.json`).
- **Formatting:** Handled automatically on pre-commit via **Husky** + **lint-staged** running `prettier --write` and `eslint --fix`.
- **Imports:** Group third-party imports first, followed by internal relative modules.
- **Worker Safety:** Do not instantiate API or DB clients globally in Next.js Server Components / Edge routes. Always declare them inside the request/function handler context to prevent the Cloudflare Worker context reuse error.
- **Secret Hygiene:** Never write or output plain credentials. Use environment variables or Portkey Model Catalog slugs.
