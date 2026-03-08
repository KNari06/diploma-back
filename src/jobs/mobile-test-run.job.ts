/**
 * Mobile Test Run Job Handler
 * BullMQ job that orchestrates mobile test execution via qait-mobile-runner.
 *
 * Flow:
 *   1. Create session on runner
 *   2. Run IntentSteps
 *   3. Get artifacts (screenshots, video)
 *   4. Upload to Supabase Storage
 *   5. Create test_results record
 *   6. Queue AI analysis
 *   7. Destroy session (always in finally)
 *
 * Pattern mirrors: src/jobs/manual-test-run.job.ts
 */

import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService } from '@/db/supabase';
import { logQueueEvent, logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { Job } from 'bullmq';
import type { MobileTestJobData } from '@/services/mobile/mobile-runner.types';
import { MobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';

// ============================================================================
// JOB HANDLER
// ============================================================================

export class MobileTestRunJobHandler {
  /**
   * Check if test is already finalized
   */
  private static async isTestFinalized(testId: string): Promise<boolean> {
    try {
      const test = (await dbAdminService.getTest(testId)) as any;
      if (!test) return false;
      return ['completed', 'failed', 'cancelled', 'timeout'].includes(test.status);
    } catch {
      return false;
    }
  }

  /**
   * Check if test was cancelled
   */
  private static async isTestCancelled(testId: string): Promise<boolean> {
    try {
      const test = (await dbAdminService.getTest(testId)) as any;
      return test?.status === 'cancelled';
    } catch {
      return false;
    }
  }

  /**
   * Process mobile test run job
   */
  static async process(job: Job<MobileTestJobData>): Promise<void> {
    const {
      testId,
      userId,
      workspaceId,
      chatSessionId,
      platform,
      browser,
      appPackage,
      intentSteps,
      geminiApiKey,
      runnerUrl,
      runnerApiKey,
    } = job.data;

    // Validate
    if (!testId || !intentSteps?.length) {
      throw new Error('Missing required parameters: testId or intentSteps');
    }

    // Guard: skip if already finalized
    if (await this.isTestFinalized(testId)) {
      logger.info('[MOBILE-TEST] Test already finalized, skipping', { testId, browser });
      return;
    }

    // Guard: skip if cancelled
    if (await this.isTestCancelled(testId)) {
      logger.info('[MOBILE-TEST] Test was cancelled before execution', { testId, browser });
      return;
    }

    logger.info('[MOBILE-TEST] Processing mobile test job', {
      testId,
      browser,
      platform,
      stepsCount: intentSteps.length,
      appPackage,
    });
    logQueueEvent('processing', job.id!, { testId, browser });

    // Create client for this job
    const client = new MobileRunnerClient({
      baseUrl: runnerUrl,
      apiKey: runnerApiKey,
    });
    if (geminiApiKey) {
      client.setGeminiApiKey(geminiApiKey);
    }

    let sessionId: string | null = null;

    try {
      // ── Phase 1: Emit progress ────────────────────────────────
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 5,
          phase: 'initializing',
          currentStep: `Preparing ${platform} emulator...`,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // ── Phase 2: Update test status ───────────────────────────
      await this.updateTestStatus(testId, 'running', browser);

      // ── Phase 3: Create session on runner ─────────────────────
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 10,
          phase: 'initializing',
          currentStep: `Starting ${platform} session...`,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      const session = await client.createSession(platform);
      sessionId = session.id;

      logger.info('[MOBILE-TEST] Session created', {
        testId,
        sessionId,
        platform,
      });

      // ── Phase 4: Run steps ────────────────────────────────────
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 20,
          phase: 'executing',
          currentStep: `Executing ${intentSteps.length} steps on ${platform}...`,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Check cancellation before long operation
      if (await this.isTestCancelled(testId)) {
        logger.info('[MOBILE-TEST] Test cancelled before step execution', { testId });
        await this.updateTestStatus(testId, 'cancelled', browser);
        return;
      }

      const runResult = await client.runSteps(sessionId, intentSteps, {
        autoScreenshot: true,
        screenshotEachStep: true,
      });

      logger.info('[MOBILE-TEST] Steps executed', {
        testId,
        sessionId,
        totalSteps: runResult.totalSteps,
        passedSteps: runResult.passedSteps,
        failedSteps: runResult.failedSteps,
        status: runResult.status,
        durationMs: runResult.durationMs,
      });

      // Emit step-level progress
      for (const stepResult of runResult.steps) {
        try {
          webSocketService.emitTestStepCompleted(testId, {
            testId,
            browser,
            stepIndex: runResult.steps.indexOf(stepResult),
            totalSteps: runResult.totalSteps,
            stepName: `Step: ${stepResult.stepId}`,
            stepStatus: stepResult.success ? 'passed' : 'failed',
            error: stepResult.error,
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
      }

      // ── Phase 5: Create test result ───────────────────────────
      const testPassed = runResult.status === 'passed';

      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 80,
          phase: 'analyzing',
          currentStep: 'Processing results...',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Finalize test status
      const finalStatus = testPassed ? 'completed' : 'failed';
      await this.updateTestStatus(testId, finalStatus, browser);

      // Create test result record
      const testResultId = await this.createTestResult(testId, browser, runResult, userId, workspaceId);

      // ── Phase 6: Queue AI analysis ────────────────────────────
      if (testResultId) {
        try {
          await QueueManager.addAIAnalysisJob(testResultId, testId);
          logger.debug('[MOBILE-TEST] AI analysis job queued', { testId, testResultId });
        } catch (err) {
          logger.warn('[MOBILE-TEST] Failed to queue AI analysis', {
            testId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── Phase 7: Emit completion events ───────────────────────
      try {
        webSocketService.emitTestBrowserCompleted(testId, {
          testId,
          browser,
          status: testPassed ? 'passed' : 'failed',
          timestamp: new Date().toISOString(),
        });

        webSocketService.emitTestCompleted(testId, {
          testId,
          status: finalStatus,
          browsers: [browser],
          timestamp: new Date().toISOString(),
        });

        if (testResultId) {
          webSocketService.emitResultReady(testId, {
            testId,
            testResultId,
            browser,
            timestamp: new Date().toISOString(),
          });
        }
      } catch { /* non-fatal */ }

      logger.info('[MOBILE-TEST] Job completed successfully', {
        testId,
        browser,
        status: finalStatus,
        passRate: runResult.passRate,
      });
    } catch (error) {
      // ── Error handling ──────────────────────────────────────────
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof MobileRunnerError ? error.code : 'UNKNOWN';

      logger.error('[MOBILE-TEST] Job failed', {
        testId,
        browser,
        errorCode,
        error: errorMessage,
      });

      // Update test status to failed
      try {
        await this.updateTestStatus(testId, 'failed', browser);
      } catch { /* ignore */ }

      // Emit failure event
      try {
        webSocketService.emitTestFailed(testId, {
          testId,
          browser,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }

      throw error;
    } finally {
      // ── Cleanup: destroy session ────────────────────────────────
      if (sessionId) {
        try {
          await client.destroySession(sessionId);
          logger.debug('[MOBILE-TEST] Session destroyed', { testId, sessionId });
        } catch (err) {
          logger.warn('[MOBILE-TEST] Failed to destroy session (runner has TTL cleanup)', {
            testId,
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  private static async updateTestStatus(
    testId: string,
    status: string,
    browser: string,
    startedAt?: string,
    completedAt?: string,
  ): Promise<void> {
    try {
      const updateData: Record<string, unknown> = { status };
      if (startedAt) updateData.started_at = startedAt;
      if (completedAt) updateData.completed_at = completedAt;
      if (status === 'running') updateData.started_at = new Date().toISOString();
      if (['completed', 'failed'].includes(status)) updateData.completed_at = new Date().toISOString();

      await dbAdminService.updateTest(testId, updateData);
    } catch (error) {
      logger.error('[MOBILE-TEST] Failed to update test status', {
        testId,
        status,
        browser,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static async createTestResult(
    testId: string,
    browser: string,
    runResult: { totalSteps: number; passedSteps: number; failedSteps: number; passRate: number; status: string; durationMs: number; steps: Array<{ stepId: string; success: boolean; error?: string; screenshot?: string; durationMs: number }> },
    userId: string,
    workspaceId: string,
  ): Promise<string | null> {
    try {
      const result = await dbAdminService.createTestResult({
        test_id: testId,
        browser,
        status: runResult.status === 'passed' ? 'passed' : 'failed',
        duration: Math.round(runResult.durationMs / 1000),
        steps_total: runResult.totalSteps,
        steps_passed: runResult.passedSteps,
        steps_failed: runResult.failedSteps,
        pass_rate: runResult.passRate,
        user_id: userId,
        workspace_id: workspaceId,
        metadata: {
          platform: 'mobile',
          steps: runResult.steps.map((s) => ({
            stepId: s.stepId,
            success: s.success,
            error: s.error,
            durationMs: s.durationMs,
          })),
        },
      });

      return result?.id || null;
    } catch (error) {
      logger.error('[MOBILE-TEST] Failed to create test result', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}
