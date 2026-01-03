/**
 * NetworkTracker
 * Detects when network activity has settled
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

export class NetworkTracker {
  private page: Page;
  private pendingRequests: Set<string> = new Set();
  private isTracking: boolean = false;

  constructor(page: Page) {
    this.page = page;
    this.startTracking();
  }

  /**
   * Start tracking network requests
   */
  private startTracking(): void {
    if (this.isTracking) return;

    this.page.on('request', (request) => {
      this.pendingRequests.add(request.url());
    });

    this.page.on('requestfinished', (request) => {
      this.pendingRequests.delete(request.url());
    });

    this.page.on('requestfailed', (request) => {
      this.pendingRequests.delete(request.url());
    });

    this.isTracking = true;
  }

  /**
   * Wait for network to become idle
   * Returns when no pending requests remain
   *
   * @param timeout - Maximum time to wait in ms
   * @returns Promise that resolves when network is idle or timeout
   */
  async waitForNetworkIdle(timeout: number = 5000): Promise<void> {
    const startTime = Date.now();
    const checkInterval = 100; // Check every 100ms

    try {
      // First wait for Playwright's built-in networkidle
      await this.page.waitForLoadState('networkidle', {
        timeout: Math.min(timeout, 3000)
      }).catch(() => {
        // Ignore timeout - we'll do our own check
      });

      // Then verify our tracking shows no pending requests
      while (this.pendingRequests.size > 0) {
        const elapsed = Date.now() - startTime;
        if (elapsed >= timeout) {
          logger.warn('[NETWORK_TRACKER] Timeout waiting for network idle', {
            pendingRequests: this.pendingRequests.size,
            timeout,
          });
          break;
        }

        await this.page.waitForTimeout(checkInterval);
      }

      logger.debug('[NETWORK_TRACKER] Network idle', {
        duration: Date.now() - startTime,
      });
    } catch (error) {
      logger.error('[NETWORK_TRACKER] Error waiting for network idle', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw - network tracking should never break the test
    }
  }

  /**
   * Get count of pending requests
   */
  getPendingCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Clear pending requests tracking
   */
  clear(): void {
    this.pendingRequests.clear();
  }
}
