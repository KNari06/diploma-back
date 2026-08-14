/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PAGE HEALTH — technical-health signals the per-flow pipeline was blind to
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The Planner/Executor/Reviewer reason over the DOM text, but the DOM alone
 * can't tell them WHY a page is broken. This helper turns raw collector data
 * (NetworkTracker errors, console error count, URL transition) into a small
 * structured verdict that closes two causal links the agents could otherwise
 * never build:
 *
 *   ① HTTP 5xx (genuine server failure) on a same-site request  ⇒  not a PASS
 *   ② navigated back to a login URL mid-flow      ⇒  "session lost", not "new page"
 *
 * Pure + deterministic: takes already-collected inputs, returns a verdict.
 * No Playwright, no I/O — trivially unit-testable and never throws. Callers
 * (command-executor) own the try/catch and the "best-effort, never fail the
 * flow" contract (CLAUDE.md invariant #11).
 */

import type { NetworkError } from './network-tracker';
import { isLoginUrl } from '../exploration/auth-url-patterns';
import { isSameSite } from '@/utils/security/url-safety';

export interface PageHealth {
  /** Highest server-error status (>=500) seen in the window, if any. */
  serverErrorStatus?: number;
  /** A genuine server failure (HTTP 5xx) on a same-site request was observed. */
  hasServerError: boolean;
  /** The site throttled us (HTTP 429) on a same-site request. NOT a server
   *  failure — the app is alive and asking us to slow down. Distinct from
   *  hasServerError so the reaction differs (back off, don't declare "broken"). */
  rateLimited: boolean;
  /** Console errors collected in the window. */
  consoleErrorCount: number;
  /**
   * A few actual console-error TEXTS (already truncated + capped).
   *
   * The count alone told the agent "3 things broke" without saying what, so it
   * could neither tell an analytics 404 apart from a TypeError in checkout nor
   * put anything useful in a bug report. The texts are what make the signal
   * actionable. Empty when nothing was collected or the caller passed none.
   *
   * Optional so a hand-built PageHealth (tests, other producers) stays valid —
   * making it required would force every construction site to care about a
   * purely additive diagnostic field.
   */
  consoleErrorSamples?: string[];
  /** Flow landed on a login/auth URL after starting elsewhere (logged out). */
  sessionLost: boolean;
}

/** How many console-error texts reach the prompt. Enough to spot a pattern,
 *  few enough that a looping error can't crowd out the rest of the context. */
const MAX_CONSOLE_SAMPLES = 3;

/** Per-message cap — one stack trace can be thousands of characters. */
const MAX_CONSOLE_SAMPLE_LENGTH = 200;

const SERVER_ERROR_MIN = 500;
const RATE_LIMIT_STATUS = 429;

export interface PageHealthInput {
  /** Network errors observed since the action/round started. */
  networkErrorsSince: readonly NetworkError[];
  /** Console error count delta for the window. */
  consoleErrorCount: number;
  /**
   * Console-error texts for the same window. Optional so existing callers
   * (and tests) keep working — they simply get the old count-only behaviour.
   */
  consoleErrorTexts?: readonly string[];
  /** URL the flow started this action/round on. */
  previousUrl?: string;
  /** Current URL after the action/round. */
  currentUrl: string;
  /** Whether THIS flow is itself an auth/login flow (then a login URL is expected). */
  flowIsAuth?: boolean;
}

/**
 * Classify page health from already-collected signals. Returns a verdict only
 * when something is actually wrong; an all-healthy page yields a verdict with
 * `hasServerError=false`, `sessionLost=false`, `consoleErrorCount` as given.
 */
export function classifyPageHealth(input: PageHealthInput): PageHealth {
  const { networkErrorsSince, consoleErrorCount, previousUrl, currentUrl, flowIsAuth } = input;

  // ① server error — highest status >= 400 in the window. We surface 4xx too
  // (auth/permission walls show as 401/403 on the document) but flag 5xx as
  // the hard "server broke" signal via serverErrorStatus.
  //
  // ONLY count errors from the SAME SITE as the current page (eTLD+1 match).
  // A real run is full of third-party 404s/POSTs (amplitude, CDNs, pixel
  // trackers) that are NOT the app under test failing — counting them flagged
  // healthy pages as broken and polluted the Reviewer signal (observed live).
  // `hasServerError` now means a genuine SERVER failure (5xx) — that is the
  // signal the Reviewer's deterministic gate acts on. Same-site 4xx (e.g. a
  // missing promo image at content-sales.<site>/...) is NOT the app failing and
  // was over-flagging healthy pages as broken; it no longer sets hasServerError.
  // (Cross-site errors — amplitude, CDNs — are skipped entirely.)
  let serverErrorStatus: number | undefined;
  let hasServerError = false;
  let rateLimited = false;
  for (const err of networkErrorsSince) {
    if (typeof err.status !== 'number') continue;
    // Skip third-party / cross-site errors — they aren't this app's failure.
    if (err.url && !isSameSite(err.url, currentUrl)) continue;
    // 429 = the site is throttling us. NOT a server failure — handled as its
    // own signal so the reaction is "back off", not "app is broken".
    if (err.status === RATE_LIMIT_STATUS) {
      rateLimited = true;
      continue;
    }
    if (err.status < SERVER_ERROR_MIN) continue; // only 5xx is a real server error
    hasServerError = true;
    serverErrorStatus = Math.max(serverErrorStatus ?? 0, err.status);
  }

  // ② session lost — we MOVED to a login URL from a non-login URL, and this
  // flow isn't itself an auth flow (for which a login URL is the goal, not a
  // regression). A flow that starts and stays on /login is not "lost".
  const movedToLogin =
    !!previousUrl &&
    previousUrl !== currentUrl &&
    !isLoginUrl(previousUrl) &&
    isLoginUrl(currentUrl);
  const sessionLost = !flowIsAuth && movedToLogin;

  return {
    serverErrorStatus,
    hasServerError,
    rateLimited,
    consoleErrorCount,
    consoleErrorSamples: (input.consoleErrorTexts ?? [])
      .slice(0, MAX_CONSOLE_SAMPLES)
      .map((t) =>
        t.length > MAX_CONSOLE_SAMPLE_LENGTH
          ? `${t.slice(0, MAX_CONSOLE_SAMPLE_LENGTH)}…`
          : t,
      ),
    sessionLost,
  };
}

/** True when the health verdict carries anything worth telling the agents. */
export function pageHealthHasSignal(h: PageHealth | undefined): h is PageHealth {
  if (!h) return false;
  return h.hasServerError || h.rateLimited || h.sessionLost || h.consoleErrorCount > 0;
}

/**
 * Render a PageHealth verdict as a compact prompt section body (no header).
 * Returns '' when there's nothing to report so callers can skip the section.
 */
export function formatPageHealth(h: PageHealth | undefined): string {
  if (!pageHealthHasSignal(h)) return '';
  const lines: string[] = [];
  if (h.serverErrorStatus) {
    lines.push(`- SERVER ERROR: HTTP ${h.serverErrorStatus} — the app failed to respond correctly`);
  }
  if (h.rateLimited) {
    lines.push(`- RATE LIMITED: HTTP 429 — the site is throttling requests. This is NOT an app failure; slow down (wait before retrying), do not treat it as goal failure.`);
  }
  if (h.sessionLost) {
    lines.push(`- SESSION LOST: redirected to a login page mid-flow (likely logged out)`);
  }
  if (h.consoleErrorCount > 0) {
    // Lead with the count, then the actual messages. A bare count is not
    // actionable — the agent can't judge severity or write a bug report from
    // "3", but it can from "TypeError: cart.total is undefined".
    lines.push(`- console errors: ${h.consoleErrorCount}`);
    const samples = h.consoleErrorSamples ?? [];
    for (const sample of samples) {
      lines.push(`    · ${sample}`);
    }
    const hidden = h.consoleErrorCount - samples.length;
    if (hidden > 0 && samples.length > 0) {
      lines.push(`    · …and ${hidden} more`);
    }
  }
  return lines.join('\n');
}
