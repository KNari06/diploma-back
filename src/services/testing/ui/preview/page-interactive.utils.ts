/**
 * waitForPageInteractive
 *
 * Composite "is this page actually ready for a bot to act on it?" gate.
 * Used at initial navigation, BEFORE the first step or first snapshot.
 *
 * Unlike naive `waitForDOMStability` (which only watches MutationObserver),
 * this helper relies on the exact same signal the step-resolver will later
 * use: the snapshot collector's view of interactive elements.
 *
 * ── Strategy ────────────────────────────────────────────────────────────
 *
 * Pipeline (top-down, each gate must pass before the next):
 *
 *   A. URL stability gate (expensive redirect chains)
 *      Watches page.url() via normalized compare (origin + pathname,
 *      ignores query/hash so aggressive SPAs that push ?t=<timestamp>
 *      don't look like redirects). Resets the "stable since" clock on
 *      every real path change. Only advances once the path has been
 *      unchanged for `minUrlStableMs`.
 *
 *   B. One-shot composite readiness check
 *      `VisualStability.waitForPageReady` runs ONCE after the URL settles:
 *      API idle + DOM stability + loading indicator polling
 *      (`[role="progressbar"]`, skeletons, spinners, NProgress, aria-busy).
 *
 *   C. Lightweight interactive-element polling
 *      Cheap `page.evaluate` (~5ms) counting matches of a safe subset of
 *      the snapshot collector's interactive selectors. Polled every
 *      `pollIntervalMs`. Requires `stabilityPasses` consecutive counts
 *      that all satisfy `≥ minElements` AND are close to each other
 *      (stability window). Much cheaper than running the full collector
 *      on every iteration.
 *
 *   D. Authoritative final check
 *      One real `SnapshotCollector.collect` call to confirm. If the full
 *      collector still sees ≥ minElements, we're ready. Otherwise fall
 *      back into polling.
 *
 * ── Correctness guarantees ──────────────────────────────────────────────
 *
 * - Fail-open: never throws. Caller is expected to log `result.ready` and
 *   proceed either way, preserving the old "always try" behavior of
 *   `waitForDOMStability`.
 * - Abort-aware: if an AbortSignal is supplied and fires, returns early
 *   with `{ ready: false, reason: 'aborted' }` — no wasted CPU after
 *   cancellation.
 * - Dead-page-aware: if `page.isClosed()` becomes true, returns
 *   immediately with `{ ready: false, reason: 'page closed' }` instead
 *   of spinning for the full budget on a corpse.
 * - No SPA-thrash: URL comparison uses normalized origin+pathname, so
 *   pages that `history.pushState` query params on every analytics beat
 *   are not mistaken for redirect chains.
 * - First-iteration honesty: `urlStableSince` starts at 0 (not
 *   `Date.now()`), so the first URL-stability check always requires one
 *   real `minUrlStableMs` observation window, not an instant pass.
 */

import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';
import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';
import { SnapshotRouter } from './snapshot-router.service';
import { VisualStability } from '@/agent/core/lite/collectors/visual-stability';
import { normalizeUrlForComparison } from './auto-wait-for.utils';

const TAG = '[PAGE_INTERACTIVE]';

export interface WaitForPageInteractiveOptions {
  /** Hard cap on total time spent polling (ms). Default: 15_000. */
  maxWaitMs?: number;
  /**
   * How long the URL (normalized: origin + pathname) must stay unchanged
   * before we trust it and start checking content (ms). Default: 600.
   */
  minUrlStableMs?: number;
  /** Minimum interactive elements the snapshot must return. Default: 1. */
  minElements?: number;
  /**
   * How many consecutive lightweight polls must all satisfy `≥ minElements`
   * before we promote to the full authoritative snapshot. Provides
   * stability without constantly running the expensive collector.
   * Default: 2.
   */
  stabilityPasses?: number;
  /**
   * Budget for the one-shot `VisualStability.waitForPageReady` call that
   * runs after URL stability is confirmed (ms). Default: 3_000.
   */
  readinessBudgetMs?: number;
  /** Delay between lightweight polls (ms). Default: 250. */
  pollIntervalMs?: number;
  /** Opaque identifier for log correlation. */
  previewSessionId?: string;
  /** Optional abort signal — exits early with ready=false when triggered. */
  signal?: AbortSignal;
}

export interface WaitForPageInteractiveResult {
  /** True iff the full snapshot returned ≥ `minElements` before the deadline. */
  ready: boolean;
  /** Total time actually spent inside the helper (ms). */
  waited: number;
  /** Element count returned by the final snapshot (or last lightweight poll). */
  elementCount: number;
  /** Terminal URL observed (fresh `page.url()` at return time). */
  finalUrl: string;
  /** Human-readable reason if ready=false. */
  reason?: string;
}

const DEFAULTS = {
  maxWaitMs: 15_000,
  minUrlStableMs: 600,
  minElements: 1,
  stabilityPasses: 2,
  readinessBudgetMs: 3_000,
  pollIntervalMs: 250,
} as const;

/** Cap on how many URL-change debug logs we emit per call (avoid log flooding on SPAs). */
const MAX_URL_CHANGE_LOGS = 5;

/**
 * Safe subset of interactive selectors. Intentionally a SUBSET of what
 * `SnapshotCollector` uses (see snapshot-collector.ts:729). Rule: any
 * element matching these will also match the full collector, so a
 * positive lightweight count is a lower bound on the real snapshot size.
 *
 * Deliberately EXCLUDES noisy selectors from the full collector:
 *   - `li`            — any unordered/ordered list gives ≥10 hits even on
 *                       "Loading..." shells.
 *   - `canvas`, `h1/h2/h3` — not interactive, included in the full
 *                       collector only for vision/goal-detection signals.
 *   - `[data-testid]`, `[data-test]` — commonly placed on static wrappers.
 *   - `dialog[open]`  — almost always contains a button we already match.
 *
 * Kept broad enough to cover modern frameworks (Rails/HTMX, Stimulus,
 * Alpine.js, Knockout, Qwik), native accordions (`summary`), and every
 * major ARIA widget role — but narrow enough that a fresh, loading-only
 * page doesn't score false positives.
 *
 * Escape note: `[x-on\\:click]` and `[on\\:click]` must escape the colon
 * in CSS selector syntax — an unescaped `:` is parsed as a pseudo-class
 * and querySelectorAll throws, which would zero out the entire count.
 * `[@click]` is INVALID CSS syntax and is intentionally NOT included —
 * Alpine compiles `@click` to `x-on:click` in the DOM anyway.
 *
 * If this list diverges from the full collector, the worst that happens
 * is we miss a ready signal on some iterations and fall back to polling
 * — correctness preserved, just a bit slower.
 */
const LIGHTWEIGHT_INTERACTIVE_SELECTOR = [
  // ── Core HTML interactive elements ──
  'button',
  'a[href]',
  'input:not([type="hidden"])',
  'select',
  'textarea',

  // ── ARIA widget roles (MUI, Ant Design, Chakra, Radix, Headless UI) ──
  '[role="button"]',
  '[role="link"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="listbox"]',
  '[role="combobox"]',
  '[role="switch"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="textbox"]',
  '[role="searchbox"]',
  '[role="treeitem"]',

  // ── Attribute-based interactive elements ──
  '[onclick]',
  '[tabindex]:not([tabindex="-1"])',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[data-toggle]',      // Bootstrap/Tailwind toggle triggers
  '[aria-haspopup]',    // Popup/menu triggers
  '[draggable="true"]', // Drag targets

  // ── Native accordions / disclosure ──
  'summary',            // <details><summary>…</summary></details>

  // ── Framework-specific bindings ──
  '[x-on\\:click]',     // Alpine.js (compiles @click → x-on:click)
  '[hx-get]',           // HTMX
  '[hx-post]',
  '[hx-put]',
  '[hx-delete]',
  '[hx-patch]',
  '[data-hx-get]',      // HTMX data-* variant
  '[data-hx-post]',
  '[data-action]',      // Stimulus (Rails)
  '[data-bind]',        // Knockout
  '[on\\:click]',       // Qwik
].join(',');

/**
 * Wait until a page is actually interactive for a bot (snapshot returns
 * ≥ minElements) or until the budget expires. Never throws.
 */
export async function waitForPageInteractive(
  page: Page,
  options: WaitForPageInteractiveOptions = {},
): Promise<WaitForPageInteractiveResult> {
  const {
    maxWaitMs = DEFAULTS.maxWaitMs,
    minUrlStableMs = DEFAULTS.minUrlStableMs,
    minElements = DEFAULTS.minElements,
    stabilityPasses = DEFAULTS.stabilityPasses,
    readinessBudgetMs = DEFAULTS.readinessBudgetMs,
    pollIntervalMs = DEFAULTS.pollIntervalMs,
    previewSessionId,
    signal,
  } = options;

  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;

  let lastNormalizedUrl = normalizeUrlForComparison(safeUrl(page));
  // Start at 0 (not Date.now()) so first iteration can't instantly pass
  // the url-stable check on a freshly-navigated page whose redirect has
  // not yet fired.
  let urlStableSince = 0;
  let readinessDone = false;
  let consecutivePasses = 0;
  let lastLightCount = 0;
  let lastFullCount = 0;
  let iterations = 0;
  let urlChangeLogsEmitted = 0;

  while (Date.now() < deadline) {
    iterations++;

    // ── Early exits ─────────────────────────────────────────────────────
    if (signal?.aborted) {
      return buildResult(false, startedAt, lastFullCount || lastLightCount, safeUrl(page), 'aborted');
    }
    if (page.isClosed()) {
      return buildResult(false, startedAt, lastFullCount || lastLightCount, safeUrl(page), 'page closed');
    }

    // ── A. URL stability gate ───────────────────────────────────────────
    const currentUrlRaw = safeUrl(page);
    const currentNormalized = normalizeUrlForComparison(currentUrlRaw);

    if (currentNormalized !== lastNormalizedUrl) {
      if (urlChangeLogsEmitted < MAX_URL_CHANGE_LOGS) {
        logger.debug(`${TAG} URL changed — redirect chain in progress`, {
          previewSessionId,
          from: truncUrl(lastNormalizedUrl),
          to: truncUrl(currentNormalized),
        });
        urlChangeLogsEmitted++;
      }
      lastNormalizedUrl = currentNormalized;
      urlStableSince = Date.now();
      // URL moved — any previous readiness/stability progress is stale.
      readinessDone = false;
      consecutivePasses = 0;
      await sleep(Math.min(pollIntervalMs, 150));
      continue;
    }

    // urlStableSince stays at 0 until the FIRST matching observation.
    if (urlStableSince === 0) {
      urlStableSince = Date.now();
      await sleep(Math.min(pollIntervalMs, 150));
      continue;
    }

    if (Date.now() - urlStableSince < minUrlStableMs) {
      await sleep(Math.min(pollIntervalMs, 150));
      continue;
    }

    // ── B. One-shot composite readiness check ─────────────────────────
    // Runs exactly once per URL-stable segment. If the URL shifts again
    // later, we reset `readinessDone = false` above and run this again.
    if (!readinessDone) {
      const readinessStart = Date.now();
      try {
        await VisualStability.waitForPageReady(page, {
          timeout: Math.min(readinessBudgetMs, Math.max(500, deadline - Date.now())),
        });
      } catch {
        // waitForPageReady is fail-open internally; belt-and-braces catch.
      }
      readinessDone = true;

      // URL might have shifted inside waitForPageReady — re-check and let
      // the next iteration's URL gate handle the reset. Yield with a tiny
      // sleep so we never busy-loop in the edge case where this branch
      // fires back-to-back.
      if (normalizeUrlForComparison(safeUrl(page)) !== lastNormalizedUrl) {
        await sleep(Math.min(pollIntervalMs, 150));
        continue;
      }

      logger.debug(`${TAG} Readiness check done`, {
        previewSessionId,
        waited: Date.now() - readinessStart,
      });
    }

    // ── C. Lightweight interactive-element count ──────────────────────
    let lightCount = 0;
    try {
      lightCount = await countInteractiveElementsLight(page);
      lastLightCount = lightCount;
    } catch (err) {
      // page.evaluate can throw on navigation-in-flight; treat as not-ready
      logger.debug(`${TAG} Light count threw — treating as not-ready`, {
        previewSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      consecutivePasses = 0;
      await sleep(pollIntervalMs);
      continue;
    }

    if (lightCount >= minElements) {
      consecutivePasses++;
    } else {
      consecutivePasses = 0;
    }

    // Not enough consecutive passes yet — keep polling cheaply.
    if (consecutivePasses < stabilityPasses) {
      await sleep(pollIntervalMs);
      continue;
    }

    // ── D. Authoritative final check via full snapshot collector ───────
    // Run the real collector to confirm. This is the same code that will
    // back the step resolver on the next line, so a positive result here
    // is a correctness guarantee.
    let fullCount = 0;
    try {
      const snap = await SnapshotRouter.collect(page, { context: 'page-interactive-check', skipStabilityWait: true });
      fullCount = Array.isArray(snap?.elements) ? snap.elements.length : 0;
      lastFullCount = fullCount;
    } catch (err) {
      logger.debug(`${TAG} Full snapshot threw — retrying`, {
        previewSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      consecutivePasses = 0;
      await sleep(pollIntervalMs);
      continue;
    }

    if (fullCount >= minElements) {
      const waited = Date.now() - startedAt;
      logger.info(`${TAG} Page interactive`, {
        previewSessionId,
        waited,
        iterations,
        elementCount: fullCount,
        lightCount,
        finalUrl: truncUrl(safeUrl(page)),
      });
      return {
        ready: true,
        waited,
        elementCount: fullCount,
        finalUrl: safeUrl(page),
      };
    }

    // Light count and full count disagree — the safe subset over-reported.
    // Reset and keep polling until deadline.
    consecutivePasses = 0;
    await sleep(pollIntervalMs);
  }

  // ── Timeout ──────────────────────────────────────────────────────────
  const reason =
    lastFullCount > 0
      ? `only ${lastFullCount} element(s) found, need ${minElements}`
      : lastLightCount > 0
        ? `light count saw ${lastLightCount} but full snapshot never confirmed`
        : 'snapshot remained empty for the entire budget';
  logger.warn(`${TAG} Timeout — proceeding without ready signal`, {
    previewSessionId,
    waited: Date.now() - startedAt,
    iterations,
    lastLightCount,
    lastFullCount,
    finalUrl: truncUrl(safeUrl(page)),
    reason,
  });
  return buildResult(
    false,
    startedAt,
    lastFullCount || lastLightCount,
    safeUrl(page),
    reason,
  );
}

// ── helpers ─────────────────────────────────────────────────────────────

function buildResult(
  ready: boolean,
  startedAt: number,
  elementCount: number,
  finalUrl: string,
  reason?: string,
): WaitForPageInteractiveResult {
  return {
    ready,
    waited: Date.now() - startedAt,
    elementCount,
    finalUrl,
    ...(reason ? { reason } : {}),
  };
}

/**
 * Lightweight interactive-element count. Uses a safe subset of the
 * snapshot collector's selectors via `document.querySelectorAll`.
 * Typical cost: 2–10ms on a 1k-node page.
 *
 * Strategy: we try the comma-joined selector as one call (fast path).
 * If that throws — usually because one framework-specific selector with
 * escaped characters is rejected by the host browser — we fall back to
 * running each sub-selector individually and summing the results,
 * collecting matched nodes in a Set to dedupe elements that match more
 * than one clause (e.g. a `<button role="button">`).
 *
 * Returns 0 in any weird state (no document yet, evaluate rejects, etc.)
 * so the caller can treat "0 elements" and "page not ready" uniformly.
 */
async function countInteractiveElementsLight(page: Page): Promise<number> {
  const raw = await page.evaluate(
    ({ joined, parts }: { joined: string; parts: string[] }) => {
      // @ts-expect-error - document may or may not exist in browser context
      if (typeof document === 'undefined' || !document || !document.querySelectorAll) {
        return 0;
      }
      // Fast path: one querySelectorAll call across all selectors.
      try {
        // @ts-expect-error - document exists in browser context
        return document.querySelectorAll(joined).length;
      } catch {
        // Slow path: iterate each sub-selector, skip invalid ones, dedupe.
        const seen = new Set<unknown>();
        for (const sel of parts) {
          try {
            // @ts-expect-error - document exists in browser context
            const nodes = document.querySelectorAll(sel);
            for (let i = 0; i < nodes.length; i++) {
              seen.add(nodes[i]);
            }
          } catch {
            // Selector invalid for this browser — skip it.
          }
        }
        return seen.size;
      }
    },
    {
      joined: LIGHTWEIGHT_INTERACTIVE_SELECTOR,
      parts: LIGHTWEIGHT_INTERACTIVE_SELECTOR.split(','),
    },
  );
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

function safeUrl(page: Page): string {
  try {
    return page.url();
  } catch {
    return '';
  }
}

function truncUrl(url: string): string {
  return url.length > 120 ? `${url.slice(0, 120)}…` : url;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
