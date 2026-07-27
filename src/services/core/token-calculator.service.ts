import { logger } from '@/utils/core/logger';

/**
 * Token Calculator Service
 * Converts between tokens and credits for accurate billing
 *
 * PRICING MODEL — this file is NOT a source of truth for prices or grants.
 * Pro is sold as three Stripe-backed tiers ($19/990, $49/7 000, $99/18 000), so
 * no single price/credits pair can describe it. The authoritative sources are:
 *   - Stripe                        → what the customer is charged
 *   - `plans.credits_per_period`    → credits actually granted (by stripe_price_id)
 *   - `pro_plan_options`            → the tier menu shown on the pricing page
 * Only `INDIVIDUAL_PLANS.free` lives here, because the free grant is a product
 * constant with no Stripe price behind it. Team/Enterprise = the B2B tiers in
 * WORKSPACE_PLANS below (granted by admin or Stripe; credits belong to the
 * USER's user_credits, not a workspace). The individual "ultra"/"Team" plan is
 * retired. 1 credit = 562.5 tokens.
 */

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * How many tokens equals 1 credit.
 * Originally derived from a retired $28.9/1000-credit Pro plan:
 * $4.50 AI budget ÷ $0.008 per 1K tokens = 562,500 tokens ÷ 1000 = 562.5.
 * The ratio is now a fixed product constant — it defines how much work a credit
 * buys, independent of what any tier charges for one.
 */
export const TOKENS_PER_CREDIT = 562.5;

/**
 * OpenAI API pricing (November 2024)
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': {
    input: 0.002, // $ per 1K tokens
    output: 0.008, // $ per 1K tokens
  },
  'gpt-4.1-mini': {
    input: 0.0002, // $ per 1K tokens
    output: 0.0008, // $ per 1K tokens
  },
  'gemini-2.5-flash': {
    input: 0.0003, // $ per 1K tokens
    output: 0.0025, // $ per 1K tokens
  },
  'gemini-2.5-flash-lite': {
    input: 0.0001, // $ per 1K tokens
    output: 0.0004, // $ per 1K tokens
  },
  'gemini-2.5-pro': {
    input: 0.00125, // $ per 1K tokens (<=200K context tier; see AI_PRICING in ai-cost-manager.service.ts)
    output: 0.01, // $ per 1K tokens (<=200K context tier; see AI_PRICING in ai-cost-manager.service.ts)
  },
};

/**
 * Fixed credit costs for different test types
 * Based on average token consumption
 */
export const TEST_CREDITS = {
  INTELLIGENT: 1, // Per-step billing: 1 credit deducted per step/action during execution
  STANDARD: 1, // No AI, just infrastructure
  API: 2, // ~1K tokens (lightweight AI analysis)
  CHAT: 1, // 1 credit per chat message
} as const;

/**
 * Mobile step cost multiplier. A mobile run (emulator/redroid on an ARM T2A
 * instance, or a real device) costs ~3–4× a web step by COGS — the emulator is
 * held for the whole run and mobile concurrency defaults to 1 (serial), so the
 * per-step infra cost is far higher than a Playwright web step. Conservative 4×
 * keeps ≥80% margin even in the worst case. Applied per mobile step in
 * mobile-test-run.job.ts; web/lite steps stay at TEST_CREDITS.INTELLIGENT.
 */
export const MOBILE_STEP_CREDIT_MULTIPLIER = 4;

/**
 * Individual subscription plans (user_credits). Self-serve individual tiers only
 * — Free + Pro. The former 'ultra' ("Team") individual plan was retired (0 users,
 * = Pro credits, not self-serve purchasable); the real Team/Enterprise offering
 * is the B2B WORKSPACE_PLANS below.
 */
export const INDIVIDUAL_PLANS = {
  free: { price: 0, credits: 50 },
} as const;

/**
 * B2B workspace plans (workspace_credits)
 * Pilot: onboarding/trial, given on workspace creation
 * Small/Middle/Enterprise: activated after Stripe payment
 */
export const WORKSPACE_PLANS = {
  pilot: { price: 150, credits: 10_000, graceLimit: 1_000 },
  small_business: { price: 1_000, credits: 29_000, graceLimit: 3_000 },
  middle_business: { price: 1_590, credits: 79_000, graceLimit: 8_000 },
  enterprise: { price: 2_990, credits: 200_000, graceLimit: 20_000 },
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
    // Validate input
    if (!Number.isFinite(tokens) || tokens <= 0) {
      return 0;
    }

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
    // Validate input
    if (!Number.isFinite(credits) || credits < 0) {
      return 0;
    }

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
    model: string
  ): number {
    // Validate inputs
    if (!Number.isFinite(inputTokens) || inputTokens < 0) {
      inputTokens = 0;
    }
    if (!Number.isFinite(outputTokens) || outputTokens < 0) {
      outputTokens = 0;
    }

    if (!MODEL_PRICING[model]) {
      logger.warn('[TOKEN_CALCULATOR] Unknown model, using gpt-4.1-mini', { model });
      model = 'gpt-4.1-mini';
    }

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
    // Validate input
    if (!Number.isFinite(costUSD) || costUSD <= 0) {
      return 0;
    }

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
   * @param estimatedPages - Estimated pages to visit (default: 5, min: 1)
   * @returns Estimated credits
   */
  static estimateIntelligentTestCredits(estimatedPages: number = 5): number {
    // Validate and clamp estimatedPages
    if (!Number.isFinite(estimatedPages) || estimatedPages < 1) {
      estimatedPages = 5; // Default to 5 pages
    }
    estimatedPages = Math.max(1, Math.floor(estimatedPages)); // Ensure integer >= 1

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
    // Validate input
    if (!Number.isFinite(credits)) {
      return '0';
    }

    return credits.toLocaleString('en-US');
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
    // Validate input
    if (!Number.isFinite(credits) || credits < 0) {
      credits = 0;
    }

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
    // Validate input
    if (!Number.isFinite(availableCredits) || availableCredits < 0) {
      availableCredits = 0;
    }

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
