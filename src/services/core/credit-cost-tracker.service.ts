import { TokenCalculatorService, MODEL_PRICING } from './token-calculator.service';
import { UserCreditsService } from './user-credits.service';
import { logger } from '@/utils/logger';

/**
 * Credit Cost Tracker Service
 * Tracks token usage and deducts credits accurately
 *
 * IMPORTANT:
 * - Only deduct credits for TESTS (intelligent, standard, api)
 * - NEVER deduct credits for chat messages
 */

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: 'gpt-4o' | 'gpt-4o-mini';
}

export interface CreditDeduction {
  userId: string;
  testType: 'intelligent' | 'standard' | 'api';
  tokens?: TokenUsage;
  credits: number;
  costUSD: number;
  testId?: string;
  description: string;
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
    model: 'gpt-4o' | 'gpt-4o-mini',
    inputTokens: number,
    outputTokens: number
  ): {
    tokens: number;
    credits: number;
    costUSD: number;
  } {
    const totalTokens = inputTokens + outputTokens;
    const credits = TokenCalculatorService.tokensToCredits(totalTokens);
    const costUSD = TokenCalculatorService.calculateCostFromTokens(inputTokens, outputTokens, model);

    TokenCalculatorService.logTokenUsage(
      'AI Call',
      { input: inputTokens, output: outputTokens, model },
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
   * @param count - Number of screenshots
   * @returns Credit cost
   */
  static trackScreenshot(count: number): {
    tokens: number;
    credits: number;
    costUSD: number;
  } {
    // Average screenshot: 700 input + 200 output tokens
    const tokensPerScreenshot = 900;
    const totalTokens = tokensPerScreenshot * count;

    const credits = TokenCalculatorService.tokensToCredits(totalTokens);

    // Cost: 700 input + 200 output
    const costPerScreenshot = TokenCalculatorService.calculateCostFromTokens(700, 200, 'gpt-4o');
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
    breakdown: any;
  } {
    // Use fixed costs for predictability
    const fixedCredits = TokenCalculatorService.getTestCreditCost(testType);

    let calculatedCost = 0;
    let breakdown: any = {
      testType,
      fixedCredits,
    };

    // Calculate actual cost if operations provided
    if (operations) {
      let totalCost = 0;

      if (operations.aiCalls) {
        for (const call of operations.aiCalls) {
          const cost = TokenCalculatorService.calculateCostFromTokens(
            call.inputTokens,
            call.outputTokens,
            call.model
          );
          totalCost += cost;
        }
        breakdown.aiCalls = operations.aiCalls.length;
      }

      if (operations.screenshots) {
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
        });
      }

      return result;
    } catch (error) {
      logger.error('[CREDIT_COST_TRACKER] Exception in deductCreditsForTest', {
        error,
        userId: deduction.userId,
      });

      return {
        success: false,
        newBalance: 0,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
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
    testType: 'intelligent' | 'standard' | 'api' | 'chat'
  ): Promise<CreditCheck> {
    try {
      // Chat is always free
      if (testType === 'chat') {
        return {
          hasEnough: true,
          required: 0,
          available: Infinity,
          shortage: 0,
        };
      }

      const requiredCredits = TokenCalculatorService.getTestCreditCost(testType);
      const userCredits = await UserCreditsService.getUserCredits(userId);

      const availableCredits = userCredits?.credits_balance || 0;
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
        error,
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
      const userCredits = await UserCreditsService.getUserCredits(userId);
      const credits = userCredits?.credits_balance || 0;

      const capacity = TokenCalculatorService.calculateTestCapacity(credits);

      return {
        credits,
        capacity,
      };
    } catch (error) {
      logger.error('[CREDIT_COST_TRACKER] Exception in getUserTestCapacity', {
        error,
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
   * @param estimatedPages - For intelligent tests
   * @returns Estimated credits
   */
  static estimateTestCost(
    testType: 'intelligent' | 'standard' | 'api',
    estimatedPages?: number
  ): {
    credits: number;
    description: string;
  } {
    if (testType === 'intelligent' && estimatedPages) {
      const estimated = TokenCalculatorService.estimateIntelligentTestCredits(estimatedPages);
      return {
        credits: estimated,
        description: `~${estimatedPages} pages`,
      };
    }

    const credits = TokenCalculatorService.getTestCreditCost(testType);
    return {
      credits,
      description: testType === 'standard' ? 'No AI usage' : 'Lightweight AI',
    };
  }
}
