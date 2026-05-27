/**
 * CLAUDE.md composition for agent groups.
 *
 * Replaces the per-group "written once at init, owned by the group" pattern
 * with a host-regenerated entry point that imports:
 *   - a shared base (`container/CLAUDE.md` mounted RO at `/app/CLAUDE.md`)
 *   - optional per-skill fragments (skills that ship `instructions.md`)
 *   - optional per-MCP-server fragments (inline `instructions` field in
 *     `container.json`)
 *   - optional host-rendered fragments from
 *     `groups/<folder>/.claude-host-fragments/*.md` — career-pilot extension
 *     (see .specs/NANOCLAW_INTERNALS.md §11 Δ3). These let the host inject
 *     per-group authored or runtime-rendered content (a persona, a
 *     candidate-profile-rendered identity card) without abusing
 *     `CLAUDE.local.md` (which is agent-writable per-group memory and not
 *     a safe home for host-managed content)
 *   - per-group agent memory (`CLAUDE.local.md`, auto-loaded by Claude Code)
 *
 * Runs on every spawn from `container-runner.buildMounts()`. Deterministic —
 * same inputs produce the same CLAUDE.md, and stale fragments are pruned.
 *
 * Host-fragment directory ownership: the composer READS `.claude-host-fragments/`
 * but does NOT prune it. The directory is owned externally — by the host
 * (pre-spawn render hooks) and by anything the operator commits to the
 * group dir. The composer just imports what it finds.
 *
 * See `docs/claude-md-composition.md` for the full design.
 */
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import type { McpServerConfig } from './container-config.js';
import { getContainerConfig } from './db/container-configs.js';
import { log } from './log.js';
import type { AgentGroup } from './types.js';

// Symlink targets are container paths — dangling on host (hence the readlink
// dance instead of existsSync), valid inside the container via RO mounts.
const SHARED_CLAUDE_MD_CONTAINER_PATH = '/app/CLAUDE.md';
const SHARED_SKILLS_CONTAINER_BASE = '/app/skills';
const SHARED_MCP_TOOLS_CONTAINER_BASE = '/app/src/mcp-tools';

// Host-side source paths used to discover fragment sources at compose time.
// Resolved at call time (process.cwd() = project root) so tests can swap cwd.
const MCP_TOOLS_HOST_SUBPATH = path.join('container', 'agent-runner', 'src', 'mcp-tools');

const COMPOSED_HEADER = '<!-- Composed at spawn — do not edit. Edit CLAUDE.local.md for per-group content. -->';

/**
 * Regenerate `groups/<folder>/CLAUDE.md` from the shared base, enabled skill
 * fragments, and MCP server fragments declared in `container.json`. Creates
 * an empty `CLAUDE.local.md` if missing.
 */
export function composeGroupClaudeMd(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  if (!fs.existsSync(groupDir)) {
    fs.mkdirSync(groupDir, { recursive: true });
  }

  const sharedLink = path.join(groupDir, '.claude-shared.md');
  syncSymlink(sharedLink, SHARED_CLAUDE_MD_CONTAINER_PATH);

  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (!fs.existsSync(fragmentsDir)) {
    fs.mkdirSync(fragmentsDir, { recursive: true });
  }

  // Desired fragment set.
  const configRow = getContainerConfig(group.id);
  const mcpServers: Record<string, McpServerConfig> = configRow
    ? (JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>)
    : {};
  const desired = new Map<string, { type: 'symlink' | 'inline'; content: string }>();

  // Skill fragments — every skill that ships an `instructions.md`.
  // TODO (shared-source refactor): respect `container.json` skill selection.
  const skillsHostDir = path.join(process.cwd(), 'container', 'skills');
  if (fs.existsSync(skillsHostDir)) {
    for (const skillName of fs.readdirSync(skillsHostDir)) {
      const hostFragment = path.join(skillsHostDir, skillName, 'instructions.md');
      if (fs.existsSync(hostFragment)) {
        desired.set(`skill-${skillName}.md`, {
          type: 'symlink',
          content: `${SHARED_SKILLS_CONTAINER_BASE}/${skillName}/instructions.md`,
        });
      }
    }
  }

  // Built-in module fragments — every MCP tool source file that ships a
  // sibling `<name>.instructions.md`. These describe how the agent should
  // use that module's MCP tools (schedule_task, install_packages, etc.).
  // Skip cli.instructions.md when cli_scope is disabled.
  const cliDisabled = configRow?.cli_scope === 'disabled';
  const mcpToolsHostDir = path.join(process.cwd(), MCP_TOOLS_HOST_SUBPATH);
  if (fs.existsSync(mcpToolsHostDir)) {
    for (const entry of fs.readdirSync(mcpToolsHostDir)) {
      const match = entry.match(/^(.+)\.instructions\.md$/);
      if (!match) continue;
      const moduleName = match[1];
      if (moduleName === 'cli' && cliDisabled) continue;
      desired.set(`module-${moduleName}.md`, {
        type: 'symlink',
        content: `${SHARED_MCP_TOOLS_CONTAINER_BASE}/${entry}`,
      });
    }
  }

  // MCP server fragments — inline instructions from container.json for
  // user-added external MCP servers.
  for (const [name, mcp] of Object.entries(mcpServers)) {
    if (mcp.instructions) {
      desired.set(`mcp-${name}.md`, {
        type: 'inline',
        content: mcp.instructions,
      });
    }
  }

  // Reconcile: drop stale, write desired.
  for (const existing of fs.readdirSync(fragmentsDir)) {
    if (!desired.has(existing)) {
      fs.unlinkSync(path.join(fragmentsDir, existing));
    }
  }
  for (const [name, frag] of desired) {
    const fragPath = path.join(fragmentsDir, name);
    if (frag.type === 'symlink') {
      syncSymlink(fragPath, frag.content);
    } else {
      writeAtomic(fragPath, frag.content);
    }
  }

  // Host-fragment discovery — career-pilot extension. See file header.
  // Externally owned (we don't write or prune); we just enumerate.
  const hostFragmentsDir = path.join(groupDir, '.claude-host-fragments');
  const hostFragmentNames: string[] = [];
  if (fs.existsSync(hostFragmentsDir)) {
    for (const entry of fs.readdirSync(hostFragmentsDir)) {
      if (entry.endsWith('.md')) hostFragmentNames.push(entry);
    }
    hostFragmentNames.sort();
  }

  // Composed entry — imports only.
  const imports = ['@./.claude-shared.md'];
  for (const name of [...desired.keys()].sort()) {
    imports.push(`@./.claude-fragments/${name}`);
  }
  for (const name of hostFragmentNames) {
    imports.push(`@./.claude-host-fragments/${name}`);
  }
  const body = [COMPOSED_HEADER, ...imports, ''].join('\n');
  writeAtomic(path.join(groupDir, 'CLAUDE.md'), body);

  const localFile = path.join(groupDir, 'CLAUDE.local.md');
  if (!fs.existsSync(localFile)) {
    fs.writeFileSync(localFile, '');
  }
}

/**
 * Render subagent definitions for an agent group, combining:
 *   1. Shared sources at `groups/_shared-subagents/*.md` (canonical for
 *      cross-group subagents — research-company, tailor-resume, etc.)
 *   2. Per-group sources at `groups/<folder>/.claude/agents-src/*.md`
 *      (group-only subagents OR per-group overrides of shared files)
 * into the Claude-Code-discoverable location
 * `groups/<folder>/.claude/agents/*.md`, resolving
 * `<!-- @include <relative-path> -->` directives by inlining the referenced
 * file's content.
 *
 * Layering rules:
 *   - When a filename appears in BOTH the shared dir AND the per-group
 *     dir, the per-group file wins (lets one group diverge a specific
 *     subagent — e.g., a sandbox-only "you're in the simulator" hint).
 *   - `@include` paths are resolved against the source's own directory
 *     FIRST, with the shared directory as fallback. So a per-group
 *     override can still pull `_shared/subagent-preamble.md` from the
 *     shared dir without duplicating it.
 *
 * Why this exists at all: Claude Code's `@`-import resolver runs on the
 * composed root CLAUDE.md only — subagent definitions are loaded by the
 * agent registry as opaque system-prompt strings. We do `@include`
 * resolution at compose time. See `.specs/STRATEGY.md §24.3` item 2 for
 * the original rationale and task #85 for the cross-group dedup refactor.
 *
 * Deterministic — same sources produce the same rendered files. Stale
 * rendered files (no corresponding source) are pruned. Throws on a missing
 * include target so authoring errors surface loudly.
 *
 * Runs on every spawn from `container-runner.buildMounts()` alongside
 * `composeGroupClaudeMd(group)`.
 */
export function composeSubagentDefinitions(group: AgentGroup): void {
  const groupDir = path.resolve(GROUPS_DIR, group.folder);
  const perGroupSrcDir = path.join(groupDir, '.claude', 'agents-src');
  const sharedSrcDir = path.resolve(GROUPS_DIR, '_shared-subagents');
  const renderedDir = path.join(groupDir, '.claude', 'agents');

  // Build the source map: shared sources first, then per-group sources
  // overwrite on name collision. Map value carries the source dir so the
  // include resolver knows where to look first.
  type SourceEntry = { srcPath: string; srcDir: string };
  const sources = new Map<string, SourceEntry>();

  if (fs.existsSync(sharedSrcDir)) {
    for (const entry of fs.readdirSync(sharedSrcDir)) {
      if (!isRenderableSubagentSource(entry)) continue;
      const srcPath = path.join(sharedSrcDir, entry);
      if (!fs.statSync(srcPath).isFile()) continue;
      sources.set(entry, { srcPath, srcDir: sharedSrcDir });
    }
  }

  if (fs.existsSync(perGroupSrcDir)) {
    for (const entry of fs.readdirSync(perGroupSrcDir)) {
      if (!isRenderableSubagentSource(entry)) continue;
      const srcPath = path.join(perGroupSrcDir, entry);
      if (!fs.statSync(srcPath).isFile()) continue;
      sources.set(entry, { srcPath, srcDir: perGroupSrcDir });
    }
  }

  if (sources.size === 0) return;

  fs.mkdirSync(renderedDir, { recursive: true });

  for (const [name, entry] of sources) {
    // Per-group sources fall back to shared dir on @include misses; shared
    // sources have no fallback (they're self-contained).
    const fallbackDir = entry.srcDir === perGroupSrcDir ? sharedSrcDir : null;
    const rendered = renderSubagentSource(entry.srcPath, entry.srcDir, fallbackDir);
    writeAtomic(path.join(renderedDir, name), rendered);
  }

  for (const existing of fs.readdirSync(renderedDir)) {
    if (!existing.endsWith('.md')) continue;
    if (sources.has(existing)) continue;
    const existingPath = path.join(renderedDir, existing);
    if (!fs.statSync(existingPath).isFile()) continue;
    fs.unlinkSync(existingPath);
  }
}

/**
 * Whether a filename in agents-src should be rendered as a runtime
 * subagent definition. Excludes developer-facing sibling files that share
 * the directory (e.g., `<name>.VERIFICATION.md` — per the CLAUDE.md
 * runtime-artifact rule, DoD lives next to the source it verifies).
 */
function isRenderableSubagentSource(filename: string): boolean {
  if (!filename.endsWith('.md')) return false;
  if (filename.endsWith('.VERIFICATION.md')) return false;
  return true;
}

const SUBAGENT_INCLUDE_PATTERN = /^[ \t]*<!--\s*@include\s+(\S+)\s*-->[ \t]*$/gm;

function renderSubagentSource(srcPath: string, primarySrcDir: string, fallbackSrcDir: string | null): string {
  const body = fs.readFileSync(srcPath, 'utf8');
  return body.replace(SUBAGENT_INCLUDE_PATTERN, (_match, relativePath: string) => {
    const primaryPath = resolveInclude(primarySrcDir, relativePath, srcPath);
    if (primaryPath && fs.existsSync(primaryPath)) {
      return fs.readFileSync(primaryPath, 'utf8').trimEnd();
    }
    if (fallbackSrcDir) {
      const fallbackPath = resolveInclude(fallbackSrcDir, relativePath, srcPath);
      if (fallbackPath && fs.existsSync(fallbackPath)) {
        return fs.readFileSync(fallbackPath, 'utf8').trimEnd();
      }
    }
    throw new Error(
      `Subagent source ${path.relative(process.cwd(), srcPath)} includes missing file: ` +
        `${relativePath} (looked in ${path.relative(process.cwd(), primarySrcDir)}` +
        `${fallbackSrcDir ? ` and ${path.relative(process.cwd(), fallbackSrcDir)}` : ''})`,
    );
  });
}

/** Resolve a relative include path against a base dir, returning the
 * absolute path if the result stays inside the base dir, or null otherwise.
 * Defense against `../` escaping the source tree. */
function resolveInclude(baseDir: string, relativePath: string, contextSrc: string): string | null {
  const absPath = path.resolve(baseDir, relativePath);
  const rel = path.relative(baseDir, absPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(
      `Subagent source ${path.relative(process.cwd(), contextSrc)} includes path ` +
        `outside ${path.relative(process.cwd(), baseDir)}: ${relativePath}`,
    );
  }
  return absPath;
}

/**
 * One-time cutover from the `groups/global/CLAUDE.md` + `.claude-global.md`
 * pattern. Idempotent — safe to run on every host startup.
 *
 * For each group dir:
 *   - remove `.claude-global.md` symlink if present
 *   - rename `CLAUDE.md` → `CLAUDE.local.md` (only if `CLAUDE.local.md`
 *     doesn't already exist — preserves pre-cutover content as per-group
 *     memory; after the first spawn regenerates `CLAUDE.md`, this branch
 *     is skipped because `CLAUDE.local.md` now exists)
 *
 * Globally:
 *   - delete `groups/global/` (content already in `container/CLAUDE.md`)
 */
export function migrateGroupsToClaudeLocal(): void {
  if (!fs.existsSync(GROUPS_DIR)) return;

  const actions: string[] = [];

  for (const entry of fs.readdirSync(GROUPS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === 'global') continue;

    const groupDir = path.join(GROUPS_DIR, entry.name);

    const oldGlobalLink = path.join(groupDir, '.claude-global.md');
    try {
      fs.lstatSync(oldGlobalLink);
      fs.unlinkSync(oldGlobalLink);
      actions.push(`${entry.name}/.claude-global.md removed`);
    } catch {
      /* already gone */
    }

    const claudeMd = path.join(groupDir, 'CLAUDE.md');
    const claudeLocal = path.join(groupDir, 'CLAUDE.local.md');
    if (fs.existsSync(claudeMd) && !fs.existsSync(claudeLocal)) {
      fs.renameSync(claudeMd, claudeLocal);
      actions.push(`${entry.name}/CLAUDE.md → CLAUDE.local.md`);
    }
  }

  const globalDir = path.join(GROUPS_DIR, 'global');
  if (fs.existsSync(globalDir)) {
    fs.rmSync(globalDir, { recursive: true, force: true });
    actions.push('groups/global/ removed');
  }

  if (actions.length > 0) {
    log.info('Migrated groups to CLAUDE.local.md model', { actions });
  }
}

function syncSymlink(linkPath: string, target: string): void {
  let currentTarget: string | null = null;
  try {
    currentTarget = fs.readlinkSync(linkPath);
  } catch {
    /* missing */
  }
  if (currentTarget === target) return;
  try {
    fs.unlinkSync(linkPath);
  } catch {
    /* missing */
  }
  fs.symlinkSync(target, linkPath);
}

function writeAtomic(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}
