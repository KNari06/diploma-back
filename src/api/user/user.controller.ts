import { Request, Response } from 'express';
import { AnonymousLimiterService } from '@/services/auth/anonymous-limiter.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { PRICING_PLANS, PRICING_METADATA } from '@/config/pricing-plans';
import { logger } from '@/utils/logger';
import { getClientIp, normalizeIpForAnonymousId } from '@/utils/ip-helper';

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
    // Get userId from auth or query params
    const userId = req.user?.id || req.query.userId || req.body?.userId;

    // If no userId, use IP address as anonymous ID
    const clientIp = getClientIp(req);
    const anonymousId = userId ? undefined : normalizeIpForAnonymousId(clientIp);
    const effectiveUserId = userId || anonymousId || 'unknown';

    logger.info('[USER_CREDITS] Getting credits info', {
      userId: effectiveUserId,
      isAuthenticated: !!req.user?.id
    });

    // Check if user is authenticated
    if (req.user?.id && isValidUUID(req.user.id)) {
      // Authenticated user - get credits from database
      const userCredits = await UserCreditsService.getOrCreateUserCredits(req.user.id);

      res.json({
        success: true,
        user: {
          id: req.user.id,
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
      return;
    }

    // Anonymous user - get rate limit info
    const limitInfo = await AnonymousLimiterService.getLimitInfo(effectiveUserId);

    res.json({
      success: true,
      user: {
        id: effectiveUserId,
        type: 'anonymous',
      },
      credits: {
        plan: 'free',
        limit: limitInfo.limit,
        used: limitInfo.current,
        remaining: limitInfo.remaining,
        resetAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24 hours from now
        isLimitReached: limitInfo.isLimitReached,
      },
      message: limitInfo.isLimitReached
        ? '🔒 Вы достигли лимита. Авторизуйтесь для продолжения!'
        : limitInfo.remaining === 1
        ? `⚠️ У вас осталось ${limitInfo.remaining} сообщение`
        : `💡 У вас осталось ${limitInfo.remaining} сообщения`,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_CREDITS] Error getting credits info', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get credits information',
      message: 'Failed to get credits information',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/user/credits/reset
 * Reset anonymous user's rate limit (admin only or after successful auth)
 */
export const resetUserCredits = async (req: Request, res: Response): Promise<void> => {
  try {
    // Get anonymous ID from IP address
    const clientIp = getClientIp(req);
    const anonymousId = normalizeIpForAnonymousId(clientIp);

    if (!anonymousId || anonymousId === 'unknown') {
      res.status(400).json({
        success: false,
        error: 'Unable to determine IP address',
        message: 'Failed to determine IP address for reset',
      });
      return;
    }

    logger.info('[USER_CREDITS] Resetting credits', { anonymousId, clientIp });

    await AnonymousLimiterService.resetRequestCount(anonymousId);

    res.json({
      success: true,
      message: '✅ Limit reset successfully',
      anonymousId,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_CREDITS] Error resetting credits', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to reset credits',
      message: 'Failed to reset limit',
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
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

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
