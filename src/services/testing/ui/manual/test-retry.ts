import { QueueManager } from '@/config/queues';
import { dbService } from '@/db/supabase';
import { ApiResponse, NotFoundError, Test, ValidationError } from '@/types';
import { logger, logTestEvent } from '@/utils/logger';
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

    // Reset test status
    const updatedTest = await dbService.updateTest(testId, {
      status: 'pending',
      started_at: null,
      completed_at: null,
    }) as any;

    // Add jobs to queue for each browser
    // IMPORTANT: Restore full AI context (commands, testGoal, etc.)
    for (const browser of test.browsers) {
      await QueueManager.addTestRunJob({
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
      });
    }

    // Deduct credits
    await deductCredits(
      userId,
      test.id,
      test.browsers,
      test.intelligent_mode,
      test.options?.estimatedCost
    );

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
