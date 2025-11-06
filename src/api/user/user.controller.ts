import { Request, Response } from 'express';
import { AnonymousLimiterService } from '@/services/anonymous-limiter.service';
import { UserCreditsService } from '@/services/user-credits.service';
import { PRICING_PLANS } from '@/config/pricing-plans';
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
    // Get userId from auth or query params
    const userId = req.user?.id || req.query.userId || req.body?.userId;
    const context = req.body?.context || req.query?.context;
    const projectId = (typeof context === 'object' ? context?.projectId : undefined) || 'default';

    // If no userId, use project-based anonymous ID
    const effectiveUserId = userId || `project_${projectId}`;

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
      message: 'Не удалось получить информацию о кредитах',
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
    const { anonymousId } = req.body;

    if (!anonymousId) {
      res.status(400).json({
        success: false,
        error: 'Missing anonymousId',
        message: 'Не указан anonymousId для сброса',
      });
      return;
    }

    logger.info('[USER_CREDITS] Resetting credits', { anonymousId });

    await AnonymousLimiterService.resetRequestCount(anonymousId);

    res.json({
      success: true,
      message: '✅ Лимит успешно сброшен',
      anonymousId,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_CREDITS] Error resetting credits', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to reset credits',
      message: 'Не удалось сбросить лимит',
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
        message: 'Требуется авторизация',
      });
      return;
    }

    const { amount, paymentId } = req.body;

    if (!amount || amount <= 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount',
        message: 'Некорректное количество кредитов',
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
        message: 'Не удалось купить кредиты',
      });
      return;
    }

    res.json({
      success: true,
      message: `✅ Успешно куплено ${amount} кредитов`,
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
      message: 'Ошибка при покупке кредитов',
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
        message: 'Требуется авторизация',
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
      message: 'Не удалось получить историю',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/user/pricing-plans
 * Get available pricing plans (public endpoint, no auth required)
 */
export const getPricingPlans = async (req: Request, res: Response): Promise<void> => {
  try {
    logger.info('[PRICING] Getting pricing plans');

    res.json({
      success: true,
      plans: PRICING_PLANS,
      count: PRICING_PLANS.length,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[PRICING] Error getting pricing plans', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get pricing plans',
      message: 'Не удалось получить тарифные планы',
      timestamp: new Date().toISOString(),
    });
  }
};
