/**
 * ═══════════════════════════════════════════════════════════════════════════
 * NETWORK CALL RECORDER — minimal request/response log for replay assertions
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * WHY a new recorder instead of reusing [NetworkTracker](../../core/lite/collectors/network-tracker.ts):
 * that tracker's constructor auto-starts tracking AND attaches request
 * interception with POST/PUT/PATCH **body capture**. That is the right trade for
 * an AI agent reasoning about a page, but replay executes every step of every
 * scheduled test — paying body parsing per request to answer "did POST /api/x
 * return 2xx?" is cost with no benefit.
 *
 * WHY not a branch inside the existing `assert` command: that case requires a
 * selector and resolves a locator BEFORE reaching the assertion-type switch
 * (`command-executor.ts` `case 'assert'`). A network assertion has no element.
 * The selector-free precedent is `assertUrl`, and this follows its shape:
 * read live state → compare → throw with both sides in the message.
 *
 * Shape mirrors [NavigationStatusTracker](../../../services/test-resource/resource-supervisor.ts):
 * idempotent `attach`, ONE `page.on('response')` listener, every handler body
 * defensive because Playwright can throw on a destroyed request.
 */

import type { Page, Response as PlaywrightResponse } from 'playwright';

/** A single observed call. Deliberately status/method/url only — no bodies. */
export interface RecordedCall {
  method: string;
  url: string;
  status: number;
  /** ms epoch, so a caller can scope assertions to "since this step began". */
  timestamp: number;
}

/**
 * Hard cap on retained calls. A chatty SPA can emit hundreds of requests per
 * step; we only ever answer "did a matching call happen?", so the oldest entries
 * are worthless once the window is full. Bounded memory matters here because a
 * replay run can execute hundreds of steps in one browser context.
 */
const MAX_RECORDED_CALLS = 500;

/** Resource types worth recording. Matches what exploration asserts on. */
const RECORDED_RESOURCE_TYPES = new Set(['fetch', 'xhr', 'document']);

export class NetworkCallRecorder {
  private calls: RecordedCall[] = [];
  private attached = false;

  /**
   * Start recording. Safe to call more than once — a second call is a no-op, so
   * a caller cannot accidentally double-count by re-attaching per step.
   */
  attach(page: Page): void {
    if (this.attached) return;
    this.attached = true;

    page.on('response', (resp: PlaywrightResponse) => {
      try {
        const request = resp.request();
        const resourceType = request.resourceType();
        if (!RECORDED_RESOURCE_TYPES.has(resourceType)) return;

        this.calls.push({
          method: request.method(),
          url: request.url(),
          status: resp.status(),
          timestamp: Date.now(),
        });

        // Ring-buffer semantics: drop the oldest rather than growing forever.
        if (this.calls.length > MAX_RECORDED_CALLS) {
          this.calls.splice(0, this.calls.length - MAX_RECORDED_CALLS);
        }
      } catch {
        // Playwright throws if the request was destroyed mid-flight. Recording
        // is best-effort by contract — a missed call must never fail a step.
      }
    });
  }

  /** All calls observed at or after `timestamp`. */
  getCallsSince(timestamp: number): RecordedCall[] {
    return this.calls.filter((c) => c.timestamp >= timestamp);
  }

  /** Every call observed so far. */
  getAllCalls(): RecordedCall[] {
    return [...this.calls];
  }

  /** Drop the log — used between test cases sharing one context. */
  clear(): void {
    this.calls = [];
  }
}
