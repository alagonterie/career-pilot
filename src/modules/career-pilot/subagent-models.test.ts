/**
 * Unit tests for the §24.163 per-subagent model injection helpers
 * (subagent-models.ts). The FS-walking `applySubagentModels` is exercised
 * end-to-end on the box (the rendered `.claude/agents/*.md` frontmatter); here we
 * test the two pure pieces: the slug→knob mapping and the frontmatter rewrite.
 */
import { describe, expect, it } from 'vitest';

import { rewriteModelInFrontmatter, subagentModelKnob } from './subagent-models.js';

describe('subagentModelKnob', () => {
  it('maps owner-group slugs to owner_model_<slug_snake>', () => {
    expect(subagentModelKnob('career-pilot', 'research-company')).toBe('owner_model_research_company');
    expect(subagentModelKnob('career-pilot', 'build-interview-kit')).toBe('owner_model_build_interview_kit');
    expect(subagentModelKnob('career-pilot', 'pipeline-scribe')).toBe('owner_model_pipeline_scribe');
  });

  it('maps sandbox-group slugs to sandbox_model_<slug_snake>', () => {
    expect(subagentModelKnob('career-pilot-sandbox', 'tailor-resume')).toBe('sandbox_model_tailor_resume');
  });

  it('returns null for a non-career-pilot group', () => {
    expect(subagentModelKnob('some-other-group', 'research-company')).toBeNull();
  });
});

describe('rewriteModelInFrontmatter', () => {
  const fm = (model: string) =>
    `---\nname: research-company\ntools: [WebSearch]\nmodel: ${model}\nmaxTurns: 12\n---\n\n# research-company\nbody\n`;

  it('replaces an existing model: line, leaving the rest of the frontmatter + body intact', () => {
    const out = rewriteModelInFrontmatter(fm('inherit'), 'claude-haiku-4-5');
    expect(out).toContain('model: claude-haiku-4-5');
    expect(out).not.toContain('model: inherit');
    expect(out).toContain('name: research-company');
    expect(out).toContain('maxTurns: 12');
    expect(out).toContain('# research-company\nbody');
  });

  it('writes inherit through unchanged', () => {
    expect(rewriteModelInFrontmatter(fm('claude-opus-4-8'), 'inherit')).toContain('model: inherit');
  });

  it('inserts a model: line when the frontmatter has none', () => {
    const noModel = `---\nname: x\ntools: []\n---\n\nbody\n`;
    const out = rewriteModelInFrontmatter(noModel, 'claude-sonnet-4-6');
    expect(out).toMatch(/^---\nmodel: claude-sonnet-4-6\nname: x/);
    expect(out).toContain('\nbody\n');
  });

  it('returns the body unchanged when there is no frontmatter block', () => {
    const plain = '# just a heading\nno frontmatter here\n';
    expect(rewriteModelInFrontmatter(plain, 'claude-haiku-4-5')).toBe(plain);
  });

  it('is not perturbed by a `$` in another frontmatter field', () => {
    const withDollar = `---\nname: x\ndescription: costs $5 per run\nmodel: inherit\n---\nbody\n`;
    const out = rewriteModelInFrontmatter(withDollar, 'claude-haiku-4-5');
    expect(out).toContain('description: costs $5 per run');
    expect(out).toContain('model: claude-haiku-4-5');
  });

  it('only touches the FIRST model: line (the frontmatter), not a body mention', () => {
    const bodyMention = `---\nname: x\nmodel: inherit\n---\n\nThe model: opus mention in prose stays.\n`;
    const out = rewriteModelInFrontmatter(bodyMention, 'claude-haiku-4-5');
    expect(out).toContain('model: claude-haiku-4-5');
    expect(out).toContain('The model: opus mention in prose stays.');
  });
});
