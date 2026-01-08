import { TestRunRegistry } from '@/agent/playwright/core/test-run-registry';
import { dbAdminService } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

// Track consecutive DB timeouts per testId
const dbTimeoutCounter = new Map<string, number>();
const MAX_CONSECUTIVE_TIMEOUTS = 3;

/**
 * Check if test is cancelled and throw error if so
 * ✅ FIX: Added timeout to prevent hanging on DB issues
 * ✅ FIX: Increased timeout to 5s, tracks consecutive timeouts to surface persistent issues
 * ✅ FIX: Also checks in-process registry for immediate cancellation detection
 */
export async function checkTestCancelled(testId: string): Promise<void> {
  // 1. Fast path: Check in-process registry first (immediate, no DB call)
  if (TestRunRegistry.isCancelled(testId)) {
    // Best-effort: make sure the run is actually aborted (context closed, video stopped)
    const run = TestRunRegistry.get(testId);
    if (run && !run.state.isTestCompleted) {
      await TestRunRegistry.abortTestRun(testId, 'cancelled', 0).catch(() => {});
    }
    throw new Error(`Test ${testId} was cancelled`);
  }

  try {
    // 2. Slow path: Check DB for cancellation (with timeout)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Cancellation check timeout')), 5000); // Increased to 5s
    });

    const checkPromise = dbAdminService.getTest(testId);

    const test = await Promise.race([checkPromise, timeoutPromise]) as any;

    // Reset timeout counter on successful check
    dbTimeoutCounter.delete(testId);

    if (test?.status === 'cancelled') {
      // Mark in registry for fast future checks
      TestRunRegistry.setCancelled(testId);
      // ✅ Red button: abort immediately in THIS worker process (closes context, stops video)
      await TestRunRegistry.abortTestRun(testId, 'cancelled', 0).catch(() => {});
      throw new Error(`Test ${testId} was cancelled`);
    }
  } catch (error) {
    // If error is already about cancellation, rethrow it
    if (error instanceof Error && error.message.includes('cancelled')) {
      throw error;
    }

    // Track consecutive timeouts
    if (error instanceof Error && error.message.includes('timeout')) {
      const currentCount = (dbTimeoutCounter.get(testId) || 0) + 1;
      dbTimeoutCounter.set(testId, currentCount);

      logger.warn(`[PLAYWRIGHT] Cancellation check timed out for test: ${testId}`, {
        error: error.message,
        consecutiveTimeouts: currentCount,
        maxAllowed: MAX_CONSECUTIVE_TIMEOUTS,
      });

      // After N consecutive timeouts, throw to surface the issue
      if (currentCount >= MAX_CONSECUTIVE_TIMEOUTS) {
        dbTimeoutCounter.delete(testId);
        throw new Error(`Test ${testId} cancellation check failed: DB unreachable (${currentCount} timeouts)`);
      }

      // Don't block execution on occasional timeouts
      return;
    }

    // Otherwise, log warning but don't block execution
    logger.warn(`[PLAYWRIGHT] Failed to check test status: ${testId}`, error);
  }
}

/**
 * Create a cancellation promise that rejects when test is cancelled
 * Use with Promise.race to add cancellation points to long-running operations
 */
export function createCancellationPromise(testId: string): Promise<never> {
  return new Promise((_, reject) => {
    // Check immediately
    if (TestRunRegistry.isCancelled(testId)) {
      reject(new Error(`Test ${testId} was cancelled`));
      return;
    }

    // Poll every 500ms
    const interval = setInterval(async () => {
      try {
        await checkTestCancelled(testId);
      } catch (error) {
        clearInterval(interval);
        reject(error);
      }
    }, 500);

    // Clean up interval after 5 minutes (safety limit)
    setTimeout(() => clearInterval(interval), 5 * 60 * 1000);
  });
}

/**
 * Wrap a long-running promise with cancellation support
 * Races the operation against cancellation checks
 */
export async function withCancellation<T>(
  testId: string,
  operation: Promise<T>,
  operationName?: string
): Promise<T> {
  // Fast check before starting
  if (TestRunRegistry.isCancelled(testId)) {
    throw new Error(`Test ${testId} was cancelled`);
  }

  const cancellationPromise = createCancellationPromise(testId);

  try {
    return await Promise.race([operation, cancellationPromise]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('cancelled')) {
      logger.info(`[CANCELLATION] Operation cancelled: ${operationName || 'unknown'}`, {
        testId,
      });
    }
    throw error;
  }
}

/**
 * Clean up timeout counter for a test (call on test completion)
 */
export function cleanupCancellationState(testId: string): void {
  dbTimeoutCounter.delete(testId);
}
