/**
 * Page load error detection (May 2026).
 *
 * Browsers replace the active URL with a special scheme when the
 * navigation target fails to load — DNS failure, TCP reset, TLS error,
 * server unreachable, certificate problems, etc. The page becomes
 * Chrome's built-in error page, with no relation to the original site.
 *
 * Symptoms we've seen in production traces:
 *   - User clicks a link that triggers a navigation
 *   - Network blip / VPN drop / site outage hits between click and load
 *   - Playwright's `waitForLoadState('load')` waits up to ~60s, then
 *     resolves because Chrome DID finish loading — its OWN error page.
 *   - Subsequent snapshots return `nodeCount: 0` because the error
 *     page has no interactive elements.
 *   - User sees: "everything froze for a minute, then nothing works".
 *
 * Without explicit detection, the apply pipeline reports `success: true`
 * (the click happened, navigation event fired) and the user is left
 * staring at a blank preview wondering what we did.
 *
 * This module provides a single source of truth for "is this URL a
 * browser error page?" used by:
 *   - websocket/handlers/preview.handler.ts — annotate apply result
 *   - preview-run.service.ts — short-circuit Run All loop with a clear
 *     message instead of timing out on each remaining step
 *
 * Patterns covered (verified against Chromium error scheme handling):
 *   - `chrome-error://chromewebdata/` — the canonical Chrome failure page
 *   - `chrome-error://` (other paths) — same scheme, edge variants
 *   - `data:text/html,chromewebdata` — older Chrome versions
 *   - Firefox / WebKit equivalents would use different schemes; for now
 *     this matches Chromium-based browsers only (which is what
 *     Playwright defaults to in this codebase).
 *
 * NOT covered (intentionally) — these are valid pages, not errors:
 *   - `about:blank` (transitional during navigation, settles quickly)
 *   - `data:text/html` non-chromewebdata (legitimate inline content)
 *   - HTTP 4xx/5xx with a real page body (the URL stays the original)
 */

/** Discriminator for the per-call decision plus a human-readable reason. */
export interface PageLoadErrorInfo {
  /** True when the URL indicates Chromium's load-failure error page. */
  isLoadError: boolean;
  /**
   * Short, user-facing message. Empty string when isLoadError is false.
   * Stable wording — used as-is in WS events and apply results, so don't
   * tweak without checking frontend / editor copy.
   */
  message: string;
  /**
   * The URL we classified (echoed for log payloads — saves the caller
   * a `.url` access and ensures the trace records exactly what was
   * inspected). Empty string for missing/empty input.
   */
  url: string;
}

/**
 * Inspect a URL string and decide whether the browser is currently
 * showing a load-failure error page rather than the navigation target.
 *
 * Pure function — no IO, no Playwright calls. Safe to call from any
 * code path (apply pipeline, run loop, navigation handler).
 */
export function detectPageLoadError(url: string | undefined | null): PageLoadErrorInfo {
  if (!url || typeof url !== 'string') {
    return { isLoadError: false, message: '', url: url ?? '' };
  }

  // Chrome's canonical failure page — `chrome-error://chromewebdata/`
  // and variants. We match the scheme prefix; any path under that
  // scheme means an error page.
  if (url.startsWith('chrome-error://')) {
    return {
      isLoadError: true,
      message:
        'Page failed to load — likely a network issue (DNS / VPN / site outage). '
        + 'Check your internet connection and try again.',
      url,
    };
  }

  // Older Chromium versions sometimes used a `data:` URL with the
  // sentinel `chromewebdata` body. Match the exact sentinel — NOT
  // `startsWith`, which would match e.g. `data:text/html,chromewebdata-extra`
  // (a hypothetical legitimate data URL whose body happens to begin
  // with our sentinel). The actual sentinel has no suffix in practice;
  // we accept either bare or trailing whitespace / fragment.
  if (
    url === 'data:text/html,chromewebdata'
    || /^data:text\/html,chromewebdata([?#\s]|$)/.test(url)
  ) {
    return {
      isLoadError: true,
      message:
        'Page failed to load — likely a network issue (DNS / VPN / site outage). '
        + 'Check your internet connection and try again.',
      url,
    };
  }

  return { isLoadError: false, message: '', url };
}
