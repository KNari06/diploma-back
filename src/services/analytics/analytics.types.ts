/**
 * Analytics Types
 * TypeScript interfaces for analytics API requests and responses
 */

/**
 * Platform filter value accepted by analytics endpoints.
 *
 *   'all'            → include every UI platform (web + mobile_*). Omits API
 *                      tests unless `includeApi` is set on the caller.
 *   'web'            → only `intent_test_cases.platform = 'web'` (and legacy
 *                      rows where `test_executions.platform IS NULL`, which
 *                      are pre-Phase-2 and therefore implicitly web).
 *   'mobile'         → any mobile platform (startsWith 'mobile_'). Today
 *                      that's `mobile_android` only; `mobile_ios` /
 *                      `mobile_flutter` / `mobile_react_native` slot in
 *                      automatically once those ship.
 *   'mobile_android' → the Android-only subset. Useful once iOS lands.
 *   'api'            → `test_executions.test_type = 'api'` plus the
 *                      sister `api_test_executions` table. Skips every
 *                      UI-platform filter.
 *
 * Keep this union closed — any new platform value needs a matching query
 * branch in `analytics-query.service` (see `applyPlatformFilter`).
 */
export type AnalyticsPlatformFilter =
  | 'all'
  | 'web'
  | 'mobile'
  | 'mobile_android'
  | 'api';

/**
 * Common filter parameters for analytics queries
 */
export interface AnalyticsFilters {
  workspaceId: string;
  projectId?: string;
  startDate?: Date;
  endDate?: Date;
  /**
   * Phase 7 — platform dimension. See `AnalyticsPlatformFilter` for the
   * semantics of each value. Omitting the field is equivalent to 'all'.
   */
  platform?: AnalyticsPlatformFilter;
}

/**
 * Breakdown slice for a single "scope" (web / mobile / api). Attached to
 * summary + overview responses so the UI can render a stacked/segmented
 * view without a second API call. Always present, even when platform
 * filter is explicit (e.g. platform='web' → byPlatform.web populated,
 * mobile/api counts zero). Kept shallow on purpose — anything deeper
 * belongs on its own endpoint.
 */
export interface PlatformBreakdownSlice {
  runs: number;
  passed: number;
  failed: number;
}

export interface SummaryPlatformBreakdown {
  web: PlatformBreakdownSlice;
  mobile: PlatformBreakdownSlice;
  api: PlatformBreakdownSlice;
}

/**
 * Summary section data (top cards + status + performance)
 */
export interface SummaryData {
  summary: {
    testStepsRun: number;
    totalRuns: number;
    tokensSpent: number;
    failedRuns: number;
    flakySteps: number;
    passRate: number;
    apiTestsRun?: number;
    apiTestsPassed?: number;
    apiTestsFailed?: number;
    /**
     * Trend deltas (signed %), comparing the last 30 days vs the prior 30 days.
     * INDEPENDENT of the headline numbers above, which stay all-time — these
     * exist only to drive the dashboard's trend pills. A field is omitted when
     * the prior window had no data (delta undefined → UI hides the pill rather
     * than showing a misleading 0%).
     */
    trend?: {
      totalRunsDeltaPct?: number;
      failedRunsDeltaPct?: number;
      flakyStepsDeltaPct?: number;
      /** Relative % change in pass rate vs the prior window (same basis as the
       *  other deltas), rendered with a "%" suffix in the UI. */
      passRateDeltaPct?: number;
    };
  };
  status: {
    state: 'passing' | 'warning' | 'failing';
    message: string;
    lastRunAt: string | null;
    nextSchedule: {
      cronExpression: string;
      nextRunAt: string;
    } | null;
  };
  performance: {
    avgRunTimeMs: number;
    avgRunTimeFormatted: string;
    failureRate: number;
    runsPerMinute: number;
  };
  /**
   * Phase 7 — per-platform breakdown of the same totals. Always returned
   * (so frontends can segment a donut / KPI card without a second call).
   * Sum of slices equals `summary.totalRuns` etc. for platform='all';
   * for a specific platform filter the non-matching slices are zero.
   */
  byPlatform: SummaryPlatformBreakdown;
}

/**
 * Results overview (donut chart breakdown)
 */
export interface ResultsOverview {
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  total: number;
  percentages: {
    passed: number;
    failed: number;
    skipped: number;
    flaky: number;
  };
  apiTests?: {
    total: number;
    passed: number;
    failed: number;
  };
}

/**
 * Single failure entry
 */
export interface RecentFailure {
  id: string;
  testCaseName: string;
  testCaseId: string;
  runId: string;
  status: 'failed';
  errorMessage: string | null;
  severity: 'failure' | 'warn' | 'recovered';
  failedAt: string;
  timeAgo: string;
  source?: 'regression' | 'api_test';
}

/**
 * Recent failures response
 */
export interface RecentFailuresData {
  failures: RecentFailure[];
}

/**
 * Single critical check entry
 */
export interface CriticalCheck {
  id: string;
  name: string;
  status: 'ok' | 'failed' | 'unknown';
  lastRunAt: string | null;
  lastRunId: string | null;
}

/**
 * Critical checks response
 */
export interface CriticalChecksData {
  checks: CriticalCheck[];
}

/**
 * Single heatmap day entry
 */
export interface HeatmapDay {
  date: string; // YYYY-MM-DD
  count: number;
  level: 0 | 1 | 2 | 3 | 4; // intensity level
}

/**
 * Heatmap response
 */
export interface HeatmapData {
  days: HeatmapDay[];
  maxCount: number;
  totalCount: number;
}

/**
 * Single deployment entry
 */
export interface DeploymentEntry {
  id: string;
  version: string | null;
  eventType: string;
  provider: string;
  status: 'passed' | 'regression_flagged' | 'pending' | 'no_tests';
  branch: string | null;
  deliveredAt: string;
  runId: string | null;
}

/**
 * Deployments response
 */
export interface DeploymentsData {
  deployments: DeploymentEntry[];
}

/**
 * Single time series data point
 */
export interface TimeSeriesPoint {
  timestamp: string;
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  apiTestsRun?: number;
}

/**
 * Time series response
 */
export interface TimeSeriesData {
  points: TimeSeriesPoint[];
  interval: string;
}

/**
 * Heatmap metric types
 */
export type HeatmapMetric = 'runs' | 'failures' | 'flaky';

/**
 * Heatmap time range
 */
export type HeatmapRange = '30d' | '90d' | '365d';

/**
 * Time series interval
 */
export type TimeSeriesInterval = '1m' | '5m' | '15m' | '1h' | '1d';

/**
 * Bug insights time range
 */
export type BugInsightsRange = '7d' | '30d' | '90d';

/**
 * Single bug trend data point (daily bucket)
 */
export interface BugTrendPoint {
  date: string; // YYYY-MM-DD
  count: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/**
 * Top recurring bug entry
 */
export interface RecurringBug {
  title: string;
  count: number;
  severity: string;
  lastSeen: string;
}

/**
 * Bug insights response
 */
export interface BugInsightsData {
  summary: {
    totalBugs: number;
    bySeverity: { critical: number; high: number; medium: number; low: number };
    newBugs: number;
    fixedBugs: number;
  };
  trend: BugTrendPoint[];
  topRecurring: RecurringBug[];
}
