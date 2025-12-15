import { supabaseAdmin } from '@/db/supabase';
import { PricingPlansService } from '@/services/core/pricing-plans.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { logger } from '@/utils/logger';
import { isValidUUID } from '@/utils/validation';
import { Request, Response } from 'express';

// Maximum credit amount to prevent DoS/integer overflow
const MAX_CREDIT_AMOUNT = 1000000;

// Maximum limit for history query
const MAX_HISTORY_LIMIT = 500;

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
        ? '💳 Purchase credits to continue'
        : `✅ You have ${userCredits.credits_balance} credits`,
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
    const { currency, billing_period } = req.query;

    logger.info('[PRICING] Getting pricing plans from database', {
      currency,
      billing_period,
    });

    // Get plans from database
    const result = await PricingPlansService.getPlansForAPI();

    let { plans, metadata } = result;

    // Filter by currency if provided
    if (currency) {
      const validCurrencies = ['USD', 'EUR', 'KZT'];
      if (!validCurrencies.includes(currency as string)) {
        res.status(400).json({
          success: false,
          error: 'Invalid currency',
          code: 'INVALID_CURRENCY',
          message: `Currency must be one of: ${validCurrencies.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      plans = plans.filter((plan) => plan.currency === currency);
      metadata.count = plans.length;
    }

    // Filter by billing_period if provided
    if (billing_period) {
      const validPeriods = ['monthly', 'yearly', 'custom'];
      if (!validPeriods.includes(billing_period as string)) {
        res.status(400).json({
          success: false,
          error: 'Invalid billing period',
          code: 'INVALID_BILLING_PERIOD',
          message: `Billing period must be one of: ${validPeriods.join(', ')}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      plans = plans.filter((plan) =>
        plan.credit_options.some((opt: any) => opt.billing_period === billing_period)
      );
      metadata.count = plans.length;
    }

    // Return enhanced structure with metadata
    res.json({
      success: true,
      plans,
      metadata,
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
      message: 'Failed to get pricing plans from database',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/user/plan
 * Get current user's plan information with credit usage
 */
export const getUserPlan = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.headers['x-user-id'] as string;

    if (!userId || !isValidUUID(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
        code: 'INVALID_USER_ID',
        message: 'Valid user ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[USER_PLAN] Getting user plan info', {
      userId: userId.substring(0, 8) + '...',
    });

    const planInfo = await PricingPlansService.getUserPlanInfo(userId);

    if (!planInfo) {
      res.status(404).json({
        success: false,
        error: 'User plan not found',
        code: 'PLAN_NOT_FOUND',
        message: 'User does not have an assigned plan',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      plan: {
        id: planInfo.plan.slug,
        name: planInfo.plan.name,
        description: planInfo.plan.description,
        price: planInfo.plan.price,
        features: planInfo.plan.features,
        limitations: planInfo.plan.limitations,
        credits_per_month: planInfo.plan.credits_per_month,
        credits_per_day: planInfo.plan.credits_per_day,
        plan_started_at: planInfo.plan_started_at,
      },
      usage: {
        credits_used_today: planInfo.credits_used_today,
        credits_used_this_month: planInfo.credits_used_this_month,
        daily_remaining: planInfo.daily_remaining,
        monthly_remaining: planInfo.monthly_remaining,
        last_reset_date: planInfo.last_credit_reset_date,
        monthly_reset_date: planInfo.monthly_reset_date,
      },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_PLAN] Error getting user plan', { error });

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to get user plan',
      code: 'SERVER_ERROR',
      message: 'Failed to get user plan information',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/user/plan/assign
 * Assign a plan to user (admin only)
 */
export const assignUserPlan = async (req: Request, res: Response): Promise<void> => {
  try {
    const adminUserId = req.headers['x-user-id'] as string;
    const { user_id, plan_slug } = req.body;

    // Validate admin
    if (!adminUserId || !isValidUUID(adminUserId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid admin user ID',
        code: 'INVALID_ADMIN_ID',
        message: 'Valid admin user ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const isAdminUser = await isAdmin(adminUserId);
    if (!isAdminUser) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        code: 'ACCESS_DENIED',
        message: 'Admin access required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate inputs
    if (!user_id || !isValidUUID(user_id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
        code: 'INVALID_USER_ID',
        message: 'Valid user ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!plan_slug || !['free', 'pro', 'team'].includes(plan_slug)) {
      res.status(400).json({
        success: false,
        error: 'Invalid plan slug',
        code: 'INVALID_PLAN_SLUG',
        message: 'Plan slug must be one of: free, pro, team',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    logger.info('[USER_PLAN] Assigning plan to user', {
      adminUserId: adminUserId.substring(0, 8) + '...',
      userId: user_id.substring(0, 8) + '...',
      planSlug: plan_slug,
    });

    const success = await PricingPlansService.assignPlanToUser(user_id, plan_slug);

    if (!success) {
      res.status(400).json({
        success: false,
        error: 'Failed to assign plan',
        code: 'PLAN_ASSIGNMENT_FAILED',
        message: 'Could not assign plan to user',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      message: 'Plan assigned successfully',
      user_id,
      plan_slug,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_PLAN] Error assigning user plan', { error });

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to assign plan',
      code: 'SERVER_ERROR',
      message: 'Failed to assign plan to user',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * POST /api/v1/user/credits/check
 * Check if user can use specified amount of credits
 */
export const checkUserCredits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.headers['x-user-id'] as string;
    const { credits_amount = 1 } = req.body;

    if (!userId || !isValidUUID(userId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
        code: 'INVALID_USER_ID',
        message: 'Valid user ID is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!Number.isInteger(credits_amount) || credits_amount < 1) {
      res.status(400).json({
        success: false,
        error: 'Invalid credits amount',
        code: 'INVALID_CREDITS_AMOUNT',
        message: 'Credits amount must be a positive integer',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const result = await PricingPlansService.checkUserCredits(userId, credits_amount);

    res.json({
      success: true,
      can_use_credits: result.can_use_credits,
      reason: result.reason,
      daily_remaining: result.daily_remaining,
      monthly_remaining: result.monthly_remaining,
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    logger.error('[USER_CREDITS] Error checking user credits', { error });

    if (res.headersSent) {
      logger.warn('[USER_CONTROLLER] Response already sent, cannot send error response');
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to check credits',
      code: 'SERVER_ERROR',
      message: 'Failed to check user credits',
      timestamp: new Date().toISOString(),
    });
  }
};
