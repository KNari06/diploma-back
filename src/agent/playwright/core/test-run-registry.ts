/**
 * TestRunRegistry
 * Global in-process registry for managing active test runs
 *
 * Purpose:
 * - Track all active test executions with their resources (context, page, video stream)
 * - Enable immediate abort via abortTestRun(testId) - "Red Button"
 * - Manage cancellation/finalization flags to silence events after stop
 * - Prevent orphaned resources on cancel/shutdown
 */

import { logger } from '@/utils/core/logger';
import { BrowserContext, Page } from 'playwright';
import { VideoStreamRegistry } from '../artifacts/video-stream-registry';
import { VideoStreamService } from '../artifacts/video-stream.service';

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
  context: BrowserContext | null;
  page: Page | null;
  videoStreamService: VideoStreamService | null;
  state: TestRunState;
  createdAt: number;
}

/**
 * Global registry for active test runs
 * Enables immediate abort and resource cleanup
 */
class TestRunRegistryClass {
  private runs = new Map<string, TestRunResources>();

  /**
   * Abort resources for an OLD run reference without touching the registry map.
   * ✅ Important: This prevents a race where register() overwrites the map entry and abortTestRun()
   * would accidentally abort the NEW run instead of the old one.
   *
   * @param testId - Test ID
   * @param run - The previous run resources snapshot
   * @param reason - Abort reason
   */
  private async abortRunResources(
    testId: string,
    run: TestRunResources,
    reason: 'cancelled' | 'timeout' | 'error' | 'replaced' | 'shutdown'
  ): Promise<void> {
    try {
      logger.warn('[TEST_RUN_REGISTRY] Aborting previous run resources', {
        testId,
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
        VideoStreamRegistry.unregister(testId);
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
        testId,
        reason,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Register a new test run with its resources
   * @param testId - Test ID
   * @param resources - Partial resources (context, page, videoStreamService)
   */
  register(
    testId: string,
    resources: Partial<Omit<TestRunResources, 'state' | 'createdAt'>>
  ): void {
    // If there's already a run for this testId, abort it first
    const existing = this.runs.get(testId);
    if (existing) {
      logger.warn('[TEST_RUN_REGISTRY] Replacing existing run', { testId });
      // ✅ FIX: Abort the OLD run by reference to avoid aborting the NEW run after map overwrite
      this.abortRunResources(testId, existing, 'replaced').catch(() => {
        // Ignore cleanup errors
      });
    }

    this.runs.set(testId, {
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

    logger.debug('[TEST_RUN_REGISTRY] Run registered', {
      testId,
      hasContext: !!resources.context,
      hasPage: !!resources.page,
      hasVideoStream: !!resources.videoStreamService,
      totalRuns: this.runs.size,
    });
  }

  /**
   * Update resources for an existing test run
   * @param testId - Test ID
   * @param resources - Partial resources to update
   */
  update(
    testId: string,
    resources: Partial<Omit<TestRunResources, 'state' | 'createdAt'>>
  ): void {
    const run = this.runs.get(testId);
    if (!run) {
      logger.warn('[TEST_RUN_REGISTRY] Cannot update non-existent run', { testId });
      return;
    }

    if (resources.context !== undefined) run.context = resources.context;
    if (resources.page !== undefined) run.page = resources.page;
    if (resources.videoStreamService !== undefined) run.videoStreamService = resources.videoStreamService;

    logger.debug('[TEST_RUN_REGISTRY] Run updated', {
      testId,
      hasContext: !!run.context,
      hasPage: !!run.page,
      hasVideoStream: !!run.videoStreamService,
    });
  }

  /**
   * Unregister a test run
   * @param testId - Test ID
   */
  unregister(testId: string): void {
    this.runs.delete(testId);
    logger.debug('[TEST_RUN_REGISTRY] Run unregistered', {
      testId,
      totalRuns: this.runs.size,
    });
  }

  /**
   * Get a test run by ID
   * @param testId - Test ID
   */
  get(testId: string): TestRunResources | undefined {
    return this.runs.get(testId);
  }

  /**
   * Get state flags for a test run
   * @param testId - Test ID
   */
  getState(testId: string): TestRunState | undefined {
    return this.runs.get(testId)?.state;
  }

  /**
   * Set cancellation flag for a test run
   * @param testId - Test ID
   */
  setCancelled(testId: string): void {
    const run = this.runs.get(testId);
    if (run) {
      run.state.isCancelled = true;
      run.state.isFinalizing = true; // Also set finalizing to silence events
      logger.debug('[TEST_RUN_REGISTRY] Run marked as cancelled', { testId });
    }
  }

  /**
   * Set finalizing flag for a test run
   * @param testId - Test ID
   */
  setFinalizing(testId: string): void {
    const run = this.runs.get(testId);
    if (run) {
      run.state.isFinalizing = true;
      logger.debug('[TEST_RUN_REGISTRY] Run marked as finalizing', { testId });
    }
  }

  /**
   * Set completed flag for a test run
   * @param testId - Test ID
   */
  setCompleted(testId: string): void {
    const run = this.runs.get(testId);
    if (run) {
      run.state.isTestCompleted = true;
      run.state.isFinalizing = true;
      logger.debug('[TEST_RUN_REGISTRY] Run marked as completed', { testId });
    }
  }

  /**
   * Check if events should be silenced for a test
   * @param testId - Test ID
   */
  shouldSilenceEvents(testId: string): boolean {
    const state = this.getState(testId);
    if (!state) return false;
    return state.isCancelled || state.isTestCompleted || state.isFinalizing;
  }

  /**
   * Check if a test is cancelled
   * @param testId - Test ID
   */
  isCancelled(testId: string): boolean {
    return this.runs.get(testId)?.state.isCancelled || false;
  }

  /**
   * ABORT TEST RUN - "Red Button"
   * Immediately stops video streaming and closes BrowserContext
   * All active Playwright operations will abort
   *
   * @param testId - Test ID to abort
   * @param reason - Reason for abort
   * @param shortFlushMs - Max time to wait for pending uploads (default 2500ms)
   */
  async abortTestRun(
    testId: string,
    reason: 'cancelled' | 'timeout' | 'error' | 'replaced' | 'shutdown',
    shortFlushMs: number = 2500
  ): Promise<void> {
    const run = this.runs.get(testId);
    if (!run) {
      logger.debug('[TEST_RUN_REGISTRY] No run to abort', { testId, reason });
      return;
    }

    logger.info('[TEST_RUN_REGISTRY] ABORTING test run', {
      testId,
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
        VideoStreamRegistry.unregister(testId);
      } catch (error) {
        logger.warn('[TEST_RUN_REGISTRY] Error stopping video stream during abort', {
          testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 3. Short flush for pending uploads (if reason allows)
    if (reason !== 'shutdown' && shortFlushMs > 0) {
      // Note: LiteEngine should call its own flushPendingGraphScreenshotUploads
      // This is just a timing guard - the flush happens in the engine itself
      await new Promise((resolve) => setTimeout(resolve, Math.min(shortFlushMs, 3000)));
    }

    // 4. Close BrowserContext (this closes page implicitly and aborts all pending Playwright operations)
    if (run.context) {
      try {
        await Promise.race([
          run.context.close(),
          new Promise<void>((resolve) => setTimeout(resolve, 2000)), // 2s timeout for context close
        ]);
        logger.info('[TEST_RUN_REGISTRY] BrowserContext closed', { testId, reason });
      } catch (error) {
        logger.warn('[TEST_RUN_REGISTRY] Error closing context during abort', {
          testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // 5. Cleanup
    this.unregister(testId);

    logger.info('[TEST_RUN_REGISTRY] Test run aborted successfully', { testId, reason });
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
    for (const testId of this.runs.keys()) {
      abortPromises.push(
        this.abortTestRun(testId, reason, 0).catch((error) => {
          logger.warn('[TEST_RUN_REGISTRY] Error aborting run', {
            testId,
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
  getSummary(): { testId: string; hasContext: boolean; hasPage: boolean; state: TestRunState; age: number }[] {
    const now = Date.now();
    return Array.from(this.runs.entries()).map(([testId, run]) => ({
      testId,
      hasContext: !!run.context,
      hasPage: !!run.page,
      state: { ...run.state },
      age: now - run.createdAt,
    }));
  }
}

// Singleton instance
export const TestRunRegistry = new TestRunRegistryClass();
