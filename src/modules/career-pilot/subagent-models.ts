/**
 * src/modules/career-pilot/subagent-models.ts — §24.163 per-subagent model injection.
 *
 * After `composeSubagentDefinitions` renders `groups/<folder>/.claude/agents/*.md`,
 * this rewrites each subagent's frontmatter `model:` line from its configured knob
 * (`owner_model_<slug>` for the owner group, `sandbox_model_<slug>` for the
 * sandbox). `inherit` is written through as SDK-native `model: inherit` — the SDK
 * resolves it to the orchestrator's pinned `config.model` (see
 * `applyOrchestratorModel`). A rendered subagent with no matching knob is left
 * untouched. Run from `container-runner.buildMounts()` right after the composer.
 *
 * Gated to the two career-pilot folders. SKIPPED for the owner group under the
 * Ollama/Claude test modes: those pin one model for the whole agent via
 * `config.model`, and rewriting the frontmatter to an exact Anthropic ID would
 * break an Ollama-routed run (`blockedHosts` refuses `api.anthropic.com`). Left
 * alone, the source `model: inherit` resolves to the test-mode `config.model`.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getConfig } from '../../get-config.js';
import { log } from '../../log.js';
import type { AgentGroup } from '../../types.js';
import { KNOB_SPECS } from '../portal/knob-registry.js';

/**
 * Map a rendered subagent file (`<slug>.md`) to its per-subagent model knob —
 * `owner_model_<slug>` for the owner group, `sandbox_model_<slug>` for the
 * sandbox, null for a non-career-pilot group. Pure; exported for tests.
 */
export function subagentModelKnob(folder: string, slug: string): string | null {
  const prefix =
    folder === 'career-pilot' ? 'owner_model_' : folder === 'career-pilot-sandbox' ? 'sandbox_model_' : null;
  if (!prefix) return null;
  return `${prefix}${slug.replace(/-/g, '_')}`;
}

/**
 * Rewrite the `model:` line inside the first YAML frontmatter block (inserts one
 * if absent). Returns the body unchanged when there's no frontmatter. Pure string
 * surgery — reconstructs from indices so a `$` in any field can't perturb a regex
 * replace. Exported for tests.
 */
export function rewriteModelInFrontmatter(body: string, model: string): string {
  const fm = /^---\n([\s\S]*?)\n---/.exec(body);
  if (!fm) return body;
  let block = fm[1];
  if (/^model:.*$/m.test(block)) {
    block = block.replace(/^model:.*$/m, `model: ${model}`);
  } else {
    block = `model: ${model}\n${block}`;
  }
  return `---\n${block}\n---${body.slice(fm[0].length)}`;
}

/**
 * Rewrite each rendered subagent's frontmatter `model:` from its per-subagent
 * knob. Idempotent — runs on every spawn after the composer.
 */
export function applySubagentModels(group: AgentGroup): void {
  if (group.folder !== 'career-pilot' && group.folder !== 'career-pilot-sandbox') return;
  // Test modes pin the owner agent to one model via config.model; leave the
  // source `model: inherit` so subagents inherit it, rather than rewriting to an
  // exact Anthropic ID (which an Ollama-routed run's blockedHosts would refuse).
  if (
    group.folder === 'career-pilot' &&
    (process.env.OLLAMA_TEST_MODE === '1' || process.env.CLAUDE_TEST_MODE === '1')
  ) {
    return;
  }

  const renderedDir = path.join(GROUPS_DIR, group.folder, '.claude', 'agents');
  if (!fs.existsSync(renderedDir)) return;
  const db = getDb();

  for (const file of fs.readdirSync(renderedDir)) {
    if (!file.endsWith('.md')) continue;
    const slug = file.slice(0, -'.md'.length); // 'research-company'
    const knob = subagentModelKnob(group.folder, slug); // 'owner_model_research_company'
    if (!knob || !(knob in KNOB_SPECS)) continue; // a subagent we don't model-control → leave it
    const model = getConfig<string>(db, knob, 'inherit');
    const filePath = path.join(renderedDir, file);
    const body = fs.readFileSync(filePath, 'utf8');
    const next = rewriteModelInFrontmatter(body, model);
    if (next === body) {
      if (!/^---\n[\s\S]*?\n---/.test(body)) log.warn('subagent-models: no frontmatter; left unset', { slug });
      continue;
    }
    fs.writeFileSync(filePath, next);
  }
}
