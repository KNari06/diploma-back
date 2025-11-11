import { logger } from '@/utils/logger';

/**
 * Token Calculator Service
 * Converts between tokens and credits for accurate billing
 *
 * PRICING MODEL (as of 2024):
 * - Plan: $39/month = 1000 credits
 * - 1 credit = 562.5 tokens
 * - Margin: 50%
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How many tokens equals 1 credit
 * Calculated: $39/month = 1000 credits
 * AI budget: $4.50 / $0.008 per 1K tokens = 562,500 tokens
 * 562,500 tokens ÷ 1000 credits = 562.5 tokens per credit
 */
export const TOKENS_PER_CREDIT = 562.5;

/**
 * OpenAI API pricing (November 2024)
 */
export const MODEL_PRICING = {
  'gpt-4o': {
    input: 0.005, // $ per 1K tokens
    output: 0.015, // $ per 1K tokens
  },
  'gpt-4o-mini': {
    input: 0.00015, // $ per 1K tokens
    output: 0.0006, // $ per 1K tokens
  },
} as const;

/**
 * Fixed credit costs for different test types
 * Based on average token consumption
 */
export const TEST_CREDITS = {
  INTELLIGENT: 20, // ~10K tokens (multiple pages + vision analysis)
  STANDARD: 1, // No AI, just infrastructure
  API: 2, // ~1K tokens (lightweight AI analysis)
  CHAT: 0, // Free for users
} as const;

/**
 * Subscription plans
 */
export const SUBSCRIPTION_PLANS = {
  starter: { price: 39, credits: 1000 },
  pro: { price: 69, credits: 2000 },
  business: { price: 149, credits: 5000 },
  enterprise: { price: 249, credits: 10000 },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// TOKEN CALCULATOR SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class TokenCalculatorService {
  /**
   * Convert tokens to credits
   * @param tokens - Number of tokens consumed
   * @returns Credits to charge (rounded up)
   */
  static tokensToCredits(tokens: number): number {
    if (tokens <= 0) return 0;

    const credits = tokens / TOKENS_PER_CREDIT;

    // Round up to nearest integer
    return Math.ceil(credits);
  }

  /**
   * Convert credits to tokens
   * @param credits - Number of credits
   * @returns Equivalent tokens
   */
  static creditsToTokens(credits: number): number {
    return credits * TOKENS_PER_CREDIT;
  }

  /**
   * Calculate cost in USD from tokens
   * @param inputTokens - Input tokens used
   * @param outputTokens - Output tokens used
   * @param model - AI model used
   * @returns Cost in USD
   */
  static calculateCostFromTokens(
    inputTokens: number,
    outputTokens: number,
    model: 'gpt-4o' | 'gpt-4o-mini'
  ): number {
    const pricing = MODEL_PRICING[model];

    const inputCost = (inputTokens / 1000) * pricing.input;
    const outputCost = (outputTokens / 1000) * pricing.output;

    return inputCost + outputCost;
  }

  /**
   * Calculate credits from cost (USD)
   * @param costUSD - Cost in US dollars
   * @returns Credits to charge
   */
  static calculateCreditsFromCost(costUSD: number): number {
    // Convert cost to tokens first (using average $0.008 per 1K tokens)
    const averageCostPerToken = 0.008 / 1000;
    const equivalentTokens = costUSD / averageCostPerToken;

    // Convert tokens to credits
    return this.tokensToCredits(equivalentTokens);
  }

  /**
   * Get fixed credit cost for a test type
   * @param testType - Type of test
   * @returns Fixed credit cost
   */
  static getTestCreditCost(testType: 'intelligent' | 'standard' | 'api' | 'chat'): number {
    switch (testType) {
      case 'intelligent':
        return TEST_CREDITS.INTELLIGENT;
      case 'standard':
        return TEST_CREDITS.STANDARD;
      case 'api':
        return TEST_CREDITS.API;
      case 'chat':
        return TEST_CREDITS.CHAT;
      default:
        logger.warn('[TOKEN_CALCULATOR] Unknown test type', { testType });
        return 0;
    }
  }

  /**
   * Estimate credits for an intelligent test
   * @param estimatedPages - Estimated pages to visit
   * @returns Estimated credits
   */
  static estimateIntelligentTestCredits(estimatedPages: number = 5): number {
    // Average: 1,400 tokens per page (700 screenshot + 300 DOM + 200 prompt + 200 response)
    const tokensPerPage = 1400;
    const totalTokens = estimatedPages * tokensPerPage;

    // Add report generation tokens (800 input + 600 output)
    const reportTokens = 1400;

    const credits = this.tokensToCredits(totalTokens + reportTokens);

    // Use fixed cost (20 credits) or calculated, whichever is higher
    return Math.max(credits, TEST_CREDITS.INTELLIGENT);
  }

  /**
   * Format credits for display (with commas)
   * @param credits - Number of credits
   * @returns Formatted string
   */
  static formatCredits(credits: number): string {
    return credits.toLocaleString('en-US');
  }

  /**
   * Get subscription plan by price
   * @param price - Monthly price
   * @returns Plan details or null
   */
  static getPlanByPrice(price: number): { price: number; credits: number } | null {
    const plan = Object.values(SUBSCRIPTION_PLANS).find((p) => p.price === price);
    return plan || null;
  }

  /**
   * Get subscription plan by credits
   * @param credits - Monthly credits
   * @returns Plan details or null
   */
  static getPlanByCredits(credits: number): { price: number; credits: number } | null {
    const plan = Object.values(SUBSCRIPTION_PLANS).find((p) => p.credits === credits);
    return plan || null;
  }

  /**
   * Calculate what user can do with credits
   * @param credits - Available credits
   * @returns Breakdown of possible tests
   */
  static calculateTestCapacity(credits: number): {
    intelligent: number;
    standard: number;
    api: number;
  } {
    return {
      intelligent: Math.floor(credits / TEST_CREDITS.INTELLIGENT),
      standard: Math.floor(credits / TEST_CREDITS.STANDARD),
      api: Math.floor(credits / TEST_CREDITS.API),
    };
  }

  /**
   * Validate if user has enough credits
   * @param availableCredits - User's available credits
   * @param testType - Type of test
   * @returns True if user has enough credits
   */
  static hasEnoughCredits(
    availableCredits: number,
    testType: 'intelligent' | 'standard' | 'api' | 'chat'
  ): boolean {
    const requiredCredits = this.getTestCreditCost(testType);
    return availableCredits >= requiredCredits;
  }

  /**
   * Log token usage for debugging
   * @param context - Context of the usage
   * @param tokens - Token details
   * @param credits - Calculated credits
   */
  static logTokenUsage(
    context: string,
    tokens: { input: number; output: number; model: string },
    credits: number
  ): void {
    logger.info('[TOKEN_CALCULATOR] Token usage', {
      context,
      tokens,
      credits,
      tokensPerCredit: TOKENS_PER_CREDIT,
    });
  }
}
