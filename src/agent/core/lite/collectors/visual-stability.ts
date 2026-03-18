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
    // Uses lightweight page.evaluate check — NOT full SnapshotCollector.collect()
    // (full snapshot parses entire DOM = 200-500ms; this check = ~5ms)
    const elapsed = Date.now() - start;
    const remaining = timeout - elapsed;
    if (remaining < 500) return; // Not enough time budget for loading check

    try {
      const isLoading = await VisualStability.hasLoadingIndicators(page);
      if (!isLoading) return; // No loading state — done

      // Loading detected — poll until clear or time budget exhausted
      const maxPolls = Math.min(5, Math.floor(remaining / 400));
      for (let i = 0; i < maxPolls; i++) {
        await VisualStability.waitForStable(page, { checkInterval: 100, maxAttempts: 2 });

        const stillLoading = await VisualStability.hasLoadingIndicators(page);
        if (!stillLoading) {
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
      });
    } catch {
      // Non-fatal: loading check should never break exploration
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
    // Initialize in the past so if no API requests arrive, we resolve immediately
    // (quiet threshold already met from the start)
    let lastApiActivity = Date.now() - API_QUIET_THRESHOLD_MS;

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

        // Use native setTimeout instead of page.waitForTimeout to avoid
        // "Execution context was destroyed" errors during page navigation
        await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
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
      // Wrap in try/catch: page may already be closed during navigation
      try {
        page.off('request', onRequest);
        page.off('requestfinished', onDone);
        page.off('requestfailed', onDone);
      } catch {
        // Page closed — listeners will be GC'd with the page
      }
    }
  }

  /**
   * Lightweight loading indicator check (runs in browser context).
   * Same 6-layer detection as SnapshotCollector.transientState but ~50x faster
   * because it doesn't parse the entire DOM — just checks specific selectors.
   *
   * Detects: role=progressbar, aria-busy, skeleton classes, animated spinners
   */
  private static async hasLoadingIndicators(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        const doc = document;
        const win = window;

        // 1. role="progressbar" (ARIA standard)
        const progressbar = doc.querySelector('[role="progressbar"]:not([aria-hidden="true"])');
        if (progressbar) {
          const style = win.getComputedStyle(progressbar);
          if (style.display !== 'none' && style.visibility !== 'hidden') return true;
        }

        // 2. aria-busy="true"
        const busy = doc.querySelector('[aria-busy="true"]');
        if (busy) {
          const style = win.getComputedStyle(busy);
          if (style.display !== 'none' && style.visibility !== 'hidden') return true;
        }

        // 3. Skeleton loaders (CSS class patterns)
        const skeleton = doc.querySelector('.skeleton, .skeleton-loader, [data-skeleton], .placeholder-glow');
        if (skeleton) {
          const style = win.getComputedStyle(skeleton);
          if (style.display !== 'none' && style.visibility !== 'hidden') return true;
        }

        // 4. Visible spinner/loader with animation
        const spinners = doc.querySelectorAll('.spinner, .loader, .loading, [class*="spinner"], [class*="loader"], [data-loading]');
        for (const el of spinners) {
          const style = win.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') continue;
          if (parseFloat(style.opacity) < 0.3) continue;
          const animName = style.animationName;
          if (animName && animName !== 'none') return true;
        }

        return false;
      });
    } catch {
      return false; // Page navigating or closed — not loading
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
