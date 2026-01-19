/**
 * TestRunRegistry
 * Global in-process registry for managing active test runs
 *
 * Purpose:
 * - Track all active test executions with their resources (context, page, video stream)
 * - Enable immediate abort via abortRun(runKey) or abortByTestId(testId) - "Red Button"
 * - Manage cancellation/finalization flags to silence events after stop
 * - Prevent orphaned resources on cancel/shutdown
 *
 * Key concept: `runKey` = `${testId}:${browser}` for isolation of parallel browser runs
 */

import { logger } from '@/utils/core/logger';
import { BrowserContext, Page } from 'playwright';
import { VideoStreamRegistry } from '../artifacts/video-stream-registry';
import { VideoStreamService } from '../artifacts/video-stream.service';

/**
 * Create a unique run key from testId and browser
 */
export function createRunKey(testId: string, browser: string): string {
  return `${testId}:${browser}`;
}

/**
 * Parse runKey back to testId and browser
 */
export function parseRunKey(runKey: string): { testId: string; browser: string } {
  const lastColonIdx = runKey.lastIndexOf(':');
  if (lastColonIdx === -1) {
    return { testId: runKey, browser: 'unknown' };
  }
  return {
    testId: runKey.substring(0, lastColonIdx),
    browser: runKey.substring(lastColonIdx + 1),
  };
}

/**
 * State flags for a test run
 */
export interface TestRunState {
  isCancelled: boolean;
  isFinalizing: boolean;
  isTestCompleted: boolean;
}

/**
 * Resources tracked for a test run
 */
export interface TestRunResources {
  testId: string;
  browser: string;
  context: BrowserContext | null;
  page: Page | null;
  videoStreamService: VideoStreamService | null;
  state: TestRunState;
  createdAt: number;
}

/**
 * Global registry for active test runs
 * Enables immediate abort and resource cleanup
 *
 * Uses `runKey` (testId:browser) as primary key for isolation of parallel browser runs
 * Maintains a secondary index testId -> Set<runKey> for test-level operations
 */
class TestRunRegistryClass {
  /** Primary map: runKey -> resources */
  private runs = new Map<string, TestRunResources>();
  /** Secondary index: testId -> Set of runKeys for that test */
  private testIdIndex = new Map<string, Set<string>>();

  /**
   * Add runKey to testId index
   */
  private addToIndex(testId: string, runKey: string): void {
    let runKeys = this.testIdIndex.get(testId);
    if (!runKeys) {
      runKeys = new Set();
      this.testIdIndex.set(testId, runKeys);
    }
    runKeys.add(runKey);
  }

  /**
   * Remove runKey from testId index
   */
  private removeFromIndex(testId: string, runKey: string): void {
    const runKeys = this.testIdIndex.get(testId);
    if (runKeys) {
      runKeys.delete(runKey);
      if (runKeys.size === 0) {
        this.testIdIndex.delete(testId);
      }
    }
  }

  /**
   * Abort resources for an OLD run reference without touching the registry map.
   * ✅ Important: This prevents a race where register() overwrites the map entry
   * and would accidentally abort the NEW run instead of the old one.
   *
   * @param runKey - Run key (testId:browser)
   * @param run - The previous run resources snapshot
   * @param reason - Abort reason
   */
  private async abortRunResources(
    runKey: string,
    run: TestRunResources,
    reason: 'cancelled' | 'timeout' | 'error' | 'replaced' | 'shutdown'
  ): Promise<void> {
    try {
      logger.warn('[TEST_RUN_REGISTRY] Aborting previous run resources', {
        runKey,
        testId: run.testId,
        browser: run.browser,
        reason,
        hasContext: !!run.context,
        hasPage: !!run.page,
        hasVideoStream: !!run.videoStreamService,
      });

      // Mark flags on the OLD run to silence any emitters that consult it
      run.state.isCancelled = reason === 'cancelled';
      run.state.isFinalizing = true;
      run.state.isTestCompleted = true;

      // Stop video streaming first (best-effort)
      if (run.videoStreamService) {
        await Promise.race([
          run.videoStreamService.stop(reason === 'cancelled' ? 'cancelled' : 'error').catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)),
        ]);
        VideoStreamRegistry.unregister(runKey);
      }

      // Close BrowserContext to abort all Playwright operations (best-effort)
      if (run.context) {
        await Promise.race([
          run.context.close().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)),
        ]);
      }
    } catch (error) {
      logger.warn('[TEST_RUN_REGISTRY] Failed to abort previous run resources', {
        runKey,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Register a new test run with its resources
   * @param runKey - Unique run key (testId:browser) or testId for backwards compatibility
   * @param testId - Test ID (required for index)
   * @param browser - Browser name (required for index)
   * @param resources - Partial resources (context, page, videoStreamService)
   */
  register(
    runKey: string,
    testId: string,
    browser: string,
    resources: Partial<Omit<TestRunResources, 'state' | 'createdAt' | 'testId' | 'browser'>>
  ): void {
    // If there's already a run for this runKey, abort it first
    const existing = this.runs.get(runKey);
    if (existing) {
      logger.warn('[TEST_RUN_REGISTRY] Replacing existing run', { runKey, testId, browser });
      // ✅ FIX: Abort the OLD run by reference to avoid aborting the NEW run after map overwrite
      this.abortRunResources(runKey, existing, 'replaced').catch(() => {
        // Ignore cleanup errors
      });
      // Remove old from index (will be re-added below)
      this.removeFromIndex(existing.testId, runKey);
    }

    this.runs.set(runKey, {
      testId,
      browser,
      context: resources.context || null,
      page: resources.page || null,
      videoStreamService: resources.videoStreamService || null,
      state: {
        isCancelled: false,
        isFinalizing: false,
        isTestCompleted: false,
      },
      createdAt: Date.now(),
    });

    // Update index
    this.addToIndex(testId, runKey);

    logger.debug('[TEST_RUN_REGISTRY] Run registered', {
      runKey,
      testId,
      browser,
      hasContext: !!resources.context,
      hasPage: !!resources.page,
      hasVideoStream: !!resources.videoStreamService,
      totalRuns: this.runs.size,
    });
  }

  /**
   * Update resources for an existing test run
   * @param runKey - Run key (testId:browser)
   * @param resources - Partial resources to update
   */
  update(
    runKey: string,
    resources: Partial<Omit<TestRunResources, 'state' | 'createdAt' | 'testId' | 'browser'>>
  ): void {
    const run = this.runs.get(runKey);
    if (!run) {
      logger.warn('[TEST_RUN_REGISTRY] Cannot update non-existent run', { runKey });
      return;
    }

    if (resources.context !== undefined) run.context = resources.context;
    if (resources.page !== undefined) run.page = resources.page;
    if (resources.videoStreamService !== undefined) run.videoStreamService = resources.videoStreamService;

    logger.debug('[TEST_RUN_REGISTRY] Run updated', {
      runKey,
      hasContext: !!run.context,
      hasPage: !!run.page,
      hasVideoStream: !!run.videoStreamService,
    });
  }

  /**
   * Unregister a test run by runKey
   * @param runKey - Run key (testId:browser)
   */
  unregister(runKey: string): void {
    const run = this.runs.get(runKey);
    if (run) {
      this.removeFromIndex(run.testId, runKey);
    }
    this.runs.delete(runKey);
    logger.debug('[TEST_RUN_REGISTRY] Run unregistered', {
      runKey,
      totalRuns: this.runs.size,
    });
  }

  /**
   * Unregister all runs for a testId
   * @param testId - Test ID
   */
  unregisterByTestId(testId: string): void {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys || runKeys.size === 0) return;

    for (const runKey of runKeys) {
      this.runs.delete(runKey);
    }
    this.testIdIndex.delete(testId);

    logger.debug('[TEST_RUN_REGISTRY] All runs unregistered for testId', {
      testId,
      count: runKeys.size,
      totalRuns: this.runs.size,
    });
  }

  /**
   * Get a test run by runKey
   * @param runKey - Run key (testId:browser)
   */
  get(runKey: string): TestRunResources | undefined {
    return this.runs.get(runKey);
  }

  /**
   * Get all runKeys for a testId
   * @param testId - Test ID
   */
  getRunKeysByTestId(testId: string): string[] {
    const runKeys = this.testIdIndex.get(testId);
    return runKeys ? Array.from(runKeys) : [];
  }

  /**
   * Get state flags for a test run
   * @param runKey - Run key (testId:browser)
   */
  getState(runKey: string): TestRunState | undefined {
    return this.runs.get(runKey)?.state;
  }

  /**
   * Set cancellation flag for a run
   * @param runKey - Run key (testId:browser)
   */
  setCancelled(runKey: string): void {
    const run = this.runs.get(runKey);
    if (run) {
      run.state.isCancelled = true;
      run.state.isFinalizing = true; // Also set finalizing to silence events
      logger.debug('[TEST_RUN_REGISTRY] Run marked as cancelled', { runKey });
    }
  }

  /**
   * Set cancellation flag for all runs of a testId
   * @param testId - Test ID
   */
  setCancelledByTestId(testId: string): void {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys) return;

    for (const runKey of runKeys) {
      const run = this.runs.get(runKey);
      if (run) {
        run.state.isCancelled = true;
        run.state.isFinalizing = true;
      }
    }
    logger.debug('[TEST_RUN_REGISTRY] All runs marked as cancelled for testId', { testId, count: runKeys.size });
  }

  /**
   * Set finalizing flag for a run
   * @param runKey - Run key (testId:browser)
   */
  setFinalizing(runKey: string): void {
    const run = this.runs.get(runKey);
    if (run) {
      run.state.isFinalizing = true;
      logger.debug('[TEST_RUN_REGISTRY] Run marked as finalizing', { runKey });
    }
  }

  /**
   * Set completed flag for a run
   * @param runKey - Run key (testId:browser)
   */
  setCompleted(runKey: string): void {
    const run = this.runs.get(runKey);
    if (run) {
      run.state.isTestCompleted = true;
      run.state.isFinalizing = true;
      logger.debug('[TEST_RUN_REGISTRY] Run marked as completed', { runKey });
    }
  }

  /**
   * Check if events should be silenced for a run
   * @param runKey - Run key (testId:browser)
   */
  shouldSilenceEvents(runKey: string): boolean {
    const state = this.getState(runKey);
    if (!state) return false;
    return state.isCancelled || state.isTestCompleted || state.isFinalizing;
  }

  /**
   * Check if events should be silenced for any run of a testId
   * (Backward compatible - returns true if ANY run for this test is silenced)
   * @param testId - Test ID
   */
  shouldSilenceEventsByTestId(testId: string): boolean {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys || runKeys.size === 0) return false;

    for (const runKey of runKeys) {
      const state = this.getState(runKey);
      if (state && (state.isCancelled || state.isTestCompleted || state.isFinalizing)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if a run is cancelled
   * @param runKey - Run key (testId:browser)
   */
  isCancelled(runKey: string): boolean {
    return this.runs.get(runKey)?.state.isCancelled || false;
  }

  /**
   * Check if any run for a testId is cancelled
   * @param testId - Test ID
   */
  isCancelledByTestId(testId: string): boolean {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys) return false;

    for (const runKey of runKeys) {
      if (this.runs.get(runKey)?.state.isCancelled) {
        return true;
      }
    }
    return false;
  }

  /**
   * ABORT RUN - "Red Button"
   * Immediately stops video streaming and closes BrowserContext
   * All active Playwright operations will abort
   *
   * @param runKey - Run key (testId:browser) to abort
   * @param reason - Reason for abort
   * @param shortFlushMs - Max time to wait for pending uploads (default 2500ms)
   */
  async abortRun(
    runKey: string,
    reason: 'cancelled' | 'timeout' | 'error' | 'replaced' | 'shutdown',
    shortFlushMs: number = 2500
  ): Promise<void> {
    const run = this.runs.get(runKey);
    if (!run) {
      logger.debug('[TEST_RUN_REGISTRY] No run to abort', { runKey, reason });
      return;
    }

    logger.info('[TEST_RUN_REGISTRY] ABORTING run', {
      runKey,
      testId: run.testId,
      browser: run.browser,
      reason,
      hasContext: !!run.context,
      hasPage: !!run.page,
      hasVideoStream: !!run.videoStreamService,
    });

    // 1. Set flags immediately to silence all events
    run.state.isCancelled = reason === 'cancelled';
    run.state.isFinalizing = true;
    run.state.isTestCompleted = true;

    // 2. Stop video streaming first (quick)
    if (run.videoStreamService) {
      try {
        await Promise.race([
          run.videoStreamService.stop(reason === 'cancelled' ? 'cancelled' : 'error'),
          new Promise<void>((resolve) => setTimeout(resolve, 1000)), // 1s timeout for video stop
        ]);
        VideoStreamRegistry.unregister(runKey);
      } catch (error) {
        logger.warn('[TEST_RUN_REGISTRY] Error stopping video stream during abort', {
          runKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 3. Short flush for pending uploads (if reason allows)
    if (reason !== 'shutdown' && shortFlushMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(shortFlushMs, 3000)));
    }

    // 4. Close BrowserContext (this closes page implicitly and aborts all pending Playwright operations)
    if (run.context) {
      try {
        await Promise.race([
          run.context.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)), // 2s timeout for context close
        ]);
        logger.info('[TEST_RUN_REGISTRY] BrowserContext closed', { runKey, reason });
      } catch (error) {
        logger.warn('[TEST_RUN_REGISTRY] Error closing context during abort', {
          runKey,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 5. Cleanup
    // ✅ IMPORTANT: Keep a short-lived tombstone entry for cancelled runs.
    const testId = run.testId;
    const browser = run.browser;
    if (reason === 'cancelled') {
      const tombstoneCreatedAt = run.createdAt;
      this.runs.set(runKey, {
        testId,
        browser,
        context: null,
        page: null,
        videoStreamService: null,
        state: { ...run.state },
        createdAt: tombstoneCreatedAt,
      });

      setTimeout(() => {
        const current = this.runs.get(runKey);
        if (current && current.createdAt === tombstoneCreatedAt && current.state.isCancelled) {
          this.unregister(runKey);
        }
      }, 30000); // 30s tombstone
    } else {
      this.unregister(runKey);
    }

    logger.info('[TEST_RUN_REGISTRY] Run aborted successfully', { runKey, reason });
  }

  /**
   * Abort all runs for a specific testId
   * Used for test cancellation (kills all browser runs for a test)
   *
   * @param testId - Test ID
   * @param reason - Reason for abort
   * @param shortFlushMs - Max time to wait for pending uploads (default 2500ms)
   */
  async abortByTestId(
    testId: string,
    reason: 'cancelled' | 'timeout' | 'error' | 'replaced' | 'shutdown',
    shortFlushMs: number = 2500
  ): Promise<void> {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys || runKeys.size === 0) {
      logger.debug('[TEST_RUN_REGISTRY] No runs to abort for testId', { testId, reason });
      return;
    }

    logger.info('[TEST_RUN_REGISTRY] Aborting all runs for testId', { testId, reason, count: runKeys.size });

    const abortPromises: Promise<void>[] = [];
    for (const runKey of runKeys) {
      abortPromises.push(
        this.abortRun(runKey, reason, shortFlushMs).catch((error) => {
          logger.warn('[TEST_RUN_REGISTRY] Error aborting run', {
            runKey,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      );
    }

    await Promise.allSettled(abortPromises);
    logger.info('[TEST_RUN_REGISTRY] All runs aborted for testId', { testId, reason });
  }

  /**
   * Abort all active test runs
   * Used for worker shutdown
   *
   * @param reason - Reason for abort
   */
  async abortAll(reason: 'shutdown' | 'error'): Promise<void> {
    const count = this.runs.size;
    if (count === 0) return;

    logger.info('[TEST_RUN_REGISTRY] Aborting all runs', { reason, count });

    const abortPromises: Promise<void>[] = [];
    for (const runKey of this.runs.keys()) {
      abortPromises.push(
        this.abortRun(runKey, reason, 0).catch((error) => {
          logger.warn('[TEST_RUN_REGISTRY] Error aborting run', {
            runKey,
            error: error instanceof Error ? error.message : String(error),
          });
        })
      );
    }

    await Promise.race([
      Promise.allSettled(abortPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)), // 5s total timeout
    ]);

    this.runs.clear();
    this.testIdIndex.clear();
    logger.info('[TEST_RUN_REGISTRY] All runs aborted', { count });
  }

  /**
   * Get count of active runs
   */
  getCount(): number {
    return this.runs.size;
  }

  /**
   * Get summary of all active runs (for debugging)
   */
  getSummary(): { runKey: string; testId: string; browser: string; hasContext: boolean; hasPage: boolean; state: TestRunState; age: number }[] {
    const now = Date.now();
    return Array.from(this.runs.entries()).map(([runKey, run]) => ({
      runKey,
      testId: run.testId,
      browser: run.browser,
      hasContext: !!run.context,
      hasPage: !!run.page,
      state: { ...run.state },
      age: now - run.createdAt,
    }));
  }

  // =====================================================================
  // BACKWARD COMPATIBILITY LAYER
  // These methods accept testId and internally use runKey for single-browser scenarios
  // =====================================================================

  /**
   * @deprecated Use register(runKey, testId, browser, resources) instead
   * Kept for backward compatibility - assumes single browser per test
   */
  registerLegacy(
    testId: string,
    resources: Partial<Omit<TestRunResources, 'state' | 'createdAt' | 'testId' | 'browser'>>
  ): void {
    const browser = 'default';
    const runKey = createRunKey(testId, browser);
    this.register(runKey, testId, browser, resources);
  }

  /**
   * @deprecated Use get(runKey) instead
   * Kept for backward compatibility - returns first run for testId
   */
  getByTestId(testId: string): TestRunResources | undefined {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys || runKeys.size === 0) return undefined;
    // Return first run (for single-browser backward compat)
    const firstRunKey = runKeys.values().next().value;
    return firstRunKey ? this.runs.get(firstRunKey) : undefined;
  }

  /**
   * @deprecated Use abortRun(runKey, reason) instead
   * Kept for backward compatibility - aborts all runs for testId
   */
  async abortTestRun(
    testId: string,
    reason: 'cancelled' | 'timeout' | 'error' | 'replaced' | 'shutdown',
    shortFlushMs: number = 2500
  ): Promise<void> {
    return this.abortByTestId(testId, reason, shortFlushMs);
  }
}

// Singleton instance
export const TestRunRegistry = new TestRunRegistryClass();
