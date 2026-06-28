/**
 * Tests for the AuthAdapter validation — the "Login" resource.
 *
 * validate() guards what gets persisted into the encrypted auth envelope:
 *   - storageState is delegated to validateAuthFixture (mocked here; it has its
 *     own test) and the normalized fixture is written back.
 *   - the mobile fast-auth snapshot ENVELOPE is shape-checked so a malformed
 *     write can't survive round-trip and blow up the runner mid-test with a
 *     confusing base64 error. Each field rule is pinned.
 *
 * apply/capture/heal touch a live browser context and are out of scope here.
 */

import { authAdapter } from '../auth.adapter';
import { validateAuthFixture } from '@/agent/core/lite/exploration/auth-fixture';

jest.mock('@/agent/core/lite/exploration/auth-fixture', () => ({ validateAuthFixture: jest.fn() }));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockValidateFixture = validateAuthFixture as jest.Mock;

function validate(config: unknown) {
  return authAdapter.validate({ config } as never);
}

function snapshot(over: Record<string, unknown> = {}) {
  return {
    platform: 'android',
    packageName: 'com.example.app',
    androidApiLevel: 30,
    dataTarballBase64: 'a'.repeat(40),
    sizeBytes: 1000,
    capturedAt: '2026-06-27T00:00:00Z',
    capturedVia: 'run-as',
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockValidateFixture.mockReturnValue({ valid: true, fixture: { cookies: [], origins: [] } });
});

describe('AuthAdapter.validate — optional fields', () => {
  it('accepts an empty config (everything is optional)', () => {
    const res = validate({});
    expect(res.valid).toBe(true);
    expect(mockValidateFixture).not.toHaveBeenCalled();
  });

  it('skips storageState validation when it is null/undefined', () => {
    expect(validate({ storageState: null }).valid).toBe(true);
    expect(mockValidateFixture).not.toHaveBeenCalled();
  });
});

describe('AuthAdapter.validate — storageState', () => {
  it('writes back the normalized fixture when valid', () => {
    mockValidateFixture.mockReturnValue({ valid: true, fixture: { cookies: [{ name: 'sid' }], origins: [] } });
    const res = validate({ storageState: { raw: true } });
    expect(res.valid).toBe(true);
    expect((res.normalized!.config as Record<string, unknown>).storageState).toEqual({
      cookies: [{ name: 'sid' }],
      origins: [],
    });
  });

  it('surfaces fixture errors when invalid', () => {
    mockValidateFixture.mockReturnValue({ valid: false, errors: ['bad cookie'] });
    const res = validate({ storageState: { raw: true } });
    expect(res.valid).toBe(false);
    expect(res.errors).toContain('bad cookie');
  });
});

describe('AuthAdapter.validate — totpSecret', () => {
  it('accepts a string secret and rejects a non-string', () => {
    expect(validate({ totpSecret: 'otpauth://x' }).valid).toBe(true);
    expect(validate({ totpSecret: 12345 }).valid).toBe(false);
  });
});

describe('AuthAdapter.validate — mobileSnapshot envelope', () => {
  it('accepts a well-formed snapshot', () => {
    expect(validate({ mobileSnapshot: snapshot() }).valid).toBe(true);
  });

  it('rejects a non-android platform (iOS deferred)', () => {
    expect(validate({ mobileSnapshot: snapshot({ platform: 'ios' }) }).valid).toBe(false);
  });

  it('rejects a missing / non-string packageName', () => {
    expect(validate({ mobileSnapshot: snapshot({ packageName: '' }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ packageName: 123 }) }).valid).toBe(false);
  });

  it('rejects an androidApiLevel below 21 or non-number', () => {
    expect(validate({ mobileSnapshot: snapshot({ androidApiLevel: 20 }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ androidApiLevel: '30' }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ androidApiLevel: 21 }) }).valid).toBe(true);
  });

  it('rejects a missing / implausibly short dataTarballBase64 (<32 chars)', () => {
    expect(validate({ mobileSnapshot: snapshot({ dataTarballBase64: 'short' }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ dataTarballBase64: undefined }) }).valid).toBe(false);
  });

  it('rejects a negative / non-number sizeBytes (0 is allowed)', () => {
    expect(validate({ mobileSnapshot: snapshot({ sizeBytes: -1 }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ sizeBytes: 'big' }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ sizeBytes: 0 }) }).valid).toBe(true);
  });

  it('rejects a missing capturedAt', () => {
    expect(validate({ mobileSnapshot: snapshot({ capturedAt: undefined }) }).valid).toBe(false);
  });

  it('rejects an invalid capturedVia (only run-as | su)', () => {
    expect(validate({ mobileSnapshot: snapshot({ capturedVia: 'root' }) }).valid).toBe(false);
    expect(validate({ mobileSnapshot: snapshot({ capturedVia: 'su' }) }).valid).toBe(true);
  });

  it('aggregates multiple snapshot errors', () => {
    const res = validate({ mobileSnapshot: snapshot({ platform: 'ios', packageName: '', capturedVia: 'x' }) });
    expect(res.valid).toBe(false);
    expect(res.errors!.length).toBeGreaterThanOrEqual(3);
  });

  it('skips snapshot validation when it is null', () => {
    expect(validate({ mobileSnapshot: null }).valid).toBe(true);
  });
});

describe('AuthAdapter metadata', () => {
  it('declares storageState, totpSecret, and mobileSnapshot as sensitive', () => {
    expect(authAdapter.sensitiveFields()).toEqual(['storageState', 'totpSecret', 'mobileSnapshot']);
  });
});
