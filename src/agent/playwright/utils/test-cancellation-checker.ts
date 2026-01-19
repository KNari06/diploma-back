import { TestRunRegistry } from '@/agent/playwright/core/test-run-registry';
import { dbAdminService } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

// Track consecutive DB timeouts per testId
const dbTimeoutCounter = new Map<string, number>();
const MAX_CONSECUTIVE_TIMEOUTS = 3;
// If DB is unstable/unreachable, temporarily disable DB cancellation checks for this testId.
// We still keep the in-process cancellation fast-path via TestRunRegistry.
const dbCancelCheckDisabledUntil = new Map<string, number>();
const DISABLE_DB_CANCEL_CHECK_MS = 60_000; // 60s cooldown

/**
 * Check if test is cancelled and throw error if so
 * ✅ FIX: Added timeout to prevent hanging on DB issues
 * ✅ FIX: Increased timeout to 5s, tracks consecutive timeouts to surface persistent issues
 * ✅ FIX: Also checks in-process registry for immediate cancellation detection
 * ✅ Uses testId-level methods (checks ALL browser runs for this test)
 */
export async function checkTestCancelled(testId: string): Promise<void> {
  // 1. Fast path: Check in-process registry first (immediate, no DB call)
  if (TestRunRegistry.isCancelledByTestId(testId)) {
    // Best-effort: make sure all runs for this test are aborted
    const runKeys = TestRunRegistry.getRunKeysByTestId(testId);
    for (const runKey of runKeys) {
      const run = TestRunRegistry.get(runKey);
      if (run && !run.state.isTestCompleted) {
        await TestRunRegistry.abortRun(runKey, 'cancelled', 0).catch(() => { });
      }
    }
    throw new Error(`Test ${testId} was cancelled`);
  }

  try {
    // If DB cancellation checks are temporarily disabled, skip DB call.
    const disabledUntil = dbCancelCheckDisabledUntil.get(testId);
    if (disabledUntil && Date.now() < disabledUntil) {
      return;
    }

    // 2. Slow path: Check DB for cancellation (with timeout)
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Cancellation check timeout')), 5000); // Increased to 5s
    });

    const checkPromise = dbAdminService.getTest(testId);

    const test = await Promise.race([checkPromise, timeoutPromise]) as any;

    // Reset timeout counter on successful check
    dbTimeoutCounter.delete(testId);

    if (test?.status === 'cancelled') {
      // Mark in registry for fast future checks (all runs for this test)
      TestRunRegistry.setCancelledByTestId(testId);
      // ✅ Red button: abort all runs for this test (closes contexts, stops video)
      await TestRunRegistry.abortByTestId(testId, 'cancelled', 0).catch(() => { });
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

      // After N consecutive timeouts, disable DB cancellation checks temporarily.
      // IMPORTANT: This must NOT fail the test run. It only means "remote cancel can't be detected right now".
      if (currentCount >= MAX_CONSECUTIVE_TIMEOUTS) {
        dbTimeoutCounter.delete(testId);
        dbCancelCheckDisabledUntil.set(testId, Date.now() + DISABLE_DB_CANCEL_CHECK_MS);
        logger.warn('[PLAYWRIGHT] Disabling DB cancellation checks temporarily', {
          testId,
          disableMs: DISABLE_DB_CANCEL_CHECK_MS,
        });
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
export function createCancellationPromise(testId: string, abortSignal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    // Check immediately
    if (TestRunRegistry.isCancelledByTestId(testId)) {
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
    const cleanupTimeout = setTimeout(() => clearInterval(interval), 5 * 60 * 1000);

    // ✅ CRITICAL FIX: prevent interval leaks.
    // When the main operation finishes (race resolves), caller will abort this signal.
    // Without this, intervals accumulate and spam DB + logs, and can starve timers.
    if (abortSignal) {
      if (abortSignal.aborted) {
        clearInterval(interval);
        clearTimeout(cleanupTimeout);
        return;
      }
      abortSignal.addEventListener('abort', () => {
        clearInterval(interval);
        clearTimeout(cleanupTimeout);
      }, { once: true });
    }
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
  if (TestRunRegistry.isCancelledByTestId(testId)) {
    throw new Error(`Test ${testId} was cancelled`);
  }

  // ✅ FIX: Ensure cancellation polling is disposed when operation settles.
  const controller = new AbortController();
  const cancellationPromise = createCancellationPromise(testId, controller.signal);

  try {
    return await Promise.race([operation, cancellationPromise]);
  } catch (error) {
    if (error instanceof Error && error.message.includes('cancelled')) {
      logger.info(`[CANCELLATION] Operation cancelled: ${operationName || 'unknown'}`, {
        testId,
      });
    }
    throw error;
  } finally {
    // Abort polling interval to avoid leaks
    // (createCancellationPromise listens to this abortSignal)
    controller.abort();
  }
}

/**
 * Clean up timeout counter for a test (call on test completion)
 */
export function cleanupCancellationState(testId: string): void {
  dbTimeoutCounter.delete(testId);
  dbCancelCheckDisabledUntil.delete(testId);
}
