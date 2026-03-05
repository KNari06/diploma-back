import { logger } from '@/utils/core/logger';
import { TokenCalculatorService } from './token-calculator.service';
import { UserCreditsService } from './user-credits.service';

/**
 * Credit Cost Tracker Service
 * Tracks token usage and deducts credits accurately
 *
 * IMPORTANT:
 * - Only deduct credits for TESTS (intelligent, api)
 * - Standard mode removed - all UI tests use intelligent mode
 * - NEVER deduct credits for chat messages
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface CreditDeduction {
  userId: string;
  testType: 'intelligent' | 'standard' | 'api' | 'chat';
  tokens?: TokenUsage;
  credits: number;
  costUSD: number;
  testId?: string;
  description: string;
}

export interface TestCostBreakdown {
  testType: 'intelligent' | 'standard' | 'api';
  fixedCredits: number;
  calculatedCostUSD?: number;
  aiCalls?: number;
  screenshots?: number;
}

export interface CreditCheck {
  hasEnough: boolean;
  required: number;
  available: number;
  shortage: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// CREDIT COST TRACKER SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class CreditCostTrackerService {
  /**
   * Track AI call and calculate credits
   * Does NOT deduct credits - only calculates
   *
   * @param model - AI model used
   * @param inputTokens - Input tokens consumed
   * @param outputTokens - Output tokens consumed
   * @returns Credits to charge
   */
  static trackAICall(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): {
    tokens: number;
    credits: number;
    costUSD: number;
  } {
    // Validate inputs
    const validInputTokens = Number.isFinite(inputTokens) && inputTokens >= 0 ? inputTokens : 0;
    const validOutputTokens = Number.isFinite(outputTokens) && outputTokens >= 0 ? outputTokens : 0;

    const totalTokens = validInputTokens + validOutputTokens;
    const credits = TokenCalculatorService.tokensToCredits(totalTokens);
    const costUSD = TokenCalculatorService.calculateCostFromTokens(
      validInputTokens,
      validOutputTokens,
      model
    );

    TokenCalculatorService.logTokenUsage(
      'AI Call',
      { input: validInputTokens, output: validOutputTokens, model },
      credits
    );

    return {
      tokens: totalTokens,
      credits,
      costUSD,
    };
  }

  /**
   * Track screenshot analysis (GPT-4o Vision)
   * @param count - Number of screenshots (must be >= 0)
   * @returns Credit cost
   */
  static trackScreenshot(count: number): {
    tokens: number;
    credits: number;
    costUSD: number;
  } {
    // Validate input
    if (!Number.isFinite(count) || count < 0) {
      count = 0;
    }
    count = Math.floor(count); // Ensure integer

    // Average screenshot: 700 input + 200 output tokens
    const tokensPerScreenshot = 900;
    const totalTokens = tokensPerScreenshot * count;

    const credits = TokenCalculatorService.tokensToCredits(totalTokens);

    // Cost: 700 input + 200 output
    const costPerScreenshot = TokenCalculatorService.calculateCostFromTokens(700, 200, 'gpt-4.1');
    const costUSD = costPerScreenshot * count;

    logger.info('[CREDIT_COST_TRACKER] Screenshot analysis', {
      count,
      tokensPerScreenshot,
      totalTokens,
      credits,
      costUSD: `$${costUSD.toFixed(4)}`,
    });

    return {
      tokens: totalTokens,
      credits,
      costUSD,
    };
  }

  /**
   * Calculate test cost (does NOT deduct)
   * @param testType - Type of test
   * @param operations - Optional: detailed token usage
   * @returns Credit cost
   */
  static calculateTestCost(
    testType: 'intelligent' | 'standard' | 'api',
    operations?: {
      aiCalls?: TokenUsage[];
      screenshots?: number;
    }
  ): {
    credits: number;
    costUSD: number;
    breakdown: TestCostBreakdown;
  } {
    // Validate testType
    // ✅ UPDATED: Standard mode removed - map to intelligent for backward compatibility
    if (testType === 'standard') {
      logger.debug('[CREDIT_COST_TRACKER] Standard mode deprecated, mapping to intelligent', { testType });
      testType = 'intelligent';
    }

    const validTestTypes = ['intelligent', 'api'];
    if (!validTestTypes.includes(testType)) {
      logger.warn('[CREDIT_COST_TRACKER] Invalid test type, using intelligent', { testType });
      testType = 'intelligent';
    }

    // Use fixed costs for predictability
    const fixedCredits = TokenCalculatorService.getTestCreditCost(testType);

    let calculatedCost = 0;
    const breakdown: TestCostBreakdown = {
      testType,
      fixedCredits,
    };

    // Calculate actual cost if operations provided
    if (operations) {
      let totalCost = 0;

      if (operations.aiCalls && Array.isArray(operations.aiCalls)) {
        for (const call of operations.aiCalls) {
          if (call && Number.isFinite(call.inputTokens) && Number.isFinite(call.outputTokens)) {
            const cost = TokenCalculatorService.calculateCostFromTokens(
              call.inputTokens,
              call.outputTokens,
              call.model || 'gemini-2.5-flash-lite'
            );
            totalCost += cost;
          }
        }
        breakdown.aiCalls = operations.aiCalls.length;
      }

      if (Number.isFinite(operations.screenshots) && operations.screenshots !== undefined) {
        const screenshotCost = this.trackScreenshot(operations.screenshots);
        totalCost += screenshotCost.costUSD;
        breakdown.screenshots = operations.screenshots;
      }

      calculatedCost = totalCost;
      breakdown.calculatedCostUSD = calculatedCost;
    }

    return {
      credits: fixedCredits,
      costUSD: calculatedCost,
      breakdown,
    };
  }

  /**
   * Deduct credits for a test
   * ONLY for tests - NOT for chat!
   *
   * @param deduction - Credit deduction details
   * @returns Success status and new balance
   */
  static async deductCreditsForTest(
    deduction: CreditDeduction
  ): Promise<{
    success: boolean;
    newBalance: number;
    error?: string;
  }> {
    try {
      // Validate inputs
      if (!deduction.userId || typeof deduction.userId !== 'string') {
        throw new Error('Invalid userId');
      }

      if (!deduction.testType || !['intelligent', 'standard', 'api', 'chat'].includes(deduction.testType)) {
        throw new Error('Invalid testType');
      }

      if (!Number.isFinite(deduction.credits) || deduction.credits < 0) {
        throw new Error('Invalid credits amount');
      }

      if (!Number.isFinite(deduction.costUSD) || deduction.costUSD < 0) {
        throw new Error('Invalid costUSD');
      }

      if (!deduction.description || typeof deduction.description !== 'string') {
        throw new Error('Description is required');
      }

      logger.info('[CREDIT_COST_TRACKER] Deducting credits for test', {
        userId: deduction.userId,
        testType: deduction.testType,
        credits: deduction.credits,
        testId: deduction.testId,
      });

      // Build metadata
      const metadata: Record<string, any> = {
        test_type: deduction.testType,
        cost_usd: deduction.costUSD,
        credits_calculated: deduction.credits,
      };

      if (deduction.tokens) {
        metadata.tokens_used = {
          input: deduction.tokens.inputTokens,
          output: deduction.tokens.outputTokens,
          model: deduction.tokens.model,
        };
      }

      if (deduction.testId) {
        metadata.test_id = deduction.testId;
      }

      // Deduct credits using UserCreditsService
      const result = await UserCreditsService.deductCredits(
        deduction.userId,
        deduction.credits,
        deduction.description,
        metadata
      );

      if (result.success) {
        logger.info('[CREDIT_COST_TRACKER] Credits deducted successfully', {
          userId: deduction.userId,
          credits: deduction.credits,
          newBalance: result.newBalance,
        });
      } else {
        logger.warn('[CREDIT_COST_TRACKER] Failed to deduct credits', {
          userId: deduction.userId,
          credits: deduction.credits,
          error: 'Insufficient credits or database error',
        });
      }

      return result;
    } catch (error) {
      logger.error('[CREDIT_COST_TRACKER] Exception in deductCreditsForTest', {
        error: error instanceof Error ? error.message : String(error),
        userId: deduction?.userId,
        testType: deduction?.testType,
      });

      return {
        success: false,
        newBalance: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Deduct exactly 1 credit for a single step/action execution.
   * Non-fatal: returns { success, newBalance } — callers decide whether to stop on failure.
   */
  static async deductStepCredit(
    userId: string,
    testId: string,
    description: string
  ): Promise<{ success: boolean; newBalance: number }> {
    try {
      const result = await this.deductCreditsForTest({
        userId,
        testType: 'intelligent',
        credits: 1,
        costUSD: 0,
        testId,
        description,
      });
      return { success: result.success, newBalance: result.newBalance };
    } catch (error) {
      logger.warn('[CREDIT_COST_TRACKER] deductStepCredit failed', {
        userId,
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, newBalance: 0 };
    }
  }

  /**
   * Check if user has enough credits for a test
   * @param userId - User ID
   * @param testType - Type of test
   * @returns Credit check result
   */
  static async checkCreditsForTest(
    userId: string,
    testType: 'intelligent' | 'api' | 'chat'
  ): Promise<CreditCheck> {
    try {
      // Validate inputs
      if (!userId || typeof userId !== 'string') {
        logger.warn('[CREDIT_COST_TRACKER] Invalid userId in checkCreditsForTest', { userId });
        return {
          hasEnough: false,
          required: 0,
          available: 0,
          shortage: 0,
        };
      }

      const requiredCredits = TokenCalculatorService.getTestCreditCost(testType);
      const userCredits = await UserCreditsService.getUserCredits(userId);

      const availableCredits = Number.isFinite(userCredits?.credits_balance)
        ? (userCredits?.credits_balance || 0)
        : 0;

      const hasEnough = availableCredits >= requiredCredits;
      const shortage = hasEnough ? 0 : requiredCredits - availableCredits;

      logger.info('[CREDIT_COST_TRACKER] Credit check', {
        userId,
        testType,
        required: requiredCredits,
        available: availableCredits,
        hasEnough,
      });

      return {
        hasEnough,
        required: requiredCredits,
        available: availableCredits,
        shortage,
      };
    } catch (error) {
      logger.error('[CREDIT_COST_TRACKER] Exception in checkCreditsForTest', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        testType,
      });

      return {
        hasEnough: false,
        required: TokenCalculatorService.getTestCreditCost(testType),
        available: 0,
        shortage: TokenCalculatorService.getTestCreditCost(testType),
      };
    }
  }

  /**
   * Get user's test capacity (how many tests they can run)
   * @param userId - User ID
   * @returns Test capacity breakdown
   */
  static async getUserTestCapacity(userId: string): Promise<{
    credits: number;
    capacity: {
      intelligent: number;
      standard: number;
      api: number;
    };
  }> {
    try {
      // Validate input
      if (!userId || typeof userId !== 'string') {
        logger.warn('[CREDIT_COST_TRACKER] Invalid userId in getUserTestCapacity', { userId });
        return {
          credits: 0,
          capacity: {
            intelligent: 0,
            standard: 0,
            api: 0,
          },
        };
      }

      const userCredits = await UserCreditsService.getUserCredits(userId);
      const credits = Number.isFinite(userCredits?.credits_balance)
        ? (userCredits?.credits_balance || 0)
        : 0;

      const capacity = TokenCalculatorService.calculateTestCapacity(credits);

      return {
        credits,
        capacity,
      };
    } catch (error) {
      logger.error('[CREDIT_COST_TRACKER] Exception in getUserTestCapacity', {
        error: error instanceof Error ? error.message : String(error),
        userId,
      });

      return {
        credits: 0,
        capacity: {
          intelligent: 0,
          standard: 0,
          api: 0,
        },
      };
    }
  }

  /**
   * Estimate cost before running a test
   * @param testType - Type of test
   * @param estimatedPages - For intelligent tests (optional)
   * @returns Estimated credits
   */
  static estimateTestCost(
    testType: 'intelligent' | 'standard' | 'api',
    estimatedPages?: number
  ): {
    credits: number;
    description: string;
  } {
    // Validate testType
    // ✅ UPDATED: Standard mode removed - map to intelligent for backward compatibility
    if (testType === 'standard') {
      logger.debug('[CREDIT_COST_TRACKER] Standard mode deprecated, mapping to intelligent', { testType });
      testType = 'intelligent';
    }

    const validTestTypes = ['intelligent', 'api'];
    if (!validTestTypes.includes(testType)) {
      logger.warn('[CREDIT_COST_TRACKER] Invalid test type in estimateTestCost, using intelligent', { testType });
      testType = 'intelligent';
    }

    if (testType === 'intelligent' && Number.isFinite(estimatedPages) && estimatedPages !== undefined) {
      const validatedPages = Math.max(1, Math.floor(estimatedPages));
      const estimated = TokenCalculatorService.estimateIntelligentTestCredits(validatedPages);
      return {
        credits: estimated,
        description: `~${validatedPages} pages`,
      };
    }

    const credits = TokenCalculatorService.getTestCreditCost(testType);
    return {
      credits,
      description: 'Lightweight AI', // All UI tests use intelligent mode
    };
  }
}
