/**
 * Preview Dirty Observer Service
 *
 * Event-driven replacement for the fixed-cadence DOM snapshot poll. An in-page
 * `MutationObserver` watches the live page for *real* structural / attribute
 * changes and signals the server (via an exposed function) so we collect + emit
 * a `preview:page` snapshot ON CHANGE instead of every N ms. On a static page
 * the observer is silent → ~0 backend cost; on a changing page it fires within
 * a frame of the mutation → fresher than the poll.
 *
 * Lifecycle mirrors `preview-hover-overlay.service.ts` (inject → re-inject on
 * `framenavigated` → teardown on session stop / page close). The page→server
 * push channel mirrors `preview-element-pick.service.ts` (`page.exposeFunction`).
 *
 * SAFETY / SCOPE (Phase 2)
 * ────────────────────────
 *   - Flag-gated, default OFF. When neither flag is set this module is never
 *     wired in, so behaviour is unchanged.
 *   - `PREVIEW_DIRTY_OBSERVER`        — observer drives snapshot emits.
 *   - `PREVIEW_DIRTY_OBSERVER_SHADOW` — observer runs but only LOGS that it
 *     would have fired; the periodic tick still drives everything. Use this to
 *     validate the observer fires at the right times before flipping the real
 *     flag.
 *   - The periodic DOM tick is intentionally LEFT RUNNING in this phase, so it
 *     remains the safety net (covers cross-origin iframes, page switches, and
 *     pure text-only mutations the observer ignores). Slowing the tick to a
 *     pure safety-net cadence is a later step.
 *
 * Known constraints (same as the snapshot collector — not regressions):
 *   - Cross-origin iframes can't be observed (browser security). Covered by the
 *     still-running tick.
 *   - Pure `characterData` (text-only) mutations are NOT observed — they are
 *     noisy (clocks/counters) and rarely change interactive-node identity;
 *     covered by the tick safety net.
 *   - Open shadow DOM is observed via `subtree: true`; closed shadow roots are
 *     opaque (same as the collector).
 */

import type { Page, Frame } from 'playwright';
import { logger } from '@/utils/core/logger';

/** Read a boolean env flag. Mirrors snapshot-router.config.ts's local helper. */
function envBool(name: string, defaultValue: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return defaultValue;
  return raw === 'true' || raw === '1';
}

const DIRTY_OBSERVER_ENABLED = envBool('PREVIEW_DIRTY_OBSERVER', false);
const DIRTY_OBSERVER_SHADOW = envBool('PREVIEW_DIRTY_OBSERVER_SHADOW', false);

/** True when the observer should be started at all (either real or shadow). */
export function isDirtyObserverActive(): boolean {
  return DIRTY_OBSERVER_ENABLED || DIRTY_OBSERVER_SHADOW;
}

/** True when the observer runs in shadow mode only (log, don't drive emits). */
export function isDirtyObserverShadowOnly(): boolean {
  return DIRTY_OBSERVER_SHADOW && !DIRTY_OBSERVER_ENABLED;
}

interface DirtyObserverSession {
  page: Page;
  navHandler: (frame: Frame) => void;
  pageCloseHandler: () => void;
  closed: boolean;
}

const activeDirtyObserverSessions = new Map<string, DirtyObserverSession>();

// In-page identifiers — kept as constants so the teardown script can find the
// state even after the JS-side reference is gone (e.g. post-navigation).
const DIRTY_STATE_KEY = '__qai_dirty_observer_state';
const DIRTY_CALLBACK_NAME = '__qai_dirty_signal';

// In-page throttle (leading + trailing) between dirty signals. Bounds wakeups
// on a continuously-mutating page (carousel/spinner) to <= ~1 per interval,
// while a quiesced page signals exactly once. The server-side signature dedup
// is the second backstop (a structural change that doesn't alter interactive
// nodes produces no wire emit).
const DIRTY_SIGNAL_INTERVAL_MS = 350;

/**
 * Start the dirty observer for a preview session. Idempotent — a second call
 * for an already-active session is a no-op.
 *
 * `onDirty` is invoked (server-side) each time the page signals a meaningful
 * DOM change. The caller decides what that means (collect+emit, or log in
 * shadow mode).
 */
export async function startDirtyObserver(params: {
  previewSessionId: string;
  page: Page;
  onDirty: () => void | Promise<void>;
}): Promise<boolean> {
  const { previewSessionId, page, onDirty } = params;

  if (page.isClosed()) {
    logger.debug('[DIRTY_OBSERVER] start skipped — page closed', { previewSessionId });
    return false;
  }
  if (activeDirtyObserverSessions.has(previewSessionId)) {
    return true; // already running
  }

  const session: DirtyObserverSession = {
    page,
    closed: false,
    navHandler: () => undefined,
    pageCloseHandler: () => undefined,
  };

  // The MutationObserver dies with the old document, so re-inject the observer
  // script on every main-frame navigation. The exposed function itself survives
  // navigations (Playwright re-installs exposeFunction bindings on each new
  // document), so it does NOT need re-exposing here.
  session.navHandler = (frame) => {
    if (session.closed) return;
    if (frame !== page.mainFrame()) return;
    page.evaluate(buildDirtyObserverScript()).catch((err) => {
      logger.debug('[DIRTY_OBSERVER] reinject after nav failed', {
        previewSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };
  session.pageCloseHandler = () => {
    void cancelDirtyObserverForSession(previewSessionId);
  };

  activeDirtyObserverSessions.set(previewSessionId, session);

  // Expose the page→server signal. Survives navigations. Tolerate
  // "already registered" — a prior session on the same page that didn't fully
  // tear down leaves the binding; the callback below routes through the session
  // map anyway so a stale binding pointing at this same function is harmless.
  try {
    await page.exposeFunction(DIRTY_CALLBACK_NAME, () => {
      const live = activeDirtyObserverSessions.get(previewSessionId);
      if (!live || live.closed) return;
      Promise.resolve(onDirty()).catch((err) => {
        logger.debug('[DIRTY_OBSERVER] onDirty handler failed', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/already (registered|exposed)/i.test(msg)) {
      logger.warn('[DIRTY_OBSERVER] exposeFunction failed — aborting start', {
        previewSessionId,
        error: msg,
      });
      await cancelDirtyObserverForSession(previewSessionId);
      return false;
    }
  }

  // Attach lifecycle listeners, then inject the observer script.
  page.on('framenavigated', session.navHandler);
  page.once('close', session.pageCloseHandler);

  try {
    await page.evaluate(buildDirtyObserverScript());
    logger.info('[DIRTY_OBSERVER] Started', { previewSessionId });
    return true;
  } catch (err) {
    logger.warn('[DIRTY_OBSERVER] script injection failed — aborting start', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    await cancelDirtyObserverForSession(previewSessionId);
    return false;
  }
}

/**
 * Tear the dirty observer down — removes page listeners, disconnects the
 * in-page observer, and clears its window state. Idempotent.
 */
export async function cancelDirtyObserverForSession(previewSessionId: string): Promise<void> {
  const session = activeDirtyObserverSessions.get(previewSessionId);
  if (!session || session.closed) return;
  session.closed = true;

  try { session.page.off('framenavigated', session.navHandler); } catch { /* best effort */ }
  try { session.page.off('close', session.pageCloseHandler); } catch { /* best effort */ }

  if (!session.page.isClosed()) {
    try {
      await session.page.evaluate(buildDirtyObserverTeardownScript()).catch(() => undefined);
    } catch { /* page closed mid-evaluate */ }
  }

  activeDirtyObserverSessions.delete(previewSessionId);
  logger.info('[DIRTY_OBSERVER] Stopped', { previewSessionId });
}

// ────────────────────────────────────────────────────────────────────────
// In-page scripts (string templates, evaluated in the live page context)
// ────────────────────────────────────────────────────────────────────────

/**
 * Build the JS injected into the page. RE-ENTRANT: re-evaluating on an already
 * installed page is a no-op (used to be defensive against double-inject).
 *
 * Filters out CSS-animation noise (class/style/aria-hidden/data-state) so a
 * pulsing button or a fade transition doesn't wake the server — matches the
 * filter used by step-readiness `waitForDOMStable`.
 */
function buildDirtyObserverScript(): string {
  return `(() => {
    const STATE_KEY = ${JSON.stringify(DIRTY_STATE_KEY)};
    const CB = ${JSON.stringify(DIRTY_CALLBACK_NAME)};
    const INTERVAL = ${DIRTY_SIGNAL_INTERVAL_MS};

    // Re-entrant: if already installed on this document, bail.
    if ((window)[STATE_KEY] && (window)[STATE_KEY].installed) return;

    // Attribute names that signal animation/transition rather than a real
    // content change — ignored so they don't wake the server.
    const ANIM_ATTRS = new Set(['class','style','aria-hidden','data-state','data-active']);

    let lastSignalAt = 0;
    let trailingTimer = null;

    function signal() {
      lastSignalAt = Date.now();
      trailingTimer = null;
      try {
        if (typeof (window)[CB] === 'function') (window)[CB]();
      } catch (e) { /* binding gone — ignore */ }
    }

    function onMutations(mutations) {
      let meaningful = false;
      for (let i = 0; i < mutations.length; i++) {
        const m = mutations[i];
        if (m.type === 'childList') { meaningful = true; break; }
        if (m.type === 'attributes' && !ANIM_ATTRS.has(m.attributeName)) { meaningful = true; break; }
      }
      if (!meaningful) return;
      // Leading + trailing throttle: fire at most once per INTERVAL.
      const now = Date.now();
      const since = now - lastSignalAt;
      if (since >= INTERVAL) {
        signal();
      } else if (!trailingTimer) {
        trailingTimer = setTimeout(signal, INTERVAL - since);
      }
    }

    let observer;
    try {
      observer = new MutationObserver(onMutations);
    } catch (e) {
      return; // MutationObserver unavailable (shouldn't happen in Chromium)
    }

    function startObserving() {
      const root = document.documentElement || document.body;
      if (!root) return false;
      try {
        observer.observe(root, { childList: true, subtree: true, attributes: true });
        return true;
      } catch (e) { return false; }
    }

    function teardown() {
      try { observer.disconnect(); } catch (e) {}
      try { if (trailingTimer) clearTimeout(trailingTimer); } catch (e) {}
      try { delete (window)[STATE_KEY]; } catch (e) {}
    }

    (window)[STATE_KEY] = { installed: true, teardown: teardown };

    // document.body may not exist yet at document_start — retry once on
    // DOMContentLoaded if the first observe couldn't attach.
    if (!startObserving()) {
      try {
        document.addEventListener('DOMContentLoaded', startObserving, { once: true });
      } catch (e) {}
    }
  })();`;
}

function buildDirtyObserverTeardownScript(): string {
  return `(() => {
    try {
      const s = (window)[${JSON.stringify(DIRTY_STATE_KEY)}];
      if (s && typeof s.teardown === 'function') s.teardown();
    } catch (e) {}
  })();`;
}
