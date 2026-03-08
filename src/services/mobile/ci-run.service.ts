/**
 * CI Run Tracking Service
 *
 * Tracks CI/CD-triggered mobile test runs using Redis (no DB schema changes).
 * Each "run" groups multiple test executions and tracks overall status.
 *
 * Redis key: ci_run:{runId} → JSON with run metadata + test IDs
 * TTL: 24 hours (CI runs are ephemeral; test results persist in DB)
 */

import { redisConnection, QueueManager } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { v4 as uuidv4 } from 'uuid';

// ── Constants ────────────────────────────────────────────────────────

const CI_RUN_PREFIX = 'ci_run:';
const CI_RUN_TTL = 86400; // 24 hours

// ── Types ────────────────────────────────────────────────────────────

export interface CiRunData {
  runId: string;
  projectId: string;
  workspaceId: string;
  userId: string;
  platform: string;
  totalTests: number;
  testEntries: Array<{
    testId: string;
    testCaseId: string;
    testCaseName: string;
  }>;
  callbackUrl?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  createdAt: string;
}

export interface CiRunStatus {
  runId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  totalTests: number;
  completedTests: number;
  failedTests: number;
  passedTests: number;
  results: Array<{
    testId: string;
    testCaseId: string;
    testCaseName: string;
    status: string;
    duration?: number;
  }>;
  createdAt: string;
}

// ── Service ──────────────────────────────────────────────────────────

export class CiRunService {
  /**
   * Create a new CI run tracking record in Redis.
   */
  static async createRun(params: {
    projectId: string;
    workspaceId: string;
    userId: string;
    platform: string;
    callbackUrl?: string;
  }): Promise<string> {
    const runId = uuidv4();

    const runData: CiRunData = {
      runId,
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      userId: params.userId,
      platform: params.platform,
      totalTests: 0,
      testEntries: [],
      callbackUrl: params.callbackUrl,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };

    await redisConnection.set(
      `${CI_RUN_PREFIX}${runId}`,
      JSON.stringify(runData),
      'EX',
      CI_RUN_TTL,
    );

    logger.info('[CI_RUN] Created run', { runId, projectId: params.projectId });

    return runId;
  }

  /**
   * Add a test to the run.
   */
  static async addTestToRun(
    runId: string,
    testId: string,
    testCaseId: string,
    testCaseName: string,
  ): Promise<void> {
    const runData = await this.getRunData(runId);
    if (!runData) {
      logger.warn('[CI_RUN] Run not found, cannot add test', { runId, testId });
      return;
    }

    runData.testEntries.push({ testId, testCaseId, testCaseName });
    runData.totalTests = runData.testEntries.length;

    if (runData.status === 'pending') {
      runData.status = 'running';
    }

    await redisConnection.set(
      `${CI_RUN_PREFIX}${runId}`,
      JSON.stringify(runData),
      'EX',
      CI_RUN_TTL,
    );
  }

  /**
   * Mark a test as complete within the run.
   * Checks if all tests are done → triggers callback if so.
   */
  static async markTestComplete(
    runId: string,
    testId: string,
    testStatus: string,
  ): Promise<void> {
    const runData = await this.getRunData(runId);
    if (!runData) {
      logger.warn('[CI_RUN] Run not found for completion', { runId, testId });
      return;
    }

    // Check if ALL tests in the run are done
    const testIds = runData.testEntries.map((e) => e.testId);
    const { data: tests, error } = await supabaseAdmin
      .from('tests')
      .select('id, status, completed_at, started_at')
      .in('id', testIds);

    if (error) {
      logger.error('[CI_RUN] Failed to fetch test statuses', { runId, error });
      return;
    }

    const allDone = tests?.every((t: any) =>
      ['completed', 'failed', 'cancelled', 'timeout'].includes(t.status),
    );

    if (allDone && tests) {
      const passed = tests.filter((t: any) => t.status === 'completed').length;
      const failed = tests.filter((t: any) => t.status !== 'completed').length;

      runData.status = failed > 0 ? 'failed' : 'completed';

      await redisConnection.set(
        `${CI_RUN_PREFIX}${runId}`,
        JSON.stringify(runData),
        'EX',
        CI_RUN_TTL,
      );

      logger.info('[CI_RUN] Run completed', {
        runId,
        status: runData.status,
        passed,
        failed,
        total: runData.totalTests,
      });

      // Trigger callback webhook if configured
      if (runData.callbackUrl) {
        await this.triggerCallback(runId, runData, tests);
      }
    }
  }

  /**
   * Get run status with live test results.
   */
  static async getRunStatus(runId: string): Promise<CiRunStatus | null> {
    const runData = await this.getRunData(runId);
    if (!runData) return null;

    // Fetch live test statuses from DB
    const testIds = runData.testEntries.map((e) => e.testId);

    let tests: any[] = [];
    if (testIds.length > 0) {
      const { data, error } = await supabaseAdmin
        .from('tests')
        .select('id, status, started_at, completed_at')
        .in('id', testIds);

      if (!error && data) {
        tests = data;
      }
    }

    const testStatusMap = new Map(tests.map((t: any) => [t.id, t]));

    const completedStatuses = ['completed', 'failed', 'cancelled', 'timeout'];
    const completedTests = tests.filter((t: any) => completedStatuses.includes(t.status)).length;
    const passedTests = tests.filter((t: any) => t.status === 'completed').length;
    const failedTests = tests.filter((t: any) =>
      ['failed', 'cancelled', 'timeout'].includes(t.status),
    ).length;

    // Determine overall status
    let status = runData.status;
    if (completedTests === runData.totalTests && runData.totalTests > 0) {
      status = failedTests > 0 ? 'failed' : 'completed';
    } else if (completedTests > 0 || tests.some((t: any) => t.status === 'running')) {
      status = 'running';
    }

    const results = runData.testEntries.map((entry) => {
      const testRow = testStatusMap.get(entry.testId) as any;
      const duration = testRow?.started_at && testRow?.completed_at
        ? Math.round((new Date(testRow.completed_at).getTime() - new Date(testRow.started_at).getTime()) / 1000)
        : undefined;

      return {
        testId: entry.testId,
        testCaseId: entry.testCaseId,
        testCaseName: entry.testCaseName,
        status: testRow?.status || 'pending',
        duration,
      };
    });

    return {
      runId,
      status,
      totalTests: runData.totalTests,
      completedTests,
      failedTests,
      passedTests,
      results,
      createdAt: runData.createdAt,
    };
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * Get raw run data from Redis.
   */
  private static async getRunData(runId: string): Promise<CiRunData | null> {
    try {
      const raw = await redisConnection.get(`${CI_RUN_PREFIX}${runId}`);
      if (!raw) return null;
      return JSON.parse(raw) as CiRunData;
    } catch (err) {
      logger.error('[CI_RUN] Failed to read run data', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Trigger outbound webhook callback on run completion.
   * Uses existing webhookQueue infrastructure.
   */
  private static async triggerCallback(
    runId: string,
    runData: CiRunData,
    tests: any[],
  ): Promise<void> {
    if (!runData.callbackUrl) return;

    try {
      const passed = tests.filter((t: any) => t.status === 'completed').length;
      const failed = tests.filter((t: any) => t.status !== 'completed').length;

      const results = runData.testEntries.map((entry) => {
        const testRow = tests.find((t: any) => t.id === entry.testId);
        const duration = testRow?.started_at && testRow?.completed_at
          ? Math.round(
              (new Date(testRow.completed_at).getTime() -
                new Date(testRow.started_at).getTime()) /
                1000,
            )
          : undefined;

        return {
          testId: entry.testId,
          testCaseId: entry.testCaseId,
          name: entry.testCaseName,
          status: testRow?.status || 'unknown',
          duration,
        };
      });

      const callbackPayload = {
        event: 'mobile_ci_run.completed',
        runId,
        status: runData.status,
        totalTests: runData.totalTests,
        passed,
        failed,
        results,
        timestamp: new Date().toISOString(),
      };

      await QueueManager.addWebhookJob({
        url: runData.callbackUrl,
        event: 'mobile_ci_run.completed',
        data: callbackPayload,
      });

      logger.info('[CI_RUN] Callback webhook queued', {
        runId,
        callbackUrl: runData.callbackUrl,
        status: runData.status,
      });
    } catch (err) {
      logger.error('[CI_RUN] Failed to queue callback webhook', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
