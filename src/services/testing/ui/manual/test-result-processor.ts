import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService, dbService } from '@/db/supabase';
import { TestCompletionHandlerService } from '@/services/testing/results/test-completion-handler.service';
import { ApiResponse, BrowserType, TestResult } from '@/types';
import { logger, logTestEvent } from '@/utils/core/logger';
import { getTest, getTestResults } from './test-queries';

/**
 * Check if test is complete and handle completion notifications
 * @param testId - The test ID to check
 */
export async function checkAndHandleTestCompletion(testId: string): Promise<void> {
  try {
    logger.info('[MANUAL_TEST_SERVICE] Checking test completion', { testId });

    // Get test details
    const testResponse = await getTest(testId);
    if (!testResponse.success || !testResponse.data) {
      logger.warn('[MANUAL_TEST_SERVICE] Test not found for completion check', { testId });
      return;
    }

    const test = testResponse.data;

    // Get all results for this test
    const resultsResponse = await getTestResults(testId);
    const results = resultsResponse.data || [];

    // Check if all browsers have completed (either 'completed', 'failed', 'cancelled', or 'timeout')
    const expectedBrowsers = test.browsers || [];
    const completedBrowsers = results.filter(result =>
      ['completed', 'failed', 'cancelled', 'timeout'].includes(result.status)
    );

    const isTestComplete = expectedBrowsers.length > 0 &&
      expectedBrowsers.every(browser =>
        completedBrowsers.some(result => result.browser === browser)
      );

    logger.info('[MANUAL_TEST_SERVICE] Test completion check', {
      testId,
      expectedBrowsers: expectedBrowsers.length,
      completedBrowsers: completedBrowsers.length,
      isComplete: isTestComplete,
    });

    if (isTestComplete) {
      // ✅ FIX #8: Determine final status based on results (not always 'completed')
      // Priority: cancelled > timeout > failed > completed
      const hasCancelled = results.some(r => r.status === 'cancelled');
      const hasTimeout = results.some(r => r.status === 'timeout');
      const hasFailed = results.some(r => r.status === 'failed' || r.status === 'timeout');

      let finalStatus: 'completed' | 'failed' | 'cancelled';
      if (hasCancelled) {
        finalStatus = 'cancelled';
      } else if (hasFailed) {
        finalStatus = 'failed';
      } else {
        finalStatus = 'completed';
      }

      // Update test status to final status
      await dbService.updateTest(testId, {
        status: finalStatus,
        completed_at: new Date().toISOString(),
      });

      logger.info('[MANUAL_TEST_SERVICE] Test marked as finished', {
        testId,
        finalStatus,
        hasCancelled,
        hasFailed,
      });

      // Notify all associated chat sessions
      await TestCompletionHandlerService.handleTestCompletion(testId);

      logTestEvent('completed', testId, {
        totalBrowsers: expectedBrowsers.length,
        completedBrowsers: completedBrowsers.length,
      });
    }

  } catch (error) {
    logger.error('[MANUAL_TEST_SERVICE] Error checking test completion', {
      error,
      testId,
    });
    // Don't throw error - this is a background process
  }
}

/**
 * Process test result from agent
 */
export async function processTestResult(resultData: {
  testId: string;
  browser: BrowserType;
  status: string;
  screenshot?: string;
  dom?: string;
  logs: string[];
  networkLogs: any[];
  errors: any[];
  performance?: any;
}): Promise<ApiResponse<TestResult>> {
  try {
    logger.info(`Processing test result: ${resultData.testId} (${resultData.browser})`);

    // Upload screenshot to storage if provided and looks like base64
    let screenshotUrl: string | undefined = undefined;
    if (resultData.screenshot) {
      try {
        // Resolve user ID for storage path (tests table stores user_id)
        let userIdForStorage: string | undefined;
        try {
          const testRecord = await dbAdminService.getTest(resultData.testId) as any;
          userIdForStorage = testRecord?.user_id;
        } catch (lookupError) {
          logger.warn('[MANUAL_TEST_SERVICE] Failed to resolve user_id for screenshot storage', {
            testId: resultData.testId,
            error: lookupError instanceof Error ? lookupError.message : String(lookupError),
          });
        }

        if (!userIdForStorage) {
          logger.warn('[MANUAL_TEST_SERVICE] user_id is missing for test, falling back to testId for storage path', {
            testId: resultData.testId,
          });
          userIdForStorage = resultData.testId;
        }

        const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

        // NOTE: For manual tests we always store screenshot as URL, not base64
        screenshotUrl = await uploadScreenshotToStorage(
          resultData.screenshot,
          resultData.testId,
          // Use real userId for storage path when available (preferred),
          // fallback to testId only if user_id is missing.
          userIdForStorage,
        );
      } catch (screenshotError) {
        logger.error('[MANUAL_TEST_SERVICE] Failed to upload screenshot to storage', {
          testId: resultData.testId,
          browser: resultData.browser,
          error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
        });
        // Do not fail the whole result processing because of screenshot upload
      }
    }

    // Decide what to store in DB:
    // - Prefer public URL from storage
    // - Fallback to original base64 if upload failed (to avoid data loss)
    const screenshotToStore = screenshotUrl || resultData.screenshot || null;

    // Create test result record
    const testResult = await dbAdminService.createTestResult({
      test_id: resultData.testId,
      browser: resultData.browser,
      status: resultData.status as any,
      screenshot: screenshotToStore,
      dom: resultData.dom,
      logs: resultData.logs,
      network_logs: resultData.networkLogs,
      errors: resultData.errors,
      performance: resultData.performance,
      completed_at: new Date().toISOString(),
    }) as any;

    // Add AI analysis job
    await QueueManager.addAIAnalysisJob(testResult.id, resultData.testId);

    // ADR-0012 — best-effort visual anomaly sweep. No-ops internally when
    // VISUAL_ANOMALY_SWEEP_ENABLED is off. Note: manual/lite runs have no
    // regression_run_id, so the job itself will skip (see
    // visual-anomaly-sweep.job.ts) — enqueued unconditionally here for
    // parity with addAIAnalysisJob rather than duplicating that check here.
    await QueueManager.addVisualAnomalySweepJob(testResult.id, resultData.testId);

    // TODO: Auto-generate final report after AI analysis completes
    // After aiAnalysisQueue finishes, call:
    // await TestReportGeneratorService.generateFinalReport({
    //   testId: resultData.testId,
    //   testResult: testResult,
    //   testPlan: await getTestPlan(...),
    //   aiAnalysis: await getAIAnalysis(...),
    // });
    // Options:
    // 1. Add to AI analysis worker (recommended - after AI analysis)
    // 2. Add here (immediate - without AI analysis)
    // 3. User-triggered only (manual via API)

    // Check if test is complete and notify chat sessions
    await checkAndHandleTestCompletion(resultData.testId);

    logTestEvent('result_processed', resultData.testId, {
      browser: resultData.browser,
      status: resultData.status
    });

    return {
      success: true,
      data: testResult,
      message: 'Test result processed successfully',
      timestamp: new Date(),
    };

  } catch (error) {
    logger.error(`Failed to process test result: ${resultData.testId}`, error);
    throw error;
  }
}
