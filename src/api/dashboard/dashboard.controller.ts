/**
 * Dashboard Controller
 * Single endpoint that aggregates all home-page data in one round-trip.
 *
 * GET /api/v1/dashboard/summary?workspaceId=<uuid>
 *
 * Fires all downstream queries in parallel and returns a unified response.
 * This replaces 5 separate frontend requests:
 *   1. GET /projects?workspace_id=...          (resolve projectId)
 *   2. GET /analytics/summary
 *   3. GET /analytics/results-overview
 *   4. GET /test-visualization/project/.../overall
 *   5. GET /regression/runs?projectId=...
 *   6. GET /schedules?projectId=...
 *
 * Redis caching: results cached per (workspaceId+userId) for 60 seconds.
 * Individual downstream services may have their own longer-lived caches.
 */

import { Request, Response } from 'express';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { ProjectService } from '@/services/core/project.service';
import { AnalyticsQueryService } from '@/services/analytics/analytics-query.service';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { OverallBuilderService } from '@/services/testing/visualization/overall-builder.service';
import { cache } from '@/utils/core/redis-cache';
import { logger } from '@/utils/core/logger';
import type { AnalyticsPlatformFilter } from '@/services/analytics/analytics.types';

const CACHE_TTL_SECONDS = 60; // 1 minute — fresh enough for dashboard, eliminates burst

/**
 * Phase 7: cache key now keys on platform too, otherwise a user who opens
 * "Web" and then "Mobile" in quick succession would get the first one's
 * cached response for both. platform='all' → empty string so existing
 * cache keys stay stable (and so clients that don't pass platform don't
 * cause a fresh miss).
 */
function cacheKey(
  workspaceId: string,
  userId: string,
  platform: AnalyticsPlatformFilter,
  projectId?: string,
): string {
  const platformSuffix = platform === 'all' ? '' : `:p:${platform}`;
  // Project is a cache dimension too: the same user switching projects must
  // not be served another project's cached response. Empty (workspace-wide)
  // keeps the legacy keyspace so existing entries stay valid.
  const projectSuffix = projectId ? `:proj:${projectId}` : '';
  return `qait:cache:dashboard:summary:ws:${workspaceId}:u:${userId}${platformSuffix}${projectSuffix}`;
}

/**
 * GET /api/v1/dashboard/summary
 */
export async function getDashboardSummary(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  const workspaceId = req.query.workspaceId as string;
  // The client sends the project it has selected in the UI. We honour it for
  // BOTH the analytics half (summary / results-overview) and the per-project
  // lists. Empty / missing → workspace-wide aggregation for the metrics and a
  // data-bearing fallback for the lists (see below) — never silently scoping
  // the whole dashboard to projects[0], which is the *newest* project and is
  // usually empty (it zeroed every metric the moment a fresh project existed).
  const requestedProjectId =
    typeof req.query.projectId === 'string' && req.query.projectId
      ? req.query.projectId
      : undefined;
  // Phase 7: dashboard now accepts the same platform filter as every other
  // analytics endpoint. Unknown / missing → 'all' (pre-Phase-7 default),
  // so clients that never heard of this param keep working unchanged.
  const platform = AnalyticsQueryService.normalisePlatform(req.query.platform);

  // ── Validation ────────────────────────────────────────────────────────────
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

  // ── Access check ──────────────────────────────────────────────────────────
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

  // ── Cache hit ─────────────────────────────────────────────────────────────
  const key = cacheKey(workspaceId, userId, platform, requestedProjectId);
  const cached = await cache.get<object>(key);
  if (cached) {
    res.json({ success: true, data: cached, cached: true, timestamp: new Date().toISOString() });
    return;
  }

  // ── Parallel resolution ───────────────────────────────────────────────────
  try {
    // Step 1: resolve which project drives the per-project LISTS (test nodes,
    // recent runs, schedules). The analytics METRICS below ignore this and use
    // `requestedProjectId` directly — undefined there means workspace-wide.
    //
    // When the client selected a project we use it. When it didn't, we must
    // NOT default to projects[0] (the newest project — typically empty, which
    // is the exact bug that zeroed the dashboard). Instead pick the project
    // with the most recent regression run so the lists show real data.
    const listProjectId: string | undefined =
      requestedProjectId ??
      (await ProjectService.getMostRecentlyActiveProjectId(workspaceId, userId));

    // Step 2: fire all project-independent and project-dependent queries in parallel.
    // Analytics services are platform-aware (Phase 7) — we forward the filter
    // so "Web" / "Mobile" / "API" dashboards actually differ.
    //
    // METRICS scope: `requestedProjectId` (undefined → whole workspace). The
    // analytics services aggregate across every project in the workspace when
    // no projectId is passed, which is the correct workspace-wide default.
    //
    // The other services (overall builder, runs list, schedules) are
    // intentionally NOT platform-filtered: test nodes and upcoming schedules are
    // structural/config-level, not execution-level — filtering them by
    // platform would hide a plan that contains mobile cases just because
    // the user is looking at "Web" metrics. Recent runs is kept unfiltered
    // for the same reason (a plan with mixed cases has one run row).
    const [summaryData, resultsOverviewData, testNodesData, recentRunsData, schedulesData] =
      await Promise.allSettled([
        AnalyticsQueryService.getSummary({ workspaceId, projectId: requestedProjectId, platform }),
        AnalyticsQueryService.getResultsOverview({ workspaceId, projectId: requestedProjectId, platform }),

        // Project-specific (skip gracefully if no project resolved)
        listProjectId
          ? OverallBuilderService.buildProjectOverall(listProjectId, userId)
          : Promise.resolve(null),
        listProjectId
          ? RegressionRunService.listRuns(listProjectId, userId)
          : Promise.resolve([]),
        listProjectId
          ? ScheduleService.listByProject(listProjectId, userId)
          : Promise.resolve([]),
      ]);

    // ── Extract settled values (never throw on partial failure) ───────────
    const summary = summaryData.status === 'fulfilled' ? summaryData.value : null;
    const resultsOverview = resultsOverviewData.status === 'fulfilled' ? resultsOverviewData.value : null;
    const testNodes = testNodesData.status === 'fulfilled' ? (testNodesData.value?.nodes ?? []) : [];
    const recentRuns = recentRunsData.status === 'fulfilled'
      ? (Array.isArray(recentRunsData.value) ? recentRunsData.value : [])
      : [];
    const upcomingSchedules = schedulesData.status === 'fulfilled'
      ? (Array.isArray(schedulesData.value) ? schedulesData.value : [])
      : [];

    // Log any partial failures for observability (non-fatal)
    [summaryData, resultsOverviewData, testNodesData, recentRunsData, schedulesData].forEach((r, i) => {
      if (r.status === 'rejected') {
        const names = ['summary', 'resultsOverview', 'testNodes', 'recentRuns', 'schedules'];
        logger.warn(`[DASHBOARD_API] Partial failure: ${names[i]}`, {
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
          workspaceId,
          projectId: listProjectId,
          userId,
        });
      }
    });

    const responseData = {
      projectId: listProjectId ?? null,
      summary,
      resultsOverview,
      testNodes,
      recentRuns,
      upcomingSchedules,
    };

    // ── Cache result ───────────────────────────────────────────────────────
    await cache.set(key, responseData, CACHE_TTL_SECONDS);

    res.json({
      success: true,
      data: responseData,
      cached: false,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[DASHBOARD_API] Failed to get dashboard summary', {
      error: error instanceof Error ? error.message : String(error),
      workspaceId,
      userId,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to retrieve dashboard summary',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * POST /api/v1/dashboard/invalidate
 * Invalidate dashboard cache for the current workspace (call after run completion, etc.)
 *
 * Phase 7: platform is a cache dimension now, so we have to drop the keys
 * for ALL platform values. Done with `delByPattern` instead of deleting
 * a single fully-qualified key.
 */
export async function invalidateDashboardCache(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  const workspaceId = req.body?.workspaceId as string;

  if (!userId || !workspaceId) {
    res.status(400).json({ success: false, error: 'workspaceId required', timestamp: new Date().toISOString() });
    return;
  }

  // Match the 'all' (legacy, no suffix) AND every per-platform variant.
  const pattern = `qait:cache:dashboard:summary:ws:${workspaceId}:u:${userId}*`;
  await cache.delByPattern(pattern);
  res.json({ success: true, timestamp: new Date().toISOString() });
}
