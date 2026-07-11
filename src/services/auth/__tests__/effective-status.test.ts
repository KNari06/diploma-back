/**
 * resolveEffectiveStatus — approval status is derived on read, so a user can
 * never get stuck at pending after a transient provision failure.
 */

// env is read at call time via the module; mock it per-case.
jest.mock('@/config/environment/env', () => ({
  env: { AUTO_APPROVE_SIGNUP: false },
}));

import { env } from '@/config/environment/env';
import { resolveEffectiveStatus } from '../effective-status';

const setFlag = (v: boolean) => {
  (env as { AUTO_APPROVE_SIGNUP: boolean }).AUTO_APPROVE_SIGNUP = v;
};

describe('resolveEffectiveStatus', () => {
  describe('when AUTO_APPROVE_SIGNUP is off (B2B)', () => {
    beforeEach(() => setFlag(false));

    it('returns the stored status unchanged for a pending user', () => {
      expect(resolveEffectiveStatus('pending_approval')).toBe('pending_approval');
    });

    it('returns approved for an already-approved user', () => {
      expect(resolveEffectiveStatus('approved')).toBe('approved');
    });

    it('defaults a null/absent status to pending_approval', () => {
      expect(resolveEffectiveStatus(null)).toBe('pending_approval');
      expect(resolveEffectiveStatus(undefined)).toBe('pending_approval');
    });

    it('keeps a rejected user rejected', () => {
      expect(resolveEffectiveStatus('rejected')).toBe('rejected');
    });
  });

  describe('when AUTO_APPROVE_SIGNUP is on (self-serve)', () => {
    beforeEach(() => setFlag(true));

    it('approves a pending user (heals a stuck provision)', () => {
      expect(resolveEffectiveStatus('pending_approval')).toBe('approved');
    });

    it('approves a user with no stored status', () => {
      expect(resolveEffectiveStatus(null)).toBe('approved');
      expect(resolveEffectiveStatus(undefined)).toBe('approved');
    });

    it('still honours a manual rejection — the flag must not un-reject', () => {
      expect(resolveEffectiveStatus('rejected')).toBe('rejected');
    });

    it('leaves an approved user approved', () => {
      expect(resolveEffectiveStatus('approved')).toBe('approved');
    });
  });
});
