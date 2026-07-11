/**
 * Tests for test-credits — billing math for a manual test run.
 *
 * Money correctness: calculateRequiredCredits must charge the exact per-browser
 * + AI cost (over-charge = angry users, under-charge = lost revenue), and
 * checkUserCredits must block a run when the balance is short with the stable
 * INSUFFICIENT_CREDITS code the frontend banner keys off. deductCredits must
 * surface RPC failures rather than silently letting a run proceed unpaid.
 *
 * db + UserCreditsService mocked at the boundary.
 */

import { calculateRequiredCredits, checkUserCredits, deductCredits } from '../test-credits';
import { dbService } from '@/db/supabase';
import { NotFoundError, ValidationError, InsufficientCreditsError } from '@/types';
import type { BrowserType } from '@/types';

jest.mock('@/db/supabase', () => ({
  dbService: { getUser: jest.fn(), supabaseAdmin: { rpc: jest.fn() } },
}));
const mockGetOrCreate = jest.fn();
const mockDeduct = jest.fn();
jest.mock('@/services/core/user-credits.service', () => ({
  UserCreditsService: {
    getOrCreateUserCredits: (...a: unknown[]) => mockGetOrCreate(...a),
    deductCredits: (...a: unknown[]) => mockDeduct(...a),
  },
}));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetUser = dbService.getUser as jest.Mock;
const mockRpc = dbService.supabaseAdmin.rpc as jest.Mock;

describe('calculateRequiredCredits', () => {
  describe('standard (non-intelligent) mode', () => {
    it('charges 1 credit per desktop browser', () => {
      expect(calculateRequiredCredits(['chrome', 'firefox', 'safari', 'edge'])).toBe(4);
    });

    it('charges 2 for mobile-web and 3 for native mobile browsers', () => {
      expect(calculateRequiredCredits(['mobile-chrome', 'mobile-safari'])).toBe(4);
      expect(calculateRequiredCredits(['mobile-android', 'mobile-ios', 'mobile-flutter'])).toBe(9);
    });

    it('mixes browser costs correctly', () => {
      expect(calculateRequiredCredits(['chrome', 'mobile-chrome', 'mobile-android'])).toBe(1 + 2 + 3);
    });

    it('treats an unknown browser as 1 credit (fallback)', () => {
      expect(calculateRequiredCredits(['netscape' as BrowserType])).toBe(1);
    });

    it('is 0 for an empty browser list', () => {
      expect(calculateRequiredCredits([])).toBe(0);
    });
  });

  describe('intelligent mode', () => {
    it('uses a 2x multiplier when no estimatedCost is provided', () => {
      expect(calculateRequiredCredits(['chrome', 'firefox'], true)).toBe(4); // base 2 * 2
    });

    it('adds AI credits from a single estimatedCost ($0.15 → 15 credits)', () => {
      expect(calculateRequiredCredits(['chrome'], true, '$0.15')).toBe(1 + 15);
    });

    it('uses the UPPER bound of a range ($0.10-0.20 → 20 credits)', () => {
      expect(calculateRequiredCredits(['chrome'], true, '$0.10-0.20')).toBe(1 + 20);
    });

    it('handles a range written with a second dollar sign ($0.10-$0.30)', () => {
      expect(calculateRequiredCredits(['chrome'], true, '$0.10-$0.30')).toBe(1 + 30);
    });

    it('rounds AI credits UP (ceil) for fractional cents ($0.151 → 16)', () => {
      expect(calculateRequiredCredits(['chrome'], true, '$0.151')).toBe(1 + 16);
    });

    it('falls back to 2x when estimatedCost is unparseable', () => {
      expect(calculateRequiredCredits(['chrome', 'firefox'], true, 'free-ish')).toBe(4);
    });
  });
});

describe('checkUserCredits', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetUser.mockResolvedValue({ id: 'u1' });
    mockGetOrCreate.mockResolvedValue({ credits_balance: 100 });
  });

  it('passes when the balance covers the required credits', async () => {
    await expect(checkUserCredits('u1', ['chrome'])).resolves.toBeUndefined();
  });

  it('throws NotFoundError when the user does not exist', async () => {
    mockGetUser.mockResolvedValue(null);
    await expect(checkUserCredits('u1', ['chrome'])).rejects.toBeInstanceOf(NotFoundError);
  });

  it('throws InsufficientCreditsError (with code + details) when short', async () => {
    mockGetOrCreate.mockResolvedValue({ credits_balance: 2 });
    try {
      await checkUserCredits('u1', ['mobile-android'], false); // needs 3
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(InsufficientCreditsError);
      expect((e as InsufficientCreditsError).code).toBe('INSUFFICIENT_CREDITS');
      expect((e as InsufficientCreditsError).details).toEqual({ required: 3, available: 2 });
    }
  });

  it('treats a non-finite balance as 0 (blocks the run)', async () => {
    mockGetOrCreate.mockResolvedValue({ credits_balance: Number.NaN });
    await expect(checkUserCredits('u1', ['chrome'])).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it('allows a run that needs exactly the available balance', async () => {
    mockGetOrCreate.mockResolvedValue({ credits_balance: 3 });
    await expect(checkUserCredits('u1', ['mobile-android'])).resolves.toBeUndefined();
  });
});

describe('deductCredits', () => {
  beforeEach(() => jest.clearAllMocks());

  it('charges via the canonical UserCreditsService.deductCredits with the computed amount', async () => {
    mockDeduct.mockResolvedValue({ success: true, newBalance: 96 });
    await deductCredits('u1', 'test-1', ['chrome', 'mobile-android']); // 1 + 3 = 4
    expect(mockDeduct).toHaveBeenCalledTimes(1);
    const [userId, amount, , metadata] = mockDeduct.mock.calls[0];
    expect(userId).toBe('u1');
    expect(amount).toBe(4);
    expect(metadata).toMatchObject({ test_id: 'test-1', test_type: 'standard' });
    // Never calls the old (non-existent) deduct_test_credits RPC.
    expect(mockRpc).not.toHaveBeenCalled();
  });

  it('tags intelligent runs as test_type=intelligent', async () => {
    mockDeduct.mockResolvedValue({ success: true, newBalance: 0 });
    await deductCredits('u1', 't1', ['chrome'], true, '$0.10');
    const [, , , metadata] = mockDeduct.mock.calls[0];
    expect(metadata).toMatchObject({ test_type: 'intelligent' });
  });

  it('throws ValidationError when the deduction fails (insufficient / error)', async () => {
    mockDeduct.mockResolvedValue({ success: false, newBalance: 0 });
    await expect(deductCredits('u1', 't1', ['chrome'])).rejects.toBeInstanceOf(ValidationError);
  });
});
