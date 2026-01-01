import { QueueManager } from '@/config/infrastructure/queues';
import { dbService, supabaseAdmin } from '@/db/supabase';
import { ApiResponse, NotFoundError, Test, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/core/logger';
import { checkUserCredits, deductCredits } from './test-credits';

/**
 * Retry a failed test
 * - For intelligent mode: Retry with same plan (Variant A) on first attempt
 * - If retryCount >= 2: Switch to Variant B (regenerate plan) - handled by user
 */
export async function retryTest(testId: string, userId?: string): Promise<ApiResponse<Test>> {
  try {
    const test = await dbService.getTest(testId) as any;
    if (!test) {
      throw new NotFoundError('Test', testId);
    }

    if (!userId) {
      throw new ValidationError('User ID is required');
    }

    if (test.user_id !== userId) {
      throw new ValidationError('Access denied to this test');
    }

    if (test.status !== 'failed') {
      throw new ValidationError('Can only retry failed tests');
    }

    logger.info('[RETRY_TEST] Retrying test', {
      testId,
      intelligentMode: test.intelligent_mode,
      userId: userId.substring(0, 8) + '...',
    });

    // Check user credits (with intelligent mode consideration)
    await checkUserCredits(
      userId,
      test.browsers,
      test.intelligent_mode,
      test.options?.estimatedCost // May be stored in options from original test
    );

    // ✅ FIX #18: Delete old test results before retry to prevent stale data
    try {
      const { error: deleteError } = await supabaseAdmin
        .from('test_results')
        .delete()
        .eq('test_id', testId);

      if (deleteError) {
        logger.warn('[RETRY_TEST] Failed to delete old test results', {
          testId,
          error: deleteError.message,
        });
        // Don't fail retry if deletion fails - old results will be overwritten
      } else {
        logger.info('[RETRY_TEST] Deleted old test results', { testId });
      }
    } catch (deleteError) {
      logger.warn('[RETRY_TEST] Failed to delete old test results', {
        testId,
        error: deleteError instanceof Error ? deleteError.message : String(deleteError),
      });
    }

    // ✅ FIX #16: Add jobs to queue BEFORE updating status
    // This ensures we don't set status to 'pending' if queueing fails
    // IMPORTANT: Restore full AI context (commands, testGoal, etc.)
    const queuedJobs: string[] = [];
    for (const browser of test.browsers) {
      const job = await QueueManager.addTestRunJob({
        testId: test.id,
        url: test.url,
        browser,
        options: test.options,
        projectId: test.project_id,
        userId: test.user_id,
        // Restore AI context from DB
        commands: test.commands || [], // Playwright commands
        intent: test.test_goal || undefined, // Use test_goal as intent
        intelligentMode: test.intelligent_mode || false,
        testGoal: test.test_goal || undefined,
        retryCount: 1, // Variant A: Retry with same plan (first retry)
        mode: 'lite', // Default to 'lite' for retries (tests table doesn't have mode column)
      });
      queuedJobs.push(job.id || 'unknown');
    }

    logger.info('[RETRY_TEST] All jobs queued successfully', {
      testId,
      queuedJobs: queuedJobs.length,
    });

    // ✅ FIX #17: Deduct credits AFTER successful queueing (before status update)
    // This ensures we only charge if jobs are actually queued
    await deductCredits(
      userId,
      test.id,
      test.browsers,
      test.intelligent_mode,
      test.options?.estimatedCost
    );

    // ✅ FIX #16: Reset test status AFTER queueing and credit deduction
    // This ensures status is only updated if everything succeeded
    const updatedTest = await dbService.updateTest(testId, {
      status: 'pending',
      started_at: null,
      completed_at: null,
    }) as any;

    logTestEvent('retried', testId, {
      userId,
      browsers: test.browsers,
      intelligentMode: test.intelligent_mode,
    });

    return {
      success: true,
      data: updatedTest,
      message: test.intelligent_mode
        ? 'Intelligent test retry initiated (using same plan)'
        : 'Test retry initiated successfully',
      timestamp: new Date(),
    };

  } catch (error) {
    logger.error(`Failed to retry test ${testId}:`, error);
    throw error;
  }
}
