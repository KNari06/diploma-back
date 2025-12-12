import { dbService } from '@/db/supabase';
import { BrowserType, NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/logger';

/**
 * Calculate required credits for browsers
 * Formula:
 * - Standard test: 1 credit per browser (2 for mobile browsers)
 * - Intelligent test: base + AI cost (parsed from estimatedCost or 2x base)
 */
export function calculateRequiredCredits(
  browsers: BrowserType[],
  intelligentMode?: boolean,
  estimatedCost?: string
): number {
  const creditCosts: Record<BrowserType, number> = {
    'chrome': 1,
    'firefox': 1,
    'safari': 1,
    'edge': 1,
    'mobile-chrome': 2,
    'mobile-safari': 2,
  };

  // 1. Calculate base browser cost
  const baseBrowserCost = browsers.reduce(
    (total, browser) => total + (creditCosts[browser] || 1),
    0
  );

  // 2. If NOT intelligent mode - return base cost
  if (!intelligentMode) {
    return baseBrowserCost;
  }

  // 3. For intelligent mode - parse estimatedCost or use 2x multiplier
  if (estimatedCost) {
    // Parse "$0.10-0.20" or "$0.15" format
    const match = estimatedCost.match(/\$([0-9.]+)(?:-\$?([0-9.]+))?/);
    if (match) {
      // Take upper bound if range, otherwise single value
      const maxCost = match[2] ? parseFloat(match[2]) : parseFloat(match[1]);

      // Convert $ to credits (1 credit = $0.01)
      const aiCredits = Math.ceil(maxCost * 100);

      logger.debug('[CREDIT_CALC] Intelligent mode cost calculated', {
        estimatedCost,
        parsedMaxCost: maxCost,
        aiCredits,
        baseBrowserCost,
        total: baseBrowserCost + aiCredits,
      });

      return baseBrowserCost + aiCredits;
    }
  }

  // 4. Fallback: If no estimatedCost - use 2x multiplier
  logger.debug('[CREDIT_CALC] Using fallback 2x multiplier for intelligent mode', {
    baseBrowserCost,
    total: baseBrowserCost * 2,
  });

  return baseBrowserCost * 2;
}

/**
 * Check user credits
 */
export async function checkUserCredits(
  userId: string,
  browsers: BrowserType[],
  intelligentMode?: boolean,
  estimatedCost?: string
): Promise<void> {
  const user = await dbService.getUser(userId) as any;
  if (!user) {
    throw new NotFoundError('User', userId);
  }

  // Get credits from user_credits table
  const { UserCreditsService } = await import('@/services/core/user-credits.service');
  const userCredits = await UserCreditsService.getOrCreateUserCredits(userId);
  const availableCredits = Number.isFinite(userCredits.credits_balance)
    ? (userCredits.credits_balance || 0)
    : 0;

  // Calculate required credits
  const requiredCredits = calculateRequiredCredits(browsers, intelligentMode, estimatedCost);

  logger.info('[CREDIT_CHECK] Credits calculation', {
    userId: userId.substring(0, 8) + '...',
    intelligentMode,
    estimatedCost,
    requiredCredits,
    availableCredits,
  });

  if (availableCredits < requiredCredits) {
    throw new ValidationError(`Insufficient credits. Required: ${requiredCredits}, Available: ${availableCredits}`);
  }
}

/**
 * Deduct user credits
 */
export async function deductCredits(
  userId: string,
  testId: string,
  browsers: BrowserType[],
  intelligentMode?: boolean,
  estimatedCost?: string
): Promise<void> {
  const requiredCredits = calculateRequiredCredits(browsers, intelligentMode, estimatedCost);

  logger.info('[CREDIT_DEDUCT] Deducting credits', {
    userId: userId.substring(0, 8) + '...',
    testId: testId.substring(0, 8) + '...',
    requiredCredits,
    intelligentMode,
  });

  // Deduct credits using Supabase function
  const { data, error } = await dbService.supabaseAdmin
    .rpc('deduct_test_credits', {
      user_uuid: userId,
      test_uuid: testId, // Real test ID (not 'temp')
      credit_amount: requiredCredits,
    });

  if (error) throw error;

  if (!data) {
    throw new ValidationError('Failed to deduct credits');
  }
}
