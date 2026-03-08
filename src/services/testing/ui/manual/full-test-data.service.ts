import { supabaseAdmin } from '@/db/supabase';
import { IntelligentTestStorageService } from '@/services/testing/results/intelligent-test-storage.service';
import { TestExecutedStepsRedisService } from '@/services/testing/results/test-executed-steps-redis.service';
import { TestReportGeneratorService } from '@/services/testing/results/test-report-generator.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';

/**
 * Extracted from manualTest.route.ts GET /:id/full handler.
 * Provides full test data (screenshots, videos, logs, errors, AI analysis)
 * for a given testId — reusable by both the manual-test route and
 * the regression execution-detail endpoint.
 */
export class FullTestDataService {
  /**
   * Get comprehensive test data by testId + userId.
   * Throws NotFoundError if test not found; ValidationError if access denied.
   */
  static async getFullTestData(testId: string, userId: string): Promise<any> {
    // 1. Get test basic info
    const testResponse = await ManualTestService.getTest(testId, userId);
    if (!testResponse.success || !testResponse.data) {
      throw new NotFoundError('Test', testId);
    }

    const test = testResponse.data;

    // 2. Get test results with all details
    const resultsResponse = await ManualTestService.getTestResults(testId, userId);
    const results = resultsResponse.data || [];

    // 3. Get test report (includes generated code)
    let report = null;
    try {
      report = await TestReportGeneratorService.getReportByTestId(testId);
    } catch (error) {
      logger.warn('[FULL_TEST_DATA] Report not found or error getting report', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 4. Get intelligent test session (if exists)
    let intelligentSession = null;
    try {
      const { data: sessions, error: sessionError } = await supabaseAdmin
        .from('intelligent_test_sessions')
        .select('id')
        .eq('test_id', testId)
        .limit(1);

      if (!sessionError && sessions && sessions.length > 0) {
        intelligentSession = await IntelligentTestStorageService.getTestSession(sessions[0].id);
      }
    } catch (error) {
      logger.warn('[FULL_TEST_DATA] Error getting intelligent session', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // 5. Get trace files (for videos/traces)
    const { data: traceFiles, error: traceError } = await supabaseAdmin
      .from('trace_files')
      .select(`
        id, test_id, user_id, file_name, storage_path, file_size,
        browser, status, public_url, parsed_data, parsed_at, created_at
      `)
      .eq('test_id', testId)
      .order('created_at', { ascending: false });

    if (traceError) {
      logger.warn('[FULL_TEST_DATA] Error getting trace files', {
        testId,
        error: traceError,
      });
    }

    // 6. Convert screenshots
    const screenshotUrlMap = await this.convertScreenshotsToUrls(
      results.map((r: any) => ({ id: r.id, screenshot: r.screenshot, browser: r.browser })),
      testId,
      userId,
    );

    const screenshots = (results as any[])
      .filter(r => r.screenshot)
      .map(r => ({
        browser: r.browser,
        url: screenshotUrlMap.get(r.id) || null,
        screenshot: screenshotUrlMap.get(r.id) || null,
        status: r.status,
        completed_at: r.completedAt ?? r.completed_at,
      }))
      .filter(s => s.url !== null);

    // 7. Collect videos (deduplicated — prefer test_results, fall back to trace_files)
    const seenVideoUrls = new Set<string>();
    const videos: Array<Record<string, unknown>> = [];
    for (const r of results as any[]) {
      const url = r.video_url || r.videoUrl;
      if (url && !seenVideoUrls.has(url)) {
        seenVideoUrls.add(url);
        videos.push({ browser: r.browser, url, status: r.status, completed_at: r.completedAt ?? r.completed_at });
      }
    }
    for (const tf of (traceFiles || []).filter((t: any) => t.public_url && t.file_name?.endsWith('.webm'))) {
      if (!seenVideoUrls.has(tf.public_url)) {
        seenVideoUrls.add(tf.public_url);
        videos.push({ browser: tf.browser, url: tf.public_url, file_name: tf.file_name, file_size: tf.file_size, created_at: tf.created_at });
      }
    }

    // 8. Collect logs
    const allLogs = results
      .filter((r: any) => r.logs && Array.isArray(r.logs) && r.logs.length > 0)
      .map((r: any) => ({
        browser: r.browser,
        logs: r.logs || [],
        status: r.status,
      }));

    // 9. Collect network logs
    const networkLogs = results
      .filter((r: any) => {
        const nl = r.network_logs ?? r.networkLogs;
        return nl && Array.isArray(nl) && nl.length > 0;
      })
      .map((r: any) => ({
        browser: r.browser,
        network_logs: r.network_logs ?? r.networkLogs ?? [],
        status: r.status,
      }));

    // 10. Collect errors
    const errors = results
      .filter((r: any) => r.errors && Array.isArray(r.errors) && r.errors.length > 0)
      .map((r: any) => ({
        browser: r.browser,
        errors: r.errors || [],
        status: r.status,
      }));

    // 10.5 Live executed steps fallback (Redis) for running tests
    const rawExecutedSteps = (test as any).executed_steps ?? (test as any).executedSteps ?? null;
    const isRunning = test.status === 'running' || test.status === 'pending';
    const executedSteps = (isRunning && (!rawExecutedSteps || (Array.isArray(rawExecutedSteps) && rawExecutedSteps.length === 0)))
      ? await TestExecutedStepsRedisService.getLive(testId)
      : rawExecutedSteps;

    return {
      test: {
        id: test.id,
        url: test.url,
        project_id: (test as any).project_id ?? (test as any).projectId,
        user_id: (test as any).user_id ?? (test as any).userId,
        status: test.status,
        browsers: test.browsers,
        options: test.options,
        created_at: (test as any).created_at ?? (test as any).createdAt,
        updated_at: (test as any).updated_at ?? (test as any).updatedAt,
        started_at: (test as any).started_at ?? (test as any).startedAt,
        completed_at: (test as any).completed_at ?? (test as any).completedAt,
        intelligent_mode: (test as any).intelligent_mode ?? (test as any).intelligentMode,
        test_goal: (test as any).test_goal ?? (test as any).testGoal,
        executed_steps: executedSteps,
      },
      results: (results as any[]).map(r => ({
        id: r.id,
        test_id: r.test_id ?? r.testId,
        browser: r.browser,
        status: r.status,
        screenshot: screenshotUrlMap.get(r.id) || null,
        dom: r.dom,
        video_url: r.video_url ?? r.videoUrl,
        trace_url: r.trace_url ?? r.traceUrl,
        performance: r.performance,
        ai_summary: r.ai_summary ?? r.aiSummary ?? null,
        logs: r.logs || [],
        network_logs: r.network_logs ?? r.networkLogs ?? [],
        errors: r.errors || [],
        created_at: r.created_at ?? r.createdAt,
        completed_at: r.completed_at ?? r.completedAt,
      })),
      report: report ? {
        generatedCode: report.generatedCode,
        artifacts: report.artifacts,
        analysis: report.analysis,
        summary: report.summary,
      } : null,
      intelligentSession,
      traceFiles: traceFiles || [],
      screenshots,
      videos,
      logs: allLogs,
      networkLogs,
      errors,
    };
  }

  /**
   * Convert base64 screenshots to storage URLs (mirrors manualTest.route.ts helper)
   */
  private static async convertScreenshotsToUrls(
    results: Array<{ id: string; screenshot?: string | null; browser: string }>,
    testId: string,
    userId: string,
  ): Promise<Map<string, string | null>> {
    const urlMap = new Map<string, string | null>();
    const conversionsNeeded: Array<{ resultId: string; screenshot: string; index: number }> = [];

    results.forEach((r, index) => {
      if (!r.screenshot) {
        urlMap.set(r.id, null);
      } else if (r.screenshot.startsWith('http://') || r.screenshot.startsWith('https://')) {
        urlMap.set(r.id, r.screenshot);
      } else if (this.isBase64Screenshot(r.screenshot)) {
        conversionsNeeded.push({ resultId: r.id, screenshot: r.screenshot, index });
      } else {
        urlMap.set(r.id, null);
      }
    });

    if (conversionsNeeded.length === 0) return urlMap;

    try {
      const { uploadScreenshotToStorage } = await import('@/services/storage/test-artifacts-storage.service');

      const uploadResults = await Promise.allSettled(
        conversionsNeeded.map(async ({ resultId, screenshot, index }) => {
          const url = await uploadScreenshotToStorage(screenshot, testId, userId, index);
          return { resultId, url };
        }),
      );

      for (const result of uploadResults) {
        if (result.status === 'fulfilled') {
          const { resultId, url } = result.value;
          urlMap.set(resultId, url);
          // Update DB async (don't wait)
          void (async () => {
            try {
              await supabaseAdmin
                .from('test_results')
                .update({ screenshot: url })
                .eq('id', resultId);
            } catch { /* ignore */ }
          })();
        } else {
          const failedIndex = uploadResults.indexOf(result);
          const failedConversion = conversionsNeeded[failedIndex];
          if (failedConversion) urlMap.set(failedConversion.resultId, null);
        }
      }
    } catch (error) {
      logger.error('[FULL_TEST_DATA] Screenshot conversion failed', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
      conversionsNeeded.forEach(({ resultId }) => {
        if (!urlMap.has(resultId)) urlMap.set(resultId, null);
      });
    }

    return urlMap;
  }

  private static isBase64Screenshot(screenshot: string): boolean {
    if (screenshot.startsWith('data:image/')) return true;
    if (screenshot.startsWith('iVBOR')) return true;
    if (screenshot.startsWith('/9j/')) return true;
    return false;
  }
}
