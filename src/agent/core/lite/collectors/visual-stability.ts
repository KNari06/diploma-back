/**
 * VisualStability
 * Waits for DOM to stop mutating before taking snapshots
 * CRITICAL: Prevents snapshots during animations/transitions
 *
 * V6: Streaming/SSE awareness — detects monotonic low-rate growth
 * and treats it as "stable enough" (e.g. chat feeds, live dashboards).
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';

/** Max element delta per check to be considered "streaming stable" (not a bulk DOM mutation) */
const STREAMING_DELTA_THRESHOLD = 20;

/** How many consecutive monotonic-growth checks needed to declare "streaming stable" */
const STREAMING_CONSECUTIVE_CHECKS = 2;

export class VisualStability {
  /**
   * Wait for page to become visually stable
   * Checks element count at intervals - if unchanged, page is stable
   * ✅ FIX: Hard timeout (3 seconds max) to prevent hanging on infinite animations
   * ✅ V6: Streaming/SSE awareness — monotonic low-rate growth = "streaming stable"
   *
   * @param page - Playwright page instance
   * @param options - Configuration options
   * @returns Promise that resolves when page is stable
   */
  static async waitForStable(
    page: Page,
    options?: {
      checkInterval?: number;
      maxAttempts?: number;
    }
  ): Promise<void> {
    const interval = options?.checkInterval ?? 150; // 150ms between checks
    const maxAttempts = options?.maxAttempts ?? 5;  // Max 5 attempts (750ms total)
    const hardTimeout = 3000; // ✅ FIX: Absolute max wait time (3s)

    try {
      // ✅ FIX: Set hard timeout to prevent hanging on infinite animations
      const timeoutPromise = new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), hardTimeout);
      });

      // Race between stability check and hard timeout
      const stabilityPromise = (async () => {
        let prevCount = await this.getElementCount(page);

        // V5: If getElementCount returns null, page is likely navigating - exit early
        if (prevCount === null) {
          return 'navigating';
        }

        // V6: Track consecutive monotonic growth for streaming detection
        let consecutiveMonotonicGrowth = 0;

        for (let i = 0; i < maxAttempts; i++) {
          await page.waitForTimeout(interval);
          const currCount = await this.getElementCount(page);

          // V5: If currCount is null, page navigation detected during check
          if (currCount === null) {
            return 'navigating';
          }

          if (currCount === prevCount) {
            return 'stable'; // Stable - element count unchanged
          }

          // V6: Streaming/SSE detection — small monotonic growth pattern
          const delta = currCount - prevCount;
          if (delta > 0 && delta <= STREAMING_DELTA_THRESHOLD) {
            consecutiveMonotonicGrowth++;
            if (consecutiveMonotonicGrowth >= STREAMING_CONSECUTIVE_CHECKS) {
              // Consistent small growth → streaming page, proceed with snapshot
              logger.debug('[VISUAL_STABILITY] Streaming pattern detected, considering stable', {
                consecutiveGrowth: consecutiveMonotonicGrowth,
                lastDelta: delta,
                elementCount: currCount,
              });
              return 'streaming-stable';
            }
          } else {
            // Large jump or count decreased — not streaming, reset counter
            consecutiveMonotonicGrowth = 0;
          }

          prevCount = currCount;
        }

        return 'max-attempts'; // Max attempts reached
      })();

      const result = await Promise.race([stabilityPromise, timeoutPromise]);

      if (result === 'timeout') {
        logger.warn('[VISUAL_STABILITY] Hard timeout reached (3s), proceeding anyway', {
          hardTimeout,
          reason: 'Page may have infinite animations (loader, cursor, etc.)',
        });
      } else if (result === 'max-attempts') {
        logger.warn('[VISUAL_STABILITY] Max attempts reached, proceeding anyway', {
          maxAttempts,
          interval,
        });
      }
    } catch (error) {
      logger.error('[VISUAL_STABILITY] Error checking stability', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - stability check should never break the test
    }
  }

  /**
   * Wait for page to be fully ready for snapshotting.
   * Combines three signals in sequence:
   *   1. API idle — wait for pending fetch/xhr to finish (IGNORES images, fonts, CSS, analytics)
   *   2. DOM stability — element count stabilization via waitForStable
   *   3. Loading state clearance — spinner/skeleton/progressbar via transientState
   *
   * Used by Exploration Agent (SurveyAgent, FlowRunner) at critical points
   * where snapshots are taken after navigation or clicks.
   *
   * Phase 1 uses a lightweight inline request tracker (same approach as NetworkTracker)
   * that only counts fetch/xhr resource types. This means:
   *   ✅ API calls — waited for
   *   ❌ Images, fonts, CSS — NOT waited for (zero delay)
   *   ❌ Analytics (GA, FB) — NOT waited for
   *   ❌ WebSocket/SSE — NOT waited for
   */
  static async waitForPageReady(
    page: Page,
    options?: { timeout?: number },
  ): Promise<void> {
    const timeout = options?.timeout ?? 5000;
    const start = Date.now();

    // ── Phase 1: API idle (fetch/xhr ONLY — ignores images, fonts, analytics) ──
    try {
      await VisualStability.waitForApiIdle(page, Math.min(timeout, 3000));
    } catch {
      // Non-fatal — proceed to DOM stability
    }

    // ── Phase 2: DOM stability (element count unchanged) ──
    await VisualStability.waitForStable(page);

    // ── Phase 3: Loading state detection (spinner/skeleton/progressbar) ──
    const elapsed = Date.now() - start;
    const remaining = timeout - elapsed;
    if (remaining < 500) return; // Not enough time budget for loading check

    try {
      // Lazy import to avoid circular dependency (SnapshotCollector → VisualStability)
      const { SnapshotCollector } = await import('./snapshot-collector');

      const snap = await SnapshotCollector.collect(page, { skipStabilityWait: true });
      if (!snap.transientState?.isTransient) return; // No loading state — done

      // Loading detected — poll until clear or time budget exhausted
      const maxPolls = Math.min(5, Math.floor(remaining / 400));
      for (let i = 0; i < maxPolls; i++) {
        await VisualStability.waitForStable(page, { checkInterval: 100, maxAttempts: 2 });

        const recheck = await SnapshotCollector.collect(page, { skipStabilityWait: true });
        if (!recheck.transientState?.isTransient) {
          logger.debug('[VISUAL_STABILITY] Loading state cleared', {
            polls: i + 1,
            elapsed: Date.now() - start,
          });
          return;
        }
      }

      logger.debug('[VISUAL_STABILITY] Loading state persisted after polling, proceeding', {
        polls: maxPolls,
        elapsed: Date.now() - start,
        loadingType: snap.transientState.type,
      });
    } catch (error) {
      // Non-fatal: loading check should never break exploration
      logger.debug('[VISUAL_STABILITY] Loading state check failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Lightweight API-only network idle wait.
   * Tracks only fetch/xhr requests — ignores images, fonts, CSS, WebSocket, SSE.
   *
   * Same approach as NetworkTracker.RELEVANT_RESOURCE_TYPES = ['fetch', 'xhr']
   * but without the heavy data collection (response parsing, error tracking, etc.)
   *
   * Resolves when:
   *   - Zero pending fetch/xhr requests AND 200ms of quiet
   *   - OR timeout reached (fail-open)
   *
   * Typical timing:
   *   - No API calls: resolves in ~0ms
   *   - API responds in 200ms: resolves in ~400ms (200ms response + 200ms quiet)
   *   - Slow API / long poll: resolves at timeout cap (fail-open)
   */
  private static async waitForApiIdle(page: Page, timeout: number): Promise<void> {
    const API_QUIET_THRESHOLD_MS = 200; // 200ms without new API requests = idle
    const POLL_INTERVAL_MS = 50;

    let pending = 0;
    let lastApiActivity = Date.now();

    const onRequest = (request: { resourceType: () => string }) => {
      const type = request.resourceType();
      if (type === 'fetch' || type === 'xhr') {
        pending++;
        lastApiActivity = Date.now();
      }
    };
    const onDone = (request: { resourceType: () => string }) => {
      const type = request.resourceType();
      if (type === 'fetch' || type === 'xhr') {
        pending = Math.max(0, pending - 1);
        lastApiActivity = Date.now();
      }
    };

    page.on('request', onRequest);
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);

    try {
      const deadline = Date.now() + timeout;

      while (Date.now() < deadline) {
        // Idle: zero pending + quiet threshold passed
        if (pending === 0 && (Date.now() - lastApiActivity) >= API_QUIET_THRESHOLD_MS) {
          return;
        }
        await page.waitForTimeout(POLL_INTERVAL_MS);
      }

      // Timeout — fail-open, log only if there were actual pending requests
      if (pending > 0) {
        logger.debug('[VISUAL_STABILITY] API idle timeout, proceeding with pending requests', {
          pending,
          timeout,
        });
      }
    } finally {
      // Always cleanup listeners — prevent memory leaks
      page.off('request', onRequest);
      page.off('requestfinished', onDone);
      page.off('requestfailed', onDone);
    }
  }

  /**
   * Get current element count on page
   * Used as a simple proxy for DOM stability
   *
   * V5: Handle "Execution context was destroyed" gracefully during navigation
   * This error is expected when page navigates and is not a real failure.
   */
  private static async getElementCount(page: Page): Promise<number | null> {
    try {
      return await page.evaluate(() => {
        // @ts-expect-error - DOM types available in browser context
        return document.querySelectorAll('*').length;
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);

      // V5: Expected during navigation - downgrade to debug
      if (errorMsg.includes('Execution context was destroyed') ||
          errorMsg.includes('Target closed') ||
          errorMsg.includes('Navigation interrupted')) {
        logger.debug('[VISUAL_STABILITY] Page navigation detected during stability check', {
          error: errorMsg,
        });
        return null; // Return null to signal "cannot measure, likely navigating"
      }

      logger.error('[VISUAL_STABILITY] Failed to get element count', {
        error: errorMsg,
      });
      return 0;
    }
  }
}
