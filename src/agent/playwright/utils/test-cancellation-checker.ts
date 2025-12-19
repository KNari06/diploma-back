import { dbAdminService } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * Check if test is cancelled and throw error if so
 * ✅ FIX #10: Added timeout to prevent hanging on DB issues
 */
export async function checkTestCancelled(testId: string): Promise<void> {
  try {
    // ✅ FIX #10: Add timeout to DB call (2 seconds max)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Cancellation check timeout')), 2000);
    });

    const checkPromise = dbAdminService.getTest(testId);

    const test = await Promise.race([checkPromise, timeoutPromise]) as any;

    if (test?.status === 'cancelled') {
      throw new Error(`Test ${testId} was cancelled`);
    }
  } catch (error) {
    // If error is already about cancellation, rethrow it
    if (error instanceof Error && error.message.includes('cancelled')) {
      throw error;
    }

    // ✅ FIX #10: Log timeout errors but don't block execution
    if (error instanceof Error && error.message.includes('timeout')) {
      logger.warn(`[PLAYWRIGHT] Cancellation check timed out for test: ${testId}`, {
        error: error.message,
      });
      // Don't block execution on timeout - assume test is not cancelled
      return;
    }

    // Otherwise, log warning but don't block execution
    logger.warn(`[PLAYWRIGHT] Failed to check test status: ${testId}`, error);
  }
}
