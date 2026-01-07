/**
 * NetworkTracker
 * Detects when network activity has settled
 * ENHANCED: Also collects network errors (failed requests + HTTP 4xx/5xx)
 */

import type { Page, Request, Response } from 'playwright';
import { logger } from '@/utils/core/logger';

/**
 * Network error structure (Pro-grade)
 */
export interface NetworkError {
  url: string;
  method: string;
  status?: number;
  error: string;
  timestamp: number;
  iteration?: number;
}

export class NetworkTracker {
  private page: Page;
  private pendingRequests: Set<string> = new Set();
  private isTracking: boolean = false;
  private networkErrors: NetworkError[] = [];
  private currentIteration: number = 0;

  // Store listener refs for proper cleanup
  private onRequest = (request: Request) => {
    this.pendingRequests.add(request.url());
  };

  private onRequestFinished = (request: Request) => {
    this.pendingRequests.delete(request.url());
  };

  private onRequestFailed = (request: Request) => {
    this.pendingRequests.delete(request.url());

    // Collect failed request as network error
    try {
      const failure = request.failure();
      this.networkErrors.push({
        url: request.url(),
        method: request.method(),
        error: failure?.errorText || 'Request failed',
        timestamp: Date.now(),
        iteration: this.currentIteration,
      });
      logger.debug('[NETWORK_TRACKER] Request failed', {
        url: request.url(),
        error: failure?.errorText,
        iteration: this.currentIteration,
      });
    } catch {
      // Ignore errors during collection
    }
  };

  private onResponse = (response: Response) => {
    // Collect HTTP 4xx/5xx responses as network errors
    try {
      const status = response.status();
      if (status >= 400) {
        // Skip common expected errors (e.g., favicon, tracking)
        const url = response.url();
        const isExpectedError =
          url.includes('favicon') ||
          url.includes('analytics') ||
          url.includes('.svg') ||
          url.includes('.png') ||
          url.includes('.jpg');

        if (!isExpectedError) {
          this.networkErrors.push({
            url,
            method: response.request().method(),
            status,
            error: `HTTP ${status}`,
            timestamp: Date.now(),
            iteration: this.currentIteration,
          });
          logger.debug('[NETWORK_TRACKER] HTTP error', {
            url,
            status,
            iteration: this.currentIteration,
          });
        }
      }
    } catch {
      // Ignore errors during collection
    }
  };

  constructor(page: Page) {
    this.page = page;
    this.startTracking();
  }

  /**
   * Start tracking network requests
   */
  private startTracking(): void {
    if (this.isTracking) return;

    this.page.on('request', this.onRequest);
    this.page.on('requestfinished', this.onRequestFinished);
    this.page.on('requestfailed', this.onRequestFailed);
    this.page.on('response', this.onResponse);

    this.isTracking = true;
    logger.debug('[NETWORK_TRACKER] Started tracking (with error collection)');
  }

  /**
   * Set current iteration for error context
   */
  setIteration(iteration: number): void {
    this.currentIteration = iteration;
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
   * Get collected network errors
   */
  getErrors(): NetworkError[] {
    return [...this.networkErrors];
  }

  /**
   * Get errors collected since a specific timestamp
   */
  getErrorsSince(timestamp: number): NetworkError[] {
    return this.networkErrors.filter((e) => e.timestamp >= timestamp);
  }

  /**
   * Clear pending requests tracking
   */
  clear(): void {
    this.pendingRequests.clear();
  }

  /**
   * Clear collected errors
   */
  clearErrors(): void {
    this.networkErrors = [];
  }

  /**
   * Stop tracking and clean up listeners
   */
  stopTracking(): void {
    if (!this.isTracking) return;

    try {
      this.page.off('request', this.onRequest);
      this.page.off('requestfinished', this.onRequestFinished);
      this.page.off('requestfailed', this.onRequestFailed);
      this.page.off('response', this.onResponse);
    } catch {
      // Ignore listener removal errors
    }

    this.isTracking = false;
    logger.debug('[NETWORK_TRACKER] Stopped tracking');
  }
}
