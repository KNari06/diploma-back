import { dbAdminService } from '@/db/supabase';
import { logger } from '@/utils/logger';

/**
 * Check if test is cancelled and throw error if so
 */
export async function checkTestCancelled(testId: string): Promise<void> {
  try {
    const test = await dbAdminService.getTest(testId) as any;
    if (test?.status === 'cancelled') {
      throw new Error(`Test ${testId} was cancelled`);
    }
  } catch (error) {
    // If error is already about cancellation, rethrow it
    if (error instanceof Error && error.message.includes('cancelled')) {
      throw error;
    }
    // Otherwise, log warning but don't block execution
    logger.warn(`[PLAYWRIGHT] Failed to check test status: ${testId}`, error);
  }
}
