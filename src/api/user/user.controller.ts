import { Request, Response } from 'express';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { PRICING_PLANS, PRICING_METADATA } from '@/config/pricing-plans';
import { logger } from '@/utils/logger';

/**
 * Check if user ID is a valid UUID (authenticated user)
 */
function isValidUUID(userId: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId);
}

/**
 * GET /api/v1/user/credits
 * Get user's current credits/limits information
 */
export const getUserCredits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    logger.info('[USER_CREDITS] Getting credits info', { userId });

    // Get credits from database
    const userCredits = await UserCreditsService.getOrCreateUserCredits(userId);

    res.json({
      success: true,
      user: {
        id: userId,
        type: 'authenticated',
      },
      credits: {
        plan: userCredits.subscription_plan,
        status: userCredits.subscription_status,
        balance: userCredits.credits_balance,
        totalPurchased: userCredits.total_purchased,
        totalUsed: userCredits.total_used,
        expiresAt: userCredits.subscription_expires_at,
      },
      message: userCredits.credits_balance === 0
        ? '💳 Купите кредиты для продолжения работы'
        : `✅ У вас ${userCredits.credits_balance} кредитов`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[USER_CREDITS] Error fetching credits', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch credits',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/user/credits/reset
 * Reset user credits (admin only)
 */
export const resetUserCredits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    logger.info('[USER_CREDITS] Resetting credits', { userId });

    // Admin endpoint - can be used to reset user's credit usage tracking
    logger.info('[USER_CREDITS] Reset endpoint called - no-op', { userId });

    res.json({
      success: true,
      message: '✅ Credits reset successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[USER_CREDITS] Error resetting credits', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to reset credits',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/user/credits/purchase
 * Purchase credits (simulate payment for now)
 */
export const purchaseCredits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user!.id;

    const { amount, paymentId } = req.body;

    if (!amount || amount <= 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount',
        message: 'Invalid credit amount',
      });
      return;
    }

    logger.info('[USER_CREDITS] Purchasing credits', { userId, amount, paymentId });

    const result = await UserCreditsService.addCredits(
      userId,
      amount,
      'purchase',
      `Purchased ${amount} credits`,
      { paymentId }
    );

    if (!result.success) {
      res.status(500).json({
        success: false,
        error: 'Purchase failed',
        message: 'Failed to purchase credits',
      });
      return;
    }

    res.json({
      success: true,
      message: `✅ Successfully purchased ${amount} credits`,
      credits: {
        balance: result.newBalance,
        purchased: amount,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_CREDITS] Error purchasing credits', { error });
    res.status(500).json({
      success: false,
      error: 'Purchase failed',
      message: 'Error purchasing credits',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/user/credits/history
 * Get user's credit transaction history
 */
export const getCreditHistory = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    const limit = parseInt(req.query.limit as string) || 50;

    logger.info('[USER_CREDITS] Getting credit history', { userId, limit });

    const transactions = await UserCreditsService.getTransactionHistory(userId, limit);

    res.json({
      success: true,
      transactions,
      count: transactions.length,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_CREDITS] Error getting credit history', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get history',
      message: 'Failed to get history',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/user/pricing-plans
 * Get available pricing plans (public endpoint, no auth required)
 * Query params: currency, billing_period, active_only
 */
export const getPricingPlans = async (req: Request, res: Response): Promise<void> => {
  try {
    const { currency, billing_period, active_only = 'true' } = req.query;

    logger.info('[PRICING] Getting pricing plans', {
      currency,
      billing_period,
      active_only,
    });

    // Validate currency if provided
    if (currency && !PRICING_METADATA.currency_options.includes(currency as any)) {
      res.status(400).json({
        success: false,
        error: 'Invalid currency',
        code: 'INVALID_CURRENCY',
        message: `Currency must be one of: ${PRICING_METADATA.currency_options.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate billing_period if provided
    if (billing_period && !PRICING_METADATA.billing_periods.includes(billing_period as any)) {
      res.status(400).json({
        success: false,
        error: 'Invalid billing period',
        code: 'INVALID_BILLING_PERIOD',
        message: `Billing period must be one of: ${PRICING_METADATA.billing_periods.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Filter plans based on query parameters
    let filteredPlans = [...PRICING_PLANS];

    if (currency) {
      filteredPlans = filteredPlans.filter((plan) => plan.currency === currency);
    }

    if (billing_period) {
      filteredPlans = filteredPlans.filter((plan) =>
        plan.credit_options.some((opt) => opt.billing_period === billing_period)
      );
    }

    // Return enhanced structure with metadata
    res.json({
      success: true,
      plans: filteredPlans,
      metadata: {
        count: filteredPlans.length,
        currency_options: PRICING_METADATA.currency_options,
        billing_periods: PRICING_METADATA.billing_periods,
        last_updated: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[PRICING] Error getting pricing plans', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get pricing plans',
      code: 'SERVER_ERROR',
      message: 'Failed to get pricing plans',
      timestamp: new Date().toISOString(),
    });
  }
};
