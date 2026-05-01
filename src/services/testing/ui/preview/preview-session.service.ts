/**
 * Preview Session Service
 * Manages server-side browser preview sessions for step editor
 * 1 session per user with TTL auto-cleanup
 */

import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';
import { logger, logPerformance } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { randomUUID } from 'crypto';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { webSocketService } from '@/websocket/core/websocket.service';
import { DomAnalysisExtractorService } from './dom-analysis-extractor.service';
import type { InteractiveNode, PreviewSession, TargetFingerprint } from './preview.types';
import { setupThirdPartyBlocker } from '@/agent/playwright/execution/third-party-blocker';
import { PREVIEW_SESSION_CONFIG, BROWSER_USER_AGENT, BROWSER_LAUNCH_ARGS, BROWSER_HEADLESS_MODE, BROWSER_EXTRA_HEADERS, BROWSER_STEALTH_SCRIPT } from '@/config/testing/playwright-tuning';
import { waitForPageInteractive } from './page-interactive.utils';

const SESSION_TTL_MS = PREVIEW_SESSION_CONFIG.sessionTtlMs;
const SESSION_CLEANUP_INTERVAL_MS = PREVIEW_SESSION_CONFIG.sessionCleanupIntervalMs;
const SNAPSHOT_THROTTLE_MS = PREVIEW_SESSION_CONFIG.snapshotThrottleMs;
const MAX_SESSIONS = PREVIEW_SESSION_CONFIG.maxSessions;
const SCREENSHOT_CONFIG = PREVIEW_SESSION_CONFIG.screenshot;
const MOUSE_INPUT_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.mouseMs;
const WHEEL_INPUT_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.wheelMs;
const KEYBOARD_TYPE_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.keyboardTypeMs;
const KEYBOARD_PRESS_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.keyboardPressMs;

/**
 * Wait for DOM to stabilize after navigation.
 * Uses MutationObserver to detect when DOM mutations stop (SPA hydration complete).
 * Unlike networkidle, this does NOT wait for images, fonts, or analytics —
 * only actual DOM changes that affect element availability.
 *
 * @param page - Playwright page
 * @param maxWaitMs - Hard cap: give up after this many ms (default 3000)
 * @param stabilityMs - Declare stable when no mutations for this many ms (default 800)
 */
async function waitForDOMStability(page: Page, maxWaitMs = 3000, stabilityMs = 800): Promise<void> {
  try {
    await page.evaluate(
      ({ maxWait, stability }: { maxWait: number; stability: number }) => {
        return new Promise<void>((resolve) => {
          // @ts-expect-error - document exists in browser context
          const root = document.body || document.documentElement;
          if (!root) { resolve(); return; }

          let lastMutation = Date.now();

          // @ts-expect-error - MutationObserver exists in browser context
          const observer = new MutationObserver(() => { lastMutation = Date.now(); });
          observer.observe(root, { childList: true, subtree: true, attributes: true });

          const check = () => {
            if (Date.now() - lastMutation >= stability) {
              observer.disconnect();
              resolve();
              return;
            }
            setTimeout(check, 100);
          };
          setTimeout(check, 100);

          // Hard cap — don't wait forever
          setTimeout(() => { observer.disconnect(); resolve(); }, maxWait);
        });
      },
      { maxWait: maxWaitMs, stability: stabilityMs }
    );
  } catch {
    // Page in weird state (navigating, crashed) — continue anyway
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NAVIGATION HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/** Threshold before emitting progress events (don't spam for fast sites) */
const SLOW_LOAD_THRESHOLD_MS = 5000;
/** Interval between progress event emissions */
const PROGRESS_EMIT_INTERVAL_MS = 3000;

/**
 * V16: External-navigation probe for preview click interception.
 *
 * When a user clicks inside the preview iframe at (x, y), walk up from the hit
 * element to the nearest `<a>` and inspect its `href` + `target`. If that link
 * would strand the user — i.e. it would navigate the single Playwright page
 * cross-origin (the user can't get back because the preview address bar has no
 * history) OR it uses a custom protocol the preview can't honour (kaspi://,
 * tg://, mailto:, tel:, etc.) — return a block verdict so the click handler
 * can short-circuit before `page.mouse.click` fires the navigation.
 *
 * Returns null when the click target is not an external/deeplink anchor: the
 * click should proceed normally. All intra-origin links, JS-driven buttons,
 * forms, and arbitrary clicks are allowed through.
 */
async function probeExternalAnchorAt(
  page: Page,
  x: number,
  y: number,
): Promise<{
  kind: 'external_origin' | 'external_protocol';
  href: string;
  hostname?: string;
  protocol: string;
  targetLabel?: string;
  linkText?: string;
} | null> {
  try {
    return await page.evaluate(
      ({ x: px, y: py }) => {
        const g = globalThis as unknown as {
          document: {
            elementFromPoint: (x: number, y: number) => unknown;
            location: { origin: string; hostname: string; protocol: string };
          };
        };
        const el = g.document.elementFromPoint(px, py) as unknown as {
          closest: (sel: string) => null | {
            getAttribute: (n: string) => string | null;
            textContent: string | null;
            href?: string;
          };
        } | null;
        if (!el) return null;
        const anchor = el.closest('a[href]');
        if (!anchor) return null;

        const rawHref = anchor.getAttribute('href') || '';
        const target = anchor.getAttribute('target') || '';
        const textContent = (anchor.textContent || '').trim().slice(0, 80);

        // Empty, in-page jump, or JavaScript-only href — let it fire.
        if (!rawHref || rawHref.startsWith('#') || rawHref.toLowerCase().startsWith('javascript:')) {
          return null;
        }

        // Resolve relative/absolute hrefs against the current document so
        // "/foo" and "https://same-host/foo" both round-trip to absolute URLs
        // via the anchor's own href property (browsers do this for us).
        const resolvedHref: string = (anchor as { href?: string }).href || rawHref;

        // Parse via URL to reliably extract protocol + hostname. If it throws,
        // the href is a custom-protocol deeplink Chromium can't resolve — still
        // block, because page.mouse.click would otherwise try to navigate.
        let protocol = '';
        let hostname = '';
        try {
          const u = new URL(resolvedHref, g.document.location.origin);
          protocol = u.protocol;
          hostname = u.hostname;
        } catch {
          // Unparseable → treat as custom protocol (kaspi://, tg://, etc).
          const schemeMatch = rawHref.match(/^([a-z][a-z0-9+.\-]*):/i);
          protocol = schemeMatch ? schemeMatch[1].toLowerCase() + ':' : '';
          return {
            kind: 'external_protocol' as const,
            href: rawHref,
            protocol,
            targetLabel: target || undefined,
            linkText: textContent || undefined,
          };
        }

        // Non-web protocols are always blocked (mailto, tel, sms, custom).
        if (protocol !== 'http:' && protocol !== 'https:') {
          return {
            kind: 'external_protocol' as const,
            href: resolvedHref,
            protocol,
            hostname: hostname || undefined,
            targetLabel: target || undefined,
            linkText: textContent || undefined,
          };
        }

        // Same-origin http(s) is fine — navigate normally.
        // Treat subdomain variants of the same registrable name as same-origin
        // to avoid false positives on www./m./dev./staging. prefixes. Compare
        // by the last two labels of each hostname — a coarse heuristic that
        // accepts x.com ↔ www.x.com, dev.x.com ↔ x.com, etc. without pulling
        // in a full public-suffix list. Multi-label ccTLDs (foo.co.uk vs
        // bar.co.uk) can over-match, but tolerating one occasional unblocked
        // external click is better than blocking the common subdomain case.
        const here = g.document.location.hostname;
        const lastTwo = (h: string) => h.split('.').slice(-2).join('.');
        if (
          hostname === here ||
          hostname.endsWith('.' + here) ||
          here.endsWith('.' + hostname) ||
          lastTwo(hostname) === lastTwo(here)
        ) return null;

        // Cross-origin http(s) opened inline (no target=_blank) strands the
        // user. Block. Note: target=_blank cases are handled separately by
        // Chromium opening a new page; we only care about the inline case.
        if (!target || target === '_self') {
          return {
            kind: 'external_origin' as const,
            href: resolvedHref,
            protocol,
            hostname,
            linkText: textContent || undefined,
          };
        }

        // target=_blank / named targets → new tab, original page survives.
        return null;
      },
      { x, y },
    );
  } catch (err) {
    // Page navigating, context destroyed, or eval rejected — fail open so
    // a legitimate click is never silently dropped by a probe glitch.
    logger.debug('[PREVIEW_SESSION] probeExternalAnchorAt eval failed, failing open', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Navigate to URL with WebSocket progress events for slow loads.
 * Emits 'preview:loading' events every 3s after 5s threshold.
 * Replaces raw page.goto with user-visible progress feedback.
 */
async function navigateWithProgress(
  page: Page,
  url: string,
  previewSessionId: string,
  opts: { waitUntil: 'load' | 'domcontentloaded' | 'networkidle' | 'commit'; timeout: number },
): Promise<void> {
  const start = Date.now();
  let phase: 'navigating' | 'dom_ready' | 'stabilizing' | 'complete' | 'error' = 'navigating';

  // Emit progress every PROGRESS_EMIT_INTERVAL_MS, but only after SLOW_LOAD_THRESHOLD_MS
  const interval = setInterval(() => {
    const elapsed = Date.now() - start;
    if (elapsed >= SLOW_LOAD_THRESHOLD_MS) {
      webSocketService.emitToRoom('preview', previewSessionId, 'preview:loading', {
        previewSessionId, phase, url, elapsedMs: elapsed,
      });
    }
  }, PROGRESS_EMIT_INTERVAL_MS);

  try {
    await page.goto(url, opts as any);
    phase = 'complete';
  } catch (error) {
    phase = 'error';
    const elapsed = Date.now() - start;
    const originalError = error instanceof Error ? error : new Error(String(error));
    const friendlyError = classifyNavigationError(originalError, url);
    // Log original error for server-side debugging (stack trace preserved)
    logger.warn('[PREVIEW_SESSION] Navigation failed', {
      url, elapsed, friendlyError, originalError: originalError.message,
    });
    webSocketService.emitToRoom('preview', previewSessionId, 'preview:loading', {
      previewSessionId, phase, url, elapsedMs: elapsed, error: friendlyError,
    });
    // Re-throw with friendly message (original stack in logs above)
    throw new Error(friendlyError);
  } finally {
    clearInterval(interval);
    // Emit final complete event (only if not error — error already emitted above)
    if (phase === 'complete') {
      webSocketService.emitToRoom('preview', previewSessionId, 'preview:loading', {
        previewSessionId, phase, url, elapsedMs: Date.now() - start,
      });
    }
  }
}

/**
 * Classify navigation errors into user-friendly messages.
 * Replaces raw Playwright TimeoutError with actionable descriptions.
 */
function classifyNavigationError(error: Error, url: string): string {
  const msg = error.message.toLowerCase();

  if (msg.includes('net::err_name_not_resolved'))
    return `Domain not found — check the URL: ${url}`;

  if (msg.includes('net::err_connection_refused'))
    return `Connection refused — the site may be down: ${url}`;

  if (msg.includes('net::err_connection_timed_out'))
    return `Connection timed out — the server is not responding: ${url}`;

  if (msg.includes('net::err_cert') || msg.includes('net::err_ssl'))
    return `SSL certificate error for: ${url}`;

  if (msg.includes('net::err_internet_disconnected') || msg.includes('net::err_network'))
    return `Network error — check your internet connection`;

  if (msg.includes('net::err_aborted'))
    return `Navigation was aborted: ${url}`;

  if (msg.includes('timeout'))
    return `Site did not finish loading within timeout. The website may be slow or unresponsive: ${url}`;

  return error.message;
}

/**
 * Sanitize Playwright close errors.
 * Playwright sometimes appends huge Chromium "Browser logs" to the error message.
 * Those logs are rarely actionable for our backend cleanup logic and can spam logs.
 */
function formatPlaywrightCloseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutBrowserLogs = raw.split('\nBrowser logs:\n')[0] || raw;
  const singleLine = withoutBrowserLogs.replace(/\s+/g, ' ').trim();
  // Cap to keep logs readable
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine;
}

/**
 * Heuristic: close errors that commonly happen when the page/context/browser
 * is already closed (benign during cleanup).
 */
function isBenignAlreadyClosedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /Target page, context or browser has been closed/i.test(msg) ||
    /Target\.disposeBrowserContext.+Failed to find context/i.test(msg)
  );
}

/**
 * Internal session state (extends PreviewSession with Playwright objects)
 */
interface InternalSession extends PreviewSession {
  browser: Browser;
  context: BrowserContext;
  page: Page; // Active page — always points to pages[activeTabIndex]
  /** V15: All open tabs. Index 0 = initial page. */
  pages: Page[];
  /** V15: Index into pages[] for the currently active tab */
  activeTabIndex: number;
  lastSnapshotEmit: number;
  lastScreenshotEmitAt: number;  // Last screenshot emission timestamp
  lastPageSignature: string;      // Hash for diff detection (url+domMetrics)
  /**
   * V20: Signature of the last `preview:page` payload actually emitted on the wire.
   * Used by emitSnapshotIfChanged + DOM tick + apply/subscribe handlers to skip redundant
   * emits when the DOM hasn't changed since the previous emit (e.g. rapid clicks on
   * non-mutating elements, wheel events on a static page). Updated by EVERY preview:page
   * emit site so force-emits and interval-emits share the same dedup window.
   */
  lastEmittedSignature: string;
  lastMouseInputAt: number;       // Mouse input throttling timestamp
  lastWheelInputAt: number;       // Wheel input throttling timestamp
  lastKeyboardTypeAt: number;     // Keyboard type throttling timestamp
  lastKeyboardPressAt: number;    // Keyboard press throttling timestamp
  domVersion: number;             // Monotonically increasing DOM version
  contextVersion: number;         // Version for context updates
  contextData: Record<string, any>; // Context data (env + test variables)

  // Recording mode state
  recording: boolean;
  recordingTypingBuffer: {
    text: string;
    elementRef?: string;
    elementLabel: string;
    lastCharAt: number;
    bindingHints?: Record<string, string>;
    /** V10: True if the focused element is multiline (textarea, contenteditable) */
    isMultiline?: boolean;
    /** URL where typing started (guards against cross-page ref collision) */
    pageUrl?: string;
    /** V13: CSS selector of iframe containing the focused element */
    iframeSelector?: string;
    /**
     * V22: Probe-time fingerprint of the focused input. Travels with the
     * buffer through `flushTypingBuffer` into the resulting type-step's
     * `recordedFingerprint`, giving the LLM resolver full identifying
     * data on first apply (no need to wait for compiled-plan generation).
     */
    recordedFingerprint?: TargetFingerprint;
  } | null;
  /**
   * V22 Pkg8: Field Session — captures the user's *intent* to fill a form
   * field as ONE logical step, regardless of how many physical events
   * (typing, backspace, arrow keys, mid-string edits, copy-paste) the user
   * generates inside the field.
   *
   * Why exist alongside recordingTypingBuffer:
   *   - The legacy buffer model coalesces letter-by-letter and patches
   *     edge-cases via per-key absorption (backspace trims last char,
   *     arrow keys fall through to press-coalesce). This model BREAKS
   *     whenever the user navigates the cursor into the middle of the
   *     value and edits there — we end up with 8+ steps in the trace
   *     and the Type step's value drifts from the real <input>.value.
   *   - Field Session treats the focus span as a single editing transaction.
   *     Internal events are absorbed; on close (blur / focus-shift /
   *     submit / nav) we read the LIVE input.value and emit ONE Type
   *     step with the canonical final value. Single source of truth.
   *
   * Lifecycle:
   *   open  — focus enters an interactive form control while recording
   *   live  — internal events (key, arrow, backspace, paste) absorbed
   *   close — focus shift / blur / submit / nav / recording stop →
   *           read live value, emit Type step (or remove if value
   *           reverted to initial), clear session
   */
  recordingFieldSession?: {
    /** data-agent-ref of the focused control (anchors live-value re-read). */
    elementRef: string;
    /** Probed label for description ("Phone", "Email", etc). */
    elementLabel: string;
    /** Probed tag (input/textarea/select). Used for value-read strategy. */
    elementTag: string;
    /** Type attr (text/number/email/password/...) — controls placeholder vs value masking. */
    elementType?: string;
    /** True for textarea / contenteditable — value reads via .value vs .textContent. */
    isMultiline?: boolean;
    /** initial input.value at session open — diff against final to detect no-op. */
    initialValue: string;
    /** monotonic ts of session open — for stale-session timeout safety. */
    startedAt: number;
    /** Page URL at open — guards cross-navigation false-merges. */
    pageUrl: string;
    /** Iframe selector if the input lives in a child frame. */
    iframeSelector?: string;
    /** Full fingerprint of the focused control — flows into recorded step. */
    recordedFingerprint?: TargetFingerprint;
    /** Pre-built BindingHints (semantic locator hints). Captured at open time
     *  via RecordingCaptureService.buildBindingHints so close-time emission
     *  doesn't need to re-probe. Distinct from recordedFingerprint (raw shape). */
    bindingHints?: Record<string, unknown>;
    /** Step ID emitted for THIS session — reused when session value
     *  re-emits on subsequent updates (`step:update`). Set after first emit. */
    emittedStepId?: string;
  } | null;
  recordingLastUrl: string;
  /** V10: Drag state tracked between mouse:down and mouse:up */
  recordingDragState: {
    startX: number;
    startY: number;
    startElement: any; // ProbedElement from recording-capture.service
    startedAt: number;
    viewport?: { width: number; height: number };
  } | null;
  /** V10: Last emitted type step — for merging consecutive typing in same element */
  recordingLastTypeStep: {
    id: string;
    elementRef?: string;
    value: string;
  } | null;
  /**
   * Last emitted press step — for coalescing consecutive identical key presses
   * into a single step with a rendered `× N` count. Without this, mashing
   * Backspace on an empty field produced one standalone "Press Backspace"
   * step per keystroke (a common complaint — 5-6 duplicates in a row).
   * Cleared on any non-matching key press OR when a non-press event arrives
   * (type, click, scroll, etc. — see ensureLastPressCleared in handlers).
   */
  recordingLastPressStep: {
    id: string;
    key: string;
    modifiersKey: string; // e.g. "Control+Shift" or "" — used to compare identity
    count: number;
  } | null;
  /**
   * Last emitted click step — used to upgrade a single-click step into a
   * dblclick when the browser fires two consecutive clicks on the same
   * element within the browser's double-click window. Without this, a user
   * double-clicking a button produced two separate steps: "Click Save"
   * followed by "Double-click Save". Cleared on any non-click event.
   */
  recordingLastClickStep: {
    id: string;
    elementSignature: string; // stable id for the clicked element
    emittedAt: number; // epoch ms — used to bound the dblclick window
  } | null;
  /**
   * Last emitted navigate/refresh step — for coalescing consecutive
   * navigations to the same URL (e.g. user mashes F5, or clicks Back and
   * lands on the same page). Cleared on any non-navigate event.
   */
  recordingLastNavigateStep: {
    id: string;
    url: string;
    kind: 'navigate' | 'back' | 'forward' | 'refresh';
    count: number;
  } | null;
  /** V10: Last emitted scroll step — for merging consecutive scrolls */
  recordingLastScrollStep: {
    id: string;
    totalDelta: number;
    totalDeltaX: number;
    emittedAt: number;
    containerSelector?: string | null;
  } | null;
  /** V11: Last hover position — for recording hover steps before click on different element */
  /** V18: Extended with full ProbedElement from hover probe for click reuse */
  recordingLastHover: {
    x: number;
    y: number;
    ref?: string;
    timestamp: number;
    /** V18: Full probe result from hover — reused by click to avoid double-probe divergence */
    probedElement?: import('@/services/testing/ui/preview/recording-capture.service').ProbedElement | null;
  } | null;
  /**
   * V22 Pkg5+: Hover CHAIN — all distinct hover-targets dwelt on between
   * consecutive clicks. Replaces "single last hover" semantics so multi-
   * level menus (Menu → Submenu → click leaf) survive replay deterministically
   * — each menu trigger gets its own hover-step in trace order.
   *
   * Distinctness is by boundingBox (same x/y/w/h = same element). Capped
   * at 4 entries to bound memory; oldest dropped when full. Cleared after
   * each click flush in preview.handler.ts.
   */
  recordingHoverChain?: Array<{
    x: number;
    y: number;
    timestamp: number;
    probedElement: import('@/services/testing/ui/preview/recording-capture.service').ProbedElement;
  }>;

  /** V13: Actual page URL when recording started (more reliable than frontend editorBaseUrl) */
  recordingStartUrl?: string;
  /** V14: Timestamp when last recording step was emitted (for inter-step delay calculation) */
  recordingLastStepEmittedAt?: number;
  /**
   * Count of NEW recording steps emitted in the current recording session.
   * Incremented in emitRecordingStep(), decremented when a step is removed
   * (`preview:recording:step:remove`, typing backspace-all). NOT incremented
   * on `:step:update` (merges don't create a new step). Reset to 0 by
   * `setRecording(false)`. Used by the max-steps auto-stop guard.
   */
  recordingStepCount?: number;

  /** V13: Dialog handling mode — controls how native dialogs are handled */
  dialogMode: 'passive' | 'recording' | 'replay';
  /** V13: Pre-installed dialog action for replay (set before the step that triggers the dialog) */
  pendingDialogAction?: {
    action: 'accept' | 'dismiss';
    promptText?: string;
  };

  /** V13: True when next keyboard:type is a paste (Ctrl+V/Cmd+V detected in keyboard:press) */
  recordingPendingPaste?: boolean;

  /** V11: Callback invoked when session switches to a new page (popup/navigation) */
  onPageSwitch?: (newPage: Page, previousUrl: string) => void;

  /** V11: True while page switch is in progress — blocks DOM tick from collecting stale/empty snapshots */
  pageSwitchInProgress?: boolean;
}

/**
 * Preview Session Manager
 * Singleton service that manages browser preview sessions
 */
export class PreviewSessionService {
  private static instance: PreviewSessionService;
  private sessions: Map<string, InternalSession> = new Map();
  private userToSession: Map<string, string> = new Map(); // userId -> sessionId
  private cleanupInterval: NodeJS.Timeout | null = null;
  // Per-user locks to prevent race conditions on concurrent start/stop
  private userLocks: Map<string, Promise<void>> = new Map();

  private constructor() {
    this.startCleanupInterval();
  }

  static getInstance(): PreviewSessionService {
    if (!PreviewSessionService.instance) {
      PreviewSessionService.instance = new PreviewSessionService();
    }
    return PreviewSessionService.instance;
  }

  /**
   * Acquire per-user lock to prevent race conditions
   * Returns a promise that resolves when the lock is acquired
   */
  private async acquireUserLock(userId: string): Promise<() => void> {
    // Wait for any existing operation to complete
    const existingLock = this.userLocks.get(userId);
    if (existingLock) {
      await existingLock.catch(() => { }); // Ignore errors from previous operation
    }

    // Create new lock promise
    let releaseLock: () => void = () => { };
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.userLocks.set(userId, lockPromise);

    // Return release function
    return () => {
      releaseLock();
      // Clean up lock after short delay to prevent immediate race
      setTimeout(() => {
        if (this.userLocks.get(userId) === lockPromise) {
          this.userLocks.delete(userId);
        }
      }, 100);
    };
  }

  /**
   * Helper to safely close browser resources
   * Guarantees cleanup even if errors occur
   * Includes 10s timeout per resource to prevent infinite hangs
   */
  private async safeCloseBrowserResources(
    browser?: Browser,
    context?: BrowserContext,
    page?: Page
  ): Promise<void> {
    const CLOSE_TIMEOUT_MS = 10000; // 10 seconds per resource
    const getBrowserPid = (b?: Browser): number | undefined => {
      try {
        const proc = (b as any)?.process?.();
        return proc?.pid;
      } catch {
        return undefined;
      }
    };

    /**
     * Helper: wrap close operation with timeout
     */
    const closeWithTimeout = async (
      closePromise: Promise<void>,
      resourceName: string,
      resourceId?: number
    ): Promise<void> => {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${resourceName} close timeout (${CLOSE_TIMEOUT_MS}ms)`)), CLOSE_TIMEOUT_MS)
      );

      try {
        await Promise.race([closePromise, timeoutPromise]);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTimeout = errorMessage.includes('timeout');

        if (isTimeout) {
          logger.warn(`[PREVIEW_SESSION] ${resourceName} close timeout, may need force kill`, {
            timeout: CLOSE_TIMEOUT_MS,
            pid: resourceId,
          });
        } else if (!isBenignAlreadyClosedError(error)) {
          logger.warn(`[PREVIEW_SESSION] Error closing ${resourceName}`, {
            error: formatPlaywrightCloseError(error),
          });
        }

        // Don't throw - we want to try closing other resources
      }
    };

    const closePromises: Promise<void>[] = [];

    if (page) {
      closePromises.push(closeWithTimeout(page.close(), 'page'));
    }

    if (context) {
      closePromises.push(closeWithTimeout(context.close(), 'context'));
    }

    if (browser) {
      const browserPid = getBrowserPid(browser);
      closePromises.push(closeWithTimeout(browser.close(), 'browser', browserPid));
    }

    await Promise.all(closePromises);
  }

  /**
   * Start a new preview session for a user
   * Closes existing session if user already has one
   */
  async startSession(params: {
    userId: string;
    projectId: string;
    startUrl: string;
    viewport?: { width: number; height: number };
  }): Promise<{
    previewSessionId: string;
    url: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
  }> {
    const { userId, projectId, startUrl, viewport } = params;
    const safeStartUrl = sanitizeUrl(startUrl);

    // Acquire per-user lock to prevent race conditions
    const releaseLock = await this.acquireUserLock(userId);

    try {
      // Check session limit
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error('Maximum preview sessions reached. Try again later.');
      }

      // Close existing session for this user (under lock)
      const existingSessionId = this.userToSession.get(userId);
      if (existingSessionId) {
        try {
          await this.stopSessionInternal(existingSessionId);
        } catch (stopError) {
          // Log but don't fail - we still want to create new session
          logger.warn('[PREVIEW_SESSION] Error stopping existing session, continuing', {
            userId,
            existingSessionId,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          });
        }
      }

      logger.info('[PREVIEW_SESSION] Starting new session', { userId, projectId, startUrl: safeStartUrl });

      // Local variables for guaranteed cleanup
      let browser: Browser | undefined;
      let context: BrowserContext | undefined;
      let page: Page | undefined;

      const sessionStartTime = Date.now();

      /** Emit real-time progress to user room (client is authenticated but not yet subscribed to preview room). */
      const emitProgress = (stage: 'launching_browser' | 'loading_page' | 'extracting_elements' | 'ready', progress: number) => {
        webSocketService.emitToUser(userId, 'preview:session:progress', {
          stage,
          progress,
          url: safeStartUrl,
          elapsedMs: Date.now() - sessionStartTime,
        });
      };

      try {
        // Stage 1: Launch browser
        emitProgress('launching_browser', 10);

        browser = await chromium.launch({
          headless: BROWSER_HEADLESS_MODE,
          args: [...BROWSER_LAUNCH_ARGS],
        });

        emitProgress('launching_browser', 25);

        context = await browser.newContext({
          viewport: viewport ?? PREVIEW_SESSION_CONFIG.viewport,
          userAgent: BROWSER_USER_AGENT,
          extraHTTPHeaders: { ...BROWSER_EXTRA_HEADERS },
        });

        // Apply stealth patches (hides headless/automation markers)
        await context.addInitScript(BROWSER_STEALTH_SCRIPT);

        page = await context.newPage();

        // Generate session ID early (needed for progress events during navigation)
        const sessionId = `preview_${randomUUID()}`;

        // Block third-party requests to prevent slow networkidle waits
        try {
          await setupThirdPartyBlocker(page);
        } catch {
          // Non-fatal: preview should work without blocker
        }

        // Register auto-dismiss for known blocking overlays (react-joyride,
        // intro.js, shepherd, driver.js). These tour libraries put a
        // full-viewport overlay on top of the page that intercepts pointer
        // events — Playwright's addLocatorHandler dismisses them before
        // every actionability check. No cost when no overlay is present.
        try {
          const { registerOverlayAutoDismiss } = await import('../auto-dismiss-overlays');
          await registerOverlayAutoDismiss(page);
        } catch {
          // Non-fatal
        }

        // Attach auth-gate detector. Emits preview:auth:required when
        // the page looks like a login gate, so the frontend can prompt
        // the user to pick an existing Login resource or record a new one.
        //
        // v2: pass projectId/userId so the detector can read workspace-
        // configured URL patterns (workspace_resource_defaults.url_pattern)
        // as an additional positive signal. Also pass an isRecording
        // probe — while the user is mid-recording we silence the detector
        // so it doesn't prompt during the very act of capturing a login.
        try {
          const { attachAuthDetector } = await import('./auth-detector');
          attachAuthDetector(page, sessionId, {
            projectId,
            userId,
            isRecording: () => this.sessions.get(sessionId)?.recording === true,
          });
        } catch {
          // Non-fatal — recording still works without the detector.
        }

        // V16: Attach external-navigation trap. Catches cross-origin nav
        // that the pre-click anchor interceptor missed (JS-driven
        // location.href, window.open without target, form submits to
        // external origins). Reverts the nav and emits a notice event.
        try {
          const { attachExternalNavTrap, markIntentionalGoto } = await import('./external-nav-trap');
          attachExternalNavTrap(page, sessionId, safeStartUrl);
          // The upcoming initial goto is user-intent — open the grace window.
          markIntentionalGoto(sessionId, safeStartUrl);
        } catch {
          // Non-fatal — preview still works; user just gets stranded on
          // the rare JS-driven external nav instead of auto-recovering.
        }

        // Stage 2: Load page
        emitProgress('loading_page', 40);

        // Navigate to start URL (with progress events for slow sites)
        await navigateWithProgress(page, safeStartUrl, sessionId, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        emitProgress('loading_page', 60);

        // Wait until the page is **actually interactive for a bot**, not just
        // "DOM stopped mutating for 800ms". The old waitForDOMStability() was
        // fooled by SSO/OAuth redirect chains (e.g. dlkz.doculite.kz →
        // accounttest.doculite.kz/oauth/authorize → …): mutations quieted
        // between redirects, so it returned ready while the login form wasn't
        // even on screen yet, and the initial snapshot collected 0 elements.
        //
        // waitForPageInteractive only returns ready once:
        //   1. URL has stopped changing (redirect chain finished)
        //   2. API idle + DOM stable + loading indicators cleared
        //   3. SnapshotCollector.collect() returns ≥1 interactive element
        //      (same collector used on line 532 — if it sees elements here,
        //      the initial snapshot below is guaranteed to be non-empty).
        // Fails open on timeout, so we preserve the old "always proceed"
        // behaviour — worst case the initial snapshot is still empty, same
        // as today.
        const initialReadiness = await waitForPageInteractive(page, {
          previewSessionId: sessionId,
        });

        if (!initialReadiness.ready) {
          logger.warn('[PREVIEW_SESSION] Initial readiness gate timed out', {
            sessionId,
            waited: initialReadiness.waited,
            elementCount: initialReadiness.elementCount,
            finalUrl: initialReadiness.finalUrl,
            reason: initialReadiness.reason,
          });
        }

        // Stage 3: Extract elements
        emitProgress('extracting_elements', 75);

        // Collect initial snapshot (skip stability wait — already done above via waitForDOMStability)
        const snapshot = await SnapshotCollector.collect(page, { skipStabilityWait: true });
        const domAnalysis = DomAnalysisExtractorService.extract(snapshot);

        // Compute initial page signature
        const initialUrl = page.url();
        const initialSignature = this.computePageSignature(initialUrl, domAnalysis.interactiveNodes);

        // Create session
        const session: InternalSession = {
          id: sessionId,
          userId,
          projectId,
          startUrl: safeStartUrl,
          pageState: {
            url: initialUrl,
            pageTitle: await page.title().catch(() => undefined),
            domNodes: domAnalysis.interactiveNodes,
            pageText: snapshot.pageTextForExtraction?.slice(0, 3000),
          },
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          browser,
          context,
          page,
          pages: [page],       // V15: multi-tab — initial page at index 0
          activeTabIndex: 0,   // V15: active tab is the initial page
          lastSnapshotEmit: 0,
          lastScreenshotEmitAt: 0,
          lastPageSignature: initialSignature,
          // V20: Start empty so the first emit after session start always passes dedup
          lastEmittedSignature: '',
          lastMouseInputAt: 0,
          lastWheelInputAt: 0,
          lastKeyboardTypeAt: 0,
          lastKeyboardPressAt: 0,
          domVersion: 1,           // Start at version 1
          contextVersion: 0,
          contextData: {},

          // Recording mode (off by default)
          recording: false,
          recordingTypingBuffer: null,
          recordingLastUrl: safeStartUrl,
          recordingDragState: null,
          recordingStepCount: 0,
          recordingLastTypeStep: null,
          recordingLastPressStep: null,
          recordingLastClickStep: null,
          recordingLastNavigateStep: null,
          recordingLastScrollStep: null,
          recordingLastHover: null,
          dialogMode: 'passive',
        };

        // Store session
        this.sessions.set(sessionId, session);
        this.userToSession.set(userId, sessionId);

        // Auto-dismiss native dialogs (alert/confirm/prompt/beforeunload)
        this.attachDialogHandler(page, sessionId);

        // Handle popup / new tab detection
        this.attachPopupHandler(context, sessionId);

        // V15: Track tab close events (site-initiated window.close())
        this.attachTabCloseListener(page, sessionId);

        // Handle page crash (renderer process OOM, infinite loop, etc.)
        this.attachCrashHandler(page, sessionId);
        this.attachFrameNavigatedTrace(page, sessionId);

        // Handle download attempts (headless can't download — notify frontend)
        this.attachPageDownloadHandler(page, sessionId);

        logger.info('[PREVIEW_SESSION] Session started', {
          sessionId,
          url: page.url(),
          nodeCount: domAnalysis.interactiveNodes.length,
        });

        // Initialize trace writer for this session — captures all preview operations to JSONL
        try {
          const { EditorTraceService } = await import('./editor-trace.service');
          const trace = EditorTraceService.getOrCreate(sessionId, userId);
          trace.writeSessionStart({
            startUrl: safeStartUrl,
            viewport: viewport ?? PREVIEW_SESSION_CONFIG.viewport,
          });
        } catch { /* trace logging must never break session start */ }

        // Stage 4: Ready
        emitProgress('ready', 100);

        return {
          previewSessionId: sessionId,
          url: page.url(),
          domNodes: domAnalysis.interactiveNodes,
        };
      } catch (error) {
        // CRITICAL: Cleanup browser resources if session creation failed
        // This prevents resource leaks when goto/snapshot fails
        logger.error('[PREVIEW_SESSION] Failed to start session, cleaning up resources', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });

        await this.safeCloseBrowserResources(browser, context, page);

        throw error;
      }
    } finally {
      // Always release the lock
      releaseLock();
    }
  }

  /**
   * Reset session (clear context/cookies/storage) and return to startUrl
   */
  async resetSession(params: {
    sessionId: string;
    userId: string;
  }): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    screenshot?: string;
    changed: boolean;
  } | null> {
    const { sessionId, userId } = params;

    // Acquire lock using the session owner to avoid race conditions
    // (we must not swap context/page concurrently with other operations)
    const sessionBeforeLock = this.getAuthorizedSession(sessionId, userId);
    if (!sessionBeforeLock) return null;
    const ownerUserId = sessionBeforeLock.userId;

    const releaseLock = await this.acquireUserLock(ownerUserId);

    // Local vars to prevent leaks on partial failure
    let newContext: BrowserContext | undefined;
    let newPage: Page | undefined;

    try {
      // Re-fetch session under lock to ensure it still exists and is owned
      const session = this.getAuthorizedSession(sessionId, userId);
      if (!session) return null;

      logger.info('[PREVIEW_SESSION] Resetting session', { sessionId });

      const browser = session.browser;
      const startUrl = session.startUrl;

      // IMPORTANT: Do reset atomically.
      // 1) Create + load a fresh context/page successfully.
      // 2) Swap session references.
      // 3) Close old resources after swap.
      newContext = await browser.newContext({
        viewport: PREVIEW_SESSION_CONFIG.viewport,
        userAgent: BROWSER_USER_AGENT,
        extraHTTPHeaders: { ...BROWSER_EXTRA_HEADERS },
      });

      await newContext.addInitScript(BROWSER_STEALTH_SCRIPT);

      newPage = await newContext.newPage();

      // Block third-party requests to prevent slow networkidle waits
      try {
        await setupThirdPartyBlocker(newPage);
      } catch {
        // Non-fatal: preview should work without blocker
      }

      // Auto-dismiss blocking overlays (tour libraries, cookie banners).
      // See auto-dismiss-overlays.ts for full rationale.
      try {
        const { registerOverlayAutoDismiss } = await import('../auto-dismiss-overlays');
        await registerOverlayAutoDismiss(newPage);
      } catch {
        // Non-fatal
      }

      // Re-attach auth detector after reset — session id stays the same,
      // the detector is idempotent via WeakSet on the new page handle.
      // Pass the same context it had originally so workspace URL
      // patterns and the recording-suppression guard keep working.
      try {
        const { attachAuthDetector } = await import('./auth-detector');
        attachAuthDetector(newPage, sessionId, {
          projectId: session.projectId,
          userId: session.userId,
          isRecording: () => this.sessions.get(sessionId)?.recording === true,
        });
      } catch {
        // Non-fatal
      }

      // V16: Re-attach external-nav trap on the fresh page. Session id is
      // reused, but the WeakSet tracks pages by reference so the new page
      // gets its own listener.
      try {
        const { attachExternalNavTrap, markIntentionalGoto } = await import('./external-nav-trap');
        attachExternalNavTrap(newPage, sessionId, startUrl);
        markIntentionalGoto(sessionId, startUrl);
      } catch {
        // Non-fatal
      }

      await newPage.goto(startUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Wait until the page is actually interactive for a bot. Same reasoning
      // as the initial session start path above — naive DOM stability is
      // fooled by SSO/OAuth redirect chains. See waitForPageInteractive
      // for the full gate (URL stable → API idle + loading indicators clear
      // → snapshot returns ≥1 interactive element). Fails open on timeout
      // to preserve the old "always proceed" behaviour.
      const resetReadiness = await waitForPageInteractive(newPage, {
        previewSessionId: sessionId,
      });

      if (!resetReadiness.ready) {
        logger.warn('[PREVIEW_SESSION] Reset readiness gate timed out', {
          sessionId,
          waited: resetReadiness.waited,
          elementCount: resetReadiness.elementCount,
          finalUrl: resetReadiness.finalUrl,
          reason: resetReadiness.reason,
        });
      }

      // Save old resources (close after swap)
      const oldContext = session.context;
      const oldPage = session.page;

      // Swap to new resources
      session.context = newContext;
      session.page = newPage;
      // V15: Reset tabs — new context = fresh single tab
      session.pages = [newPage];
      session.activeTabIndex = 0;
      // Critical: refresh createdAt so evidence-shortcut's session-lifetime
      // gate treats the new context as a new ref namespace. Without this,
      // recorded `evidence.lastSuccessRef` values from before the reset
      // would still be considered valid — but `__agentRefCounter` on the
      // new browser context starts at 0, so those refs now point at
      // unrelated elements (fake-pass class bug). See evidenceShortcut
      // session_newer_than_evidence check.
      session.createdAt = Date.now();

      // Auto-dismiss native dialogs on the new page
      this.attachDialogHandler(newPage, sessionId);

      // Re-attach handlers on new context/page
      this.attachPopupHandler(newContext, sessionId);
      this.attachCrashHandler(newPage, sessionId);
      this.attachFrameNavigatedTrace(newPage, sessionId);
      this.attachPageDownloadHandler(newPage, sessionId);
      this.attachTabCloseListener(newPage, sessionId);

      // Reset internal timers/state to avoid throttling weirdness after reset
      session.lastSnapshotEmit = 0;
      session.lastScreenshotEmitAt = 0;
      session.lastPageSignature = '';
      // V20: Reset dedup marker so the first emit on the new page always passes through
      session.lastEmittedSignature = '';
      session.lastMouseInputAt = 0;
      session.lastWheelInputAt = 0;
      session.lastKeyboardTypeAt = 0;
      session.lastKeyboardPressAt = 0;
      session.domVersion = 1; // Reset to version 1 on session reset

      // Reset recording state
      session.recording = false;
      session.recordingTypingBuffer = null;
      session.recordingLastUrl = startUrl;
      session.recordingDragState = null;
      session.recordingLastTypeStep = null;
      session.recordingLastPressStep = null;
      session.recordingLastClickStep = null;
      session.recordingLastNavigateStep = null;
      session.recordingStepCount = 0;
      session.recordingLastScrollStep = null;

      // Close old resources after swap (do not break reset if close fails)
      await this.safeCloseBrowserResources(undefined, oldContext, oldPage);

      return this.getSnapshot(sessionId, userId, {
        force: true,
        includeDomNodes: true,
        onlyIfChanged: false,
      });
    } catch (error) {
      logger.error('[PREVIEW_SESSION] Session reset failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Cleanup partially-created resources if we failed before swapping
      await this.safeCloseBrowserResources(undefined, newContext, newPage).catch(() => {});
      return null;
    } finally {
      releaseLock();
    }
  }

  /**
   * Refresh current page
   */
  async refreshPage(sessionId: string, userId: string): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    screenshot?: string;
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const startMs = Date.now();
      const currentUrl = session.page.url();
      logger.info('[PREVIEW_SESSION] Refreshing page', { sessionId, url: currentUrl });

      // Refresh is user-intent; suppress the external-nav trap so a
      // server-side redirect that bounces to a different origin (OAuth,
      // session expiry) isn't reverted.
      try {
        const { markIntentionalGoto } = await import('./external-nav-trap');
        markIntentionalGoto(sessionId, currentUrl);
      } catch { /* non-fatal */ }

      // Use domcontentloaded — networkidle can hang 5-10s on sites with analytics/WS
      await session.page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      logPerformance('preview.refreshPage.reload', Date.now() - startMs, { sessionId, url: currentUrl });

      // Snapshot is collected asynchronously after returning to the caller so the
      // WebSocket handler can emit pageActionResult immediately without blocking.
      setImmediate(() => {
        this.getSnapshot(sessionId, userId, {
          force: true,
          includeDomNodes: true,
          onlyIfChanged: false,
        }).catch((err) => {
          logger.warn('[PREVIEW_SESSION] refreshPage snapshot failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      // Return a lightweight result so the handler can emit success right away.
      // The full DOM update arrives via the DOM-update interval (500ms) once the
      // snapshot is ready.
      const url = session.page.url();
      return {
        url,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        changed: url !== currentUrl,
      };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Page refresh failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Navigate back in browser history
   */
  async goBack(sessionId: string, userId: string): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const startMs = Date.now();
      const previousUrl = session.page.url();
      logger.info('[PREVIEW_SESSION] Navigating back', { sessionId, currentUrl: previousUrl });

      // History navigation is user-intent — let the trap accept the
      // target URL instead of treating it as a stranded redirect.
      try {
        const { markIntentionalGoto } = await import('./external-nav-trap');
        markIntentionalGoto(sessionId, previousUrl);
      } catch { /* non-fatal */ }

      const response = await session.page.goBack({
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });

      const newUrl = session.page.url();

      // goBack returns null both when there's no history AND for SPA navigations
      // (pushState/replaceState don't produce network responses).
      // Check URL change to distinguish: if URL changed, back worked (SPA case).
      if (!response && newUrl === previousUrl) {
        // V-Phase4: "No history" on this page does NOT necessarily mean the
        // user has nowhere to go. When a site opened a popup (window.open
        // or target=_blank) we've swapped `session.page` to the popup, but
        // the previous tab is still alive in `session.pages[]`. A real
        // browser's back button wouldn't work on that popup either — but
        // the user expects "take me back to where I was before clicking
        // the payment link". So fall back to closing the current tab and
        // activating the previous one; closeTab emits the right tab
        // events and restarts video on the now-active page.
        if (session.pages.length > 1 && session.activeTabIndex > 0) {
          const previousTabIndex = session.activeTabIndex - 1;
          const closedIndex = session.activeTabIndex;
          logger.info('[PREVIEW_SESSION] goBack fell back to closing popup tab', {
            sessionId, closedIndex, switchingToIndex: previousTabIndex, popupUrl: previousUrl,
          });
          const closed = await this.closeTab(sessionId, userId, closedIndex);
          if (closed) {
            const restoredUrl = session.page.url();
            logPerformance('preview.goBack', Date.now() - startMs, {
              sessionId, from: previousUrl, to: restoredUrl, via: 'popup_close',
            });
            setImmediate(() => {
              this.getSnapshot(sessionId, userId, {
                force: true, includeDomNodes: true, onlyIfChanged: false,
              }).catch(() => { /* non-fatal */ });
            });
            return {
              url: restoredUrl,
              domVersion: session.domVersion,
              pageSignature: session.lastPageSignature,
              changed: restoredUrl !== previousUrl,
            };
          }
        }
        logger.debug('[PREVIEW_SESSION] No history to go back', { sessionId });
        return null;
      }
      logPerformance('preview.goBack', Date.now() - startMs, { sessionId, from: previousUrl, to: newUrl });

      // Kick off snapshot collection without blocking — caller gets result immediately
      setImmediate(() => {
        this.getSnapshot(sessionId, userId, {
          force: true,
          includeDomNodes: true,
          onlyIfChanged: false,
        }).catch((err) => {
          logger.warn('[PREVIEW_SESSION] goBack snapshot failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      return {
        url: newUrl,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        changed: newUrl !== previousUrl,
      };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] goBack failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Navigate forward in browser history
   */
  async goForward(sessionId: string, userId: string): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const startMs = Date.now();
      const previousUrl = session.page.url();
      logger.info('[PREVIEW_SESSION] Navigating forward', { sessionId, currentUrl: previousUrl });

      // History navigation is user-intent — let the trap accept the
      // target URL instead of treating it as a stranded redirect.
      try {
        const { markIntentionalGoto } = await import('./external-nav-trap');
        markIntentionalGoto(sessionId, previousUrl);
      } catch { /* non-fatal */ }

      const response = await session.page.goForward({
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });

      const newUrl = session.page.url();

      // goForward returns null both when no forward history AND for SPA navigations.
      // Check URL change to distinguish: if URL changed, forward worked (SPA case).
      if (!response && newUrl === previousUrl) {
        logger.debug('[PREVIEW_SESSION] No history to go forward', { sessionId });
        return null;
      }
      logPerformance('preview.goForward', Date.now() - startMs, { sessionId, from: previousUrl, to: newUrl });

      // Kick off snapshot collection without blocking — caller gets result immediately
      setImmediate(() => {
        this.getSnapshot(sessionId, userId, {
          force: true,
          includeDomNodes: true,
          onlyIfChanged: false,
        }).catch((err) => {
          logger.warn('[PREVIEW_SESSION] goForward snapshot failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      return {
        url: newUrl,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        changed: newUrl !== previousUrl,
      };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] goForward failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Stop a preview session
   */
  async stopSession(sessionId: string, userId?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (userId && session.userId !== userId) {
      throw new Error('Forbidden: preview session does not belong to user');
    }

    // Acquire lock to prevent race with concurrent startSession
    const releaseLock = await this.acquireUserLock(session.userId);

    try {
      logger.info('[PREVIEW_SESSION] Stopping session', { sessionId });

      // Force-cancel any in-flight preview run BEFORE we close the
      // browser context. Without this, the run loop keeps trying to
      // page.evaluate against a closed page → throws → unwind path may
      // leave `activeRuns` populated, blocking every future run for
      // this session id with "Run already in progress" until process
      // restart. forceCancelOnSessionStop is a no-op when nothing is
      // active. Lazy-import to dodge a circular dependency between
      // session and run services (each pulls the other's API surface
      // at module-eval time).
      try {
        const { PreviewRunService } = await import('./preview-run.service');
        PreviewRunService.forceCancelOnSessionStop(sessionId);
      } catch (e) {
        logger.warn('[PREVIEW_SESSION] forceCancelOnSessionStop threw (non-fatal)', {
          sessionId,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // Safety-net: close and upload editor trace (idempotent — no-op if already closed)
      try {
        const { EditorTraceService } = await import('./editor-trace.service');
        const meta = await EditorTraceService.close(sessionId);
        if (meta) {
          const { uploadEditorTrace } = await import('./editor-trace-upload');
          uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId: sessionId, traceType: 'editor' })
            .catch((err) => logger.error('[EDITOR_TRACE] Upload failed on session cleanup', { sessionId, error: err instanceof Error ? err.message : String(err) }));
        }
      } catch (err) { logger.error('[EDITOR_TRACE] Close failed on session cleanup', { sessionId, error: err instanceof Error ? err.message : String(err) }); }

      // V15: Close all open tabs, then browser resources
      for (const p of session.pages) {
        if (p !== session.page) {
          try { await p.close().catch(() => {}); } catch { /* best effort */ }
        }
      }
      await this.safeCloseBrowserResources(session.browser, session.context, session.page);

      // Remove from maps
      this.sessions.delete(sessionId);
      this.userToSession.delete(session.userId);

      logger.info('[PREVIEW_SESSION] Session stopped', { sessionId });
    } finally {
      releaseLock();
    }
  }

  /**
   * Stop a preview session (internal, without lock)
   * IMPORTANT: Only call this when lock is already acquired (e.g., inside startSession)
   * For external calls, use stopSession() which acquires lock
   */
  private async stopSessionInternal(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Idempotent: already deleted
    }

    logger.info('[PREVIEW_SESSION] Stopping session (internal)', { sessionId, userId: session.userId });

    // Safety-net: close and upload editor trace (idempotent — no-op if already closed)
    try {
      const { EditorTraceService } = await import('./editor-trace.service');
      // Write final session_stop event before closing the trace file
      const traceBeforeClose = EditorTraceService.get(sessionId);
      if (traceBeforeClose) {
        try { traceBeforeClose.writeSessionStop('stop_internal'); } catch { /* non-critical */ }
      }
      const meta = await EditorTraceService.close(sessionId);
      if (meta) {
        const { uploadEditorTrace } = await import('./editor-trace-upload');
        uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId: sessionId, traceType: 'editor' })
          .catch((err) => logger.error('[EDITOR_TRACE] Upload failed on session destroy', { sessionId, error: err instanceof Error ? err.message : String(err) }));
      }
    } catch (err) { logger.error('[EDITOR_TRACE] Close failed on session destroy', { sessionId, error: err instanceof Error ? err.message : String(err) }); }

    try {
      // V15: Close all open tabs first
      for (const p of session.pages) {
        if (p !== session.page) {
          try { await p.close().catch(() => {}); } catch { /* best effort */ }
        }
      }
      // Safe cleanup of browser resources (active page + context + browser)
      await this.safeCloseBrowserResources(session.browser, session.context, session.page);

      // Fallback force-kill if browser process still alive
      const browserProcess = (session.browser as any)?.process?.();
      if (browserProcess && browserProcess.pid) {
        try {
          // Check if process is still alive
          process.kill(browserProcess.pid, 0); // Signal 0 checks existence without killing
          logger.warn('[PREVIEW_SESSION] Browser process still alive after close, force killing', {
            sessionId,
            pid: browserProcess.pid,
          });
          process.kill(browserProcess.pid, 'SIGKILL');
        } catch (error) {
          // Process already dead or not accessible - this is fine
        }
      }
    } catch (error) {
      logger.error('[PREVIEW_SESSION] Error during stopSessionInternal', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Remove from maps atomically (even if cleanup failed)
    this.sessions.delete(sessionId);
    this.userToSession.delete(session.userId);

    logger.info('[PREVIEW_SESSION] Session stopped (internal)', { sessionId });
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): InternalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastSeenAt = Date.now();
    }
    return session;
  }

  /**
   * Validate that session exists and is owned by user
   * Updates lastSeenAt only for authorized access.
   */
  isSessionOwned(sessionId: string, userId: string): boolean {
    if (!sessionId || !userId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.userId !== userId) return false;
    session.lastSeenAt = Date.now();
    return true;
  }

  /**
   * Get session by ID and validate ownership (if userId provided)
   * Updates lastSeenAt only for authorized access.
   */
  private getAuthorizedSession(sessionId: string, userId?: string): InternalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    if (userId && session.userId !== userId) {
      logger.warn('[PREVIEW_SESSION] Unauthorized session access attempt', {
        sessionId,
        attemptedUserId: userId,
        ownerUserId: session.userId,
      });
      return undefined;
    }

    session.lastSeenAt = Date.now();
    return session;
  }

  /**
   * Return the `createdAt` (ms-since-epoch) of a session, validated against
   * `userId` ownership. Returns `null` when the session is gone or the user
   * does not own it — callers should treat both the same as "no session
   * info available" and skip session-based invalidation gracefully.
   *
   * Exposed so evidence-shortcut callers can compare the session's lifetime
   * against the step's `evidence.capturedAt` to catch cross-session ref
   * staleness (same numeric ref, different browser instance → different
   * element). Not needed in background/regression runs — those mint a
   * fresh browser per run and have no cross-session concept.
   */
  getSessionCreatedAt(sessionId: string, userId: string): number | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session ? session.createdAt : null;
  }

  /**
   * Get session for user
   */
  getSessionForUser(userId: string): InternalSession | undefined {
    const sessionId = this.userToSession.get(userId);
    if (!sessionId) return undefined;
    return this.getSession(sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERACTIVE CONTROL METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get viewport metadata for coordinate mapping
   */
  getViewportMetadata(
    sessionId: string,
    userId?: string
  ): { width: number; height: number; devicePixelRatio: number } | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    const viewport = session.page.viewportSize();
    if (!viewport) {
      return { width: PREVIEW_SESSION_CONFIG.viewport.width, height: PREVIEW_SESSION_CONFIG.viewport.height, devicePixelRatio: 1 };
    }

    return {
      width: viewport.width,
      height: viewport.height,
      devicePixelRatio: 1, // Always 1 for headless (no deviceScaleFactor)
    };
  }

  /**
   * Change viewport size on an active session (live resize).
   * Triggers CSS media queries / responsive reflow. Next snapshot will reflect new layout.
   */
  async setViewport(
    sessionId: string,
    userId: string,
    width: number,
    height: number,
  ): Promise<{ success: boolean; error?: string }> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    // Validate dimensions
    if (
      !Number.isFinite(width) || !Number.isFinite(height) ||
      width < 320 || height < 320 ||
      width > 1920 || height > 1200
    ) {
      return { success: false, error: 'Invalid viewport dimensions (320-1920 x 320-1200)' };
    }

    try {
      await session.page.setViewportSize({ width, height });

      // Wait for CSS media queries and responsive reflow to complete before returning.
      // Viewport resize is fast (CSS reflow <100ms), so use shorter timeouts than
      // navigation (which loads new content). Without this, emitSnapshotAlways()
      // would collect DOM before layout has settled.
      await waitForDOMStability(session.page, 800, 150);

      session.lastSeenAt = Date.now();

      logger.info('[PREVIEW_SESSION] Viewport changed', {
        sessionId,
        width,
        height,
      });

      return { success: true };
    } catch (error) {
      logger.error('[PREVIEW_SESSION] Failed to set viewport', {
        sessionId,
        width,
        height,
        error: error instanceof Error ? error.message : String(error),
      });
      return { success: false, error: 'Failed to set viewport' };
    }
  }

  /**
   * Execute mouse action in preview session
   * @returns {success, needsSnapshot} - needsSnapshot=true if action likely changed page
   */
  async executeMouseAction(params: {
    sessionId: string;
    userId: string;
    action: 'move' | 'click' | 'down' | 'up';
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  }): Promise<{ success: boolean; error?: string; needsSnapshot: boolean }> {
    const { sessionId, userId, action, x, y, button = 'left', clickCount = 1 } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized', needsSnapshot: false };
    }

    const now = Date.now();

    // Throttle input events (anti-DoS)
    if (now - session.lastMouseInputAt < MOUSE_INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled', needsSnapshot: false };
    }

    session.lastMouseInputAt = now;
    session.lastSeenAt = now;

    try {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: 'Invalid coordinates', needsSnapshot: false };
      }

      const viewport = session.page.viewportSize();
      if (!viewport) {
        return { success: false, error: 'Viewport unavailable', needsSnapshot: false };
      }

      // Clamp coordinates to viewport bounds
      const clampedX = Math.max(0, Math.min(x, viewport.width - 1));
      const clampedY = Math.max(0, Math.min(y, viewport.height - 1));
      const safeButton: 'left' | 'right' | 'middle' = button === 'right' || button === 'middle' ? button : 'left';
      const safeClickCount = Number.isInteger(clickCount) && clickCount > 0 && clickCount <= 2 ? clickCount : 1;

      switch (action) {
        case 'move': {
          // V20: Fire-and-forget for high-frequency hover. The handler does NOT need to know
          // when Playwright finished applying the move — hover probe and recordingLastHover
          // both work off the coords stored in the WS handler closure, not the actual page state.
          // Awaiting here serializes every move through one network RTT and is the main source
          // of perceived lag on cloud Playwright.
          session.page.mouse.move(clampedX, clampedY).catch((err: unknown) => {
            logger.debug('[PREVIEW_SESSION] Async mouse move failed', {
              sessionId,
              x: clampedX,
              y: clampedY,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          return { success: true, needsSnapshot: false };
        }

        case 'click': {
          // V16: Intercept clicks on external-navigation anchors BEFORE they
          // fire. External http(s) links opened inline strand the user (the
          // preview address bar has no "back" history), and custom-protocol
          // deeplinks (kaspi://, tg://, mailto:) navigate to nothing visible
          // while replacing the preview with about:blank. Probe first; if the
          // anchor is a foot-gun, surface a user-facing error and skip the
          // click entirely so the original page stays authorable.
          const blocker = await probeExternalAnchorAt(session.page, clampedX, clampedY);
          if (blocker) {
            const linkLabel = blocker.linkText ? `"${blocker.linkText}" ` : '';
            const message = blocker.kind === 'external_protocol'
              ? `Link ${linkLabel}uses protocol "${blocker.protocol}" which can't be followed inside the preview. It would work in a real browser.`
              : `Link ${linkLabel}opens ${blocker.hostname || 'an external site'} in the same tab and would leave the preview with no way back. Record a step to stop here, or set target="_blank" on the site.`;
            logger.info('[PREVIEW_SESSION] Blocked external-navigation click', {
              sessionId,
              kind: blocker.kind,
              hostname: blocker.hostname,
              protocol: blocker.protocol,
              href: blocker.href.slice(0, 200),
            });
            return { success: false, error: message, needsSnapshot: false };
          }
          await session.page.mouse.click(clampedX, clampedY, { button: safeButton, clickCount: safeClickCount });
          return { success: true, needsSnapshot: true };
        }

        case 'down':
          await session.page.mouse.move(clampedX, clampedY);
          await session.page.mouse.down({ button: safeButton });
          return { success: true, needsSnapshot: false };

        case 'up':
          await session.page.mouse.move(clampedX, clampedY);
          await session.page.mouse.up({ button: safeButton });
          return { success: true, needsSnapshot: true };

        default:
          return { success: false, error: `Unknown action: ${action}`, needsSnapshot: false };
      }
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Mouse action failed', {
        sessionId,
        action,
        x,
        y,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Mouse action failed',
        needsSnapshot: false,
      };
    }
  }

  /**
   * Execute mouse wheel scroll
   */
  async executeMouseWheel(params: {
    sessionId: string;
    userId: string;
    deltaX: number;
    deltaY: number;
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, userId, deltaX, deltaY } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    const now = Date.now();

    if (now - session.lastWheelInputAt < WHEEL_INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastWheelInputAt = now;
    session.lastSeenAt = now;

    try {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        return { success: false, error: 'Invalid wheel delta' };
      }

      // Apply scroll sensitivity multiplier and prevent extreme values
      const SCROLL_SENSITIVITY = 1.8;
      const safeDeltaX = Math.max(-2000, Math.min(2000, deltaX * SCROLL_SENSITIVITY));
      const safeDeltaY = Math.max(-2000, Math.min(2000, deltaY * SCROLL_SENSITIVITY));

      // V20: Fire-and-forget — wheel is high-frequency and the recording / snapshot
      // pipeline does not depend on Playwright having finished applying the wheel before
      // we acknowledge the WS event. Errors logged at debug level only.
      session.page.mouse.wheel(safeDeltaX, safeDeltaY).catch((err: unknown) => {
        logger.debug('[PREVIEW_SESSION] Async mouse wheel failed', {
          sessionId,
          deltaX: safeDeltaX,
          deltaY: safeDeltaY,
          error: err instanceof Error ? err.message : String(err),
        });
      });
      return { success: true };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Mouse wheel failed', {
        sessionId,
        deltaX,
        deltaY,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Wheel action failed',
      };
    }
  }

  /**
   * Execute keyboard type (insert text)
   */
  async executeKeyboardType(params: {
    sessionId: string;
    userId: string;
    text: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, userId, text } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    // Length limit (prevent abuse)
    if (text.length > 500) {
      return { success: false, error: 'Text too long (max 500 chars)' };
    }

    const now = Date.now();
    if (now - session.lastKeyboardTypeAt < KEYBOARD_TYPE_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastKeyboardTypeAt = now;
    session.lastSeenAt = now;

    try {
      await session.page.keyboard.type(text);
      return { success: true };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Keyboard type failed', {
        sessionId,
        textLength: text.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Type action failed',
      };
    }
  }

  /**
   * Execute keyboard key press with modifiers
   */
  async executeKeyboardPress(params: {
    sessionId: string;
    userId: string;
    key: string;
    modifiers?: ('Control' | 'Shift' | 'Alt' | 'Meta')[];
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, userId, key, modifiers } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    const now = Date.now();
    if (now - session.lastKeyboardPressAt < KEYBOARD_PRESS_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastKeyboardPressAt = now;
    session.lastSeenAt = now;

    const safeModifiers = Array.isArray(modifiers) ? modifiers : [];

    try {
      // Hold modifiers
      if (safeModifiers.length > 0) {
        for (const mod of safeModifiers) {
          await session.page.keyboard.down(mod);
        }
      }

      // Press key
      await session.page.keyboard.press(key);

      return { success: true };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Keyboard press failed', {
        sessionId,
        key,
        modifiers,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Press action failed',
      };
    } finally {
      // Ensure we always release modifiers (avoid sticky modifier state after errors)
      if (safeModifiers.length > 0) {
        for (const mod of [...safeModifiers].reverse()) {
          await session.page.keyboard.up(mod).catch(() => { });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBUG / PROBE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Probe element at given viewport coordinates (debug tool)
   * Returns element info at (x, y) to verify coordinate mapping from frontend
   */
  async probeElementAt(params: {
    sessionId: string;
    userId: string;
    x: number;
    y: number;
  }): Promise<{
    element?: {
      tag: string;
      id?: string;
      className?: string;
      text?: string;
      ariaLabel?: string;
      ref?: string;
    };
  }> {
    const { sessionId, userId, x, y } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return {};
    }

    try {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {};
      }

      const viewport = session.page.viewportSize();
      if (!viewport) {
        return {};
      }

      // Clamp coordinates to viewport bounds
      const clampedX = Math.max(0, Math.min(x, viewport.width - 1));
      const clampedY = Math.max(0, Math.min(y, viewport.height - 1));

      // Query element at point in page context
      const elementInfo = await session.page.evaluate(
        ({ px, py }) => {
          // @ts-ignore - document is available in browser context
          const el = document.elementFromPoint(px, py);
          if (!el) return null;

          // Extract basic info
          const tag = el.tagName?.toLowerCase() || '';
          const id = el.id || undefined;
          const className = el.className && typeof el.className === 'string'
            ? el.className.slice(0, 100)
            : undefined;
          const text = el.textContent?.trim().slice(0, 50) || undefined;
          const ariaLabel = el.getAttribute('aria-label') || undefined;
          const ref = el.getAttribute('data-agent-ref') || undefined;

          return { tag, id, className, text, ariaLabel, ref };
        },
        { px: clampedX, py: clampedY }
      );

      return { element: elementInfo || undefined };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Probe element failed', {
        sessionId,
        x,
        y,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * Probe the nearest interactive element at (x, y) for hover highlighting.
   * Reuses RecordingCaptureService.probeForRecording() which already has the
   * 5-priority interactive element detection (nativeTag → ariaRole → behavioral → cssClass → cursorPointer).
   *
   * Returns null when:
   * - No element at point
   * - Element resolved via 'directHit' (not interactive — plain div/text)
   * - Element is inside a cross-origin iframe
   */
  async probeInteractiveElementAt(params: {
    sessionId: string;
    userId: string;
    x: number;
    y: number;
    /**
     * When set, populates `rejectReason` on the result instead of just
     * returning null. Lets the WS handler write a precise reason into the
     * hover_probe trace ('cross_origin_iframe' vs 'direct_hit' vs
     * 'no_bounding_box' vs 'no_probe_result') so a stuck recording doesn't
     * look like 53× identical 'no_interactive_element' rows.
     */
    withRejectReason?: boolean;
  }): Promise<{
    tag: string;
    label: string;
    boundingBox: { x: number; y: number; width: number; height: number };
    resolvedVia: string;
    rejectReason?: undefined;
  } | {
    rejectReason: 'no_session' | 'invalid_coords' | 'no_viewport' | 'no_probe_result' | 'cross_origin_iframe' | 'direct_hit_non_interactive' | 'no_bounding_box' | 'error';
  } | null> {
    const { sessionId, userId, x, y, withRejectReason } = params;
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return withRejectReason ? { rejectReason: 'no_session' } : null;

    try {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return withRejectReason ? { rejectReason: 'invalid_coords' } : null;
      }

      const viewport = session.page.viewportSize();
      if (!viewport) return withRejectReason ? { rejectReason: 'no_viewport' } : null;

      const clampedX = Math.max(0, Math.min(x, viewport.width - 1));
      const clampedY = Math.max(0, Math.min(y, viewport.height - 1));

      const { RecordingCaptureService } = await import(
        '@/services/testing/ui/preview/recording-capture.service'
      );
      const probed = await RecordingCaptureService.probeForRecording(session.page, clampedX, clampedY);

      // V18: Cache full probe result for click handler reuse.
      // Guard: only store if recordingLastHover coords are close to this probe's input coords
      // (another mouse:move may have overwritten lastHover while probe was in-flight).
      // Use raw x,y (pre-clamp) for comparison since that's what handler stores.
      if (session.recordingLastHover
        && Math.abs(session.recordingLastHover.x - x) <= 1
        && Math.abs(session.recordingLastHover.y - y) <= 1) {
        session.recordingLastHover.probedElement = probed;
      }

      if (!probed) return withRejectReason ? { rejectReason: 'no_probe_result' } : null;
      if (probed.crossOriginIframe) return withRejectReason ? { rejectReason: 'cross_origin_iframe' } : null;
      // directHit = no interactive element found — don't highlight plain divs
      if (probed.resolvedVia === 'directHit') return withRejectReason ? { rejectReason: 'direct_hit_non_interactive' } : null;
      if (!probed.boundingBox) return withRejectReason ? { rejectReason: 'no_bounding_box' } : null;

      // V22 Pkg5+ Patch C: append to hover chain — distinct hover-targets
      // accumulated between two consecutive clicks. Skips noise via:
      //   - directHit / crossOriginIframe / no-bbox already filtered above
      //   - de-dupe vs last entry by boundingBox in appendRecordingHoverChain
      // Recording-only — no overhead when not recording.
      if (session.recording) {
        try {
          this.appendRecordingHoverChain(sessionId, userId, {
            x, y, timestamp: Date.now(), probedElement: probed,
          });
        } catch { /* chain append best-effort */ }
      }

      // Hover caps label at 40 chars to fit the floating tooltip; record/DB path uses 60.
      // `getProbedLabel` returns null for literal tag-only fallbacks so we can surface a
      // 'element' placeholder instead of "div"/"svg".
      const label = RecordingCaptureService.getProbedLabel(probed, 40) || 'element';

      return {
        tag: probed.tag,
        label,
        boundingBox: probed.boundingBox,
        resolvedVia: probed.resolvedVia || 'unknown',
      };
    } catch (error) {
      logger.debug('[PREVIEW_SESSION] probeInteractiveElementAt failed', {
        sessionId, x, y,
        error: error instanceof Error ? error.message : String(error),
      });
      return withRejectReason ? { rejectReason: 'error' } : null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SNAPSHOT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute page signature for diff detection
   * Returns hash of URL + DOM node count + interactive element count
   */
  private computePageSignature(url: string, domNodes: InteractiveNode[]): string {
    const data = `${url}|${domNodes.length}|${domNodes.map(n => n.ref).join(',')}`;
    return Buffer.from(data).toString('base64');
  }

  /**
   * Capture screenshot as JPEG base64 (no data: prefix)
   * Returns null if capture fails or size exceeds limit
   */
  private async captureScreenshot(page: Page): Promise<string | null> {
    try {
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: SCREENSHOT_CONFIG.quality,
        fullPage: false, // Viewport only
      });

      // Check size limit
      if (buffer.length > SCREENSHOT_CONFIG.maxSizeBytes) {
        logger.debug('[PREVIEW_SESSION] Screenshot too large, skipping', {
          size: buffer.length,
          maxSize: SCREENSHOT_CONFIG.maxSizeBytes,
        });
        return null;
      }

      return buffer.toString('base64');
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Screenshot capture failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get current page snapshot with DOM versioning
   * @param options.force - Skip throttling
   * @param options.includeScreenshot - Include JPEG screenshot (default: false for new video-based flow)
   * @param options.onlyIfChanged - Only return full response if page signature changed
   * @param options.includeDomNodes - Force include domNodes even if not changed (default: auto)
   */
  async getSnapshot(
    sessionId: string,
    userId?: string,
    options?: {
      force?: boolean;
      includeScreenshot?: boolean;
      onlyIfChanged?: boolean;
      includeDomNodes?: boolean;
      /** Collect elements below the viewport (for replay/run where scroll will happen) */
      fullPage?: boolean;
    }
  ): Promise<{
    url: string;
    pageTitle?: string;
    domNodes?: InteractiveNode[];  // Only included when DOM changed or forced
    domVersion: number;
    pageSignature: string;
    screenshot?: string;           // Deprecated: use video:frame instead
    changed: boolean;
    /** V26: Real browser viewport — used by resolver for accurate modal-coverage
     *  ratio in `buildAllowedSets`. Optional for back-compat. */
    viewport?: { width: number; height: number };
    /** V26: per-phase wall-time inside page.evaluate (ms). Surfaced so the
     *  slow-snapshot warn can show where the bottleneck is. */
    phaseTimings?: {
      primaryMs: number;
      dedupeMs: number;
      secondaryMs: number;
      forEachMs: number;
      tailMs: number;
      totalMs: number;
    };
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    // V11: Block snapshot collection during page switch to prevent stale/empty DOM emission
    if (session.pageSwitchInProgress) {
      return null;
    }

    const now = Date.now();
    const includeScreenshot = options?.includeScreenshot === true; // Default false now

    // Throttle snapshot collection (unless forced or cache was explicitly invalidated).
    // V15: When lastSnapshotEmit === 0, a DOM-mutating action (click, hover, etc.)
    // invalidated the cache — we MUST collect fresh DOM, not return stale nodes.
    // Without this, the next lint sees pre-action DOM (e.g., dropdown still closed).
    const cacheInvalidated = session.lastSnapshotEmit === 0;
    if (!options?.force && !cacheInvalidated && now - session.lastSnapshotEmit < SNAPSHOT_THROTTLE_MS) {
      // IMPORTANT:
      // Linting needs domNodes, but collecting a fresh snapshot is expensive.
      // When throttled, return the last known domNodes from session.pageState if explicitly requested.
      const shouldIncludeDomNodes = options?.includeDomNodes === true;
      return {
        url: session.pageState.url,
        pageTitle: session.pageState.pageTitle,
        domNodes: shouldIncludeDomNodes ? session.pageState.domNodes : undefined,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        changed: false,
      };
    }

    try {
      const snapshot = await SnapshotCollector.collect(session.page, {
        fullPage: options?.fullPage,
      });
      const domAnalysis = DomAnalysisExtractorService.extract(snapshot);
      const currentUrl = session.page.url();

      // Detect navigation-in-progress state: document.body not yet ready
      // (__debugStats.documentBodyChildCount === -1 means document.body was null during collection)
      const debugStats = (snapshot as any).__debugStats;
      const isNavigationInProgress = debugStats?.documentBodyChildCount === -1
        && domAnalysis.interactiveNodes.length === 0;

      // ── DEBUG: Log when snapshot returns 0 elements to diagnose drawer/popup issues ──
      const trace = await import('./editor-trace.service').then(m => m.EditorTraceService.get(sessionId)).catch(() => null);

      if (domAnalysis.interactiveNodes.length === 0 && snapshot.elements.length === 0) {
        // V21: Three benign states downgrade this from warn to debug:
        //   1. Navigation in progress (document.body not ready yet)
        //   2. Page already closed (race with session shutdown)
        //   3. Genuinely empty page but mid-teardown
        // Only a non-navigation, non-closed zero-element result is a real
        // anomaly worth a warn-level log.
        const pageIsClosed = (() => {
          try { return session.page.isClosed(); } catch { return true; }
        })();
        const isBenign = isNavigationInProgress || pageIsClosed;
        const logFn = isBenign ? logger.debug : logger.warn;
        logFn('[PREVIEW_SESSION] Snapshot returned 0 elements', {
          sessionId,
          url: currentUrl,
          pageIsClosed,
          snapshotElementCount: snapshot.elements?.length ?? -1,
          isNavigationInProgress,
        });
        trace?.writeSnapshotEmpty({
          url: currentUrl,
          isNavigationInProgress,
          keptPreviousState: isNavigationInProgress && session.pageState.domNodes.length > 0,
          debugStats,
        });
      } else if (domAnalysis.interactiveNodes.length === 0 && snapshot.elements.length > 0) {
        logger.warn('[PREVIEW_SESSION] Snapshot has elements but extractor returned 0 nodes', {
          sessionId,
          url: currentUrl,
          rawElementCount: snapshot.elements.length,
        });
        trace?.writeSnapshotError({
          url: currentUrl,
          source: 'getSnapshot',
          error: 'extractor returned 0 nodes from non-empty raw elements',
          debugStats,
        });
      } else {
        trace?.writeSnapshotResult({
          url: currentUrl,
          nodeCount: domAnalysis.interactiveNodes.length,
          durationMs: Date.now() - now,
          source: options?.force ? 'force' : 'interval',
          debugStats,
        });
      }

      // If navigation is in progress and we have valid previous state, return cached state
      // instead of overwriting pageState with empty nodes (which would break next lint)
      if (isNavigationInProgress && session.pageState.domNodes.length > 0) {
        logger.debug('[PREVIEW_SESSION] Navigation in progress, keeping previous DOM state', {
          sessionId,
          previousNodeCount: session.pageState.domNodes.length,
        });
        return {
          url: session.pageState.url,
          pageTitle: session.pageState.pageTitle,
          domNodes: options?.includeDomNodes ? session.pageState.domNodes : undefined,
          domVersion: session.domVersion,
          pageSignature: session.lastPageSignature,
          changed: false,
        };
      }

      const currentTitle = await session.page.title().catch(() => undefined);

      session.pageState = {
        url: currentUrl,
        pageTitle: currentTitle,
        domNodes: domAnalysis.interactiveNodes,
        pageText: snapshot.pageTextForExtraction?.slice(0, 3000),
      };
      session.lastSnapshotEmit = now;

      // Compute signature for diff detection
      const newSignature = this.computePageSignature(currentUrl, domAnalysis.interactiveNodes);
      const changed = newSignature !== session.lastPageSignature;

      // Increment domVersion only if signature changed
      if (changed) {
        session.domVersion++;
        session.lastPageSignature = newSignature;
      }

      // If onlyIfChanged and no change, return minimal response
      if (options?.onlyIfChanged && !changed) {
        return {
          url: session.pageState.url,
          pageTitle: session.pageState.pageTitle,
          domVersion: session.domVersion,
          pageSignature: session.lastPageSignature,
          changed: false,
        };
      }

      // Capture screenshot if explicitly requested (deprecated for preview)
      let screenshot: string | undefined;
      if (includeScreenshot) {
        const canEmitScreenshot = now - session.lastScreenshotEmitAt >= SCREENSHOT_CONFIG.throttleMs;
        if (canEmitScreenshot || options?.force) {
          const captured = await this.captureScreenshot(session.page);
          if (captured) {
            screenshot = captured;
            session.lastScreenshotEmitAt = now;
          }
        }
      }

      // Include domNodes only if changed or explicitly requested
      const shouldIncludeDomNodes = options?.includeDomNodes ?? changed;

      return {
        url: session.pageState.url,
        pageTitle: session.pageState.pageTitle,
        domNodes: shouldIncludeDomNodes ? session.pageState.domNodes : undefined,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        screenshot,
        changed,
        // V26: pass viewport through so resolver can compute accurate
        // modal-coverage ratio. domAnalysis carries it from snapshot collector.
        viewport: domAnalysis.viewport,
        // V26: surface in-page phase timings so the slow-snapshot warning
        // upstream can call out the real bottleneck (primary querySelectorAll
        // vs Tier-2 walk vs forEach extract). Optional — old callers ignore.
        phaseTimings: debugStats?.phaseTimings,
      };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Failed to get snapshot', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get current DOM version for a session
   */
  getDomVersion(sessionId: string, userId?: string): number | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.domVersion ?? null;
  }

  /**
   * V20: Get the signature of the last `preview:page` payload emitted on the wire.
   * Used by every preview:page emit site to skip redundant emits when the DOM hasn't
   * changed since the previous emit. Returns empty string if no emit has happened yet
   * (first emit always passes the dedup gate).
   */
  getLastEmittedSignature(sessionId: string, userId?: string): string {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.lastEmittedSignature ?? '';
  }

  /**
   * V20: Mark a pageSignature as just-emitted so the next emit site with the same
   * signature can skip. Callers MUST invoke this immediately after a successful
   * `nsp.to(room).emit('preview:page', ...)` to keep the dedup window consistent
   * across `emitSnapshotIfChanged`, DOM tick, apply, subscribe, and page-switch retry.
   */
  markEmittedSignature(sessionId: string, userId: string | undefined, signature: string): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session && typeof signature === 'string') {
      session.lastEmittedSignature = signature;
    }
  }

  /**
   * Get context data for a session
   */
  getContextData(sessionId: string, userId?: string): { version: number; data: Record<string, any> } | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;
    return {
      version: session.contextVersion,
      data: session.contextData,
    };
  }

  /**
   * Set context data for a session
   */
  setContextData(sessionId: string, userId: string, data: Record<string, any>): { version: number; data: Record<string, any> } | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    session.contextVersion++;
    session.contextData = { ...data };

    return {
      version: session.contextVersion,
      data: session.contextData,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORDING STATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set recording state for a session
   */
  setRecording(sessionId: string, userId: string, recording: boolean): boolean {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return false;
    session.recording = recording;
    if (recording) {
      // V14: Reset inter-step delay tracking on recording start
      session.recordingLastStepEmittedAt = undefined;
      // Reset the per-session step counter at the start of each recording
      // so the max-steps guard always measures the CURRENT session.
      session.recordingStepCount = 0;
    } else {
      session.recordingTypingBuffer = null;
      session.recordingDragState = null;
      session.recordingLastTypeStep = null;
      session.recordingLastPressStep = null;
      session.recordingLastClickStep = null;
      session.recordingLastNavigateStep = null;
      session.recordingLastScrollStep = null;
      session.recordingLastHover = null;
      // V22 Pkg5+: clear hover chain on recording stop too.
      session.recordingHoverChain = [];
      // V22 Pkg8: clear field session on recording stop.
      session.recordingFieldSession = null;
      session.recordingLastStepEmittedAt = undefined;
      session.recordingStepCount = 0;
    }
    return true;
  }

  /**
   * Get the number of NEW steps emitted in the current recording session.
   * Excludes :step:update merges (those don't grow the count) and excludes
   * steps that were removed via :step:remove (decremented). Returns 0 when
   * recording is not active or the session doesn't exist.
   */
  getRecordingStepCount(sessionId: string, userId?: string): number {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingStepCount ?? 0;
  }

  /**
   * Increment the recording step counter and return the new value.
   * Caller (emitRecordingStep) uses the returned count to (a) stamp the
   * outgoing WS payload and (b) trigger the max-steps auto-stop guard.
   */
  incrementRecordingStepCount(sessionId: string, userId: string): number {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return 0;
    session.recordingStepCount = (session.recordingStepCount ?? 0) + 1;
    return session.recordingStepCount;
  }

  /**
   * Decrement the recording step counter (never below 0). Called when a
   * previously-emitted step is removed — currently only from the
   * backspace-all path that emits `preview:recording:step:remove`.
   */
  decrementRecordingStepCount(sessionId: string, userId: string): number {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return 0;
    session.recordingStepCount = Math.max(0, (session.recordingStepCount ?? 0) - 1);
    return session.recordingStepCount;
  }

  /**
   * Check if recording is active for a session
   */
  isRecording(sessionId: string, userId?: string): boolean {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recording ?? false;
  }

  /**
   * Get recording typing buffer
   */
  getRecordingBuffer(sessionId: string, userId?: string): InternalSession['recordingTypingBuffer'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingTypingBuffer ?? null;
  }

  /**
   * Set recording typing buffer
   */
  setRecordingBuffer(sessionId: string, userId: string, buffer: InternalSession['recordingTypingBuffer']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingTypingBuffer = buffer;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // V22 Pkg8: Field Session — focus-span editing transaction
  // ─────────────────────────────────────────────────────────────────────────

  /** Read the active field session (or null when none open). */
  getRecordingFieldSession(
    sessionId: string,
    userId?: string,
  ): NonNullable<InternalSession['recordingFieldSession']> | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingFieldSession ?? null;
  }

  /**
   * Open a new field session. Caller is responsible for closing any
   * previous session BEFORE calling this (handler does close → emit step
   * → open new). Idempotent for the same elementRef — overwriting with
   * identical ref is a no-op (caller should detect & skip).
   */
  setRecordingFieldSession(
    sessionId: string,
    userId: string,
    fs: NonNullable<InternalSession['recordingFieldSession']> | null,
  ): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingFieldSession = fs;
  }

  /**
   * Update the emittedStepId on the active field session — called after
   * the first Type step is emitted, so subsequent live-value re-reads
   * can dispatch `preview:recording:step:update` with the same id and
   * merge into the existing list entry instead of stacking duplicates.
   */
  setRecordingFieldSessionStepId(
    sessionId: string,
    userId: string,
    stepId: string,
  ): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session?.recordingFieldSession) {
      session.recordingFieldSession.emittedStepId = stepId;
    }
  }

  /**
   * Get last recorded URL (for navigation detection)
   */
  getRecordingLastUrl(sessionId: string, userId?: string): string | undefined {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastUrl;
  }

  /**
   * Set last recorded URL
   */
  setRecordingLastUrl(sessionId: string, userId: string, url: string): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastUrl = url;
  }

  /**
   * V13: Get the URL where recording started (actual page URL, not frontend editorBaseUrl).
   * Used as fallback startUrl for Apply All when frontend doesn't provide one.
   */
  getRecordingStartUrl(sessionId: string, userId?: string): string | undefined {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingStartUrl;
  }

  /**
   * V13: Set the URL where recording started
   */
  setRecordingStartUrl(sessionId: string, userId: string, url: string): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingStartUrl = url;
  }

  /**
   * V10: Get recording drag state (for drag & drop detection)
   */
  getRecordingDragState(sessionId: string, userId?: string): InternalSession['recordingDragState'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingDragState ?? null;
  }

  /**
   * V10: Set recording drag state
   */
  setRecordingDragState(sessionId: string, userId: string, state: InternalSession['recordingDragState']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingDragState = state;
  }

  /**
   * V10: Get last emitted type step (for merge detection)
   */
  getRecordingLastTypeStep(sessionId: string, userId?: string): InternalSession['recordingLastTypeStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastTypeStep ?? null;
  }

  /**
   * V10: Set last emitted type step
   */
  setRecordingLastTypeStep(sessionId: string, userId: string, step: InternalSession['recordingLastTypeStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastTypeStep = step;
  }

  /** Get last emitted press step (for coalescing consecutive identical keys). */
  getRecordingLastPressStep(sessionId: string, userId?: string): InternalSession['recordingLastPressStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastPressStep ?? null;
  }

  /** Set last emitted press step. Pass null to break the coalescing chain. */
  setRecordingLastPressStep(sessionId: string, userId: string, step: InternalSession['recordingLastPressStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastPressStep = step;
  }

  /** Get last emitted click step (for upgrading to dblclick on rapid second click). */
  getRecordingLastClickStep(sessionId: string, userId?: string): InternalSession['recordingLastClickStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastClickStep ?? null;
  }

  /** Set last emitted click step. Pass null to break the coalescing chain. */
  setRecordingLastClickStep(sessionId: string, userId: string, step: InternalSession['recordingLastClickStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastClickStep = step;
  }

  /** Get last emitted navigate step (for coalescing repeated navigations to same URL). */
  getRecordingLastNavigateStep(sessionId: string, userId?: string): InternalSession['recordingLastNavigateStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastNavigateStep ?? null;
  }

  /** Set last emitted navigate step. Pass null to break the coalescing chain. */
  setRecordingLastNavigateStep(sessionId: string, userId: string, step: InternalSession['recordingLastNavigateStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastNavigateStep = step;
  }

  /**
   * V13: Check if next typing is a paste (Ctrl+V/Cmd+V detected)
   */
  isRecordingPendingPaste(sessionId: string, userId?: string): boolean {
    const session = this.getAuthorizedSession(sessionId, userId);
    return !!session?.recordingPendingPaste;
  }

  /**
   * V13: Set/clear paste flag
   */
  setRecordingPendingPaste(sessionId: string, userId: string, isPaste: boolean): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingPendingPaste = isPaste;
  }

  /**
   * V10: Get last emitted scroll step (for merge detection)
   */
  getRecordingLastScrollStep(sessionId: string, userId?: string): InternalSession['recordingLastScrollStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastScrollStep ?? null;
  }

  /**
   * V10: Set last emitted scroll step
   */
  setRecordingLastScrollStep(sessionId: string, userId: string, step: InternalSession['recordingLastScrollStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastScrollStep = step;
  }

  /**
   * V11: Get last hover state (for recording hover steps before click)
   */
  getRecordingLastHover(sessionId: string, userId?: string): InternalSession['recordingLastHover'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastHover ?? null;
  }

  /**
   * V11: Set last hover state
   */
  setRecordingLastHover(sessionId: string, userId: string, state: InternalSession['recordingLastHover']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastHover = state;
  }

  /**
   * V22 Pkg5+: Append a distinct hover-target to the chain. Distinctness
   * is checked by boundingBox (same x/y/w/h = same element). Caps at 4
   * entries to bound memory — oldest dropped when full.
   *
   * Called from preview.handler.ts after each successful hover-probe so
   * the chain reflects the user's mouse-movement history between two
   * consecutive clicks. Cleared on click-flush so next click starts fresh.
   */
  appendRecordingHoverChain(
    sessionId: string,
    userId: string,
    entry: { x: number; y: number; timestamp: number; probedElement: import('@/services/testing/ui/preview/recording-capture.service').ProbedElement },
  ): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return;
    if (!session.recordingHoverChain) session.recordingHoverChain = [];
    const chain = session.recordingHoverChain;
    // De-dupe vs the LAST entry — if same boundingBox, just refresh timestamp.
    const newBB = entry.probedElement.boundingBox;
    const last = chain.length > 0 ? chain[chain.length - 1] : null;
    if (last && newBB && last.probedElement.boundingBox) {
      const lbb = last.probedElement.boundingBox;
      if (lbb.x === newBB.x && lbb.y === newBB.y
        && lbb.width === newBB.width && lbb.height === newBB.height) {
        last.timestamp = entry.timestamp; // freshen, but don't add duplicate
        return;
      }
    }
    chain.push(entry);
    // Cap at 4 — multi-level menus rarely exceed 3 (root → submenu → leaf).
    while (chain.length > 4) chain.shift();
  }

  /**
   * V22 Pkg5+: Read the hover chain (read-only snapshot).
   */
  getRecordingHoverChain(
    sessionId: string,
    userId?: string,
  ): NonNullable<InternalSession['recordingHoverChain']> {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingHoverChain ?? [];
  }

  /**
   * V22 Pkg5+: Clear the hover chain after a click is flushed.
   */
  clearRecordingHoverChain(sessionId: string, userId: string): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingHoverChain = [];
  }

  /**
   * V14: Compute and stamp interStepDelayMs on a step, then update the timestamp.
   * Call right before emitting a recording step to automatically track timing.
   * Returns the delay in ms (0 if this is the first step).
   */
  stampInterStepDelay(sessionId: string, userId: string, step: { evidence?: { interStepDelayMs?: number } } | null | undefined): number {
    if (!step) return 0;
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return 0;
    const now = Date.now();
    const prevTs = session.recordingLastStepEmittedAt;
    const delayMs = prevTs ? now - prevTs : 0;
    session.recordingLastStepEmittedAt = now;
    // Only stamp meaningful delays (>500ms) — sub-500ms is just fast clicking
    if (delayMs > 500 && step.evidence) {
      step.evidence.interStepDelayMs = delayMs;
    } else if (delayMs > 500 && !step.evidence) {
      (step as any).evidence = { interStepDelayMs: delayMs };
    }
    return delayMs;
  }

  /**
   * V14: Reset recording timestamp (call on recording start).
   */
  resetRecordingStepTimestamp(sessionId: string, userId: string): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastStepEmittedAt = undefined;
  }

  /**
   * V13: Set dialog mode for a session.
   * - 'passive': Auto-dismiss dialogs (default, browsing mode)
   * - 'recording': Emit dialog to frontend, wait for user response, record as step
   * - 'replay': Use pre-installed pendingDialogAction
   */
  setDialogMode(sessionId: string, userId: string, mode: 'passive' | 'recording' | 'replay'): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) {
      session.dialogMode = mode;
      logger.debug('[PREVIEW_SESSION] Dialog mode changed', { sessionId, mode });
    }
  }

  /**
   * V13: Pre-install a dialog action for replay.
   * Must be called BEFORE the step that triggers the dialog.
   */
  setPendingDialogAction(sessionId: string, userId: string, action: { action: 'accept' | 'dismiss'; promptText?: string } | undefined): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.pendingDialogAction = action;
  }

  /**
   * Attach a dialog handler to handle native dialogs (alert/confirm/prompt/beforeunload).
   * V13: Behavior depends on dialogMode:
   * - passive: Auto-dismiss (prevents hanging)
   * - recording: Emit to frontend, wait for user response, record as step
   * - replay: Use pre-installed pendingDialogAction from recorded step
   */
  private attachDialogHandler(page: Page, previewSessionId: string): void {
    page.on('dialog', async (dialog) => {
      try {
        const type = dialog.type() as 'alert' | 'confirm' | 'prompt' | 'beforeunload';
        const msg = dialog.message();

        // Find session to check dialog mode
        const session = this.sessions.get(previewSessionId);
        const mode = session?.dialogMode || 'passive';

        logger.info('[PREVIEW_SESSION] Dialog triggered', {
          previewSessionId, type, mode, message: msg.slice(0, 200),
        });

        // ═══════════════════════════════════════════════════════════════════
        // REPLAY MODE: Use pre-installed action from recorded dialog step
        // ═══════════════════════════════════════════════════════════════════
        if (mode === 'replay' && session?.pendingDialogAction) {
          const { action, promptText } = session.pendingDialogAction;
          session.pendingDialogAction = undefined; // consume
          try {
            if (action === 'accept') {
              await dialog.accept(promptText);
            } else {
              await dialog.dismiss();
            }
            logger.info('[PREVIEW_SESSION] Dialog handled via replay action', {
              previewSessionId, type, action, promptText: promptText?.slice(0, 50),
            });
          } catch (e) {
            logger.warn('[PREVIEW_SESSION] Replay dialog action failed', {
              previewSessionId, error: e instanceof Error ? e.message : String(e),
            });
          }
          return;
        }

        // ═══════════════════════════════════════════════════════════════════
        // RECORDING MODE: Notify frontend, wait for user response
        // ═══════════════════════════════════════════════════════════════════
        if (mode === 'recording' && session) {
          // Emit pending dialog to frontend — frontend shows accept/dismiss UI
          try {
            webSocketService.emitToRoom('preview', previewSessionId, 'preview:dialog:pending' as any, {
              previewSessionId,
              dialogType: type,
              message: msg.slice(0, 500),
              timestamp: new Date().toISOString(),
            });
          } catch { /* non-critical */ }

          // Wait for frontend response (stored by WS handler via setPendingDialogAction)
          // Poll for up to 30s — user must respond to the dialog
          const deadline = Date.now() + 30000;
          while (Date.now() < deadline) {
            if (session.pendingDialogAction) {
              const { action, promptText } = session.pendingDialogAction;
              session.pendingDialogAction = undefined;
              try {
                if (action === 'accept') {
                  await dialog.accept(promptText);
                } else {
                  await dialog.dismiss();
                }
              } catch { /* dialog may have been handled */ }

              // Create and emit the dialog recording step directly
              try {
                const { RecordingCaptureService } = await import('./recording-capture.service');
                const step = RecordingCaptureService.captureDialog({
                  dialogType: type,
                  action,
                  message: msg,
                  promptText,
                  pageUrl: page.url(),
                });
                webSocketService.emitToRoom('preview', previewSessionId, 'preview:recording:step' as any, {
                  previewSessionId, step, timestamp: new Date().toISOString(),
                });
              } catch { /* non-critical — step emission failure doesn't block recording */ }
              return;
            }
            await new Promise(r => setTimeout(r, 200));
          }

          // Timeout — auto-dismiss to prevent hanging
          logger.warn('[PREVIEW_SESSION] Dialog recording timeout, auto-dismissing', { previewSessionId, type });
          try { await dialog.dismiss(); } catch { /* ok */ }
          return;
        }

        // ═══════════════════════════════════════════════════════════════════
        // PASSIVE MODE: Auto-dismiss (original behavior)
        // ═══════════════════════════════════════════════════════════════════
        try {
          if (type === 'beforeunload') {
            await dialog.accept();
          } else {
            await dialog.dismiss();
          }
        } catch (dialogError) {
          logger.warn('[PREVIEW_SESSION] Failed to dismiss dialog (may already be handled)', {
            previewSessionId, type,
            error: dialogError instanceof Error ? dialogError.message : String(dialogError),
          });
          return;
        }

        // Notify frontend (best-effort)
        try {
          webSocketService.emitToRoom('preview', previewSessionId, 'preview:dialog' as any, {
            previewSessionId, type, message: msg.slice(0, 500),
            action: type === 'beforeunload' ? 'accepted' : 'dismissed',
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-critical */ }
      } catch (error) {
        logger.warn('[PREVIEW_SESSION] Dialog handler error', {
          previewSessionId, error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Handle new pages (popups, target="_blank" links, window.open).
   * When a new page is created in the BrowserContext, auto-switch the session
   * to the new page so the preview doesn't freeze on the old (backgrounded) page.
   *
   * Strategy:
   * - Wait for new page to reach domcontentloaded (max 10s)
   * - Close the OLD page (we only support one active page)
   * - Swap session.page to the new page
   * - Re-attach dialog handler
   * - Invoke onPageSwitch callback (registered by WS handler to restart video stream)
   * - Notify frontend of page switch
   */
  private attachPopupHandler(context: BrowserContext, previewSessionId: string): void {
    context.on('page', async (newPage: Page) => {
      const session = this.sessions.get(previewSessionId);
      if (!session) return;

      const oldUrl = session.page.url();

      try {
        // Wait for new page to load (best-effort, don't block forever)
        await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

        let newUrl = newPage.url();

        // Guard: some sites open about:blank, then inject content via document.write().
        // Wait a bit more to see if it navigates away from about:blank.
        if (newUrl === 'about:blank') {
          await new Promise(r => setTimeout(r, 2000));
          await newPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          newUrl = newPage.url();

          // Still blank → close popup and keep old page
          if (newUrl === 'about:blank') {
            logger.info('[PREVIEW_SESSION] Popup stayed at about:blank — closing it', { previewSessionId });
            await newPage.close().catch(() => {});
            return;
          }
        }

        logger.info('[PREVIEW_SESSION] Popup/new tab detected — switching', {
          previewSessionId,
          oldUrl,
          newUrl,
        });

        // V11: Block snapshot collection during page switch to prevent stale/empty DOM
        session.pageSwitchInProgress = true;

        // V15: Keep old page alive — push new page to tabs array
        const oldPage = session.page;
        const maxTabs = PREVIEW_SESSION_CONFIG.maxTabsPerSession;

        // Evict oldest non-active tab if at max capacity
        if (session.pages.length >= maxTabs) {
          const evictIdx = session.pages.findIndex((_, idx) => idx !== session.activeTabIndex);
          if (evictIdx >= 0) {
            const evicted = session.pages.splice(evictIdx, 1)[0];
            // Adjust activeTabIndex if eviction shifted it
            if (evictIdx < session.activeTabIndex) {
              session.activeTabIndex--;
            }
            try { await evicted.close().catch(() => {}); } catch { /* best effort */ }
            logger.info('[PREVIEW_SESSION] Evicted tab at max capacity', {
              previewSessionId,
              evictedIndex: evictIdx,
              maxTabs,
            });
          }
        }

        // Add new page to tabs and switch to it
        session.pages.push(newPage);
        session.activeTabIndex = session.pages.length - 1;
        session.page = newPage;

        // Attach handlers to new page
        this.attachDialogHandler(newPage, previewSessionId);
        this.attachCrashHandler(newPage, previewSessionId);
        this.attachFrameNavigatedTrace(newPage, previewSessionId);
        this.attachPageDownloadHandler(newPage, previewSessionId);
        this.attachTabCloseListener(newPage, previewSessionId);

        // V16: Auth detector + external-nav trap for the popup. Popups are
        // frequently payment/OAuth flows that cross-origin-redirect; without
        // these the user gets no safety net once we've switched to the popup.
        // A popup IS an intentional cross-origin nav by the user's click —
        // rebase the trap baseline on the popup's landing URL.
        try {
          const { attachAuthDetector } = await import('./auth-detector');
          const sessionForPopup = this.sessions.get(previewSessionId);
          attachAuthDetector(newPage, previewSessionId, {
            projectId: sessionForPopup?.projectId,
            userId: sessionForPopup?.userId,
            isRecording: () => this.sessions.get(previewSessionId)?.recording === true,
          });
        } catch { /* non-fatal */ }
        try {
          const { attachExternalNavTrap, markIntentionalGoto } = await import('./external-nav-trap');
          attachExternalNavTrap(newPage, previewSessionId, newUrl);
          markIntentionalGoto(previewSessionId, newUrl);
        } catch { /* non-fatal */ }

        // Overlay auto-dismiss on popups too. Without this, a popup
        // whose host site ships a tour library (joyride etc.) would
        // have no handler registered, so every action inside the popup
        // would fight the overlay on its own.
        try {
          const { registerOverlayAutoDismiss } = await import('../auto-dismiss-overlays');
          await registerOverlayAutoDismiss(newPage);
        } catch { /* non-fatal */ }

        // Wait for new page DOM to be ready before allowing snapshot collection.
        // domcontentloaded is sufficient — 'load' waits for all subresources (images,
        // fonts, iframes) and can hang 8s+ on media-heavy pages. Halved timeout from
        // 8s → 4s: timeout is acceptable, DOM is still usable for element resolution.
        try {
          await newPage.waitForLoadState('domcontentloaded', { timeout: 4000 });
        } catch {
          // Timeout is acceptable — DOM should still be ready enough for snapshots.
        }

        // Reset snapshot state so next getSnapshot() forces a fresh collect
        session.lastSnapshotEmit = 0;
        session.lastPageSignature = '';
        // V20: Reset dedup marker so the first emit for the new page always passes
        // through, even in the (unlikely) case that the new page's signature
        // coincidentally matches the old page's last-emitted signature.
        session.lastEmittedSignature = '';

        // V11: Unblock snapshot collection now that new page is loaded
        session.pageSwitchInProgress = false;

        // Update recording URL baseline if recording
        if (session.recording) {
          session.recordingLastUrl = newUrl;
        }

        // Invoke page switch callback (WS handler uses this to restart video/devtools)
        if (session.onPageSwitch) {
          try {
            session.onPageSwitch(newPage, oldUrl);
          } catch (cbError) {
            logger.warn('[PREVIEW_SESSION] onPageSwitch callback error', {
              previewSessionId,
              error: cbError instanceof Error ? cbError.message : String(cbError),
            });
          }
        }

        // Notify frontend about page switch + tabs list
        try {
          const tabsInfo = this.buildTabsInfo(session);
          webSocketService.emitToRoom('preview', previewSessionId, 'preview:page:navigated', {
            previewSessionId,
            url: newUrl,
            previousUrl: oldUrl,
            reason: 'popup',
            timestamp: new Date().toISOString(),
          });
          // V15: Emit tab events for multi-tab UI
          webSocketService.emitToRoom('preview', previewSessionId, 'preview:tab:opened', {
            previewSessionId,
            tabs: tabsInfo,
            activeTabIndex: session.activeTabIndex,
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Non-critical
        }
      } catch (error) {
        logger.warn('[PREVIEW_SESSION] Popup handler error', {
          previewSessionId,
          error: error instanceof Error ? error.message : String(error),
        });

        // V11: Ensure pageSwitchInProgress is cleared even on error
        if (session) {
          session.pageSwitchInProgress = false;
        }

        // V15: On error, remove the new page from tabs if it was added
        if (session && session.pages.includes(newPage)) {
          const idx = session.pages.indexOf(newPage);
          session.pages.splice(idx, 1);
          // Restore active tab to the previous page
          if (session.activeTabIndex >= session.pages.length) {
            session.activeTabIndex = Math.max(0, session.pages.length - 1);
          }
          session.page = session.pages[session.activeTabIndex];
        }

        // Close the failed popup
        try {
          if (!newPage.isClosed()) {
            await newPage.close().catch(() => {});
          }
        } catch {
          // Best effort
        }
      }
    });
  }

  /**
   * V11: Register a callback for page switch events (popup/new tab).
   * The websocket handler uses this to restart video stream + devtools on the new page.
   */
  setOnPageSwitch(sessionId: string, userId: string, callback: (newPage: Page, previousUrl: string) => void): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) {
      session.onPageSwitch = callback;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // V15: Multi-tab management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Switch active tab to a different index.
   * Updates session.page, invokes onPageSwitch callback, resets snapshot state.
   */
  async switchTab(sessionId: string, userId: string, tabIndex: number): Promise<boolean> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return false;

    if (tabIndex < 0 || tabIndex >= session.pages.length) {
      logger.warn('[PREVIEW_SESSION] switchTab: invalid tabIndex', { sessionId, tabIndex, totalTabs: session.pages.length });
      return false;
    }

    if (tabIndex === session.activeTabIndex) return true; // Already active

    const oldPage = session.page;
    const oldUrl = oldPage.url();
    const newPage = session.pages[tabIndex];

    if (newPage.isClosed()) {
      logger.warn('[PREVIEW_SESSION] switchTab: target tab is closed', { sessionId, tabIndex });
      // Remove closed tab and adjust
      session.pages.splice(tabIndex, 1);
      if (session.activeTabIndex >= session.pages.length) {
        session.activeTabIndex = Math.max(0, session.pages.length - 1);
      }
      session.page = session.pages[session.activeTabIndex];
      return false;
    }

    session.pageSwitchInProgress = true;

    session.activeTabIndex = tabIndex;
    session.page = newPage;

    // Reset snapshot state for fresh collection on new tab
    session.lastSnapshotEmit = 0;
    session.lastPageSignature = '';
    // V20: Reset dedup marker so the first emit for the newly active tab always
    // passes through the signature-dedup gate.
    session.lastEmittedSignature = '';

    session.pageSwitchInProgress = false;

    // Update recording URL baseline
    if (session.recording) {
      session.recordingLastUrl = newPage.url();
    }

    // Invoke page switch callback (video restart, devtools restart)
    if (session.onPageSwitch) {
      try {
        session.onPageSwitch(newPage, oldUrl);
      } catch (cbError) {
        logger.warn('[PREVIEW_SESSION] switchTab: onPageSwitch callback error', {
          sessionId,
          error: cbError instanceof Error ? cbError.message : String(cbError),
        });
      }
    }

    logger.info('[PREVIEW_SESSION] Switched active tab', {
      sessionId,
      fromTabIndex: session.pages.indexOf(oldPage),
      toTabIndex: tabIndex,
      newUrl: newPage.url(),
    });

    return true;
  }

  /**
   * Close a specific tab and adjust state.
   * Cannot close the last remaining tab.
   */
  async closeTab(sessionId: string, userId: string, tabIndex: number): Promise<boolean> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return false;

    if (tabIndex < 0 || tabIndex >= session.pages.length) return false;
    if (session.pages.length <= 1) {
      logger.warn('[PREVIEW_SESSION] closeTab: cannot close last tab', { sessionId });
      return false;
    }

    const closedPage = session.pages.splice(tabIndex, 1)[0];

    // Adjust activeTabIndex
    if (tabIndex === session.activeTabIndex) {
      // Closed the active tab — switch to the nearest remaining
      session.activeTabIndex = Math.min(tabIndex, session.pages.length - 1);
      session.page = session.pages[session.activeTabIndex];

      // Reset snapshot + invoke callback
      session.lastSnapshotEmit = 0;
      session.lastPageSignature = '';
      // V20: Reset dedup marker for the newly-active tab
      session.lastEmittedSignature = '';
      if (session.onPageSwitch) {
        try { session.onPageSwitch(session.page, closedPage.url()); } catch { /* non-critical */ }
      }
    } else if (tabIndex < session.activeTabIndex) {
      session.activeTabIndex--;
    }

    // Close the actual page
    try { await closedPage.close().catch(() => {}); } catch { /* best effort */ }

    logger.info('[PREVIEW_SESSION] Tab closed', {
      sessionId,
      closedTabIndex: tabIndex,
      remainingTabs: session.pages.length,
      activeTabIndex: session.activeTabIndex,
    });

    return true;
  }

  /**
   * Get tab info list for frontend.
   */
  getTabsInfo(sessionId: string, userId?: string): import('./preview.types').PreviewTabInfo[] {
    const session = userId ? this.getAuthorizedSession(sessionId, userId) : this.sessions.get(sessionId);
    if (!session) return [];
    return this.buildTabsInfo(session);
  }

  /**
   * Build PreviewTabInfo[] from session state (internal helper).
   */
  private buildTabsInfo(session: InternalSession): import('./preview.types').PreviewTabInfo[] {
    return session.pages.map((page, idx) => ({
      tabIndex: idx,
      url: page.isClosed() ? '' : (page.url() || ''),
      title: page.isClosed() ? undefined : undefined, // Title fetched async elsewhere
      isActive: idx === session.activeTabIndex,
    }));
  }

  /**
   * Attach close listener to a page — removes from tabs array when site closes it.
   */
  private attachTabCloseListener(page: Page, previewSessionId: string): void {
    page.on('close', () => {
      const session = this.sessions.get(previewSessionId);
      if (!session) return;

      const idx = session.pages.indexOf(page);
      if (idx < 0) return; // Already removed

      // Don't auto-remove if it's the last tab
      if (session.pages.length <= 1) return;

      session.pages.splice(idx, 1);

      // Adjust activeTabIndex
      if (idx === session.activeTabIndex) {
        session.activeTabIndex = Math.min(idx, session.pages.length - 1);
        session.page = session.pages[session.activeTabIndex];
        session.lastSnapshotEmit = 0;
        session.lastPageSignature = '';
        // V20: Reset dedup marker for the newly-active tab
        session.lastEmittedSignature = '';
        if (session.onPageSwitch) {
          try { session.onPageSwitch(session.page, ''); } catch { /* non-critical */ }
        }
      } else if (idx < session.activeTabIndex) {
        session.activeTabIndex--;
      }

      logger.info('[PREVIEW_SESSION] Tab closed by site', {
        previewSessionId,
        closedTabIndex: idx,
        remainingTabs: session.pages.length,
      });

      // Notify frontend
      try {
        const tabsInfo = this.buildTabsInfo(session);
        webSocketService.emitToRoom('preview', previewSessionId, 'preview:tab:closed', {
          previewSessionId,
          tabs: tabsInfo,
          activeTabIndex: session.activeTabIndex,
          closedTabIndex: idx,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-critical */ }
    });
  }

  /**
   * Handle page crash (renderer process OOM, infinite loop, GPU crash, etc.)
   * Without this, the session stays in the map with a dead page reference and
   * all subsequent operations fail silently or with cryptic CDP errors.
   */
  private attachCrashHandler(page: Page, previewSessionId: string): void {
    page.once('crash', () => {
      logger.error('[PREVIEW_SESSION] Page crashed — cleaning up session', { previewSessionId });

      // Notify frontend
      try {
        webSocketService.emitToRoom('preview', previewSessionId, 'preview:error' as any, {
          previewSessionId,
          error: 'Page crashed. Please reload the preview.',
          code: 'PAGE_CRASH',
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-critical
      }

      // Destroy entire session (browser process is likely unstable)
      this.stopSession(previewSessionId).catch(() => {});
    });
  }

  /**
   * Editor trace — mirror every main-frame `framenavigated` into the JSONL
   * log. This is the ground-truth URL timeline (browser-observed, not our
   * inferred state) and is invaluable for correlating action outcomes
   * with unexpected navigations. Sub-frame (iframe) navigations are
   * ignored so the log isn't flooded with ad/analytics frames.
   *
   * Wired at the same three sites as crash/download handlers: initial
   * session start, session reset, and popup adoption.
   */
  private attachFrameNavigatedTrace(page: Page, previewSessionId: string): void {
    page.on('framenavigated', (frame) => {
      try {
        const isMain = frame.parentFrame() === null;
        if (!isMain) return;
        const url = frame.url();
        if (!url || url === 'about:blank') return;
        // Import lazily — the trace service already handles missing-session
        // gracefully, and we don't want this listener to import-cycle at
        // module load time.
        import('./editor-trace.service').then(({ EditorTraceService }) => {
          EditorTraceService.get(previewSessionId)?.writeFrameNavigated({
            url,
            isMainFrame: true,
          });
        }).catch(() => { /* trace is advisory */ });
      } catch {
        /* frame may be detached mid-handler */
      }
    });
  }

  /**
   * Handle download attempts in headless preview.
   * Headless Chromium can't actually save files — cancel the download and notify frontend.
   * Called on each page (session start, reset, popup switch).
   */
  private attachPageDownloadHandler(page: Page, previewSessionId: string): void {
    page.on('download', async (download) => {
      const url = download.url();
      const suggestedFilename = download.suggestedFilename();

      logger.info('[PREVIEW_SESSION] Download intercepted', {
        previewSessionId,
        url: url.slice(0, 200),
        filename: suggestedFilename,
      });

      const session = this.sessions.get(previewSessionId);

      // V13: During replay, save the download to a temp path for verification
      if (session?.dialogMode === 'replay') {
        try {
          // Save to temp path instead of cancelling — allows verification
          const path = await download.path();
          logger.info('[PREVIEW_SESSION] Download saved for replay verification', {
            previewSessionId, filename: suggestedFilename, path,
          });
        } catch {
          // If save fails, cancel to prevent hanging
          try { await download.cancel(); } catch { /* ok */ }
        }
        return;
      }

      // Cancel the download (preview mode — headless can't save files to user disk)
      try {
        await download.cancel();
      } catch {
        // May already be cancelled
      }

      // V13: During recording, emit download step
      if (session?.recording) {
        try {
          const { RecordingCaptureService } = await import('./recording-capture.service');
          const step = RecordingCaptureService.captureDownload({
            filename: suggestedFilename,
            url: url.slice(0, 500),
            pageUrl: page.url(),
          });
          webSocketService.emitToRoom('preview', previewSessionId, 'preview:recording:step' as any, {
            previewSessionId, step, timestamp: new Date().toISOString(),
          });
        } catch { /* non-critical */ }
      }

      // Notify frontend
      try {
        webSocketService.emitToRoom('preview', previewSessionId, 'preview:download' as any, {
          previewSessionId,
          url: url.slice(0, 500),
          filename: suggestedFilename,
          message: 'File download detected.',
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-critical
      }
    });
  }

  /**
   * Get page from session (for action execution)
   */
  getPage(sessionId: string, userId?: string): Page | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.page || null;
  }

  /**
   * Get the underlying BrowserContext. Used by the Test Resources layer to
   * apply (cookies/localStorage) or capture (storageState) a Login against
   * the live preview. Auth is enforced the same way as `getPage`.
   */
  getContext(sessionId: string, userId?: string): BrowserContext | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.context || null;
  }

  /**
   * Navigate to URL in session
   */
  async navigate(sessionId: string, url: string, userId?: string): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const startMs = Date.now();
      const safeUrl = sanitizeUrl(url);
      logger.info('[PREVIEW_SESSION] Navigating to URL', { sessionId, url: safeUrl });

      // Address-bar / programmatic navigate is user-intent — mark it so the
      // external-nav trap accepts the new origin as the fresh baseline.
      try {
        const { markIntentionalGoto } = await import('./external-nav-trap');
        markIntentionalGoto(sessionId, safeUrl);
      } catch { /* non-fatal */ }

      await session.page.goto(safeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      const landedUrl = session.page.url();
      logPerformance('preview.navigate', Date.now() - startMs, { sessionId, url: safeUrl, landed: landedUrl });

      // Kick off snapshot collection without blocking
      setImmediate(() => {
        this.getSnapshot(sessionId, userId, { force: true, includeDomNodes: true }).catch((err) => {
          logger.warn('[PREVIEW_SESSION] navigate snapshot failed', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      });

      return {
        url: landedUrl,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        changed: true,
      };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Navigation failed', {
        sessionId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Cleanup expired sessions
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      logger.info('[PREVIEW_SESSION] Cleaning up expired session', { sessionId });
      await this.stopSession(sessionId);
    }

    if (expiredSessions.length > 0) {
      logger.info('[PREVIEW_SESSION] Cleanup complete', {
        expiredCount: expiredSessions.length,
        remainingSessions: this.sessions.size,
      });
    }
  }

  /**
   * Start cleanup interval
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        logger.error('[PREVIEW_SESSION] Cleanup error', { error });
      });
    }, SESSION_CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop all sessions and cleanup (for graceful shutdown)
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }

    logger.info('[PREVIEW_SESSION] Shutdown complete');
  }

  /**
   * Get session count (for monitoring)
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

// Export singleton getter
export const getPreviewSessionService = () => PreviewSessionService.getInstance();
