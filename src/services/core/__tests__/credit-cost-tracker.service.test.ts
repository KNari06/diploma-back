/**
 * Unit tests for CreditCostTrackerService
 * Tests AI call tracking, screenshot costs, test costs, and credit deduction
 */

import { CreditCostTrackerService } from '../credit-cost-tracker.service';
import { TEST_CREDITS } from '../token-calculator.service';
import { UserCreditsService } from '../user-credits.service';

// Mock UserCreditsService
jest.mock('../user-credits.service', () => ({
  UserCreditsService: {
    getUserCredits: jest.fn(),
    getOrCreateUserCredits: jest.fn(),
    deductCredits: jest.fn(),
    hasCredits: jest.fn(),
  },
}));

const mockUserCreditsService = UserCreditsService as jest.Mocked<typeof UserCreditsService>;

describe('CreditCostTrackerService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // trackAICall
  // ═══════════════════════════════════════════════════════════════════════════
  describe('trackAICall', () => {
    it('should track valid AI call and return correct values', () => {
      const result = CreditCostTrackerService.trackAICall('gpt-4o-mini', 1000, 500);

      expect(result.tokens).toBe(1500);
      expect(result.credits).toBeGreaterThan(0);
      expect(result.costUSD).toBeGreaterThan(0);
    });

    it('should handle negative input tokens by treating as 0', () => {
      const result = CreditCostTrackerService.trackAICall('gpt-4o-mini', -100, 500);

      expect(result.tokens).toBe(500); // Only output tokens counted
    });

    it('should handle negative output tokens by treating as 0', () => {
      const result = CreditCostTrackerService.trackAICall('gpt-4o-mini', 500, -100);

      expect(result.tokens).toBe(500); // Only input tokens counted
    });

    it('should handle NaN tokens', () => {
      const result = CreditCostTrackerService.trackAICall('gpt-4o-mini', NaN, 500);

      expect(result.tokens).toBe(500);
    });

    it('should calculate for gpt-4o model', () => {
      const result = CreditCostTrackerService.trackAICall('gpt-4o', 1000, 500);

      expect(result.tokens).toBe(1500);
      expect(result.costUSD).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // trackScreenshot
  // ═══════════════════════════════════════════════════════════════════════════
  describe('trackScreenshot', () => {
    it('should return 0 for 0 screenshots', () => {
      const result = CreditCostTrackerService.trackScreenshot(0);

      expect(result.tokens).toBe(0);
      expect(result.credits).toBe(0);
      expect(result.costUSD).toBe(0);
    });

    it('should handle negative count by treating as 0', () => {
      const result = CreditCostTrackerService.trackScreenshot(-5);

      expect(result.tokens).toBe(0);
      expect(result.credits).toBe(0);
    });

    it('should handle NaN count', () => {
      const result = CreditCostTrackerService.trackScreenshot(NaN);

      expect(result.tokens).toBe(0);
    });

    it('should floor fractional count', () => {
      const result1 = CreditCostTrackerService.trackScreenshot(2.7);
      const result2 = CreditCostTrackerService.trackScreenshot(2);

      expect(result1.tokens).toBe(result2.tokens);
    });

    it('should calculate tokens for multiple screenshots', () => {
      const result = CreditCostTrackerService.trackScreenshot(5);

      // 900 tokens per screenshot
      expect(result.tokens).toBe(5 * 900);
      expect(result.credits).toBeGreaterThan(0);
      expect(result.costUSD).toBeGreaterThan(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // calculateTestCost
  // ═══════════════════════════════════════════════════════════════════════════
  describe('calculateTestCost', () => {
    it('should return fixed credits for intelligent test', () => {
      const result = CreditCostTrackerService.calculateTestCost('intelligent');

      expect(result.credits).toBe(TEST_CREDITS.INTELLIGENT);
      expect(result.breakdown.testType).toBe('intelligent');
      expect(result.breakdown.fixedCredits).toBe(TEST_CREDITS.INTELLIGENT);
    });

    it('should map standard to intelligent (deprecated)', () => {
      const result = CreditCostTrackerService.calculateTestCost('standard');

      expect(result.breakdown.testType).toBe('intelligent');
      expect(result.credits).toBe(TEST_CREDITS.INTELLIGENT);
    });

    it('should return fixed credits for api test', () => {
      const result = CreditCostTrackerService.calculateTestCost('api');

      expect(result.credits).toBe(TEST_CREDITS.API);
      expect(result.breakdown.testType).toBe('api');
    });

    it('should fallback to intelligent for unknown test type', () => {
      // @ts-expect-error - Testing invalid test type
      const result = CreditCostTrackerService.calculateTestCost('unknown');

      expect(result.breakdown.testType).toBe('intelligent');
    });

    it('should include operations breakdown when provided', () => {
      const result = CreditCostTrackerService.calculateTestCost('intelligent', {
        aiCalls: [
          { inputTokens: 1000, outputTokens: 500, model: 'gpt-4o-mini' },
          { inputTokens: 500, outputTokens: 250, model: 'gpt-4o-mini' },
        ],
        screenshots: 3,
      });

      expect(result.breakdown.aiCalls).toBe(2);
      expect(result.breakdown.screenshots).toBe(3);
      expect(result.breakdown.calculatedCostUSD).toBeGreaterThan(0);
    });

    it('should handle empty operations', () => {
      const result = CreditCostTrackerService.calculateTestCost('intelligent', {
        aiCalls: [],
        screenshots: 0,
      });

      expect(result.credits).toBe(TEST_CREDITS.INTELLIGENT);
      expect(result.breakdown.calculatedCostUSD).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // estimateTestCost
  // ═══════════════════════════════════════════════════════════════════════════
  describe('estimateTestCost', () => {
    it('should return fixed credits for intelligent without estimatedPages', () => {
      const result = CreditCostTrackerService.estimateTestCost('intelligent');

      expect(result.credits).toBe(TEST_CREDITS.INTELLIGENT);
    });

    it('should map standard to intelligent', () => {
      const result = CreditCostTrackerService.estimateTestCost('standard');

      expect(result.credits).toBe(TEST_CREDITS.INTELLIGENT);
    });

    it('should return fixed credits for api test', () => {
      const result = CreditCostTrackerService.estimateTestCost('api');

      expect(result.credits).toBe(TEST_CREDITS.API);
    });

    it('should estimate higher credits for more pages', () => {
      const result10 = CreditCostTrackerService.estimateTestCost('intelligent', 10);
      const result20 = CreditCostTrackerService.estimateTestCost('intelligent', 20);

      expect(result20.credits).toBeGreaterThanOrEqual(result10.credits);
    });

    it('should fallback to intelligent for unknown test type', () => {
      // @ts-expect-error - Testing invalid test type
      const result = CreditCostTrackerService.estimateTestCost('unknown');

      expect(result.credits).toBe(TEST_CREDITS.INTELLIGENT);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // deductCreditsForTest
  // ═══════════════════════════════════════════════════════════════════════════
  describe('deductCreditsForTest', () => {
    it('should reject invalid userId', async () => {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: '',
        testType: 'intelligent',
        credits: 20,
        costUSD: 0.01,
        description: 'Test deduction',
      });

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });

    it('should reject invalid testType', async () => {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        // @ts-expect-error - Testing invalid test type
        testType: 'invalid',
        credits: 20,
        costUSD: 0.01,
        description: 'Test deduction',
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative credits', async () => {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        testType: 'intelligent',
        credits: -10,
        costUSD: 0.01,
        description: 'Test deduction',
      });

      expect(result.success).toBe(false);
    });

    it('should reject negative costUSD', async () => {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        testType: 'intelligent',
        credits: 20,
        costUSD: -0.01,
        description: 'Test deduction',
      });

      expect(result.success).toBe(false);
    });

    it('should reject empty description', async () => {
      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        testType: 'intelligent',
        credits: 20,
        costUSD: 0.01,
        description: '',
      });

      expect(result.success).toBe(false);
    });

    it('should call UserCreditsService.deductCredits on valid input', async () => {
      mockUserCreditsService.deductCredits.mockResolvedValue({
        success: true,
        newBalance: 80,
      });

      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        testType: 'intelligent',
        credits: 20,
        costUSD: 0.01,
        description: 'Intelligent test run',
        testId: 'test-456',
      });

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(80);
      expect(mockUserCreditsService.deductCredits).toHaveBeenCalledWith(
        'user-123',
        20,
        'Intelligent test run',
        expect.objectContaining({
          test_type: 'intelligent',
          cost_usd: 0.01,
          credits_calculated: 20,
          test_id: 'test-456',
        })
      );
    });

    it('should handle UserCreditsService failure', async () => {
      mockUserCreditsService.deductCredits.mockResolvedValue({
        success: false,
        newBalance: 100,
      });

      const result = await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        testType: 'intelligent',
        credits: 20,
        costUSD: 0.01,
        description: 'Test deduction',
      });

      expect(result.success).toBe(false);
    });

    it('should include token usage in metadata when provided', async () => {
      mockUserCreditsService.deductCredits.mockResolvedValue({
        success: true,
        newBalance: 80,
      });

      await CreditCostTrackerService.deductCreditsForTest({
        userId: 'user-123',
        testType: 'intelligent',
        credits: 20,
        costUSD: 0.01,
        description: 'Test with tokens',
        tokens: {
          inputTokens: 1000,
          outputTokens: 500,
          model: 'gpt-4o-mini',
        },
      });

      expect(mockUserCreditsService.deductCredits).toHaveBeenCalledWith(
        'user-123',
        20,
        'Test with tokens',
        expect.objectContaining({
          tokens_used: {
            input: 1000,
            output: 500,
            model: 'gpt-4o-mini',
          },
        })
      );
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // checkCreditsForTest
  // ═══════════════════════════════════════════════════════════════════════════
  describe('checkCreditsForTest', () => {
    it('should return hasEnough:false for invalid userId', async () => {
      const result = await CreditCostTrackerService.checkCreditsForTest('', 'intelligent');

      expect(result.hasEnough).toBe(false);
      expect(result.available).toBe(0);
    });

    it('should return correct values when user has enough credits', async () => {
      mockUserCreditsService.getUserCredits.mockResolvedValue({
        id: 'uc-1',
        user_id: 'user-123',
        credits_balance: 100,
        total_purchased: 100,
        total_used: 0,
        subscription_plan: 'pro',
        subscription_status: 'active',
        subscription_expires_at: null,
        grace_limit: 0,
        overage_balance: 0,
        grace_started_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await CreditCostTrackerService.checkCreditsForTest('user-123', 'intelligent');

      expect(result.hasEnough).toBe(true);
      expect(result.available).toBe(100);
      expect(result.required).toBe(TEST_CREDITS.INTELLIGENT);
      expect(result.shortage).toBe(0);
    });

    it('should return correct shortage when user lacks credits', async () => {
      mockUserCreditsService.getUserCredits.mockResolvedValue({
        id: 'uc-1',
        user_id: 'user-123',
        credits_balance: 0,
        total_purchased: 10,
        total_used: 10,
        subscription_plan: 'free',
        subscription_status: 'active',
        subscription_expires_at: null,
        grace_limit: 0,
        overage_balance: 0,
        grace_started_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await CreditCostTrackerService.checkCreditsForTest('user-123', 'intelligent');

      expect(result.hasEnough).toBe(false);
      expect(result.available).toBe(0);
      expect(result.shortage).toBe(TEST_CREDITS.INTELLIGENT);
    });

    it('should handle null user credits', async () => {
      mockUserCreditsService.getUserCredits.mockResolvedValue(null);

      const result = await CreditCostTrackerService.checkCreditsForTest('user-123', 'intelligent');

      expect(result.hasEnough).toBe(false);
      expect(result.available).toBe(0);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // getUserTestCapacity
  // ═══════════════════════════════════════════════════════════════════════════
  describe('getUserTestCapacity', () => {
    it('should return 0 capacity for invalid userId', async () => {
      const result = await CreditCostTrackerService.getUserTestCapacity('');

      expect(result.credits).toBe(0);
      expect(result.capacity.intelligent).toBe(0);
      expect(result.capacity.standard).toBe(0);
      expect(result.capacity.api).toBe(0);
    });

    it('should return correct capacity for user with credits', async () => {
      mockUserCreditsService.getUserCredits.mockResolvedValue({
        id: 'uc-1',
        user_id: 'user-123',
        credits_balance: 100,
        total_purchased: 100,
        total_used: 0,
        subscription_plan: 'pro',
        subscription_status: 'active',
        subscription_expires_at: null,
        grace_limit: 0,
        overage_balance: 0,
        grace_started_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const result = await CreditCostTrackerService.getUserTestCapacity('user-123');

      expect(result.credits).toBe(100);
      expect(result.capacity.intelligent).toBe(Math.floor(100 / TEST_CREDITS.INTELLIGENT));
      expect(result.capacity.standard).toBe(Math.floor(100 / TEST_CREDITS.STANDARD));
      expect(result.capacity.api).toBe(Math.floor(100 / TEST_CREDITS.API));
    });

    it('should handle null user credits', async () => {
      mockUserCreditsService.getUserCredits.mockResolvedValue(null);

      const result = await CreditCostTrackerService.getUserTestCapacity('user-123');

      expect(result.credits).toBe(0);
      expect(result.capacity.intelligent).toBe(0);
    });
  });
});
