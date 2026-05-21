/**
 * Preview Hover Overlay Service
 *
 * Drop-in replacement for the React-side `usePreviewHoverHighlight` —
 * a hover outline that lives INSIDE the iframe page, painted by an
 * injected vanilla-JS script. Distinct from `preview-element-pick`:
 *
 *   pick service          hover service (this file)
 *   ──────────────────    ────────────────────────────────────
 *   Blocks all clicks     Never blocks anything
 *   Blocks keydown/Esc    Never blocks anything
 *   Steals focus          Never touches focus
 *   60s timeout           Lives until setMode('off') / page close
 *   z-index very high     z-index lower than pick (pick wins if both)
 *   Visualises selection  Visualises hover only
 *
 * Why an in-page overlay instead of the existing React-rendered hover
 * highlight:
 *
 *   * **Latency.** React hover round-trips through WS → backend probe →
 *     WS reply → setState → re-render → composite. Round-trip ~250-400 ms
 *     on a typical LAN. In-page paint is sub-frame (<16 ms).
 *   * **Parity with pick.** Both overlays now share the same resolver
 *     (overlay-resolver-helpers.ts) so the hover outline picks the
 *     EXACT same element that pick click would capture.
 *   * **No backend cost.** No per-mousemove WS traffic, no per-mousemove
 *     PROBE_AT_POINT_FN evaluation (which on dense pages is 30-90 ms).
 *
 * Modes
 * ─────
 *   - 'navigation' — blue solid border; default during preview interaction.
 *   - 'recording'  — red dashed border; matches the recording UI accent.
 *   - 'off'        — overlay torn down, no listeners.
 *
 * Pick mode coexistence
 * ─────────────────────
 * When `preview-element-pick.service.startPick()` is called, this hover
 * overlay must NOT be active concurrently (the pick overlay handles its
 * own outline AND blocks clicks). The WS handler is the single source
 * of truth — it calls `setMode(id, 'off')` before `startPick` and
 * restores the previous mode in the pick session's `onExit` callback.
 */

import type { Page, Frame } from 'playwright';
import { logger } from '@/utils/core/logger';
import { buildOverlayResolverHelpers } from './overlay-resolver-helpers';

export type HoverOverlayMode = 'navigation' | 'recording' | 'off';

interface HoverSession {
  page: Page;
  mode: HoverOverlayMode;
  navHandler: (frame: Frame) => void;
  pageCloseHandler: () => void;
  closed: boolean;
}

const activeHoverSessions = new Map<string, HoverSession>();

// In-page identifiers — kept as constants so we can craft a teardown
// script even when the JS-side state is gone (e.g. after framenavigated).
const HOVER_ROOT_ID = '__qai_hover_overlay_root';
const HOVER_TIP_ID = '__qai_hover_overlay_tooltip';
const HOVER_STATE_KEY = '__qai_hover_overlay_state';

/**
 * Set the hover overlay mode for a preview session.
 *
 *   - First call with a non-'off' mode injects the listeners + paints
 *     a fresh outline on the next mousemove.
 *   - Subsequent calls with a different mode just update the colour
 *     scheme — listeners stay attached (no reinjection cost).
 *   - 'off' tears the overlay down and unsubscribes page listeners.
 *
 * Safe to call repeatedly with the same mode — no-op when the in-page
 * state is already on that mode (the script itself checks before
 * repainting).
 */
export async function setHoverOverlayMode(
  previewSessionId: string,
  page: Page,
  mode: HoverOverlayMode,
): Promise<void> {
  if (mode === 'off') {
    await teardownHover(previewSessionId);
    return;
  }

  if (page.isClosed()) {
    logger.debug('[HOVER_OVERLAY] setMode skipped — page closed', { previewSessionId });
    return;
  }

  let session = activeHoverSessions.get(previewSessionId);
  if (!session) {
    session = {
      page,
      mode,
      closed: false,
      navHandler: () => undefined,
      pageCloseHandler: () => undefined,
    };
    // Re-inject overlay after navigation (script + DOM are gone after
    // a new document load).
    session.navHandler = (frame) => {
      if (!session) return;
      if (frame !== page.mainFrame()) return;
      if (session.closed) return;
      // Fire-and-forget — re-paint asynchronously, never throw out of a
      // navigation handler.
      page.evaluate(buildHoverScript(session.mode)).catch((err) => {
        logger.debug('[HOVER_OVERLAY] reinject after nav failed', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    // Auto-cleanup on page close.
    session.pageCloseHandler = () => {
      void teardownHover(previewSessionId);
    };
    page.on('framenavigated', session.navHandler);
    page.once('close', session.pageCloseHandler);
    activeHoverSessions.set(previewSessionId, session);
  } else {
    session.mode = mode;
  }

  try {
    await page.evaluate(buildHoverScript(mode));
  } catch (err) {
    logger.debug('[HOVER_OVERLAY] inject failed', {
      previewSessionId,
      mode,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Tear the hover overlay down — removes listeners, DOM, and state.
 * Idempotent.
 */
export async function teardownHover(previewSessionId: string): Promise<void> {
  const session = activeHoverSessions.get(previewSessionId);
  if (!session || session.closed) return;
  session.closed = true;

  try { session.page.off('framenavigated', session.navHandler); } catch {}
  try { session.page.off('close', session.pageCloseHandler); } catch {}

  if (!session.page.isClosed()) {
    try {
      await session.page.evaluate(buildHoverTeardownScript()).catch(() => undefined);
    } catch {
      // page closed mid-evaluate
    }
  }

  activeHoverSessions.delete(previewSessionId);
}

/** Convenience: tear down when preview session itself is destroyed. */
export async function teardownHoverForSession(previewSessionId: string): Promise<void> {
  if (!activeHoverSessions.has(previewSessionId)) return;
  await teardownHover(previewSessionId);
}

/** Used by recording / pick handlers to read current mode without state hack. */
export function getHoverOverlayMode(previewSessionId: string): HoverOverlayMode {
  const session = activeHoverSessions.get(previewSessionId);
  if (!session || session.closed) return 'off';
  return session.mode;
}

// ────────────────────────────────────────────────────────────────────────
// In-page script (string template, evaluated in the live page context)
// ────────────────────────────────────────────────────────────────────────

/**
 * Build the JS string injected into the page.
 *
 * The script is RE-ENTRANT — calling it again on an already-initialised
 * page just updates the mode (no duplicate listeners). This lets the
 * server flip between 'navigation' and 'recording' colours with a
 * single page.evaluate cost.
 *
 * Critical properties (read carefully — every line below is a contract):
 *   1. Listeners use { passive: true } where possible — we must NEVER
 *      preventDefault on a hover event, otherwise we'd block clicks.
 *   2. The outline div is pointer-events:none so mouse events pass
 *      through to the page underneath.
 *   3. Mode is stored on window so re-eval reads the freshest value
 *      without re-attaching listeners.
 *   4. We re-paint on mousemove AND on scroll/resize (the target rect
 *      shifts under the cursor).
 */
function buildHoverScript(mode: HoverOverlayMode): string {
  return `(() => {
    const ROOT_ID = ${JSON.stringify(HOVER_ROOT_ID)};
    const TIP_ID = ${JSON.stringify(HOVER_TIP_ID)};
    const STATE_KEY = ${JSON.stringify(HOVER_STATE_KEY)};
    const MODE = ${JSON.stringify(mode)};

    // If already installed, just update the colour scheme and bail.
    if ((window)[STATE_KEY] && (window)[STATE_KEY].installed) {
      (window)[STATE_KEY].mode = MODE;
      try { (window)[STATE_KEY].repaint && (window)[STATE_KEY].repaint(); } catch (e) {}
      return;
    }

    // Resolver helpers — IDENTICAL to the pick overlay so hover outline
    // and pick target are byte-for-byte consistent.
    ${buildOverlayResolverHelpers()}

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('style', [
      'position:fixed','left:0','top:0','width:0','height:0',
      'pointer-events:none','z-index:2147483640',
      'box-sizing:border-box',
      'transition:all 50ms linear',
      'display:none',
    ].join(';'));

    const tip = document.createElement('div');
    tip.id = TIP_ID;
    tip.setAttribute('style', [
      'position:fixed','left:0','top:0',
      'pointer-events:none','z-index:2147483641',
      'color:#fff',
      'font:11px/1.3 ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
      'padding:3px 6px','border-radius:3px',
      'box-shadow:0 2px 8px rgba(0,0,0,.20)',
      'max-width:280px','white-space:nowrap','overflow:hidden','text-overflow:ellipsis',
      'display:none',
    ].join(';'));

    document.documentElement.appendChild(root);
    document.documentElement.appendChild(tip);

    function applyModeStyles() {
      const m = (window)[STATE_KEY] && (window)[STATE_KEY].mode;
      if (m === 'recording') {
        root.style.border = '2px dashed #ef4444';
        root.style.background = 'rgba(239,68,68,0.06)';
        tip.style.background = '#dc2626';
      } else {
        // navigation / default
        root.style.border = '2px solid #2563eb';
        root.style.background = 'rgba(37,99,235,0.06)';
        tip.style.background = '#111827';
      }
    }

    let lastTargetEl = null;
    let lastClientX = 0;
    let lastClientY = 0;

    function paint(el) {
      if (!(el instanceof Element)) {
        root.style.display = 'none';
        tip.style.display = 'none';
        return;
      }
      let rect;
      try { rect = el.getBoundingClientRect(); } catch (e) { return; }
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        root.style.display = 'none';
        tip.style.display = 'none';
        return;
      }
      root.style.display = 'block';
      root.style.left = rect.left + 'px';
      root.style.top = rect.top + 'px';
      root.style.width = rect.width + 'px';
      root.style.height = rect.height + 'px';

      const label = describeElement(el);
      tip.textContent = label;
      tip.style.display = 'block';
      const tw = Math.min(280, label.length * 7 + 12);
      let tx = rect.left;
      let ty = rect.top - 20;
      if (ty < 0) ty = rect.bottom + 4;
      if (tx + tw > window.innerWidth) tx = Math.max(0, window.innerWidth - tw - 4);
      tip.style.left = tx + 'px';
      tip.style.top = ty + 'px';
    }

    function updateFromPoint(x, y) {
      let real = null;
      try {
        const stack = (typeof document.elementsFromPoint === 'function')
          ? document.elementsFromPoint(x, y)
          : [];
        real = stack && stack.length ? stack[0] : null;
      } catch (e) {}
      if (!(real instanceof Element)) return;
      const target = findInteractive(real) || real;
      if (target === lastTargetEl) return;
      lastTargetEl = target;
      paint(target);
    }

    function onMouseMove(ev) {
      // CRITICAL: never preventDefault here — must let the page see the
      // mousemove so its own hover effects still work.
      const path = (typeof ev.composedPath === 'function') ? ev.composedPath() : [];
      const real = (path && path.length ? path[0] : ev.target);
      lastClientX = ev.clientX;
      lastClientY = ev.clientY;
      if (!(real instanceof Element)) return;
      const target = findInteractive(real) || real;
      if (target === lastTargetEl) return;
      lastTargetEl = target;
      paint(target);
    }

    function onMouseLeave() {
      // Cursor left the document — hide the outline (otherwise it sticks
      // on the last hovered element with no signal it's stale).
      root.style.display = 'none';
      tip.style.display = 'none';
      lastTargetEl = null;
    }

    function onScroll() {
      // Layout under the cursor shifted — re-resolve from last known
      // pointer coords and repaint. Also catches CSS:hover-triggered
      // size changes.
      updateFromPoint(lastClientX, lastClientY);
      if (lastTargetEl) paint(lastTargetEl);
    }

    function repaint() {
      applyModeStyles();
      if (lastTargetEl) paint(lastTargetEl);
    }

    function teardown() {
      try { document.removeEventListener('mousemove', onMouseMove, true); } catch (e) {}
      try { document.removeEventListener('mouseleave', onMouseLeave, true); } catch (e) {}
      try { window.removeEventListener('scroll', onScroll, true); } catch (e) {}
      try { window.removeEventListener('resize', onScroll, true); } catch (e) {}
      try { root.remove(); } catch (e) {}
      try { tip.remove(); } catch (e) {}
      try { delete (window)[STATE_KEY]; } catch (e) {}
    }

    (window)[STATE_KEY] = {
      installed: true,
      mode: MODE,
      teardown: teardown,
      repaint: repaint,
    };

    applyModeStyles();

    // All listeners use { passive: true } so the browser knows we won't
    // call preventDefault — crucial for scroll perf and to guarantee the
    // page receives every mousemove for its own logic.
    document.addEventListener('mousemove', onMouseMove, { capture: true, passive: true });
    document.addEventListener('mouseleave', onMouseLeave, { capture: true, passive: true });
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
  })();`;
}

function buildHoverTeardownScript(): string {
  return `(() => {
    try {
      const s = (window)[${JSON.stringify(HOVER_STATE_KEY)}];
      if (s && typeof s.teardown === 'function') s.teardown();
    } catch (e) {}
  })();`;
}
