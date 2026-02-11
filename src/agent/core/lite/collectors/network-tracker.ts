/**
 * NetworkTracker
 * Detects when network activity has settled
 * ENHANCED: Manus-style smart filtering - tracks successful API responses and validation errors
 */

import { logger } from '@/utils/core/logger';
import type { Page, Request, Response } from 'playwright';
import type { NetworkSuccess, NetworkValidationError } from '../lite-types';

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

/**
 * Tracked request info (for resource type filtering)
 */
interface TrackedRequest {
  request: Request;
  resourceType: string;
  timestamp: number;
}

export class NetworkTracker {
  private page: Page;
  private pendingRequests: Set<string> = new Set();
  private isTracking: boolean = false;
  private networkErrors: NetworkError[] = [];
  private currentIteration: number = 0;

  // Manus Style: Track successful API responses
  private successfulResponses: NetworkSuccess[] = [];
  // Manus Style: Track validation errors (400-499 with parsed body)
  private validationErrors: NetworkValidationError[] = [];
  // Track only fetch/xhr requests for smart filtering
  private trackedRequests: Map<string, TrackedRequest> = new Map();
  // P1: Captured request bodies for POST/PUT/PATCH (keyed by URL)
  private capturedRequestBodies: Map<string, any> = new Map();

  // Manus Style: Analytics blacklist (ignore even POST to these domains)
  private static readonly ANALYTICS_DOMAINS = [
    // Core analytics platforms
    'google-analytics.com',
    'analytics.google.com',
    'googletagmanager.com',
    'googleadservices.com',
    'doubleclick.net',
    'googleads.g.doubleclick.net',

    // Error tracking & monitoring
    'sentry.io',
    'sentry-cdn.com',
    'bugsnag.com',
    'rollbar.com',
    'airbrake.io',
    'raygun.io',

    // Product analytics
    'mixpanel.com',
    'amplitude.com',
    'heap.io',
    'segment.com',
    'segment.io',
    'posthog.com',
    'posthog.net',
    'kissmetrics.com',
    'kissmetrics.io',

    // Session replay & heatmaps
    'hotjar.com',
    'hotjar.io',
    'fullstory.com',
    'fullstoryapp.com',
    'logrocket.com',
    'logrocket.io',
    'mouseflow.com',
    'inspectlet.com',
    'crazyegg.com',
    'clarity.microsoft.com',

    // Marketing & advertising pixels
    'facebook.com',
    'facebook.net',
    'fbcdn.net',
    'linkedin.com',
    'licdn.com',
    'twitter.com',
    'twimg.com',
    'pinterest.com',
    'pinterestads.com',
    'snapchat.com',
    'sc-static.net',
    'tiktok.com',
    'tiktokcdn.com',
    'vk.com',
    'vk-cdn.net',

    // Customer messaging (often used for tracking)
    'intercom.io',
    'intercomcdn.com',
    'drift.com',
    'drift-api.com',
    'zendesk.com',
    'zendesk-chat.com',
    'olark.com',
    'livechatinc.com',
    'tawk.to',

    // Marketing automation
    'hubspot.com',
    'hs-scripts.com',
    'hsappstatic.net',
    'marketo.com',
    'marketo.net',
    'pardot.com',
    'pardot.net',

    // A/B testing & optimization
    'optimizely.com',
    'optimizelyapis.com',
    'vwo.com',
    'wingify.com',
    'convert.com',
    'convertapi.com',
    'unbounce.com',
    'unbouncepages.com',

    // APM & monitoring
    'datadoghq.com',
    'datadoghq.net',
    'newrelic.com',
    'nr-data.net',
    'dynatrace.com',
    'dynatrace-managed.com',
    'appdynamics.com',

    // Other analytics
    'adobe.com',
    'omniture.com',
    '2o7.net',
    'demdex.net',
    'adobedtm.com',
    'cloudflare.com',
    'cloudflareinsights.com',
    'yandex.ru',
    'yandex.net',
    'metrica.yandex.ru',
    'baidu.com',
    'baidu-analytics.com',
    'matomo.org',
    'piwik.pro',
    'plausible.io',
    'fathomanalytics.com',
    'simpleanalytics.com',
    'clicky.com',
    'statcounter.com',
    'gosquared.com',
    'chartbeat.com',
    'parsely.com',

    // Lead generation & enrichment
    'clearbit.com',
    'clearbitstatic.com',
    '6sense.com',
    'demandbase.com',
    'leadfeeder.com',
  ];

  // Manus Style: Track only dynamic resource types
  private static readonly RELEVANT_RESOURCE_TYPES = ['fetch', 'xhr'];

  // Store listener refs for proper cleanup
  private onRequest = (request: Request) => {
    const url = request.url();
    const resourceType = request.resourceType();

    // Manus Style: Save only fetch/xhr for later processing
    if (NetworkTracker.RELEVANT_RESOURCE_TYPES.includes(resourceType)) {
      this.trackedRequests.set(url, {
        request,
        resourceType,
        timestamp: Date.now(),
      });

      // Only track fetch/xhr in pendingRequests to avoid blocking on WebSocket/SSE
      this.pendingRequests.add(url);
    }
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

  private onResponse = async (response: Response) => {
    // Manus Style: Smart filtering for API responses
    const url = response.url();
    const method = response.request().method();
    const status = response.status();

    // Check if this is a tracked request (fetch/xhr only)
    const tracked = this.trackedRequests.get(url);
    if (!tracked) {
      // Not fetch/xhr - handle only as error (if 4xx/5xx)
      if (status >= 400) {
        // Skip common expected errors
        const isExpectedError =
          url.includes('favicon') ||
          url.includes('analytics') ||
          url.includes('.svg') ||
          url.includes('.png') ||
          url.includes('.jpg');

        if (!isExpectedError) {
          this.networkErrors.push({
            url,
            method,
            status,
            error: `HTTP ${status}`,
            timestamp: Date.now(),
            iteration: this.currentIteration,
          });
        }
      }
      return;
    }

    // Manus Style: Exclude analytics (blacklist domains)
    try {
      const urlObj = new URL(url);
      if (NetworkTracker.ANALYTICS_DOMAINS.some(domain => urlObj.hostname.includes(domain))) {
        this.trackedRequests.delete(url);
        return; // Ignore even POST to analytics
      }
    } catch {
      // Invalid URL, continue processing
    }

    // Manus Style: Check if request is relevant (mutating methods + API patterns + JSON)
    const isMutatingMethod = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    const hasApiPattern = /\/api\/|\/v1\/|\/v2\/|\/graphql/i.test(url);

    // Check Content-Type for JSON
    let isJsonResponse = false;
    try {
      const contentType = response.headers()['content-type'] || '';
      isJsonResponse = contentType.includes('application/json');
    } catch {
      // Ignore header errors
    }

    const isRelevant = isMutatingMethod || hasApiPattern || isJsonResponse;

    if (!isRelevant) {
      this.trackedRequests.delete(url);
      return; // Not relevant
    }

    // Manus Style: Classify by status
    try {
      if (status >= 200 && status < 300) {
        // Success - save as NetworkSuccess
        this.successfulResponses.push({
          url,
          method,
          status,
          timestamp: Date.now(),
          resourceType: tracked.resourceType as 'fetch' | 'xhr',
          iteration: this.currentIteration,
        });
        logger.debug('[NETWORK_TRACKER] API success', {
          url,
          method,
          status,
          iteration: this.currentIteration,
        });
      } else if (status >= 400 && status < 500) {
        // P1: Enhanced validation error capture with full body parsing
        try {
          const body = await response.json().catch(() => null);
          const message = body?.message || body?.error?.message || `HTTP ${status}`;
          const errors = body?.errors || (body?.error ? [body.error] : []);

          // P1: Get captured request body (if any)
          const requestBody = this.capturedRequestBodies.get(url) ?? null;
          this.capturedRequestBodies.delete(url); // Cleanup after use

          // P1: Parse field-level errors
          const fieldErrors = this.parseValidationErrors(body);

          // P1: Parse rate limit info from response headers
          let headers: Record<string, string> = {};
          try {
            headers = response.headers();
          } catch {
            // Ignore header access errors
          }
          const rateLimitInfo = this.parseRateLimitHeaders(headers);

          // P1: Parse auth error hint
          const authErrorHint = this.parseAuthErrorHint(status, body);

          this.validationErrors.push({
            url,
            method,
            status,
            timestamp: Date.now(),
            message: typeof message === 'string' ? message : String(message),
            errors: Array.isArray(errors) ? errors.map(String) : [],
            iteration: this.currentIteration,
            // P1: Enhanced fields
            requestBody,
            responseBody: body,
            headers,
            fieldErrors: fieldErrors.length > 0 ? fieldErrors : undefined,
            rateLimitInfo: rateLimitInfo || undefined,
            authErrorHint: authErrorHint || undefined,
          });

          logger.debug('[NETWORK_TRACKER] Enhanced validation error captured', {
            url,
            method,
            status,
            message,
            fieldErrorCount: fieldErrors.length,
            hasRequestBody: requestBody !== null,
            hasRateLimit: !!rateLimitInfo,
            authHint: authErrorHint,
            iteration: this.currentIteration,
          });
        } catch {
          // Fallback: save without body if parsing fails
          this.validationErrors.push({
            url,
            method,
            status,
            timestamp: Date.now(),
            message: `HTTP ${status}`,
            errors: [],
            iteration: this.currentIteration,
          });
        }
      } else if (status >= 500) {
        // Server error - critical blocker
        this.networkErrors.push({
          url,
          method,
          status,
          error: `HTTP ${status} - Server Error`,
          timestamp: Date.now(),
          iteration: this.currentIteration,
        });
        logger.debug('[NETWORK_TRACKER] Server error', {
          url,
          method,
          status,
          iteration: this.currentIteration,
        });
      }
    } catch (error) {
      logger.error('[NETWORK_TRACKER] Error processing response', {
        url,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Remove from tracked after processing
    this.trackedRequests.delete(url);

    // P1: Cleanup old tracked requests and captured bodies to prevent memory leak
    if (this.trackedRequests.size > 1000) {
      const now = Date.now();
      for (const [trackedUrl, tracked] of this.trackedRequests.entries()) {
        if (now - tracked.timestamp > 30000) { // 30 seconds
          this.trackedRequests.delete(trackedUrl);
          this.capturedRequestBodies.delete(trackedUrl);
        }
      }
    }
  };

  constructor(page: Page) {
    this.page = page;
    this.startTracking();
    this.setupRequestInterception();
  }

  /**
   * P1: Setup request body capture
   * Captures POST/PUT/PATCH request bodies before they are sent.
   * Uses page.on('request') to read body without re-fetching (no route.fetch()).
   * Response body capture is done in onResponse handler.
   */
  private setupRequestInterception(): void {
    // Capture request bodies from tracked requests (non-blocking, no route interception)
    this.page.on('request', (request: Request) => {
      const method = request.method();
      if (!['POST', 'PUT', 'PATCH'].includes(method)) return;

      const url = request.url();
      let requestBody: any = null;
      try {
        const postData = request.postData();
        if (postData) {
          try {
            requestBody = JSON.parse(postData);
          } catch {
            requestBody = postData;
          }
        } else {
          try {
            requestBody = request.postDataJSON();
          } catch {
            // No body available
          }
        }
      } catch {
        // Ignore body capture errors
      }

      if (requestBody !== null) {
        this.capturedRequestBodies.set(url, requestBody);
      }
    });

    logger.debug('[NETWORK_TRACKER] Request body capture enabled');
  }

  /**
   * Parse field-level validation errors from response body
   * Handles common API error formats:
   * - Object-based: { email: 'invalid', password: 'too short' }
   * - Array-based: [{ field: 'email', message: 'invalid' }]
   * - Laravel: { errors: { email: ['invalid'], password: ['too short'] } }
   * - Rails: { errors: { email: ['invalid'], password: ['too short'] } }
   */
  private parseValidationErrors(body: any): Array<{ field: string; message: string }> {
    if (!body) return [];

    const fieldErrors: Array<{ field: string; message: string }> = [];

    try {
      // Format 1: Array-based with field/message objects
      if (Array.isArray(body.errors)) {
        for (const error of body.errors) {
          if (typeof error === 'object' && error.field && error.message) {
            fieldErrors.push({
              field: String(error.field),
              message: String(error.message),
            });
          }
        }
      }
      // Format 2: Object-based { email: 'invalid', password: 'too short' }
      else if (typeof body.errors === 'object' && body.errors !== null) {
        for (const [field, value] of Object.entries(body.errors)) {
          if (Array.isArray(value)) {
            // Laravel/Rails format: { email: ['invalid', 'required'] }
            for (const msg of value) {
              fieldErrors.push({ field, message: String(msg) });
            }
          } else if (typeof value === 'string') {
            fieldErrors.push({ field, message: value });
          }
        }
      }
      // Format 3: Top-level object { email: 'invalid', password: 'too short' }
      else if (typeof body === 'object' && !body.message && !body.error) {
        for (const [field, value] of Object.entries(body)) {
          if (typeof value === 'string') {
            fieldErrors.push({ field, message: value });
          }
        }
      }
    } catch {
      // Ignore parsing errors
    }

    return fieldErrors;
  }

  /**
   * Parse rate limit info from response headers
   * Checks common headers: retry-after, x-ratelimit-*, ratelimit-*
   */
  private parseRateLimitHeaders(
    headers: Record<string, string>
  ): { retryAfter?: number; limit?: number; remaining?: number; reset?: number } | null {
    const retryAfter = headers['retry-after'];
    const limit = headers['x-ratelimit-limit'] || headers['ratelimit-limit'];
    const remaining = headers['x-ratelimit-remaining'] || headers['ratelimit-remaining'];
    const reset = headers['x-ratelimit-reset'] || headers['ratelimit-reset'];

    if (!retryAfter && !limit && !remaining && !reset) {
      return null;
    }

    return {
      retryAfter: retryAfter ? parseInt(retryAfter, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      remaining: remaining ? parseInt(remaining, 10) : undefined,
      reset: reset ? parseInt(reset, 10) : undefined,
    };
  }

  /**
   * Parse authentication error hint from response
   * Common hints: 'token_expired', 'invalid_credentials', 'unauthorized', etc.
   */
  private parseAuthErrorHint(status: number, body: any): string | null {
    if (status !== 401 && status !== 403) {
      return null;
    }

    try {
      // Check for common auth error codes
      const code = body?.code || body?.error_code || body?.errorCode;
      if (typeof code === 'string') {
        const lowerCode = code.toLowerCase();
        if (
          lowerCode.includes('token') ||
          lowerCode.includes('auth') ||
          lowerCode.includes('credential') ||
          lowerCode.includes('unauthorized') ||
          lowerCode.includes('forbidden')
        ) {
          return code;
        }
      }

      // Check message for hints
      const message = body?.message || body?.error?.message || '';
      if (typeof message === 'string') {
        const lowerMsg = message.toLowerCase();
        if (lowerMsg.includes('token expired')) return 'token_expired';
        if (lowerMsg.includes('invalid token')) return 'invalid_token';
        if (lowerMsg.includes('invalid credentials')) return 'invalid_credentials';
        if (lowerMsg.includes('unauthorized')) return 'unauthorized';
        if (lowerMsg.includes('forbidden')) return 'forbidden';
        if (lowerMsg.includes('access denied')) return 'access_denied';
      }
    } catch {
      // Ignore parsing errors
    }

    return null;
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
    const staleThresholdMs = 10000; // Consider requests older than 10s as stale

    try {
      // Cleanup stale pending requests (safety net for WebSocket/SSE leaks)
      const now = Date.now();
      const stalePendingUrls: string[] = [];
      for (const url of this.pendingRequests) {
        const tracked = this.trackedRequests.get(url);
        if (tracked && now - tracked.timestamp > staleThresholdMs) {
          stalePendingUrls.push(url);
        }
      }
      if (stalePendingUrls.length > 0) {
        logger.debug('[NETWORK_TRACKER] Removing stale pending requests', {
          staleCount: stalePendingUrls.length,
        });
        stalePendingUrls.forEach((url) => this.pendingRequests.delete(url));
      }

      // Skip Playwright wait if already idle
      if (this.pendingRequests.size > 0) {
        // First wait for Playwright's built-in networkidle (reduced timeout)
        await this.page.waitForLoadState('networkidle', {
          timeout: Math.min(timeout, 2000)
        }).catch(() => {
          // Ignore timeout - we'll do our own check
        });
      }

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
   * Get successful API responses since a specific timestamp (Manus Style)
   */
  getSuccessfulResponsesSince(timestamp: number): NetworkSuccess[] {
    return this.successfulResponses.filter((s) => s.timestamp >= timestamp);
  }

  /**
   * Get validation errors since a specific timestamp (Manus Style)
   */
  getValidationErrorsSince(timestamp: number): NetworkValidationError[] {
    return this.validationErrors.filter((v) => v.timestamp >= timestamp);
  }

  /**
   * Clear pending requests tracking
   */
  clear(): void {
    this.pendingRequests.clear();
  }

  /**
   * Clear collected errors, successful responses, and validation errors
   */
  clearErrors(): void {
    this.networkErrors = [];
    this.successfulResponses = [];
    this.validationErrors = [];
    this.capturedRequestBodies.clear();
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

    // P1: Clear tracked requests and captured bodies to prevent memory leak
    this.trackedRequests.clear();
    this.capturedRequestBodies.clear();

    this.isTracking = false;
    logger.debug('[NETWORK_TRACKER] Stopped tracking');
  }
}
