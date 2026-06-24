import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../llm-fetch.js', () => ({
  portkeyConfigured: vi.fn(() => true),
  callPortkeyChat: vi.fn(),
}));
vi.mock('../../db/connection.js', () => ({ getDb: vi.fn(() => ({})) }));
vi.mock('../../get-config.js', () => ({ getConfig: vi.fn(() => 'claude-haiku-4-5') }));

import { callPortkeyChat, portkeyConfigured } from '../../llm-fetch.js';

import { classifyJobIndustry } from './job-classify.js';

const mockChat = vi.mocked(callPortkeyChat);
const mockConfigured = vi.mocked(portkeyConfigured);

describe('classifyJobIndustry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfigured.mockReturnValue(true);
  });

  it('returns a slugified industry from the model', async () => {
    mockChat.mockResolvedValue({ text: ' Health ' } as Awaited<ReturnType<typeof callPortkeyChat>>);
    expect(await classifyJobIndustry('a behavioral-health EHR backend role', 'Senior Backend Engineer')).toBe('health');
  });

  it('slugifies multi-word answers + strips punctuation', async () => {
    mockChat.mockResolvedValue({ text: 'Real Estate.' } as Awaited<ReturnType<typeof callPortkeyChat>>);
    expect(await classifyJobIndustry('property listings JD')).toBe('real-estate');
  });

  it('returns null (no spend) when Portkey is not configured', async () => {
    mockConfigured.mockReturnValue(false);
    expect(await classifyJobIndustry('jd', 'role')).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns null on an empty JD without calling the model', async () => {
    expect(await classifyJobIndustry('   ')).toBeNull();
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('returns null when the model echoes "misc" (keeps the generic fallback)', async () => {
    mockChat.mockResolvedValue({ text: 'misc' } as Awaited<ReturnType<typeof callPortkeyChat>>);
    expect(await classifyJobIndustry('vague jd')).toBeNull();
  });

  it('never throws — returns null on a model failure', async () => {
    mockChat.mockRejectedValue(new Error('portkey down'));
    expect(await classifyJobIndustry('jd')).toBeNull();
  });
});
