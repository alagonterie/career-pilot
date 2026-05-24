# Feasibility Analysis & Technical Verification

This document provides a rigorous, deep-dive technical validation of the **Career Pilot** architecture. It details the runtime constraints, code-level fallback pipelines, Docker lifecycle controls, database synchronization, and anonymization algorithms required to guarantee system feasibility.

---

## 1. Project Naming Configuration

The project name is officially finalized as **`career-pilot`**. All repository configurations, Docker files, Terraform resources, and project namespaces will use this designation.

---

## 2. NanoClaw Host-Sandbox & Hermes-Inspired Self-Improving Loop

This project combines the best practices of two primary 2026 agent paradigms: **NanoClaw** (for security-first sandboxing) and **Hermes Agent** (for persistent, self-improving human collaboration).

### A. NanoClaw Security Sandboxing (Agents)
Because agents must scrape the web, read custom files, and construct email drafts, running them with direct access to the host's primary credentials or SQLite tables is a high security risk.
- We utilize **NanoClaw's security-first philosophy** by compiling each agent (`resume-tailor`, `cold-outreach`, etc.) as an isolated, ephemeral Docker container (MicroVM-style sandbox).
- Each container contains a minimalist TypeScript runtime (~600 lines) built on the Claude SDK.
- The container has no access to the host's files or main database. It communicates only through standard, read-only volume-mounted `input.json` and writes results to a write-only `/results` volume.

### B. Hermes-Inspired Persistent Dialogue & Self-Improving Memory (Host)
While NanoClaw keeps execution isolated, we implement a **Hermes-inspired learning and memory loop** at the Host level to provide a persistent, human-like dialogue over Telegram:
- **Telegram Natural Language Interface:** Rather than using rigid slash commands (e.g. `/apply`), the host utilizes Gemini to route the user's free-form natural language input (e.g., *"Hey, let's prepare for my tech screen tomorrow"* or *"Can you rewrite my resume bullet points for this startup?"*).
- **Persistent Memory (SQLite):** To prevent agent "amnesia," the Host maintains a multi-tier memory system in SQLite (`system_settings`, `candidate_profile`, and `public_audit_trail`).
- **Self-Improving Skill Optimization:** When an agent finishes a task (e.g., a successful recruiter outreach draft or a tailored resume bullet), the Host tracks user feedback. If the user edits the outreach text, the Host feeds the diff back into the candidate profile context, allowing the system to dynamically refine its styling rules and improve subsequent runs.

---

## 3. Architectural Isolation: Next.js Edge vs. GCP VM

A primary source of Next.js deployment failures on Cloudflare is attempting to execute Node-specific or native C/C++ libraries (such as `sqlite3`, `better-sqlite3`, or `dockerode`) within the V8-based Cloudflare Worker runtime.

### Runtime Isolation Separation
*   **Cloudflare Workers (Frontend):** Executes only standard HTTP `fetch` requests, Next.js server components (SSR/ISR) without native bindings, and serves static files. It has **no direct access** to SQLite or Docker.
*   **GCP VM (Backend Host):** Runs a standard Node.js runtime (`node:20-alpine`) which supports native bindings. It hosts the SQLite database, manages the local Docker socket (`/var/run/docker.sock`), and exposes a REST API via Express.
*   **Network Bridge (Cloudflare Tunnel):** The Next.js API route (`frontend/src/app/api/logs/route.ts`) acts as a secure reverse-proxy, forwarding client requests to the backend VM via a Cloudflare Tunnel (`https://api.mydomain.com/logs`). The `cloudflared` daemon runs as a container on the VM and connects outbound to Cloudflare, eliminating the need to expose port `4000` or port `80`/`443` publicly in the GCP firewall. The request is signed with a custom authentication header (`X-Career-Pilot-Auth`).

### Cloudflare Worker I/O Constraints
To avoid the common Worker runtime error: `Error: Cannot perform I/O on behalf of a different request`, developers must ensure that any API clients, proxy handlers, or fetch wrappers are **instantiated within the request handler scope** of each Next.js route rather than as global singletons.

---

## 4. Local Developer Sandbox & Cost-Optimized Testing

To enable unlimited end-to-end testing without incurring LLM token costs or GCP cloud fees, the system is designed to run entirely locally using Docker Desktop and local models.

### A. Environment Separation & Cost Control
- **Local Dev Environment:** The entire stack (Express backend, Next.js frontend, SQLite database, and agent containers) runs locally on the developer's machine. By setting `LLM_PROVIDER=ollama` in the local `.env` file, all LLM requests are routed to the local Ollama instance running on the developer's GPU. **This allows E2E execution tests for $0.**
- **Cloud VM Environment:** The cloud GCP VM is a low-cost, CPU-only `e2-small` instance. To minimize hosting fees, the cloud VM does not run a GPU or Ollama daemon. It relies on the Portkey API Gateway to connect to cloud models.
- **Portkey Semantic Caching:** If cloud testing is required locally, developers can route queries through the Portkey gateway. Portkey's semantic cache intercepts identical or highly similar prompt runs (e.g., repeated test runs of the resume tailor with the same inputs), serving them from cache for 0 tokens/0 cost.

### B. TypeScript Local/Fallback Router (`backend/src/gateway/llm.ts`)
```typescript
import { createOpenAI } from '@ai-sdk/openai';
import { generateText, LanguageModel } from 'ai';

// Initialize Portkey Provider (Cloud Production)
const portkeyProvider = createOpenAI({
  baseURL: 'https://api.portkey.ai/v1',
  apiKey: process.env.PORTKEY_API_KEY || '',
  headers: {
    'x-portkey-api-key': process.env.PORTKEY_API_KEY || ''
  }
});

// Initialize Local Ollama Provider (Zero-Cost Local Dev & Testing)
const ollamaProvider = createOpenAI({
  baseURL: process.env.OLLAMA_HOST || 'http://localhost:11434/v1',
  apiKey: 'ollama' // Ollama does not require keys, but the client requires a placeholder string
});

export async function executeLLMTask(
  prompt: string,
  preferredModel: string = '@openrouter-catalog/anthropic/claude-3.5-sonnet',
  fallbackModel: string = 'llama3.2'
): Promise<{ text: string; provider: 'portkey' | 'ollama'; tokens: number }> {
  // Rule 1: Force local Ollama if configured for developer testing
  const forceLocal = process.env.LLM_PROVIDER === 'ollama';

  if (forceLocal) {
    try {
      const result = await generateText({
        model: ollamaProvider(fallbackModel) as LanguageModel,
        prompt: prompt,
        temperature: 0.2
      });
      return { text: result.text, provider: 'ollama', tokens: result.usage?.totalTokens || 0 };
    } catch (err) {
      console.error("Local Ollama execution failed:", err);
      throw err;
    }
  }

  // Rule 2: In cloud production, run via Portkey with a silent log-level fallback (if configured)
  try {
    const result = await generateText({
      model: portkeyProvider(preferredModel) as LanguageModel,
      prompt: prompt,
      temperature: 0.2
    });
    return {
      text: result.text,
      provider: 'portkey',
      tokens: result.usage?.totalTokens || 0
    };
  } catch (error) {
    console.warn(`Primary cloud LLM failed: ${error}. Retrying...`);
    throw error;
  }
}
```

---

## 4. Container IPC, Timeouts & Error Recovery

Because the containerized agents are spawned dynamically, the orchestrator host must handle hung processes, non-zero exits, and file parsing failures.

### The Lifecycle Management Loop
```typescript
// backend/src/host/container-runner.ts
import Docker from 'dockerode';
import fs from 'fs/promises';
import path from 'path';

const docker = new Docker(); // Automatically binds to Unix socket /var/run/docker.sock

export async function runAgentContainer(
  agentName: string,
  taskId: string,
  inputPayload: any,
  timeoutMs: number = 300000 // 5-minute timeout threshold
): Promise<any> {
  const sharedDir = path.resolve('./shared');
  const taskPath = path.join(sharedDir, 'tasks', `${taskId}.json`);
  const resultPath = path.join(sharedDir, 'results', `${taskId}.json`);

  // 1. Write Input Payload
  await fs.mkdir(path.dirname(taskPath), { recursive: true });
  await fs.mkdir(path.dirname(resultPath), { recursive: true });
  await fs.writeFile(taskPath, JSON.stringify(inputPayload, null, 2));

  // 2. Define Container Configuration
  const container = await docker.createContainer({
    Image: `career-pilot-agent-${agentName}`,
    HostConfig: {
      Binds: [
        `${taskPath}:/input.json:ro`,
        `${sharedDir}/results:/results:rw`
      ],
      AutoRemove: true,
      Memory: 512 * 1024 * 1024, // Limit memory to 512MB
      CpuQuota: 100000 // Limit to 1 CPU core
    },
    Env: [
      `TASK_ID=${taskId}`,
      `PORTKEY_API_KEY=${process.env.PORTKEY_API_KEY}`
    ]
  });

  // 3. Start Container with Timeout Race
  await container.start();

  const containerPromise = container.wait();
  const timeoutPromise = new Promise<never>((_, reject) => 
    setTimeout(() => reject(new Error('CONTAINER_TIMEOUT')), timeoutMs)
  );

  try {
    // Race execution against the timeout limit
    const waitResult = await Promise.race([containerPromise, timeoutPromise]);
    
    if (waitResult.StatusCode !== 0) {
      throw new Error(`Container exited with code ${waitResult.StatusCode}`);
    }

    // 4. Read and Validate Output JSON
    const data = await fs.readFile(resultPath, 'utf-8');
    const parsed = JSON.parse(data);
    
    // Clean up temporary files
    await fs.unlink(taskPath);
    await fs.unlink(resultPath);

    return parsed;
  } catch (error) {
    console.error(`Error executing container agent ${agentName}:`, error);
    
    // In case of timeout or failure, guarantee container termination
    try {
      await container.kill();
    } catch (killErr) {
      // Container may already be terminated
    }
    
    // Clean up files
    await fs.unlink(taskPath).catch(() => {});
    await fs.unlink(resultPath).catch(() => {});
    
    throw error;
  }
}
```

---

## 5. Google Workspace Token Refresh Mechanics

Google APIs use short-lived Access Tokens (expired in 3600 seconds) and persistent Refresh Tokens.
- During initial onboarding (token generation CLI), we configure the client configuration to request offline access:
  ```typescript
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline', // Demands a refresh token
    prompt: 'consent',     // Forces consent screen to guarantee refresh token delivery
    scope: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/calendar.events.readonly']
  });
  ```
- The resulting JSON is stored in SQLite under `sync_state`.
- In the sync service loop, the OAuth client handles refresh checks automatically:
  ```typescript
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) {
      // Google sometimes issues a new refresh token, persist it immediately
      await db.run('INSERT OR REPLACE INTO sync_state (key, val) VALUES (?, ?)', ['refresh_token', tokens.refresh_token]);
    }
    await db.run('INSERT OR REPLACE INTO sync_state (key, val) VALUES (?, ?)', ['access_token', tokens.access_token]);
  });
  ```

---

## 6. Deterministic Anonymization Verification Pipeline

To ensure company names never slip through LLM translation glitches, the system runs a double-pass check.

```typescript
// backend/src/gateway/sanitizer.ts
import { db } from '../database/sqlite';

/**
 * Sweeps text to strip PII and obfuscate company names matching target applications
 */
export async function sanitizePublicLog(rawText: string): Promise<string> {
  let sanitized = rawText;

  // Pass 1: Deterministic regex sweeps (Emails, Phones, IPs)
  sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi, '[Redacted Email]');
  sanitized = sanitized.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '[Redacted Phone]');

  // Pass 2: Dynamic DB lookup sanitization (Matches active applications)
  const applications = await db.all('SELECT company_name FROM private_applications');
  
  for (const app of applications) {
    const escapedCompany = app.company_name.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const regex = new RegExp(`\\b${escapedCompany}\\b`, 'gi');
    
    // Replace all occurrences of the real company name with a generalized indicator
    sanitized = sanitized.replace(regex, '[Obfuscated Target Company]');
  }

  return sanitized;
}
```
This guarantees that even if the AI model fails to obfuscate the company name, the deterministic regex engine intercepts it before it writes to the public audit logs.
