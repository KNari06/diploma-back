/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Preview External-Navigation Trap
 *
 * When a user interacts with the preview iframe, pages they don't control can
 * trigger cross-origin navigations via anchors, buttons, JS (`location.href`,
 * `window.open`), form submits, etc. Since the preview has exactly one
 * Playwright page per tab and no "back" history when an inline navigation is
 * triggered by a single click, cross-origin redirects strand the user on
 * `kaspi.kz` / `checkout.stripe.com` / whatever with no way to recover the
 * original preview page.
 *
 * The click-site anchor interceptor (`probeExternalAnchorAt`) catches the
 * common `<a href>` case pre-flight. This module is the backstop: it listens
 * to `framenavigated` on the main frame and, if the navigation takes the
 * session off its original origin without the user having explicitly
 * requested a goto via the preview address bar, it reverts the navigation
 * and emits a `preview:external-nav:blocked` WebSocket event so the frontend
 * can toast.
 *
 * Design:
 *   - PER-PAGE state. Each Playwright page (initial tab, popups, reset
 *     successor) has its own baseline origin + intent window. Multi-tab
 *     sessions keep independent traps so switching tabs doesn't confuse
 *     ownership.
 *   - One listener per page (idempotent via WeakSet), mirroring auth-detector.
 *   - Baseline origin = origin of the session's `startUrl` (for the initial
 *     page) or the popup's landing URL (for popups). Updated on explicit
 *     user navigation via `markIntentionalGoto`.
 *   - Intent window: 3000ms. Any framenavigated inside this window is
 *     allowed (used to cover goto + redirect chains).
 *   - Revert: `page.goBack()` preferred (history depth ≥1); otherwise
 *     `page.goto(lastKnownSafeUrl, { waitUntil: 'domcontentloaded' })`.
 *   - Notice payload includes the blocked URL so the frontend shows what
 *     tried to happen.
 *
 * What we DO NOT do:
 *   - Block `about:blank` / `chrome://` / data URLs — those don't strand.
 *   - Block navigation to a same-origin variant (subdomain/www heuristic).
 *   - Interfere with `target=_blank` popups — Chromium routes them to a
 *     new page; we attach a fresh trap on the popup at its landing URL.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { Page, Frame } from 'playwright';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';

type PageState = {
  sessionId: string;
  baselineOrigin: string;
  baselineUrl: string;
  lastSafeUrl: string;
  // Wall-clock timestamp in ms. Navigations that fire before this instant
  // are trusted as user-intended and will update the baseline instead of
  // being reverted.
  intentUntil: number;
  // True while we are in the middle of reverting a trapped nav. Prevents
  // the goBack() / goto() we ourselves trigger from re-entering the trap.
  reverting: boolean;
};

const attached = new WeakSet<Page>();
const perPage = new WeakMap<Page, PageState>();
// Cross-index so `markIntentionalGoto(sessionId)` can fan out to every page
// that belongs to the session. Stored as a Set of weak refs via a plain Set
// of Page objects — callers always remove from the set on page close, so we
// don't accumulate zombies.
const pagesOfSession = new Map<string, Set<Page>>();
// Notice dedup is session-wide: if two different pages in the same session
// revert to the same blocked URL within the window, only one toast fires.
const lastNoticeAt = new Map<string, { url: string; at: number }>();

// Suppression flag — when a session is in "automated replay" mode (Run-from-
// start, step-by-step replay, etc.) the trap is fully disabled. Recorded
// tests may intentionally navigate through OAuth / payment flows that cross
// origins, and the replay engine has its own orchestration. The trap exists
// to catch *user-triggered* strandings, not to police automation.
const suppressedSessions = new Set<string>();

/** Grace window around explicit goto/address-bar nav. Covers redirect chains. */
const INTENT_WINDOW_MS = 3000;

/** Emit dedup — don't spam multiple notices for the same blocked URL within this window. */
const NOTICE_DEDUP_MS = 1500;

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Coarse "same app" check used for the origin baseline. Mirrors the logic in
 * `probeExternalAnchorAt` so the pre-click and post-nav paths agree on what
 * counts as cross-origin. Accepts any of:
 *   - identical origin
 *   - one hostname is a subdomain of the other (www/m/dev/staging)
 *   - last two DNS labels match (covers plain-TLD variants)
 * Multi-label ccTLDs (foo.co.uk ↔ bar.co.uk) can over-match, but allowing an
 * occasional benign external nav beats blocking the common subdomain case.
 */
function isSameApp(navUrl: string, baselineUrl: string): boolean {
  const a = hostnameOf(navUrl);
  const b = hostnameOf(baselineUrl);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.endsWith('.' + b) || b.endsWith('.' + a)) return true;
  const last2 = (h: string) => h.split('.').slice(-2).join('.');
  return last2(a) === last2(b);
}

function addPageToSession(sessionId: string, page: Page): void {
  let set = pagesOfSession.get(sessionId);
  if (!set) {
    set = new Set();
    pagesOfSession.set(sessionId, set);
  }
  set.add(page);
}

function removePageFromSession(sessionId: string, page: Page): void {
  const set = pagesOfSession.get(sessionId);
  if (!set) return;
  set.delete(page);
  if (set.size === 0) {
    pagesOfSession.delete(sessionId);
    lastNoticeAt.delete(sessionId);
    suppressedSessions.delete(sessionId);
  }
}

/**
 * Attach the trap to a page. Must be called once per page instance; subsequent
 * calls are no-ops. Call after session creation, session reset, and popup
 * adoption.
 */
export function attachExternalNavTrap(page: Page, sessionId: string, baselineUrl: string): void {
  if (attached.has(page)) return;
  attached.add(page);

  const baselineOrigin = originOf(baselineUrl);
  if (!baselineOrigin) {
    logger.debug('[EXTERNAL_NAV_TRAP] Skipping attach — baseline URL unparseable', {
      sessionId, baselineUrl,
    });
    return;
  }

  const state: PageState = {
    sessionId,
    baselineOrigin,
    baselineUrl,
    lastSafeUrl: baselineUrl,
    // Grant an intent window to cover the initial load + any same-origin redirects.
    intentUntil: Date.now() + INTENT_WINDOW_MS,
    reverting: false,
  };
  perPage.set(page, state);
  addPageToSession(sessionId, page);

  const onFrameNavigated = async (frame: Frame): Promise<void> => {
    if (frame !== page.mainFrame()) return;
    const url = frame.url();
    if (!url || url === 'about:blank') return;

    // Non-http(s) main-frame navs (data:, chrome-error://, etc.) skip the
    // trap — Playwright will surface its own error for unsupported schemes.
    const navOrigin = originOf(url);
    if (!navOrigin) return;
    if (!navOrigin.startsWith('http://') && !navOrigin.startsWith('https://')) return;

    const current = perPage.get(page);
    if (!current) return;

    const now = Date.now();

    // Snapshot the PRE-mutation baseline so the editor-trace `fromUrl`
    // shows the real transition (from-URL → to-URL). Previous pass wrote
    // `fromUrl: current.baselineUrl` AFTER we overwrote it to `url`, so
    // suppressed/intent branches logged fromUrl=toUrl (looked bogus).
    const fromBaseline = current.baselineUrl;

    // Editor trace — lazy-loaded so this module doesn't depend on the
    // trace service load order. Every decision below fires exactly one
    // event so the JSONL shows why a given nav was reverted / accepted.
    const writeTrap = async (
      action: 'reverted' | 'allowed_intent' | 'allowed_same_app' | 'suppressed_during_run',
      extra?: { recoveredTo?: string; reason?: string },
    ) => {
      try {
        const { EditorTraceService } = await import('./editor-trace.service');
        EditorTraceService.get(current.sessionId)?.writeExternalNavTrap({
          action,
          fromUrl: fromBaseline,
          toUrl: url,
          ...extra,
        });
      } catch { /* trace is advisory */ }
    };

    // Our own revert just fired — clear the guard and update baseline.
    // Checked BEFORE suppression so we always recognise the revert loop.
    if (current.reverting) {
      current.reverting = false;
      current.lastSafeUrl = url;
      return;
    }

    // User-intended navigations (address bar, preview reset, back/forward,
    // refresh, Phase-4 apply-login) extend the intent window. A user
    // action MUST beat suppression — otherwise users can't interact with
    // the preview at all during a running test (back button was already
    // reported broken by a user precisely because suppression fired
    // first). Any nav that lands inside the intent window is accepted
    // and becomes the new baseline.
    if (now < current.intentUntil) {
      current.baselineOrigin = navOrigin;
      current.baselineUrl = url;
      current.lastSafeUrl = url;
      void writeTrap('allowed_intent', { reason: 'within_intent_window' });
      return;
    }

    // Trap is disabled while an automated run is in progress. Recorded
    // tests may legitimately cross origins (OAuth, payment provider
    // handoff) and reverting mid-run would break the replay. We keep the
    // safe checkpoint + baseline fresh so a post-run user-triggered
    // revert has something useful to fall back to.
    if (suppressedSessions.has(current.sessionId)) {
      current.lastSafeUrl = url;
      current.baselineUrl = url;
      current.baselineOrigin = navOrigin;
      void writeTrap('suppressed_during_run', { reason: 'run_in_progress' });
      return;
    }

    // Same-app navigation — allowed, refresh the safe-url checkpoint.
    if (isSameApp(url, current.baselineUrl)) {
      current.lastSafeUrl = url;
      void writeTrap('allowed_same_app');
      return;
    }

    // Cross-origin navigation with no user intent behind it → revert.
    logger.info('[EXTERNAL_NAV_TRAP] Reverting cross-origin navigation', {
      sessionId: current.sessionId,
      from: current.baselineUrl,
      to: url,
      safeUrl: current.lastSafeUrl,
    });
    void writeTrap('reverted', { recoveredTo: current.lastSafeUrl });

    current.reverting = true;
    try {
      // Prefer `goBack` — preserves any client-side state on the origin
      // page. Falls back to goto if history is empty (single-click nav).
      let recovered = false;
      try {
        const backResult = await page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 });
        recovered = backResult !== null;
      } catch {
        recovered = false;
      }
      if (!recovered) {
        try {
          await page.goto(current.lastSafeUrl, { waitUntil: 'domcontentloaded', timeout: 10000 });
        } catch (err) {
          logger.warn('[EXTERNAL_NAV_TRAP] Recovery goto failed', {
            sessionId: current.sessionId,
            safeUrl: current.lastSafeUrl,
            error: err instanceof Error ? err.message : String(err),
          });
          // Give up — the user is stranded, but they'll see a toast and can
          // reset the session manually. Clear the reverting flag so future
          // navs aren't silently swallowed.
          current.reverting = false;
        }
      }
    } finally {
      // If the revert nav itself triggers framenavigated, the reverting
      // flag is consumed there. If it didn't (e.g. goBack returned null
      // without a nav event), clear it here so subsequent navs aren't lost.
      // Small delay to let the revert's framenavigated settle first.
      setTimeout(() => {
        const s = perPage.get(page);
        if (s?.reverting) s.reverting = false;
      }, 500);
    }

    // Emit notice — session-scoped dedup. If two tabs revert to the same
    // URL concurrently the user sees one toast, not two.
    const last = lastNoticeAt.get(current.sessionId);
    if (last && last.url === url && (now - last.at) < NOTICE_DEDUP_MS) return;
    lastNoticeAt.set(current.sessionId, { url, at: now });

    try {
      webSocketService.emitToRoom('preview', current.sessionId, 'preview:external-nav:blocked', {
        previewSessionId: current.sessionId,
        blockedUrl: url,
        blockedHostname: hostnameOf(url),
        baselineUrl: current.baselineUrl,
        baselineHostname: hostnameOf(current.baselineUrl),
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      logger.warn('[EXTERNAL_NAV_TRAP] Notice emit failed', {
        sessionId: current.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  page.on('framenavigated', onFrameNavigated);

  page.once('close', () => {
    perPage.delete(page);
    removePageFromSession(sessionId, page);
  });
}

/**
 * Mark an upcoming navigation as user-intended. Call immediately BEFORE a
 * `page.goto` that the user requested (address bar, preview reset, recorded
 * step `navigate_to`, etc.). Opens a short grace window during which the
 * trap will update its baseline instead of reverting.
 *
 * Per-session: the grace window fans out to every page attached to the
 * session so a navigate invoked on any tab is recognised by the trap
 * regardless of which tab ends up firing framenavigated.
 */
export function markIntentionalGoto(sessionId: string, _url: string): void {
  const pages = pagesOfSession.get(sessionId);
  if (!pages) return;
  const until = Date.now() + INTENT_WINDOW_MS;
  for (const page of pages) {
    const state = perPage.get(page);
    if (!state) continue;
    state.intentUntil = until;
    state.reverting = false;
  }
}

/**
 * Page-keyed variant for call sites that don't have the session id in scope
 * (preview-step-apply.executeAction, etc.). No-op if the page was never
 * attached. Safe to call liberally — each call refreshes the grace window.
 */
export function markIntentionalGotoByPage(page: Page): void {
  const state = perPage.get(page);
  if (!state) return;
  state.intentUntil = Date.now() + INTENT_WINDOW_MS;
  state.reverting = false;
}

/**
 * Drop all session state — used on session close when all pages are
 * destroyed together. Idempotent.
 */
export function clearExternalNavTrapSession(sessionId: string): void {
  pagesOfSession.delete(sessionId);
  lastNoticeAt.delete(sessionId);
  suppressedSessions.delete(sessionId);
}

/**
 * Put the trap into pass-through mode for the duration of an automated
 * preview run. Call when PreviewRunService starts the run; pair with
 * `resumeTrap` once the run completes (success or failure). During
 * suppression cross-origin navigations are not reverted — the trap only
 * keeps baselines fresh so it re-engages correctly after resume.
 */
export function suspendTrap(sessionId: string): void {
  suppressedSessions.add(sessionId);
}

export function resumeTrap(sessionId: string): void {
  suppressedSessions.delete(sessionId);
  // Open an intent window on all pages so any late-firing redirect that
  // crosses the resume boundary is still accepted as part of the run.
  const pages = pagesOfSession.get(sessionId);
  if (!pages) return;
  const until = Date.now() + INTENT_WINDOW_MS;
  for (const page of pages) {
    const state = perPage.get(page);
    if (!state) continue;
    state.intentUntil = until;
    state.reverting = false;
  }
}
