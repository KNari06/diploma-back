/**
 * NetworkTracker
 * Detects when network activity has settled
 * ENHANCED: Manus-style smart filtering - tracks successful API responses and validation errors
 */

import { logger } from '@/utils/core/logger';
import type { Page, Request, Response } from 'playwright';
import type { NetworkSuccess, NetworkValidationError } from '../lite-types';
import { THIRD_PARTY_DOMAINS } from '@/agent/playwright/execution/third-party-blocker';

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
  // Uses shared domain list from ThirdPartyBlocker for consistency
  private static readonly ANALYTICS_DOMAINS: readonly string[] = THIRD_PARTY_DOMAINS;

  // Same-origin tracker path filter. Modern frameworks (Next.js,
  // SvelteKit, Remix) often serve their analytics endpoints from
  // their OWN origin, bypassing the domain blocklist. Examples:
  //   - /_vercel/insights/event           (Vercel Web Analytics)
  //   - /_vercel/speed-insights/vitals    (Vercel Speed Insights)
  //   - /gtm/collect, /gtag/js (self-hosted GTM)
  //   - /beacon, /telemetry endpoints
  // Without this filter, every same-origin POST /track returning JSON
  // 200 falsely elevates `progressSentiment` to 'Significant Change'
  // because progress-evaluator step 4 reads `successfulApiResponses`.
  // Audit M2 + audit follow-up.
  //
  // CRITICAL false-positive avoidance: bare /track, /event, /metrics,
  // /collect would match real business endpoints — e-commerce sites
  // have `/api/track-order/{id}`, calendars have `/api/event/{id}`,
  // dashboards have `/api/metrics/{report}`. We DO NOT add those.
  // Only well-known tracker SHAPES that have no business meaning:
  //   - /_vercel/insights, /_vercel/speed-insights (Vercel)
  //   - /gtm/, /gtag/js (Google Tag Manager self-hosted)
  //   - /beacon (W3C Beacon API endpoints — universally analytics)
  //   - /telemetry (Microsoft / Datadog APM convention)
  //   - /pixel (1×1 tracking pixels — never legitimate API)
  // For bare /track / /event / /metrics — leaves them alone; rely on
  // domain-level blocklist for trackers that route via known vendors.
  private static readonly TRACKER_PATH_RX = /(?:^|\/)(?:_vercel\/(?:insights|speed-insights)|gtm\/|gtag(?:\/|\.js)|beacon(?:\/|$)|telemetry(?:\/|$)|pixel(?:\/|$))/i;

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
      // Same-origin tracker path filter — see TRACKER_PATH_RX comment.
      // Catches /_vercel/insights/event and other framework analytics
      // that ride on the user's own domain, bypassing the domain
      // blocklist above.
      if (NetworkTracker.TRACKER_PATH_RX.test(urlObj.pathname)) {
        this.trackedRequests.delete(url);
        logger.debug('[NETWORK_TRACKER] Skipped same-origin tracker path', {
          url: url.slice(0, 100),
          method,
        });
        return; // Ignore even successful POST to /track, /_vercel/insights, etc.
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
          const raw = await response.text().catch(() => '');
          let body: any = null;
          try {
            body = raw ? JSON.parse(raw) : null;
          } catch {
            // Keep the raw response body below when it is not valid JSON.
          }
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
            responseBody: body ?? raw,
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

    // P1 fix — proactive cleanup. Previously only ran when size > 1000;
    // now runs each response so memory stays bounded under any test
    // length. The 30s TTL still applies — recent in-flight requests
    // are kept for await-network-idle correctness, only stale-and-
    // already-completed entries get evicted.
    const now = Date.now();
    for (const [trackedUrl, tracked] of this.trackedRequests.entries()) {
      if (now - tracked.timestamp > 30000) { // 30 seconds
        this.trackedRequests.delete(trackedUrl);
        this.capturedRequestBodies.delete(trackedUrl);
      }
    }

    // P1 fix — rotating buffer cap on accumulator arrays. Previously
    // these grew unbounded for the entire test run. With 100+ iter
    // tests doing dozens of API calls each, easy to hit 5000+ entries.
    // Cap = 500 is more than enough for downstream consumers
    // (StateDiffComputer reads only THIS iteration's slice, not
    // historical). When over cap, drop the oldest entries.
    const MAX_BUFFER = 500;
    if (this.successfulResponses.length > MAX_BUFFER) {
      this.successfulResponses.splice(0, this.successfulResponses.length - MAX_BUFFER);
    }
    if (this.networkErrors.length > MAX_BUFFER) {
      this.networkErrors.splice(0, this.networkErrors.length - MAX_BUFFER);
    }
    if (this.validationErrors.length > MAX_BUFFER) {
      this.validationErrors.splice(0, this.validationErrors.length - MAX_BUFFER);
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
   * Get network activity state (Manus-style for Observer)
   * Returns current pending state + recent requests (last 3s)
   */
  getNetworkActivityState(): {
    hasPendingRequests: boolean;
    recentRequests: Array<{ url: string; method: string; status?: number }>;
    asyncWorkTriggered: boolean;
  } {
    const now = Date.now();
    const RECENT_WINDOW = 3000; // 3 seconds

    // Get recent successful responses
    const recentSuccessful = this.successfulResponses.filter(s => now - s.timestamp < RECENT_WINDOW);

    // Async work triggered if we have recent successful requests or pending requests
    const asyncWorkTriggered = this.pendingRequests.size > 0 || recentSuccessful.length > 0;

    // Build recent requests list (from successful responses)
    const recentRequests = recentSuccessful.map(s => ({
      url: s.url,
      method: s.method,
      status: s.status,
    }));

    return {
      hasPendingRequests: this.pendingRequests.size > 0,
      recentRequests,
      asyncWorkTriggered,
    };
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
