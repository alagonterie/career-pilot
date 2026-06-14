/**
 * Unit tests for the origin-side Cloudflare Access JWT validation (§24.70 D2).
 * `jose` + `getConfig` are mocked so we exercise OUR env-gating + error handling
 * (the crypto correctness is jose's job).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(() => ({ jwks: true })),
  jwtVerify: vi.fn(),
}));
vi.mock('../../get-config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../db/connection.js', () => ({ getDb: vi.fn(() => ({})) }));

import { jwtVerify } from 'jose';

import { getConfig } from '../../get-config.js';

import { originJwtEnabled, validateAccessJwt } from './access-jwt.js';

const verifyMock = vi.mocked(jwtVerify);
const configMock = vi.mocked(getConfig);

function enable(enabled: boolean): void {
  configMock.mockReturnValue(enabled as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CF_ACCESS_TEAM = 'acme';
  process.env.CF_ACCESS_AUD = 'aud-123';
});

afterEach(() => {
  delete process.env.CF_ACCESS_TEAM;
  delete process.env.CF_ACCESS_AUD;
});

describe('originJwtEnabled', () => {
  it('is false when the config flag is off (default)', () => {
    enable(false);
    expect(originJwtEnabled()).toBe(false);
  });

  it('is false when enabled but the team/aud env is missing', () => {
    enable(true);
    delete process.env.CF_ACCESS_TEAM;
    expect(originJwtEnabled()).toBe(false);
  });

  it('is true only when enabled AND team + aud are configured', () => {
    enable(true);
    expect(originJwtEnabled()).toBe(true);
  });
});

describe('validateAccessJwt', () => {
  it('passes through (true) when validation is disabled — even with no token', async () => {
    enable(false);
    expect(await validateAccessJwt(undefined)).toBe(true);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('rejects (false) when enabled but no assertion is present', async () => {
    enable(true);
    expect(await validateAccessJwt(undefined)).toBe(false);
    expect(verifyMock).not.toHaveBeenCalled();
  });

  it('accepts a valid assertion and checks the issuer + audience', async () => {
    enable(true);
    verifyMock.mockResolvedValue({} as never);
    expect(await validateAccessJwt('tok')).toBe(true);
    expect(verifyMock).toHaveBeenCalledWith('tok', expect.anything(), {
      issuer: 'https://acme.cloudflareaccess.com',
      audience: 'aud-123',
    });
  });

  it('rejects (false, never throws) when verification fails', async () => {
    enable(true);
    verifyMock.mockRejectedValue(new Error('bad audience'));
    expect(await validateAccessJwt('tok')).toBe(false);
  });
});
