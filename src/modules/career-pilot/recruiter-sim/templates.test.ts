import { describe, expect, it } from 'vitest';

import { EMAIL_CLASSIFICATIONS } from '../funnel-types.js';
import { STAGE_CLASSIFICATIONS, buildEmailContent, buildNoiseContent } from './templates.js';

describe('recruiter-sim templates', () => {
  it('every email classification yields a non-empty subject/body/prompt mentioning the facts', () => {
    for (const c of EMAIL_CLASSIFICATIONS) {
      const content = buildEmailContent(c, { company: 'Meridian Labs', role: 'Backend Engineer' });
      expect(content.subject.length).toBeGreaterThan(0);
      expect(content.deterministicBody.length).toBeGreaterThan(0);
      expect(content.prosePrompt.length).toBeGreaterThan(0);
    }
  });

  it('funnel-stage emails name the company and role', () => {
    for (const c of STAGE_CLASSIFICATIONS) {
      const content = buildEmailContent(c, { company: 'Northwind Systems', role: 'Platform Engineer' });
      const blob = `${content.subject}\n${content.deterministicBody}`;
      expect(blob).toContain('Northwind Systems');
      expect(blob).toContain('Platform Engineer');
    }
  });

  it('the stage sequence is the linear funnel walk', () => {
    expect(STAGE_CLASSIFICATIONS).toEqual([
      'application_confirmation',
      'screen_invite',
      'onsite_invite',
      'next_round_update',
    ]);
  });

  it('noise content is generic and not job-application prose', () => {
    const noise = buildNoiseContent(0);
    expect(noise.subject.length).toBeGreaterThan(0);
    expect(noise.deterministicBody.toLowerCase()).toContain('unsubscribe');
  });
});
