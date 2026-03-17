/**
 * Analytics Types
 * TypeScript interfaces for analytics API requests and responses
 */

/**
 * Common filter parameters for analytics queries
 */
export interface AnalyticsFilters {
  workspaceId: string;
  projectId?: string;
  startDate?: Date;
  endDate?: Date;
}

/**
 * Summary section data (top cards + status + performance)
 */
export interface SummaryData {
  summary: {
    testStepsRun: number;
    totalRuns: number;
    tokensSpent: number;
    errorSteps: number;
    flakySteps: number;
    passRate: number;
    apiTestsRun?: number;
    apiTestsPassed?: number;
    apiTestsFailed?: number;
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
