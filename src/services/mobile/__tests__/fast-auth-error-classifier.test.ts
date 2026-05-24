import { categorizeFastAuthError } from '../fast-auth-error-classifier';

describe('categorizeFastAuthError', () => {
  describe('invalidate_snapshot', () => {
    it('returns invalidate_snapshot for SNAPSHOT_TOO_LARGE', () => {
      expect(categorizeFastAuthError('SNAPSHOT_TOO_LARGE', 413)).toBe('invalidate_snapshot');
    });

    it('returns invalidate_snapshot for SNAPSHOT_PRIVILEGE', () => {
      expect(categorizeFastAuthError('SNAPSHOT_PRIVILEGE', 409)).toBe('invalidate_snapshot');
    });

    it('returns invalidate_snapshot for SNAPSHOT_TOO_LARGE regardless of status code', () => {
      expect(categorizeFastAuthError('SNAPSHOT_TOO_LARGE', undefined)).toBe('invalidate_snapshot');
    });
  });

  describe('config_bug', () => {
    it('returns config_bug for PACKAGE_NAME_MISMATCH', () => {
      expect(categorizeFastAuthError('PACKAGE_NAME_MISMATCH', 400)).toBe('config_bug');
    });

    it('returns config_bug for PLATFORM_UNSUPPORTED', () => {
      expect(categorizeFastAuthError('PLATFORM_UNSUPPORTED', 400)).toBe('config_bug');
    });
  });

  describe('transient', () => {
    it('returns transient for 500+ status with no code', () => {
      expect(categorizeFastAuthError(undefined, 500)).toBe('transient');
    });

    it('returns transient for 503 with no code', () => {
      expect(categorizeFastAuthError(undefined, 503)).toBe('transient');
    });

    it('returns transient for network error (no code, no status)', () => {
      expect(categorizeFastAuthError(undefined, undefined)).toBe('transient');
    });
  });

  describe('unknown', () => {
    it('returns unknown for an unrecognised code with a 4xx status', () => {
      // Known code that doesn't match any category — be conservative
      expect(categorizeFastAuthError('SOME_FUTURE_CODE', 422)).toBe('unknown');
    });

    it('returns unknown for an unrecognised code with a 5xx status', () => {
      // Code present but unrecognised — code takes precedence over status
      expect(categorizeFastAuthError('FUTURE_SERVER_ERROR', 500)).toBe('unknown');
    });
  });

  describe('code takes priority over status code', () => {
    it('invalidates when code is SNAPSHOT_TOO_LARGE even if status is 200', () => {
      expect(categorizeFastAuthError('SNAPSHOT_TOO_LARGE', 200)).toBe('invalidate_snapshot');
    });

    it('returns config_bug when code is PACKAGE_NAME_MISMATCH even if status is 500', () => {
      expect(categorizeFastAuthError('PACKAGE_NAME_MISMATCH', 500)).toBe('config_bug');
    });
  });
});
