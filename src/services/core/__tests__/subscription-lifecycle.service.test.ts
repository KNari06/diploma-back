/**
 * Tests for SubscriptionLifecycleService.remindExpiringPlans — the daily
 * "your plan expires soon" sweep.
 *
 * Billing-sensitive behaviours that must hold:
 *   - mark-reminded ONLY after a successful send, so a mail failure retries
 *     next sweep instead of being silently skipped for the whole period.
 *   - willAutoRenew is true ONLY when Stripe says cancel_at_period_end === false
 *     — null/unknown must NOT falsely reassure the user their card will charge.
 *   - best-effort per user: one failure never aborts the batch.
 *
 * The db layer + EmailService are mocked at the boundary (architecture rule:
 * service tests stub db/, never Supabase directly).
 */

import { SubscriptionLifecycleService } from '../subscription-lifecycle.service';
import { EmailService } from '@/services/core/email.service';
import {
  fetchExpiringUsers,
  markExpiryReminderSent,
} from '@/services/core/db/subscription-lifecycle.db';

jest.mock('@/services/core/db/subscription-lifecycle.db', () => ({
  fetchExpiringUsers: jest.fn(),
  markExpiryReminderSent: jest.fn(),
  EXPIRING_USERS_LIMIT: 100,
}));
jest.mock('@/services/core/email.service', () => ({
  EmailService: { sendPlanExpiringEmail: jest.fn() },
}));
jest.mock('@/config/environment/env', () => ({ env: { FRONTEND_URL: 'https://app.test' } }));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockFetch = fetchExpiringUsers as jest.Mock;
const mockMark = markExpiryReminderSent as jest.Mock;
const mockSend = EmailService.sendPlanExpiringEmail as jest.Mock;

function user(over: Record<string, unknown> = {}) {
  return {
    id: 'u1',
    email: 'a@b.com',
    name: 'A',
    current_period_end: '2026-07-01T00:00:00Z',
    cancel_at_period_end: false,
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockSend.mockResolvedValue({ success: true });
  mockMark.mockResolvedValue(undefined);
});

describe('remindExpiringPlans', () => {
  it('sends to each eligible user and marks them reminded', async () => {
    mockFetch.mockResolvedValue([user({ id: 'u1' }), user({ id: 'u2', email: 'c@d.com' })]);
    const result = await SubscriptionLifecycleService.remindExpiringPlans();
    expect(result).toEqual({ sent: 2, failed: 0, candidates: 2 });
    expect(mockSend).toHaveBeenCalledTimes(2);
    expect(mockMark).toHaveBeenCalledTimes(2);
  });

  it('passes the default 3-day window to the db query', async () => {
    mockFetch.mockResolvedValue([]);
    await SubscriptionLifecycleService.remindExpiringPlans();
    expect(mockFetch).toHaveBeenCalledWith(3);
  });

  it('skips users with no email (counted as candidates, not sent/failed)', async () => {
    mockFetch.mockResolvedValue([user({ id: 'u1', email: null }), user({ id: 'u2', email: 'c@d.com' })]);
    const result = await SubscriptionLifecycleService.remindExpiringPlans();
    expect(result).toEqual({ sent: 1, failed: 0, candidates: 2 });
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  describe('mark-reminded only after a successful send', () => {
    it('does NOT mark reminded when the email reports failure', async () => {
      mockFetch.mockResolvedValue([user()]);
      mockSend.mockResolvedValue({ success: false, error: 'smtp down' });
      const result = await SubscriptionLifecycleService.remindExpiringPlans();
      expect(result).toEqual({ sent: 0, failed: 1, candidates: 1 });
      expect(mockMark).not.toHaveBeenCalled();
    });

    it('does NOT mark reminded when the send throws', async () => {
      mockFetch.mockResolvedValue([user()]);
      mockSend.mockRejectedValue(new Error('boom'));
      const result = await SubscriptionLifecycleService.remindExpiringPlans();
      expect(result).toEqual({ sent: 0, failed: 1, candidates: 1 });
      expect(mockMark).not.toHaveBeenCalled();
    });
  });

  it('is best-effort: one failure does not abort the rest of the batch', async () => {
    mockFetch.mockResolvedValue([user({ id: 'u1' }), user({ id: 'u2' }), user({ id: 'u3' })]);
    mockSend
      .mockResolvedValueOnce({ success: true })
      .mockRejectedValueOnce(new Error('mid-batch'))
      .mockResolvedValueOnce({ success: true });
    const result = await SubscriptionLifecycleService.remindExpiringPlans();
    expect(result).toEqual({ sent: 2, failed: 1, candidates: 3 });
    expect(mockMark).toHaveBeenCalledTimes(2);
  });

  describe('willAutoRenew derivation (no false reassurance)', () => {
    it('true only when cancel_at_period_end === false', async () => {
      mockFetch.mockResolvedValue([user({ cancel_at_period_end: false })]);
      await SubscriptionLifecycleService.remindExpiringPlans();
      expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ willAutoRenew: true }));
    });

    it.each([[true], [null], [undefined]])(
      'false when cancel_at_period_end is %s (treat unknown as will-end)',
      async (val) => {
        mockFetch.mockResolvedValue([user({ cancel_at_period_end: val })]);
        await SubscriptionLifecycleService.remindExpiringPlans();
        expect(mockSend).toHaveBeenCalledWith(expect.objectContaining({ willAutoRenew: false }));
      },
    );
  });

  it('warns when the candidate cap is hit (coverage-gap signal)', async () => {
    // mocked EXPIRING_USERS_LIMIT = 100; return exactly that many.
    mockFetch.mockResolvedValue(Array.from({ length: 100 }, (_, i) => user({ id: `u${i}`, email: `u${i}@x.com` })));
    const result = await SubscriptionLifecycleService.remindExpiringPlans();
    expect(result.candidates).toBe(100);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { logger } = require('@/utils/core/logger');
    expect(logger.warn).toHaveBeenCalledWith('[SUB_LIFECYCLE] Expiring-plan candidate cap hit', expect.any(Object));
  });

  it('returns zeroes for an empty candidate set', async () => {
    mockFetch.mockResolvedValue([]);
    expect(await SubscriptionLifecycleService.remindExpiringPlans()).toEqual({ sent: 0, failed: 0, candidates: 0 });
  });
});
