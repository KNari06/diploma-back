import {
  AccessDeniedError,
  WorkspaceAccessService,
} from '@/services/core/workspace-access.service';
import { WorkspaceCreditsService } from '@/services/core/workspace-credits.service';
import { cache } from '@/utils/core/redis-cache';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Cache key for a workspace's /credits response.
 * Exported so service-layer mutations can invalidate after writes.
 */
export const workspaceCreditsCacheKey = (workspaceId: string) =>
  `qait:cache:workspace-credits:${workspaceId}`;

const WORKSPACE_CREDITS_TTL_SECONDS = 30;

/**
 * GET /api/v1/workspaces/:id/credits
 * Returns balance + plan info. Any active member may read.
 */
export const getCredits = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await WorkspaceAccessService.requireMembership(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const cacheKey = workspaceCreditsCacheKey(workspaceId);
    const cached = await cache.get<object>(cacheKey);
    if (cached) {
      res.json({
        success: true,
        data: cached,
        cached: true,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const [credits, monthly] = await Promise.all([
      WorkspaceCreditsService.getWorkspaceCredits(workspaceId),
      WorkspaceCreditsService.getMonthlyUsage(workspaceId),
    ]);

    const payload = credits
      ? {
          balance: credits.credits_balance,
          credits: credits.credits_balance,
          total: credits.total_purchased,
          total_purchased: credits.total_purchased,
          total_used: credits.total_used,
          subscription_plan: credits.subscription_plan,
          subscription_status: credits.subscription_status,
          subscription_expires_at: credits.subscription_expires_at,
          last_credit_usage: credits.last_credit_usage,
          monthly_credit_limit: credits.monthly_credit_limit,
          credits_used_this_period: credits.credits_used_this_period,
          period_start_date: credits.period_start_date,
          grace_limit: credits.grace_limit,
          overage_balance: credits.overage_balance,
          grace_started_at: credits.grace_started_at,
          monthly_usage: monthly,
        }
      : {
          balance: 0,
          total: 0,
          credits: 0,
          total_purchased: 0,
          total_used: 0,
          subscription_plan: 'free',
          subscription_status: 'inactive',
          monthly_usage: monthly,
        };

    await cache.set(cacheKey, payload, WORKSPACE_CREDITS_TTL_SECONDS);

    res.json({
      success: true,
      data: payload,
      cached: false,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_CREDITS_API] Error getting credits', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get credits',
      timestamp: new Date().toISOString(),
    });
  }
};

/**
 * GET /api/v1/workspaces/:id/credits/transactions
 * Paginated credit transactions. Any active member may read (matches RLS).
 */
export const getCreditTransactions = async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = req.user?.id;
    const workspaceId = req.params.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !UUID_REGEX.test(workspaceId)) {
      res.status(400).json({
        success: false,
        error: 'Invalid workspace ID',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      await WorkspaceAccessService.requireMembership(userId, workspaceId);
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        res.status(403).json({
          success: false,
          error: error.message,
          timestamp: new Date().toISOString(),
        });
        return;
      }
      throw error;
    }

    const page = Math.max(1, parseInt(String(req.query.page ?? '1'), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit ?? '10'), 10) || 10)
    );

    const result = await WorkspaceCreditsService.getTransactionsPaginated(workspaceId, {
      page,
      limit,
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[WORKSPACE_CREDITS_API] Error getting credit transactions', { error });
    res.status(500).json({
      success: false,
      error: 'Failed to get credit transactions',
      timestamp: new Date().toISOString(),
    });
  }
};
