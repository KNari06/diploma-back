/**
 * AI Usage Controller
 * Handles API endpoints for querying AI token usage and costs.
 */

import { Request, Response } from 'express';
import { AIUsageQueryService } from '@/services/ai/tracking/ai-usage-query.service';
import { logger } from '@/utils/core/logger';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';

/**
 * GET /api/v1/workspaces/:id/ai-usage
 * Get AI usage statistics for a workspace
 */
export async function getWorkspaceAIUsage(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.params.id;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to workspace
    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have access to this workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Parse query parameters
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
    const operationType = req.query.operationType as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    // Get usage statistics
    const stats = await AIUsageQueryService.getWorkspaceUsageStats(
      workspaceId,
      startDate,
      endDate
    );

    // Get breakdown by operation type
    const byOperationType = await AIUsageQueryService.getUsageByOperationType(
      workspaceId,
      startDate,
      endDate
    );

    res.json({
      success: true,
      data: {
        stats,
        byOperationType,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AI_USAGE_API] Failed to get workspace AI usage', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.params.id,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve AI usage statistics',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/workspaces/:id/ai-usage/history
 * Get AI usage history (list of records) for a workspace
 */
export async function getWorkspaceAIUsageHistory(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.params.id;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to workspace
    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have access to this workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Parse query parameters
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;
    const operationType = req.query.operationType as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 100;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;

    // Query usage records
    const records = await AIUsageQueryService.queryUsage({
      workspaceId,
      startDate,
      endDate,
      operationType,
      limit,
      offset,
    });

    res.json({
      success: true,
      data: records,
      pagination: {
        limit,
        offset,
        count: records.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AI_USAGE_API] Failed to get workspace AI usage history', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.params.id,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve AI usage history',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/workspaces/:id/ai-usage/daily
 * Get daily AI usage statistics for charting
 */
export async function getWorkspaceAIUsageDaily(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.params.id;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to workspace
    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have access to this workspace',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Parse date range (required for daily stats)
    const startDateStr = req.query.startDate as string;
    const endDateStr = req.query.endDate as string;

    if (!startDateStr || !endDateStr) {
      res.status(400).json({
        success: false,
        error: 'Invalid request',
        message: 'startDate and endDate query parameters are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const startDate = new Date(startDateStr);
    const endDate = new Date(endDateStr);

    // Get daily usage
    const dailyUsage = await AIUsageQueryService.getDailyUsage(
      workspaceId,
      startDate,
      endDate
    );

    res.json({
      success: true,
      data: dailyUsage,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AI_USAGE_API] Failed to get daily AI usage', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.params.id,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve daily AI usage',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/tests/:testId/ai-usage
 * Get AI usage for a specific test
 */
export async function getTestAIUsage(req: Request, res: Response): Promise<void> {
  try {
    const testId = req.params.testId;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'Authentication required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Get test usage
    const usage = await AIUsageQueryService.getTestUsage(testId);

    if (!usage) {
      res.status(404).json({
        success: false,
        error: 'Not found',
        message: 'No AI usage data found for this test',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify user has access to the workspace
    const role = await WorkspaceAccessService.getRole(userId, usage.workspace_id);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        message: 'You do not have access to this test',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    res.json({
      success: true,
      data: usage,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[AI_USAGE_API] Failed to get test AI usage', {
      error: error instanceof Error ? error.message : String(error),
      testId: req.params.testId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve test AI usage',
      timestamp: new Date().toISOString(),
    });
  }
}
