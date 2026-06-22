/**
 * Preview Lint Highlight Service
 *
 * Draws the "is this the element you meant?" border for a lint/Find result
 * INSIDE the browser page (injected vanilla-JS), mirroring
 * preview-hover-overlay.service.ts. This is the target architecture: the outline
 * is part of the page, so it uses the element's live getBoundingClientRect and
 * SCROLLS WITH THE PAGE for free — no document↔viewport conversion, no scroll
 * math, no drift (the bug that the old React-<div>-over-the-video overlay had on
 * scrolled pages).
 *
 * Difference from the hover overlay: hover resolves the element under the cursor
 * (elementsFromPoint); this resolves a SPECIFIC element the resolver already
 * chose, by its `data-agent-ref` (the snapshot collector stamps that attribute
 * on the live DOM — see snapshot-collector.ts assignAgentRefs). No listeners, no
 * mousemove — it just paints one element and repaints on scroll/resize.
 *
 * Frame coverage: draws in-page for the main document AND same-origin iframes
 * (findTarget descends into them and paint() adds the iframe's offset). Only a
 * CROSS-ORIGIN <iframe> is unreachable — page.evaluate can't read its
 * contentDocument — so there `showLintHighlight` returns `{ drawn: false }` and
 * the caller falls back to the React-<div> overlay (which paints over the video
 * frame regardless of frame origin). That's the single uncovered in-page case.
 *
 * Invariant parity with hover (#13): paint-only — root div is pointer-events:none
 * and there are NO input-blocking listeners. Never interferes with the test.
 */

import type { Page, Frame } from 'playwright';
import { logger } from '@/utils/core/logger';

export type LintHighlightType = 'success' | 'warning' | 'error';

interface LintHighlightSession {
  page: Page;
  ref: string;
  type: LintHighlightType;
  navHandler: (frame: Frame) => void;
  pageCloseHandler: () => void;
  closed: boolean;
}

const activeSessions = new Map<string, LintHighlightSession>();

// Sessions where a step is currently executing (apply / run). A lint can be
// emitted just before Apply, but its resolver round-trip finishes AFTER apply
// already cleared the border — that late `showLintHighlight` would repaint a
// stale border that never goes away (observed: border stuck on the "Name" input
// after Run). While suppressed, showLintHighlight is a no-op that also clears
// any existing border. Suppression is the lint-side half of the
// recording/run/apply mutual-exclusion invariant (#1).
const suppressedSessions = new Set<string>();
const releaseTimers = new Map<string, NodeJS.Timeout>();

// Grace window after a step finishes during which late lint results stay
// suppressed. Sized to outlast a lint resolver round-trip (LLM ~hundreds of ms).
const LINT_SUPPRESSION_GRACE_MS = 1500;

/**
 * Mark a session as executing a step — late lint highlights are suppressed (and
 * any current border cleared) until `releaseLintHighlightSuppression`. Call on
 * apply start / run:start.
 */
export function suppressLintHighlight(previewSessionId: string): void {
  if (!previewSessionId) return;
  // Cancel any pending graced release from a previous step — keep suppressed.
  const pending = releaseTimers.get(previewSessionId);
  if (pending) { clearTimeout(pending); releaseTimers.delete(previewSessionId); }
  suppressedSessions.add(previewSessionId);
  void clearLintHighlight(previewSessionId);
}

/**
 * Lift suppression once the step / run finished — after a short grace so a lint
 * that was emitted JUST BEFORE apply (its resolver round-trip lands AFTER apply
 * completes — the exact race that wedged the border on the "Name" input) is
 * still swallowed. The grace covers a typical lint resolver round-trip.
 */
export function releaseLintHighlightSuppression(previewSessionId: string): void {
  if (!previewSessionId) return;
  const existing = releaseTimers.get(previewSessionId);
  if (existing) clearTimeout(existing);
  const t = setTimeout(() => {
    suppressedSessions.delete(previewSessionId);
    releaseTimers.delete(previewSessionId);
  }, LINT_SUPPRESSION_GRACE_MS);
  t.unref?.();
  releaseTimers.set(previewSessionId, t);
}

// In-page identifiers — stable so a teardown script works even after the JS
// state is gone (e.g. after framenavigated wiped the document).
const ROOT_ID = '__qai_lint_highlight_root';
const STATE_KEY = '__qai_lint_highlight_state';

/**
 * Show the lint highlight for `ref` in the live page.
 *
 * @returns `{ drawn }` — true if the element was found in the main frame and
 *   outlined; false if it wasn't (e.g. cross-origin iframe / not in DOM), so the
 *   caller can fall back to the React overlay.
 */
export async function showLintHighlight(
  previewSessionId: string,
  page: Page,
  ref: string,
  type: LintHighlightType = 'success',
): Promise<{ drawn: boolean }> {
  if (!ref || page.isClosed()) return { drawn: false };

  // A step is executing — this lint result raced past Apply. Don't repaint a
  // border the apply handler already cleared (it would stick forever). Clear
  // any leftover and report not-drawn so the FE doesn't draw the fallback.
  if (suppressedSessions.has(previewSessionId)) {
    void clearLintHighlight(previewSessionId);
    return { drawn: false };
  }

  let session = activeSessions.get(previewSessionId);
  if (!session) {
    session = {
      page,
      ref,
      type,
      closed: false,
      navHandler: () => undefined,
      pageCloseHandler: () => undefined,
    };
    // Re-inject after navigation (script + DOM are gone after a new document).
    session.navHandler = (frame) => {
      if (!session || session.closed) return;
      if (frame !== page.mainFrame()) return;
      page.evaluate(buildLintHighlightScript(session.ref, session.type)).catch((err) => {
        logger.debug('[LINT_HIGHLIGHT] reinject after nav failed', {
          previewSessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    };
    session.pageCloseHandler = () => { void clearLintHighlight(previewSessionId); };
    page.on('framenavigated', session.navHandler);
    page.once('close', session.pageCloseHandler);
    activeSessions.set(previewSessionId, session);
  } else {
    session.ref = ref;
    session.type = type;
  }

  try {
    const drawn = await page.evaluate(buildLintHighlightScript(ref, type));
    return { drawn: drawn === true };
  } catch (err) {
    logger.debug('[LINT_HIGHLIGHT] inject failed', {
      previewSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return { drawn: false };
  }
}

/** Tear the lint highlight down — removes listeners, DOM, and state. Idempotent. */
export async function clearLintHighlight(previewSessionId: string): Promise<void> {
  const session = activeSessions.get(previewSessionId);
  if (!session || session.closed) return;
  session.closed = true;

  try { session.page.off('framenavigated', session.navHandler); } catch {}
  try { session.page.off('close', session.pageCloseHandler); } catch {}

  if (!session.page.isClosed()) {
    try {
      await session.page.evaluate(buildLintTeardownScript()).catch(() => undefined);
    } catch { /* page closed mid-evaluate */ }
  }

  activeSessions.delete(previewSessionId);
}

/** Tear down when the preview session itself is destroyed. */
export async function clearLintHighlightForSession(previewSessionId: string): Promise<void> {
  if (!activeSessions.has(previewSessionId)) return;
  await clearLintHighlight(previewSessionId);
}

// ────────────────────────────────────────────────────────────────────────
// In-page script (string template, evaluated in the live page context)
// ────────────────────────────────────────────────────────────────────────

/**
 * Build the JS injected into the page. Returns `true` if the element was found
 * and painted, `false` otherwise (caller uses this for the iframe fallback).
 *
 * Re-entrant: a second call updates the target/colour without duplicate DOM.
 * Critical contracts (mirror hover invariant #13):
 *   1. root is pointer-events:none → never blocks clicks/hover under it.
 *   2. NO input listeners — only scroll/resize repaint (passive).
 *   3. currentCSSZoom divide — sites that set CSS zoom on <html> (the overlay
 *      lives inside that zoomed root, so the browser re-applies zoom to our px).
 */
function buildLintHighlightScript(ref: string, type: LintHighlightType): string {
  return `(() => {
    const ROOT_ID = ${JSON.stringify(ROOT_ID)};
    const STATE_KEY = ${JSON.stringify(STATE_KEY)};
    const REF = ${JSON.stringify(ref)};
    const TYPE = ${JSON.stringify(type)};

    function colorFor(t) {
      // The lint "is this the element you meant?" border is RED DASHED (and a
      // touch heavier, 3px — see border below) so it reads as "AI's proposed
      // target", distinct from the hover overlay (blue solid = navigation hover).
      // Note: hover-recording is also red dashed but never coexists with lint
      // (lint shows on Find in navigation mode; recording-red shows while
      // recording), so there's no on-screen collision.
      if (t === 'warning') return ['#f59e0b', 'rgba(245,158,11,0.08)']; // amber (needs clarification)
      // success + error both use red — success is the proposed target, error the
      // failed one; the red dashed style is the shared "lint target" look.
      return ['#ef4444', 'rgba(239,68,68,0.08)'];                       // red
    }

    // Find the element by data-agent-ref. Searches the main document AND
    // SAME-ORIGIN iframes (CDP stamps the attribute inside those too). Returns
    // { el, frameEl } — frameEl is the owning <iframe> when the element lives in
    // one (null for main doc), so paint() can add the iframe's offset. Returns
    // null when not found (cross-origin iframe / removed from DOM) → caller's
    // drawn:false → React fallback.
    function findTarget(r) {
      try {
        const sel = '[data-agent-ref="' + (window.CSS && CSS.escape ? CSS.escape(r) : r) + '"]';
        const top = document.querySelector(sel);
        if (top) return { el: top, frameEl: null };
        // Descend into same-origin iframes (one level — nested iframes are rare
        // in tested apps; deepen here if that changes).
        const iframes = document.querySelectorAll('iframe');
        for (let i = 0; i < iframes.length; i++) {
          let doc = null;
          try { doc = iframes[i].contentDocument; } catch (e) { doc = null; } // cross-origin throws → skip
          if (!doc) continue;
          const inFrame = doc.querySelector(sel);
          if (inFrame) return { el: inFrame, frameEl: iframes[i] };
        }
      } catch (e) {}
      return null;
    }

    // Already installed → update target/colour and repaint.
    if (window[STATE_KEY] && window[STATE_KEY].installed) {
      window[STATE_KEY].ref = REF;
      window[STATE_KEY].type = TYPE;
      const found = !!findTarget(REF);
      try { window[STATE_KEY].repaint(); } catch (e) {}
      return found;
    }

    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.setAttribute('style', [
      'position:fixed','left:0','top:0','width:0','height:0',
      'pointer-events:none','z-index:2147483639',
      'box-sizing:border-box','border-radius:3px',
      'transition:all 80ms linear','display:none',
    ].join(';'));
    document.documentElement.appendChild(root);

    function paint() {
      const st = window[STATE_KEY];
      if (!st) return;
      const found = findTarget(st.ref);
      if (!found || !(found.el instanceof Element)) { root.style.display = 'none'; return; }
      let rect;
      try { rect = found.el.getBoundingClientRect(); } catch (e) { root.style.display = 'none'; return; }
      if (!rect || (rect.width === 0 && rect.height === 0)) { root.style.display = 'none'; return; }
      // For an element inside a same-origin iframe, its rect is relative to the
      // IFRAME's viewport — add the iframe element's own top-left to map into the
      // main viewport where our fixed-position overlay lives.
      let offX = 0, offY = 0;
      if (found.frameEl) {
        try {
          const fr = found.frameEl.getBoundingClientRect();
          offX = fr.left; offY = fr.top;
        } catch (e) {}
      }
      const [border, bg] = colorFor(st.type);
      const z = root.currentCSSZoom || 1;
      root.style.display = 'block';
      // 3px dashed — heavier than the hover overlay's 2px so the AI's proposed
      // target stands out as "look here".
      root.style.border = '3px dashed ' + border;
      root.style.background = bg;
      root.style.left = ((rect.left + offX) / z) + 'px';
      root.style.top = ((rect.top + offY) / z) + 'px';
      root.style.width = (rect.width / z) + 'px';
      root.style.height = (rect.height / z) + 'px';
    }

    function onScroll() { paint(); }
    function teardown() {
      try { window.removeEventListener('scroll', onScroll, true); } catch (e) {}
      try { window.removeEventListener('resize', onScroll, true); } catch (e) {}
      try { root.remove(); } catch (e) {}
      try { delete window[STATE_KEY]; } catch (e) {}
    }

    window[STATE_KEY] = { installed: true, ref: REF, type: TYPE, repaint: paint, teardown: teardown };

    // Repaint when layout shifts under the element. Passive — never blocks.
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onScroll, { passive: true });

    paint();
    return !!findTarget(REF);
  })();`;
}

function buildLintTeardownScript(): string {
  return `(() => {
    try {
      const s = window[${JSON.stringify(STATE_KEY)}];
      if (s && typeof s.teardown === 'function') s.teardown();
    } catch (e) {}
  })();`;
}
