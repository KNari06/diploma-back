/**
 * Unit tests for ImportCreditsService.
 * Verifies the feature gate, idempotency, per-test pricing, and the
 * never-throw / never-double-charge safety guarantees.
 */

import { ImportCreditsService } from '../import-credits.service';
import { CreditCostTrackerService } from '../credit-cost-tracker.service';
import { ImportCreditsFeature } from '@/config/features/import-credits';
import { importAlreadyCharged } from '../db/import-credits.db';

jest.mock('../credit-cost-tracker.service', () => ({
  CreditCostTrackerService: { deductCreditsForTest: jest.fn() },
}));
jest.mock('../db/import-credits.db', () => ({
  importAlreadyCharged: jest.fn(),
}));
jest.mock('@/config/features/import-credits', () => ({
  ImportCreditsFeature: {
    isEnabled: jest.fn(),
    // Keep real pricing math so the credits×tests calculation is exercised.
    getPerTest: jest.fn(() => 1),
    creditsFor: (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0),
  },
}));

const mockDeduct = CreditCostTrackerService.deductCreditsForTest as jest.Mock;
const mockAlreadyCharged = importAlreadyCharged as jest.Mock;
const mockIsEnabled = ImportCreditsFeature.isEnabled as jest.Mock;

const base = { userId: 'u1', importId: 'imp1', testsImported: 79, fileName: 'a.pdf' };

describe('ImportCreditsService.chargeForImport', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsEnabled.mockReturnValue(true);
    mockAlreadyCharged.mockResolvedValue(false);
    mockDeduct.mockResolvedValue({ success: true, newBalance: 921 });
  });

  it('does not charge when the feature is disabled', async () => {
    mockIsEnabled.mockReturnValue(false);
    const r = await ImportCreditsService.chargeForImport(base);
    expect(r).toEqual({ charged: false, credits: 0, reason: 'disabled' });
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('does not charge when nothing was imported', async () => {
    const r = await ImportCreditsService.chargeForImport({ ...base, testsImported: 0 });
    expect(r.charged).toBe(false);
    expect(r.reason).toBe('zero_credits');
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('charges perTest × testsImported on the happy path', async () => {
    const r = await ImportCreditsService.chargeForImport(base);
    expect(r).toEqual({ charged: true, credits: 79 });
    expect(mockDeduct).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', testType: 'import', credits: 79, testId: 'imp1' }),
    );
  });

  it('skips when this import was already charged (BullMQ retry)', async () => {
    mockAlreadyCharged.mockResolvedValue(true);
    const r = await ImportCreditsService.chargeForImport(base);
    expect(r.charged).toBe(false);
    expect(r.reason).toBe('already_charged');
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('does NOT charge when the idempotency check itself fails (avoid double-charge)', async () => {
    mockAlreadyCharged.mockRejectedValue(new Error('db down'));
    const r = await ImportCreditsService.chargeForImport(base);
    expect(r.charged).toBe(false);
    expect(r.reason).toBe('idempotency_check_failed');
    expect(mockDeduct).not.toHaveBeenCalled();
  });

  it('reports not-charged when the deduction fails (insufficient credits)', async () => {
    mockDeduct.mockResolvedValue({ success: false, newBalance: 0 });
    const r = await ImportCreditsService.chargeForImport(base);
    expect(r.charged).toBe(false);
    expect(r.reason).toBe('deduction_failed');
  });
});
