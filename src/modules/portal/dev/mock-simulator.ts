/**
 * src/modules/portal/dev/mock-simulator.ts — a scripted, container-free
 * simulator run for dev/demo + the Playwright E2E harness (Sub-milestone 8.2,
 * STRATEGY §24.31).
 *
 * Loaded ONLY via a dynamic import behind the `PORTAL_MOCK_SIMULATOR` env gate
 * in startSimulatorRun (src/modules/portal/simulator.ts) — never on a
 * production request path (mirrors the §24.26 fake-everything-transparently
 * seam: PORTAL_MOCK_CONTAINERS). It drives a
 * deterministic `trace`/`chat` sequence onto the run's `simulator:<id>`
 * SSE topic *exactly as* the portal channel adapter's deliver() would (push +
 * accumulator), so the frontend sees a real streaming run with no LLM/container.
 *
 * The step payloads match the real wire: `trace` carries a TraceEvent
 * (container/agent-runner sdkMessageToTraceEvents — `tool`/`subagent`
 * dispatches + one end-of-run `result` cost), `chat` carries `{ text }`. The
 * terminal is the `result` trace (§24.21 Δ) — finalize then pushes `end` and
 * closes the stream, exactly like a real run.
 */
import { log } from '../../../log.js';
import { recordSimulatorOutput } from '../simulator.js';
import { pushSimulatorEvent } from '../sse-broadcaster.js';

interface ScriptStep {
  /** Delay after the previous step (ms). The first step is delayed enough for
   * the frontend to open the stream before any event is pushed (pushes are a
   * no-op with no client, exactly like a real run before the container warms). */
  delayMs: number;
  kind: 'trace' | 'chat';
  payload: unknown;
}

/**
 * Pure: the deterministic step sequence for a mock run, templated on the
 * visitor's company/role so `dev:mock` + the results look personalized. Shapes
 * match the real wire — `trace` payloads are TraceEvents, `chat` is `{ text }`.
 * The terminal `result` trace step finalizes + persists the run (§24.21 Δ).
 */
export function buildSimulatorScript(company: string, role: string): ScriptStep[] {
  const resume = [
    `## Tailored resume — ${role} @ ${company}`,
    '',
    `- Shipped a multi-region ingestion pipeline on GCP serving 4B+ events/day — the scale ${company}'s platform team operates at.`,
    '- Cut p99 API latency 38% by moving hot paths to an edge cache + read-model projections.',
    '- Led a 4-engineer team from design through on-call for a zero-downtime datastore migration.',
  ].join('\n');
  const outreach = [
    `## Cold outreach — ${company}`,
    '',
    `Subject: ${role} — a builder who ships at your scale`,
    '',
    'Hi there,',
    '',
    `I came across ${company}'s recent engineering work and it lines up closely with what I have been building. I would love a short conversation about the ${role} opening.`,
    '',
    'Best,',
    'Jane',
  ].join('\n');

  return [
    {
      delayMs: 500,
      kind: 'trace',
      payload: {
        t: 'tool',
        name: 'analyze_jd',
        input_summary: `extract role / level / skills · "${role}"`,
        parent_tool_use_id: null,
      },
    },
    {
      delayMs: 350,
      kind: 'trace',
      payload: {
        t: 'subagent',
        subagent: 'research-company',
        input_summary: `digest ${company}`,
        parent_tool_use_id: null,
      },
    },
    {
      delayMs: 350,
      kind: 'trace',
      payload: {
        t: 'tool',
        name: 'web_search',
        input_summary: `"${company} engineering"`,
        parent_tool_use_id: 'toolu_research',
      },
    },
    {
      delayMs: 350,
      kind: 'trace',
      payload: { t: 'tool', name: 'web_fetch', input_summary: '3 sources', parent_tool_use_id: 'toolu_research' },
    },
    {
      delayMs: 350,
      kind: 'trace',
      payload: {
        t: 'subagent',
        subagent: 'tailor-resume',
        input_summary: 'rank + rewrite top bullets',
        parent_tool_use_id: null,
      },
    },
    {
      delayMs: 50,
      kind: 'trace',
      payload: {
        t: 'subagent',
        subagent: 'draft-outreach',
        input_summary: 'tone-matched cold email',
        parent_tool_use_id: null,
      },
    },
    { delayMs: 500, kind: 'chat', payload: { text: resume } },
    { delayMs: 400, kind: 'chat', payload: { text: outreach } },
    { delayMs: 50, kind: 'trace', payload: { t: 'result', cost_usd: 0.041 } },
  ];
}

/**
 * Schedule the scripted run. Each step pushes to the run's SSE topic AND feeds
 * the run accumulator (recordSimulatorOutput) — exactly what adapter.deliver()
 * does — so the terminal `result` trace finalizes + persists the run for the
 * share page (and pushes `end` + closes the stream, per §24.21 Δ).
 * Timers are `.unref()`'d so a pending run never holds the process open.
 */
export function runMockSimulator(runId: string, company: string, role: string): void {
  const steps = buildSimulatorScript(company, role);
  let cumulative = 0;
  for (const step of steps) {
    cumulative += step.delayMs;
    const timer = setTimeout(() => {
      try {
        pushSimulatorEvent(runId, step.kind, step.payload);
        recordSimulatorOutput(runId, step.kind, step.payload);
      } catch (err) {
        log.warn('mock simulator step failed', { runId, kind: step.kind, err });
      }
    }, cumulative);
    if (typeof timer.unref === 'function') timer.unref();
  }
  log.info('mock simulator run scheduled', { runId, steps: steps.length });
}
