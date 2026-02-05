/**
 * VisualStability
 * Waits for DOM to stop mutating before taking snapshots
 * CRITICAL: Prevents snapshots during animations/transitions
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';

export class VisualStability {
  /**
   * Wait for page to become visually stable
   * Checks element count at intervals - if unchanged, page is stable
   * ✅ FIX: Hard timeout (3 seconds max) to prevent hanging on infinite animations
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

        for (let i = 0; i < maxAttempts; i++) {
          await page.waitForTimeout(interval);
          const currCount = await this.getElementCount(page);

          // V5: If currCount is null, page navigation detected during check
          if (currCount === null) {
            return 'navigating';
          }

          if (currCount === prevCount) {
            // logger.debug('[VISUAL_STABILITY] Page stable', {
              // elementCount: currCount,
            //   attempts: i + 1,
            // });
            return 'stable'; // Stable - element count unchanged
          }

          // logger.debug('[VISUAL_STABILITY] Page still mutating', {
          //   prevCount,
          //   currCount,
          //   attempt: i + 1,
          // });

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
