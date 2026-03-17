/**
 * Analytics Controller
 * API endpoints for workspace test analytics
 */

import { Request, Response } from 'express';
import { AnalyticsQueryService } from '@/services/analytics/analytics-query.service';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { logger } from '@/utils/core/logger';
import type { HeatmapMetric, HeatmapRange, TimeSeriesInterval, BugInsightsRange } from '@/services/analytics/analytics.types';

/**
 * GET /api/v1/analytics/summary
 * Get summary data (top cards + status + performance)
 */
export async function getSummary(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
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

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId query parameter is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Verify workspace access
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

    const projectId = req.query.projectId as string | undefined;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    const data = await AnalyticsQueryService.getSummary({
      workspaceId,
      projectId,
      startDate,
      endDate,
    });

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get summary', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve analytics summary',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/results-overview
 * Get results overview (donut chart data)
 */
export async function getResultsOverview(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const projectId = req.query.projectId as string | undefined;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    const data = await AnalyticsQueryService.getResultsOverview({
      workspaceId,
      projectId,
      startDate,
      endDate,
    });

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get results overview', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve results overview',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/recent-failures
 * Get recent test failures
 */
export async function getRecentFailures(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const projectId = req.query.projectId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 10;

    const data = await AnalyticsQueryService.getRecentFailures(workspaceId, projectId, limit);

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get recent failures', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve recent failures',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/critical-checks
 * Get critical test checks status
 */
export async function getCriticalChecks(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const projectId = req.query.projectId as string | undefined;

    const data = await AnalyticsQueryService.getCriticalChecks(workspaceId, projectId);

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get critical checks', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve critical checks',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/heatmap
 * Get activity heatmap data
 */
export async function getHeatmap(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const metric = req.query.metric as HeatmapMetric;
    const range = (req.query.range as HeatmapRange) || '365d';
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !metric) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId and metric query parameters are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!['runs', 'failures', 'flaky'].includes(metric)) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'metric must be one of: runs, failures, flaky',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const projectId = req.query.projectId as string | undefined;

    const data = await AnalyticsQueryService.getHeatmap(workspaceId, metric, range, projectId);

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get heatmap', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve heatmap data',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/deployments
 * Get recent deployments
 */
export async function getDeployments(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const projectId = req.query.projectId as string | undefined;
    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 5;

    const data = await AnalyticsQueryService.getRecentDeployments(workspaceId, projectId, limit);

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get deployments', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve deployments',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/time-series
 * Get time series data for charting
 */
export async function getTimeSeries(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const interval = req.query.interval as TimeSeriesInterval;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId || !interval) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId and interval query parameters are required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!['1m', '5m', '15m', '1h', '1d'].includes(interval)) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'interval must be one of: 1m, 5m, 15m, 1h, 1d',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const projectId = req.query.projectId as string | undefined;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    const data = await AnalyticsQueryService.getTimeSeries({
      workspaceId,
      projectId,
      startDate,
      endDate,
      interval,
    });

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get time series', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve time series data',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * GET /api/v1/analytics/bug-insights
 * Get bug insights (summary, trend, top recurring bugs)
 */
export async function getBugInsights(req: Request, res: Response): Promise<void> {
  try {
    const workspaceId = req.query.workspaceId as string;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!workspaceId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'workspaceId is required',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const role = await WorkspaceAccessService.getRole(userId, workspaceId);
    if (!role) {
      res.status(403).json({
        success: false,
        error: 'Access denied',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const range = (req.query.range as BugInsightsRange) || '30d';
    const projectId = req.query.projectId as string | undefined;

    if (!['7d', '30d', '90d'].includes(range)) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'range must be one of: 7d, 30d, 90d',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    const data = await AnalyticsQueryService.getBugInsights(workspaceId, range, projectId);

    res.json({
      success: true,
      data,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[ANALYTICS_API] Failed to get bug insights', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId: req.query.workspaceId,
      userId: req.user?.id,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve bug insights',
      timestamp: new Date().toISOString(),
    });
  }
}
