#!/usr/bin/env tsx
/**
 * scripts/test/glm-toolshape-probe.ts — GLM tool-shape de-risking spike.
 *
 * Probes the EXACT layer where the `<Agent>`-as-text failure originates:
 * Ollama's Anthropic `/v1/messages` shim (the same endpoint the container's
 * Claude Code CLI hits via ANTHROPIC_BASE_URL under OLLAMA_TEST_MODE — see
 * src/container-config.ts applyOllamaTestOverrides). This bypasses Docker +
 * OneCLI so we can answer three questions cheaply:
 *
 *   1. Can GLM emit a real `tool_use` block AT ALL through this shim? (baseline)
 *   2. Does it emit a real `tool_use` for the `Agent` delegation tool, or the
 *      inert `<Agent .../>` text that stalls every subagent chain?
 *   3. Does a realistic tool palette + delegation system prompt (context
 *      pressure) change the answer vs. the minimal case? (Tier-0-vs-Tier-1 tell)
 *
 * If GLM tool-calls fine minimally but fails under the full palette, the
 * problem is context pressure → a prompt/nudge fix (Tier 0) may suffice.
 * If it fails even minimally on `Agent`, it's a hard model/shim limitation →
 * Tier 1 (runner-side synthesis) or a model swap is required.
 *
 * Usage:
 *   pnpm exec tsx scripts/test/glm-toolshape-probe.ts
 *   OLLAMA_TEST_MODEL=some-other-model pnpm exec tsx scripts/test/glm-toolshape-probe.ts
 *
 * Pure diagnostic. Writes nothing, costs $0 (local). Re-run when evaluating a
 * new local model as the free-CI driver.
 */

import fs from 'fs';
import path from 'path';

const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://localhost:11434';
const MODEL = process.env.OLLAMA_TEST_MODEL ?? 'glm-4.7-flash';
const RUNS_PER_SCENARIO = Number(process.env.PROBE_RUNS ?? '3');
const MAX_TOKENS = Number(process.env.PROBE_MAX_TOKENS ?? '3072');

const PERSONA_PATH = path.join(
  process.cwd(),
  'groups',
  'career-pilot',
  '.claude-host-fragments',
  'persona.md',
);
function loadPersona(): string {
  try {
    return fs.readFileSync(PERSONA_PATH, 'utf8');
  } catch {
    return DELEGATION_SYSTEM_PROMPT;
  }
}

// ---- Anthropic Messages API shapes (subset we use) ----
interface Tool {
  name: string;
  description: string;
  input_schema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}
interface ContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
}
interface MessagesResponse {
  content?: ContentBlock[];
  stop_reason?: string;
  usage?: { input_tokens?: number; output_tokens?: number };
}

// ---- Tool definitions (faithful to what Claude Code sends) ----
const AGENT_TOOL: Tool = {
  name: 'Agent',
  description:
    'Launch a specialized subagent to handle a focused task. Available subagent_type values: ' +
    'research-company, tailor-resume, draft-outreach, prep-interview, scrape-jobs. ' +
    'Each runs in a fresh context with its own tool palette.',
  input_schema: {
    type: 'object',
    properties: {
      subagent_type: { type: 'string', description: 'Which subagent to launch' },
      description: { type: 'string', description: 'A short (3-5 word) task description' },
      prompt: { type: 'string', description: 'The full task prompt for the subagent' },
    },
    required: ['subagent_type', 'description', 'prompt'],
  },
};

const LIST_APPS_TOOL: Tool = {
  name: 'mcp__career-pilot__list_applications',
  description: 'List the candidate\'s job applications with their current status.',
  input_schema: {
    type: 'object',
    properties: { status: { type: 'string', description: 'Optional status filter' } },
  },
};

// A realistic ~12-tool palette mirroring the orchestrator's runtime surface.
function fullPalette(): Tool[] {
  const mcp = (name: string, desc: string): Tool => ({
    name: `mcp__career-pilot__${name}`,
    description: desc,
    input_schema: { type: 'object', properties: { arg: { type: 'string' } } },
  });
  const builtin = (name: string, desc: string): Tool => ({
    name,
    description: desc,
    input_schema: { type: 'object', properties: { arg: { type: 'string' } } },
  });
  return [
    AGENT_TOOL,
    LIST_APPS_TOOL,
    mcp('get_application', 'Get one application by id.'),
    mcp('update_application', 'Create or update an application.'),
    mcp('record_pipeline_event', 'Append a pipeline event to an application.'),
    mcp('query_job_leads', 'Query the job-lead pool with filters.'),
    builtin('Read', 'Read a file from the workspace.'),
    builtin('Bash', 'Run a shell command.'),
    builtin('WebSearch', 'Search the web.'),
    builtin('WebFetch', 'Fetch and read a URL.'),
    builtin('TodoWrite', 'Manage a task list.'),
    {
      name: 'mcp__nanoclaw__send_message',
      description: 'Send a message to a destination.',
      input_schema: {
        type: 'object',
        properties: { to: { type: 'string' }, text: { type: 'string' } },
        required: ['to', 'text'],
      },
    },
  ];
}

// Condensed version of the persona's load-bearing delegation directive.
const DELEGATION_SYSTEM_PROMPT = `You are Career Pilot, a job-search orchestrator.

For these task shapes you ALWAYS delegate to the named subagent via the Agent tool:
research-company, tailor-resume, draft-outreach, prep-interview, scrape-jobs.

Load-bearing: Agent is a REAL tool. You must invoke it via a structured tool_use
content block with name "Agent" and input { subagent_type, description, prompt }.
Do NOT emit XML-shaped Agent text like <Agent subagent_type="..." /> — that is inert
text the runtime ignores, the subagent never runs, and the workflow stalls.`;

// The real Claude Code `Agent` tool description is long + prescriptive. A
// realistic-length schema is part of the context pressure we want to test.
const AGENT_TOOL_REALISTIC: Tool = {
  name: 'Agent',
  description:
    'Launch a new agent to handle complex, multi-step tasks. Each agent type has ' +
    'specific capabilities and tools available to it. Available subagent_type values: ' +
    'research-company (deep web research on a company), tailor-resume (rewrite resume ' +
    'bullets for a JD), draft-outreach (draft recruiter outreach + Gmail draft), ' +
    'prep-interview (interview prep brief), scrape-jobs (refresh the job-lead pool ' +
    'from ATS boards). When using the Agent tool you MUST invoke it as a structured ' +
    'tool call — never describe the call in text. The subagent runs in a fresh ' +
    'context window with no access to this conversation, so the prompt field must ' +
    'contain every input the subagent needs, inlined verbatim.',
  input_schema: {
    type: 'object',
    properties: {
      subagent_type: { type: 'string', description: 'The type of specialized agent to use' },
      description: { type: 'string', description: 'A short (3-5 word) description of the task' },
      prompt: { type: 'string', description: 'The full, self-contained task for the agent to perform' },
    },
    required: ['subagent_type', 'description', 'prompt'],
  },
};

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | unknown[];
}

interface Scenario {
  id: string;
  label: string;
  system?: string;
  systemFromPersona?: boolean;
  tools: Tool[];
  user?: string;
  /** When set, overrides the single-user-message default (for multi-turn probes). */
  messages?: ChatMessage[];
}

const SCENARIOS: Scenario[] = [
  {
    id: 'A',
    label: 'Baseline: 1 simple MCP tool — can GLM tool_use AT ALL?',
    tools: [LIST_APPS_TOOL],
    user: 'Show me all my current job applications.',
  },
  {
    id: 'B',
    label: 'Agent tool alone, minimal context — real tool_use or <Agent> text?',
    tools: [AGENT_TOOL],
    user: 'Research the company Anthropic for me — what they do, culture, recent news.',
  },
  {
    id: 'C',
    label: 'Agent + full palette + delegation system prompt (context pressure)',
    system: DELEGATION_SYSTEM_PROMPT,
    tools: fullPalette(),
    user: 'Refresh my job leads from the usual boards and tell me what is new.',
  },
  {
    id: 'D',
    label: 'REAL ~900-line persona as system prompt + realistic Agent tool + full palette',
    systemFromPersona: true,
    tools: [AGENT_TOOL_REALISTIC, ...fullPalette().slice(1)],
    user: 'Tailor my resume to this Staff Backend Engineer JD at Anthropic: [JD text]. Use Go, Rust, PostgreSQL.',
  },
  {
    id: 'E',
    label: 'MULTI-TURN chain — after a subagent result returns, does turn 2 emit real tool_use?',
    systemFromPersona: true,
    tools: [AGENT_TOOL_REALISTIC, ...fullPalette().slice(1)],
    messages: [
      {
        role: 'user',
        content:
          'Tailor my resume to this Staff Backend Engineer JD at Anthropic. ' +
          'The JD emphasizes distributed systems, Go, and inference infrastructure. ' +
          'My skills: Go, Rust, PostgreSQL, Kubernetes.',
      },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'toolu_probe_1',
            name: 'Agent',
            input: {
              subagent_type: 'research-company',
              description: 'Research Anthropic',
              prompt: 'Research Anthropic for a Staff Backend Engineer applicant.',
            },
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'toolu_probe_1',
            content:
              '## Anthropic — research digest\n' +
              'AI safety company behind Claude. Eng culture values rigor, distributed ' +
              'systems at scale for model inference. Recent: Claude 4 family, expanding ' +
              'inference infra team. Tech: large-scale Go/Rust services, Kubernetes, ' +
              'custom inference runtimes. Hiring bar emphasizes systems depth + writing.',
          },
        ],
      },
    ],
  },
  {
    id: 'F',
    label: 'FAITHFUL repro: real persona + NanoClaw XML message envelope + exact failing prompt',
    systemFromPersona: true,
    tools: [AGENT_TOOL_REALISTIC, ...fullPalette().slice(1)],
    messages: [
      {
        role: 'user',
        content:
          '<context timezone="America/Denver" />\n' +
          '<message id="2" from="local-cli-test" sender="cli" time="May 29, 2026, 9:40 AM">research anthropic for me</message>',
      },
    ],
  },
];

type Verdict =
  | 'REAL_AGENT_TOOL_USE' // ✓ structured tool_use for Agent/Task — the goal
  | 'REAL_OTHER_TOOL_USE' // ✓ structured tool_use, but a non-Agent tool
  | 'XML_AGENT_TEXT' //      ✗ the bug: <Agent .../> emitted as text
  | 'XML_OTHER_TOOL_TEXT' // ✗ some other tool emitted as XML text
  | 'TEXT_ONLY' //           ✗ plain prose, no delegation
  | 'THINKING_ONLY' //       ✗ thinking block(s), no text/tool
  | 'EMPTY'; //              ✗ nothing usable

function classify(resp: MessagesResponse): { verdict: Verdict; detail: string } {
  const blocks = resp.content ?? [];
  const toolUses = blocks.filter((b) => b.type === 'tool_use');
  const texts = blocks.filter((b) => b.type === 'text' && b.text);
  const thinking = blocks.filter((b) => b.type === 'thinking');

  if (toolUses.length > 0) {
    const agentCall = toolUses.find((b) => b.name === 'Agent' || b.name === 'Task');
    if (agentCall) {
      const input = agentCall.input as { subagent_type?: string } | undefined;
      return { verdict: 'REAL_AGENT_TOOL_USE', detail: `Agent(subagent_type=${input?.subagent_type ?? '?'})` };
    }
    return { verdict: 'REAL_OTHER_TOOL_USE', detail: toolUses.map((b) => b.name).join(', ') };
  }

  const allText = texts.map((b) => b.text).join('\n');
  if (/<Agent\b|<Task\b/i.test(allText)) {
    return { verdict: 'XML_AGENT_TEXT', detail: firstTag(allText, /<(?:Agent|Task)\b[^>]*\/?>/i) };
  }
  if (/<(?:mcp__|Read|Bash|WebSearch|WebFetch|TodoWrite)\b/i.test(allText)) {
    return { verdict: 'XML_OTHER_TOOL_TEXT', detail: firstTag(allText, /<[A-Za-z_][^>]*\/?>/) };
  }
  if (allText.trim()) {
    return { verdict: 'TEXT_ONLY', detail: `${allText.trim().slice(0, 80).replace(/\s+/g, ' ')}…` };
  }
  if (thinking.length > 0) {
    return { verdict: 'THINKING_ONLY', detail: `${thinking.length} thinking block(s), no output` };
  }
  return { verdict: 'EMPTY', detail: `stop_reason=${resp.stop_reason ?? '?'}` };
}

function firstTag(text: string, re: RegExp): string {
  const m = text.match(re);
  return m ? m[0].slice(0, 100) : '(matched but no tag captured)';
}

const STREAM = process.env.PROBE_STREAM === '1';
// Optional context padding to mimic the full stack's ~45k-token system prompt
// (the real flow has the claude_code preset + persona; persona.md alone is ~5k).
const PAD_TOKENS = Number(process.env.PROBE_PAD_TOKENS ?? '0');

function padding(): string {
  if (PAD_TOKENS <= 0) return '';
  // ~4 chars/token of inert filler the model must carry but can ignore.
  const line = 'Operational note: this directive is contextual background only and requires no action. ';
  return '\n\n# Background context (ignore)\n' + line.repeat(Math.ceil((PAD_TOKENS * 4) / line.length));
}

async function callOnce(scn: Scenario): Promise<{ verdict: Verdict; detail: string; stop?: string; out?: number }> {
  const body: Record<string, unknown> = {
    model: MODEL,
    max_tokens: MAX_TOKENS,
    tools: scn.tools,
    messages: scn.messages ?? [{ role: 'user', content: scn.user }],
  };
  let system = scn.systemFromPersona ? loadPersona() : scn.system;
  if (PAD_TOKENS > 0) system = (system ?? '') + padding();
  if (system) body.system = system;
  if (STREAM) body.stream = true;

  const res = await fetch(`${OLLAMA_URL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    return { verdict: 'EMPTY', detail: `HTTP ${res.status}: ${txt.slice(0, 120)}` };
  }

  if (STREAM) {
    // Anthropic SSE: scan the raw stream. A real tool call shows up as a
    // content_block_start with content_block.type=tool_use; an <Agent>-text
    // failure shows up as text_delta payloads containing the literal tag.
    const sse = await res.text();
    const toolUse = /"type":"tool_use"/.test(sse);
    const agentName = /"type":"tool_use"[^}]*"name":"(Agent|Task)"/.test(sse);
    const xmlAgent = /<Agent\b|<Task\b/.test(sse);
    const stopMatch = sse.match(/"stop_reason":"([^"]+)"/);
    const stop = stopMatch ? stopMatch[1] : 'stream';
    if (agentName) return { verdict: 'REAL_AGENT_TOOL_USE', detail: '(streamed)', stop };
    if (toolUse) return { verdict: 'REAL_OTHER_TOOL_USE', detail: '(streamed tool_use)', stop };
    if (xmlAgent) return { verdict: 'XML_AGENT_TEXT', detail: '(streamed <Agent> text)', stop };
    return { verdict: 'TEXT_ONLY', detail: '(streamed text, no tool/agent)', stop };
  }

  const json = (await res.json()) as MessagesResponse;
  const c = classify(json);
  return { verdict: c.verdict, detail: c.detail, stop: json.stop_reason, out: json.usage?.output_tokens };
}

const GOOD: Set<Verdict> = new Set(['REAL_AGENT_TOOL_USE', 'REAL_OTHER_TOOL_USE']);

async function main(): Promise<void> {
  console.log(`\nGLM tool-shape probe — model=${MODEL}, ${RUNS_PER_SCENARIO} runs/scenario, max_tokens=${MAX_TOKENS}`);
  console.log(`endpoint=${OLLAMA_URL}/v1/messages (the Anthropic shim the SDK uses under OLLAMA_TEST_MODE)\n`);

  const only = process.env.PROBE_SCENARIOS?.split(',').map((s) => s.trim().toUpperCase());
  const scenarios = only ? SCENARIOS.filter((s) => only.includes(s.id)) : SCENARIOS;
  for (const scn of scenarios) {
    console.log(`── Scenario ${scn.id}: ${scn.label}`);
    const sysTag = scn.systemFromPersona ? ' | +REAL persona system prompt' : scn.system ? ' | +delegation system prompt' : '';
    const turnTag = scn.messages ? ` | ${scn.messages.length}-message multi-turn` : '';
    const userPreview = scn.user ?? '(multi-turn — see messages)';
    console.log(`   user: "${userPreview}"  | tools: ${scn.tools.length}${sysTag}${turnTag}`);
    let good = 0;
    for (let i = 1; i <= RUNS_PER_SCENARIO; i++) {
      try {
        const r = await callOnce(scn);
        const mark = GOOD.has(r.verdict) ? '✓' : '✗';
        if (GOOD.has(r.verdict)) good++;
        console.log(`   run ${i}: ${mark} ${r.verdict.padEnd(20)} ${r.detail}  [stop=${r.stop ?? '?'}, out=${r.out ?? '?'}]`);
      } catch (err) {
        console.log(`   run ${i}: ✗ ERROR ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`   → ${good}/${RUNS_PER_SCENARIO} produced a real structured tool_use\n`);
  }
  console.log('Legend: REAL_*_TOOL_USE = good (structured); XML_*_TEXT = the bug; TEXT_ONLY/THINKING_ONLY/EMPTY = no delegation.\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
