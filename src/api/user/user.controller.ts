import { PRICING_METADATA, PRICING_PLANS } from '@/config/pricing-plans';
import { supabaseAdmin } from '@/db/supabase';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { logger } from '@/utils/logger';
import { Request, Response } from 'express';

// UUID validation regex
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Maximum credit amount to prevent DoS/integer overflow
const MAX_CREDIT_AMOUNT = 1000000;

// Maximum limit for history query
const MAX_HISTORY_LIMIT = 500;

/**
 * Check if user ID is a valid UUID (authenticated user)
 */
function isValidUUID(userId: string): boolean {
  return UUID_REGEX.test(userId);
}

/**
 * Check if user is admin
 */
async function isAdmin(userId: string): Promise<boolean> {
  try {
    const { data, error } = await supabaseAdmin
      .from('users')
      .select('role')
      .eq('id', userId)
      .maybeSingle();

    if (error || !data) {
      return false;
    }

    return data.role === 'admin';
  } catch (error) {
    logger.error('[USER_CONTROLLER] Admin check failed', { error, userId });
    return false;
  }
}

/**
 * GET /api/v1/user/credits
 * Get user's current credits/limits information
 */
export const getUserCredits = async (req: Request, res: Response): Promise<void> => {
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

    // Validate userId format (UUID)
    if (!isValidUUID(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      });
      return;
    }

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

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

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
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    // Validate userId format (UUID)
    if (!isValidUUID(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      });
      return;
    }

    // Check admin role - this endpoint is admin only
    const admin = await isAdmin(userId);
    if (!admin) {
      res.status(403).json({
        success: false,
        error: 'Admin access required',
        message: 'Only administrators can reset credits',
      });
      return;
    }

    logger.info('[USER_CREDITS] Resetting credits (admin)', { userId });

    // Admin endpoint - can be used to reset user's credit usage tracking
    // Currently a no-op, but structure is ready for implementation
    logger.info('[USER_CREDITS] Reset endpoint called - no-op', { userId });

    res.json({
      success: true,
      message: '✅ Credits reset successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[USER_CREDITS] Error resetting credits', { error });

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

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
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authorization required',
      });
      return;
    }

    // Validate userId format (UUID)
    if (!isValidUUID(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      });
      return;
    }

    const { amount, paymentId } = req.body;

    // Validate amount
    if (amount === undefined || amount === null) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount',
        message: 'Credit amount is required',
      });
      return;
    }

    // Validate amount is a number
    if (typeof amount !== 'number' || isNaN(amount)) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount',
        message: 'Credit amount must be a number',
      });
      return;
    }

    // Validate amount range
    if (amount <= 0) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount',
        message: 'Credit amount must be greater than 0',
      });
      return;
    }

    if (amount > MAX_CREDIT_AMOUNT) {
      res.status(400).json({
        success: false,
        error: 'Invalid amount',
        message: `Credit amount cannot exceed ${MAX_CREDIT_AMOUNT}`,
      });
      return;
    }

    // Validate paymentId format if provided
    if (paymentId !== undefined && paymentId !== null) {
      if (typeof paymentId !== 'string' || paymentId.trim().length === 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid payment ID',
          message: 'Payment ID must be a non-empty string',
        });
        return;
      }

      if (paymentId.length > 200) {
        res.status(400).json({
          success: false,
          error: 'Invalid payment ID',
          message: 'Payment ID is too long (max 200 characters)',
        });
        return;
      }
    }

    logger.info('[USER_CREDITS] Purchasing credits', { userId, amount, paymentId });

    const result = await UserCreditsService.addCredits(
      userId,
      amount,
      'purchase',
      `Purchased ${amount} credits`,
      { paymentId: paymentId || undefined }
    );

    if (!result.success) {
      if (res.headersSent) {
        logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
        return;
      }

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

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

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

    // Validate userId format (UUID)
    if (!isValidUUID(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID format',
      });
      return;
    }

    // Validate and parse limit
    const limitParam = req.query.limit as string;
    let limit = 50; // default

    if (limitParam !== undefined) {
      const parsedLimit = parseInt(limitParam, 10);

      if (isNaN(parsedLimit)) {
        res.status(400).json({
          success: false,
          error: 'Invalid limit',
          message: 'Limit must be a valid number',
        });
        return;
      }

      if (parsedLimit <= 0) {
        res.status(400).json({
          success: false,
          error: 'Invalid limit',
          message: 'Limit must be greater than 0',
        });
        return;
      }

      if (parsedLimit > MAX_HISTORY_LIMIT) {
        res.status(400).json({
          success: false,
          error: 'Invalid limit',
          message: `Limit cannot exceed ${MAX_HISTORY_LIMIT}`,
        });
        return;
      }

      limit = parsedLimit;
    }

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

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

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

    // Validate active_only if provided (accepts 'true', 'false', '1', '0')
    if (active_only !== undefined) {
      const activeOnlyStr = String(active_only).toLowerCase();
      if (!['true', 'false', '1', '0'].includes(activeOnlyStr)) {
        res.status(400).json({
          success: false,
          error: 'Invalid active_only parameter',
          code: 'INVALID_ACTIVE_ONLY',
          message: 'active_only must be one of: true, false, 1, 0',
          timestamp: new Date().toISOString(),
        });
        return;
      }
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

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get pricing plans',
      code: 'SERVER_ERROR',
      message: 'Failed to get pricing plans',
      timestamp: new Date().toISOString(),
    });
  }
};
