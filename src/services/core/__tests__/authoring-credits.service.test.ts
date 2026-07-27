/**
 * Unit tests for AuthoringCreditsService.
 * Verifies the resolverPath gate (charge only when the LLM ran), per-(session,
 * step) dedup, the never-double-charge window, and refund-of-dedup on failure.
 */

import { AuthoringCreditsService } from '../authoring-credits.service';
import { CreditCostTrackerService } from '../credit-cost-tracker.service';
import { AuthoringCreditsFeature } from '@/config/features/authoring-credits';

jest.mock('../credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductCreditsForTest: jest.fn() },
}));
jest.mock('@/config/features/authoring-credits', () => {
  const PAID = new Set(['llm', 'vision']);
  const PAID_MOBILE = new Set(['llm', 'vision', 'thinking']);
  return {
    AuthoringCreditsFeature: {
      isEnabled: jest.fn(),
      getPerResolve: jest.fn(() => 1),
      isPaidResolverPath: (p?: string) => !!p && PAID.has(p),
      isPaidMobileResolvedVia: (v?: string) => !!v && PAID_MOBILE.has(v),
    },
  };
});

const mockDeduct = CreditCostTrackerService.deductCreditsForTest as jest.Mock;
const mockIsEnabled = AuthoringCreditsFeature.isEnabled as jest.Mock;

const base = { userId: 'u1', previewSessionId: 'sess1', stepId: 'step1', resolverPath: 'llm' as const };

describe('AuthoringCreditsService.chargeForApply', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockDeduct.mockResolvedValue({ success: true, newBalance: 42 });
    AuthoringCreditsService.clearSession('sess1');
  });

  it('does not charge when the feature is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const r = await AuthoringCreditsService.chargeForApply(base);
    expect(r.reason).toBe('disabled');
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('does not charge a free resolver path (identity/compiled)', async () => {
    const r = await AuthoringCreditsService.chargeForApply({ ...base, resolverPath: 'compiled' });
    expect(r).toEqual({ charged: false, credits: 0, reason: 'no_llm' });
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('charges once for an LLM-resolved apply', async () => {
    const r = await AuthoringCreditsService.chargeForApply(base);
    expect(r).toEqual({ charged: true, credits: 1 });
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', testType: 'intelligent', credits: 1, testId: 'sess1' }),
    );
  });

  it('charges for the vision resolver path too', async () => {
    const r = await AuthoringCreditsService.chargeForApply({ ...base, resolverPath: 'vision' });
    expect(r.charged).toBe(true);
  });

  it('dedupes a re-apply of the same step in the same session', async () => {
    await AuthoringCreditsService.chargeForApply(base);
    const second = await AuthoringCreditsService.chargeForApply(base);
    expect(second.reason).toBe('already_charged');
    expect(mockDeduct).toHaveBeenCalledTimes(1);
  });

  it('charges again after the session dedup is cleared', async () => {
    await AuthoringCreditsService.chargeForApply(base);
    AuthoringCreditsService.clearSession('sess1');
    const again = await AuthoringCreditsService.chargeForApply(base);
    expect(again.charged).toBe(true);
    expect(mockDeduct).toHaveBeenCalledTimes(2);
  });

  it('releases the dedup on a failed deduction so a retry can charge', async () => {
    mockDeduct.mockResolvedValueOnce({ success: false, newBalance: 0 });
    const first = await AuthoringCreditsService.chargeForApply(base);
    expect(first.reason).toBe('deduction_failed');

    mockDeduct.mockResolvedValueOnce({ success: true, newBalance: 41 });
    const retry = await AuthoringCreditsService.chargeForApply(base);
    expect(retry.charged).toBe(true);
  });

  it('charges different steps in the same session independently', async () => {
    await AuthoringCreditsService.chargeForApply(base);
    const other = await AuthoringCreditsService.chargeForApply({ ...base, stepId: 'step2' });
    expect(other.charged).toBe(true);
    expect(mockDeduct).toHaveBeenCalledTimes(2);
  });

  it('does not charge when the apply carried no step id', async () => {
    const r = await AuthoringCreditsService.chargeForApply({ ...base, stepId: '' });
    expect(r.reason).toBe('no_step_id');
    expect(mockDeduct).not.toHaveBeenCalled();
  });
});

describe('AuthoringCreditsService.chargeForMobileApply', () => {
  const mobileBase = { userId: 'u1', previewSessionId: 'msess1', stepId: 'step1' };

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockDeduct.mockResolvedValue({ success: true, newBalance: 42 });
    AuthoringCreditsService.clearSession('msess1');
  });

  it.each(['llm', 'vision', 'thinking'])('charges a mobile apply resolved via %s', async (resolvedVia) => {
    const r = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia });
    expect(r).toEqual({ charged: true, credits: 1 });
  });

  it.each(['compiled', 'exact_label', 'exact_text', 'text_match', 'coordinates', 'passthrough'])(
    'does not charge a deterministic mobile resolve (%s)',
    async (resolvedVia) => {
      const r = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia });
      expect(r.reason).toBe('no_llm');
      expect(mockDeduct).not.toHaveBeenCalled();
    },
  );

  it('does not charge an unrecognised resolvedVia the runner may add later', async () => {
    const r = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia: 'some_future_path' });
    expect(r.reason).toBe('no_llm');
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('does not charge when resolvedVia is absent', async () => {
    const r = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia: undefined });
    expect(r.reason).toBe('no_llm');
  });

  it('charges mobile at the same rate as web', async () => {
    const web = await AuthoringCreditsService.chargeForApply(base);
    const mobile = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia: 'llm' });
    expect(mobile.credits).toBe(web.credits);
  });

  it('dedupes a re-apply of the same mobile step in the same session', async () => {
    await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia: 'llm' });
    const second = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia: 'llm' });
    expect(second.reason).toBe('already_charged');
    expect(mockDeduct).toHaveBeenCalledTimes(1);
  });

  it('does not charge when the feature is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const r = await AuthoringCreditsService.chargeForMobileApply({ ...mobileBase, resolvedVia: 'llm' });
    expect(r.reason).toBe('disabled');
    expect(mockDeduct).not.toHaveBeenCalled();
  });
});
