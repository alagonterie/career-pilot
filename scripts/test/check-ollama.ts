#!/usr/bin/env tsx
/**
 * scripts/test/check-ollama.ts — pre-flight: Ollama is reachable + the
 * required model is pulled.
 *
 * Used by the E2E test orchestrator before any test that runs with
 * OLLAMA_TEST_MODE=1. Also useful as a standalone sanity check:
 *
 *   pnpm exec tsx scripts/test/check-ollama.ts
 *
 * Exits 0 on success, 1 with a clear remediation message on failure.
 *
 * Override the model name via the OLLAMA_TEST_MODEL env var (defaults to
 * `qwen3-coder:30b` — chosen per the research in the Phase 1.5 design
 * discussion: best tool-calling stability on a 24GB-VRAM card).
 */

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const REQUIRED_MODEL = process.env.OLLAMA_TEST_MODEL ?? 'qwen3-coder:30b';

interface OllamaTag {
  name: string;
  model: string;
  size: number;
  details?: { parameter_size?: string; quantization_level?: string };
}

interface OllamaTagsResponse {
  models: OllamaTag[];
}

async function main(): Promise<void> {
  const tagsUrl = `${OLLAMA_URL}/api/tags`;
  let res: Response;
  try {
    res = await fetch(tagsUrl);
  } catch (err) {
    fail(
      `Ollama not reachable at ${OLLAMA_URL}.\n` +
        `  - Install: https://ollama.com/download/windows\n` +
        `  - After install, the daemon registers as a Windows service and auto-starts.\n` +
        `  - Verify: curl -s ${tagsUrl}\n\n` +
        `Underlying error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    fail(`Ollama returned HTTP ${res.status} from ${tagsUrl}. Daemon may be unhealthy — try restarting.`);
  }

  const body = (await res.json()) as OllamaTagsResponse;
  const present = (body.models ?? []).map((m) => m.name);

  if (!present.includes(REQUIRED_MODEL)) {
    fail(
      `Ollama is reachable but model "${REQUIRED_MODEL}" is not pulled.\n` +
        `  Available: ${present.length === 0 ? '(none)' : present.join(', ')}\n` +
        `  Pull it: ollama pull ${REQUIRED_MODEL}\n\n` +
        `(Override the required model via OLLAMA_TEST_MODEL env var if you want to test against a different one.)`,
    );
  }

  const m = body.models.find((x) => x.name === REQUIRED_MODEL)!;
  const paramSize = m.details?.parameter_size ?? '?';
  const quant = m.details?.quantization_level ?? '?';
  const sizeGB = (m.size / 1_073_741_824).toFixed(1);
  console.log(`✓ Ollama OK — ${REQUIRED_MODEL} (${paramSize}, ${quant}, ${sizeGB}GB) is loaded.`);
}

function fail(message: string): never {
  console.error(`✗ Ollama pre-flight failed.\n\n${message}`);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
