import { describe, expect, it } from 'vitest';

import { PORTKEY_METADATA_MAX_VALUE_LEN, buildPortkeyMetadata } from './portkey.js';

describe('buildPortkeyMetadata', () => {
  it('keeps only present, non-empty string values', () => {
    expect(buildPortkeyMetadata({ environment: 'dev', agent_group: 'career-pilot' })).toEqual({
      environment: 'dev',
      agent_group: 'career-pilot',
    });
  });

  it('drops undefined and empty-string fields', () => {
    expect(buildPortkeyMetadata({ environment: undefined, surface: '', session_id: 'sess-1' })).toEqual({
      session_id: 'sess-1',
    });
  });

  it('returns {} when nothing is set (caller skips the header)', () => {
    expect(buildPortkeyMetadata({})).toEqual({});
  });

  it('clamps values to the 128-char Portkey limit', () => {
    const long = 'x'.repeat(200);
    expect(buildPortkeyMetadata({ session_id: long }).session_id).toHaveLength(PORTKEY_METADATA_MAX_VALUE_LEN);
  });
});
