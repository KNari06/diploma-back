/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REPLAY CONSOLE COLLECTOR — console errors for the replay assertion path
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The agent/lite pipeline already has `core/lite/collectors/console-collector`,
 * but the REPLAY executor (`agent/execution/command-executor.ts`) never had a
 * console listener at all. Without one, `assertNoConsoleErrors` has nothing to
 * assert over and `aiCheck` cannot answer "are there console errors?" — the
 * model correctly reports the assertion as unsupported.
 *
 * Two properties the lite collector does NOT provide, and which this path needs:
 *
 *   ① CONTEXT-LEVEL ATTACHMENT. The replay executor reassigns `this.page` on
 *      every tab switch (anchor-promotion, popup, tab close…). A per-Page
 *      listener would silently stop collecting after the first switch. We bind
 *      to the BrowserContext's `page` event instead, so every current AND
 *      future page in the run is covered by construction — the same pattern
 *      `page-watcher.ts` and `preview-session` already use.
 *
 *   ② ERRORS ONLY. Product decision: warnings never fail a test. A `warning`
 *      is noise on most real sites and would make the assertion unusable. We
 *      keep `console.error` AND uncaught `pageerror` exceptions — the latter
 *      is what an uncaught TypeError surfaces as, and users unambiguously mean
 *      it when they say "no console errors".
 *
 * Fail-soft contract (CLAUDE.md invariant #11): collection is best-effort and
 * MUST never throw into the flow. A listener that cannot attach degrades to
 * "no errors collected", never to a failed run.
 */

import type { BrowserContext, ConsoleMessage, Page, Request, Response } from 'playwright';
import { logger } from '@/utils/core/logger';
import { isSameSite } from '@/utils/security/url-safety';

export interface ReplayConsoleError {
  /** Always 'error' — warnings are intentionally not collected. */
  type: 'error';
  /** Message text (already string-joined by Playwright). */
  text: string;
  /** Epoch ms when observed — used for per-step windowing. */
  timestamp: number;
  /** Source URL of the script that logged it, when known. */
  location?: string;
  /**
   * Where the error came from:
   *  - 'console'   → console.error(...)
   *  - 'pageerror' → uncaught exception
   *  - 'network'   → failed request / HTTP 5xx (opt-in, see NetworkErrorOptions)
   */
  source: 'console' | 'pageerror' | 'network';
}

/**
 * Network errors are OPT-IN because they are a different product question.
 *
 * DevTools paints a failed request red in the Console tab, so a user asking for
 * "no console errors" may reasonably expect a 500 to count — but many healthy
 * apps fire tolerated 4xx (auth probes, feature flags, analytics beacons that
 * 404). Turning this on by default would make the assertion red on sites that
 * are working fine, which is exactly the failure mode that makes a QA feature
 * get switched off and never used again.
 */
export interface NetworkErrorOptions {
  /** Collect network failures at all. Default false. */
  enabled: boolean;
  /**
   * Minimum HTTP status treated as an error. Default 500 — server failures
   * only. Set 400 to include client errors (noisier; see above).
   */
  minStatus?: number;
  /**
   * Only count requests to the site under test. Default true: a third-party
   * analytics/ad endpoint failing says nothing about the app, and blocked
   * trackers are extremely common.
   */
  sameSiteOnly?: boolean;
  /**
   * Base URL the same-site check compares against. Usually the run's start
   * URL. When absent, the same-site filter cannot run and is skipped (we log
   * rather than silently widening the net).
   */
  baseUrl?: string;
}

const DEFAULT_MIN_STATUS = 500;

/** Hard cap on retained errors — a looping error must not exhaust memory. */
const MAX_ERRORS = 200;

/** Truncate any single message; one stack trace can be enormous. */
const MAX_TEXT_LENGTH = 2000;

export class ReplayConsoleCollector {
  private readonly context: BrowserContext;
  private errors: ReplayConsoleError[] = [];
  private attached = false;
  /** Pages already wired, so a re-attach can't double-count one page. */
  private readonly wiredPages = new WeakSet<Page>();
  /** Count of errors dropped by the MAX_ERRORS cap — reported for honesty. */
  private droppedCount = 0;

  private readonly onPage = (page: Page): void => this.wirePage(page);
  /** Network-error policy for this run. Disabled unless the caller opts in. */
  private readonly network: NetworkErrorOptions;
  /** Logged once if a same-site filter was requested without a baseUrl. */
  private warnedMissingBaseUrl = false;

  constructor(context: BrowserContext, network?: NetworkErrorOptions) {
    this.context = context;
    this.network = network ?? { enabled: false };
  }

  /**
   * Begin collecting. Idempotent. Wires every page that already exists in the
   * context plus every page opened later.
   */
  start(): void {
    if (this.attached) return;
    this.attached = true;

    try {
      this.context.on('page', this.onPage);
      for (const page of this.context.pages()) {
        this.wirePage(page);
      }
      logger.debug('[REPLAY_CONSOLE] Started collecting console errors');
    } catch (err) {
      // Never let observability break the run.
      logger.warn('[REPLAY_CONSOLE] Failed to attach collector — console assertions will see no data', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Detach every listener. Idempotent; safe after the context is closed. */
  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    try {
      this.context.off('page', this.onPage);
    } catch {
      // Context already closed — the listener died with it.
    }
    logger.debug('[REPLAY_CONSOLE] Disposed', { collected: this.errors.length });
  }

  private wirePage(page: Page): void {
    if (this.wiredPages.has(page)) return;
    this.wiredPages.add(page);

    try {
      page.on('console', (msg: ConsoleMessage) => {
        // Errors only — warnings are deliberately ignored (see header ②).
        if (msg.type() !== 'error') return;
        this.record({
          type: 'error',
          text: msg.text(),
          timestamp: Date.now(),
          location: msg.location()?.url,
          source: 'console',
        });
      });

      // An uncaught exception never reaches the 'console' event, but it IS
      // what users mean by "console error" — it's what they see in red.
      page.on('pageerror', (err: Error) => {
        this.record({
          type: 'error',
          text: err.message || String(err),
          timestamp: Date.now(),
          source: 'pageerror',
        });
      });

      if (this.network.enabled) {
        // A request that never produced a response: DNS failure, connection
        // refused, TLS error, or a blocked request. Playwright reports the
        // reason via `failure()`.
        page.on('requestfailed', (req: Request) => {
          const url = req.url();
          if (!this.countsAsAppRequest(url)) return;
          // `net::ERR_ABORTED` is overwhelmingly a benign navigation/cancel
          // (user navigated away, fetch aborted), not an app failure.
          const reason = req.failure()?.errorText || 'request failed';
          if (reason.includes('ERR_ABORTED')) return;
          this.record({
            type: 'error',
            text: `${req.method()} ${url} failed: ${reason}`,
            timestamp: Date.now(),
            location: url,
            source: 'network',
          });
        });

        page.on('response', (res: Response) => {
          const status = res.status();
          const min = this.network.minStatus ?? DEFAULT_MIN_STATUS;
          if (status < min) return;
          const url = res.url();
          if (!this.countsAsAppRequest(url)) return;
          this.record({
            type: 'error',
            text: `HTTP ${status} ${res.request().method()} ${url}`,
            timestamp: Date.now(),
            location: url,
            source: 'network',
          });
        });
      }
    } catch (err) {
      logger.debug('[REPLAY_CONSOLE] Could not wire page (likely already closed)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Whether a request URL belongs to the app under test.
   *
   * Third-party failures (analytics, ads, trackers, CDNs) are the single
   * biggest source of noise here — ad blockers and privacy defaults make them
   * fail constantly on perfectly healthy apps. Counting them would train users
   * to ignore the assertion.
   *
   * Fails OPEN (counts the request) only when the filter is explicitly off.
   * When same-site filtering is requested but no baseUrl was supplied we
   * cannot evaluate it, so we DROP the request and log once — silently
   * widening to "everything" would be the surprising behaviour.
   */
  private countsAsAppRequest(url: string): boolean {
    const sameSiteOnly = this.network.sameSiteOnly ?? true;
    if (!sameSiteOnly) return true;

    const base = this.network.baseUrl;
    if (!base) {
      if (!this.warnedMissingBaseUrl) {
        this.warnedMissingBaseUrl = true;
        logger.warn(
          '[REPLAY_CONSOLE] sameSiteOnly requested without a baseUrl — network errors cannot be attributed and are being skipped',
        );
      }
      return false;
    }
    return isSameSite(url, base);
  }

  private record(error: ReplayConsoleError): void {
    if (error.text.length > MAX_TEXT_LENGTH) {
      error.text = `${error.text.slice(0, MAX_TEXT_LENGTH)}… (truncated)`;
    }
    this.errors.push(error);
    if (this.errors.length > MAX_ERRORS) {
      this.errors.shift();
      this.droppedCount++;
    }
  }

  /**
   * Errors observed at or after `since` (epoch ms).
   *
   * Windowing matters: an `assertNoConsoleErrors` step should judge what the
   * flow produced, not an error the site logged on first paint minutes ago.
   * Callers decide the window; passing 0 returns everything.
   */
  getErrorsSince(since: number): ReplayConsoleError[] {
    return this.errors.filter((e) => e.timestamp >= since);
  }

  /** Every retained error (subject to the MAX_ERRORS cap). */
  getAllErrors(): ReplayConsoleError[] {
    return [...this.errors];
  }

  /**
   * How many errors the cap discarded. Non-zero means `getAllErrors()` is a
   * suffix, not the whole truth — surfaced so a report never implies
   * completeness it doesn't have.
   */
  getDroppedCount(): number {
    return this.droppedCount;
  }
}
