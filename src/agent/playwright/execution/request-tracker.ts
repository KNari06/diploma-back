/**
 * Request tracker for intelligent mode
 * Setup BEFORE navigation to catch all API requests
 * ✅ FIX: Uses Map with counters to track duplicate requests to the same URL
 */
export class RequestTracker {
  private page: import('playwright').Page;
  // Active requests tracked by Request object (most reliable)
  private pendingRequests: Set<import('playwright').Request> = new Set();
  // Counters per URL for metrics/logging
  private pendingCountsByUrl: Map<string, number> = new Map();
  private completedCountsByUrl: Map<string, number> = new Map();

  // Patterns for external services we want to ignore
  private readonly externalServicePatterns = [
    'google-analytics.com',
    'googletagmanager.com',
    'facebook.net',
    'sentry.io',
    'browserstack',
    'rollbar',
    'hotjar',
  ];

  constructor(page: import('playwright').Page) {
    this.page = page;
    this.setupListeners();
  }

  private isPotentialApiRequest(url: string, resourceType?: string) {
    if (!url) return false;
    const lower = url.toLowerCase();
    if (this.externalServicePatterns.some(p => lower.includes(p))) return false;
    // Heuristic: treat XHR/fetch and URLs with /api/ /graphql/ /rest/ as important
    if (resourceType === 'xhr' || resourceType === 'fetch') return true;
    if (lower.includes('/api/') || lower.includes('/graphql') || lower.includes('/rest/')) return true;
    // otherwise skip noisy assets
    return false;
  }

  private setupListeners() {
    this.page.on('request', (request) => {
      try {
        const url = request.url();
        const rt = request.resourceType();
        if (!this.isPotentialApiRequest(url, rt)) return;

        this.pendingRequests.add(request);
        const prev = this.pendingCountsByUrl.get(url) || 0;
        this.pendingCountsByUrl.set(url, prev + 1);

        // debug log
        // eslint-disable-next-line no-console
        console.debug('[RequestTracker] request added', { url: url.slice(0, 200), totalPending: this.pendingRequests.size });
      } catch (e) {
        // ignore listener errors
      }
    });

    // Use requestfinished and requestfailed to reliably remove pending requests
    this.page.on('requestfinished', (request) => this.markCompleted(request, 'finished'));
    this.page.on('requestfailed', (request) => this.markCompleted(request, 'failed'));
  }

  private markCompleted(request: import('playwright').Request, reason: string) {
    try {
      if (!this.pendingRequests.has(request)) return;
      this.pendingRequests.delete(request);
      const url = request.url();
      const prev = this.pendingCountsByUrl.get(url) || 1;
      if (prev <= 1) {
        this.pendingCountsByUrl.delete(url);
        this.completedCountsByUrl.set(url, (this.completedCountsByUrl.get(url) || 0) + 1);
      } else {
        this.pendingCountsByUrl.set(url, prev - 1);
      }

      // eslint-disable-next-line no-console
      console.debug('[RequestTracker] request completed', { url: url.slice(0,200), reason, remaining: this.pendingRequests.size });
    } catch (e) {
      // ignore
    }
  }

  /**
   * Wait for outstanding tracked requests to settle or until timeout.
   * Returns true if all tracked requests completed, false if timed out.
   */
  async waitForNetworkIdle(timeout = 15000, checkInterval = 200) {
    const start = Date.now();
    while (this.pendingRequests.size > 0 && (Date.now() - start) < timeout) {
      await new Promise(r => setTimeout(r, checkInterval));
    }

    const completed = this.pendingRequests.size === 0;
    if (!completed) {
      // Log details about remaining requests for debugging
      const leftoverUrls = Array.from(this.pendingCountsByUrl.keys()).slice(0, 10);
      // eslint-disable-next-line no-console
      console.warn('[RequestTracker] network idle wait timed out', { remaining: this.pendingRequests.size, leftoverUrls });
    }
    return completed;
  }

  getPendingCount() {
    return this.pendingRequests.size;
  }

  getPendingCountsByUrl() {
    return new Map(this.pendingCountsByUrl);
  }
}
