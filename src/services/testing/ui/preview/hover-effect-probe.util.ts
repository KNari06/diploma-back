/**
 * Hover-effect probe — detects whether a hover caused a meaningful structural
 * change in the DOM (new interactives appeared, aria-expanded flipped, Radix
 * data-state opened) so the recorder can keep ONLY hovers that genuinely drive
 * the UI and drop random cursor sweeps.
 *
 * Why local-subtree only:
 *   A full-page snapshot diff costs 80–250 ms and re-collects every interactive
 *   on the page — most of which are irrelevant to the element under cursor.
 *   We need a 5–15 ms probe that the hover handler can fire ~twice per
 *   candidate without delaying anything user-visible.
 *
 * What "subtree" means:
 *   target.closest 3-up.  Three levels is enough to cover:
 *     - dropdown menu opening as sibling of trigger (1 up + 1 down)
 *     - "delete" button appearing in the same table row (1 up + 1 down)
 *     - accordion expanding adjacent panel (2 up + 1 down)
 *   Tooltips that render in a body-level portal (Radix Tooltip default) are
 *   intentionally out of scope — tooltip-only hovers have no replay value.
 *
 * Symmetry note:
 *   The probe uses the SAME visibility heuristic as snapshot-collector
 *   (`offsetParent !== null` plus rect.width/height > 0) so the count delta
 *   is comparable to what the resolver will see.
 */

import type { Page } from 'playwright';
import { logger } from '@/utils/core/logger';

/** Single probe of the local subtree around a hover target. */
export interface HoverEffectSnapshot {
  /** Visible interactive descendants count inside the 3-up ancestor subtree. */
  interactiveCount: number;
  /**
   * "Visually rendered" interactive count — adds the `opacity > 0.05` and
   * `visibility !== hidden` filter on top of `interactiveCount`.  Catches
   * the row-affordance pattern (`.delete-btn { opacity: 0 }` revealed on
   * `tr:hover { opacity: 1 }`) which `interactiveCount` alone misses
   * because opacity:0 elements are still layout-positioned (offsetParent
   * is non-null, getBoundingClientRect returns a real rect).
   */
  visualInteractiveCount: number;
  /**
   * Map of `aria-expanded` values along target → 3 ancestors.
   * Index 0 = target, 1..3 = ancestors. Missing key means attribute absent.
   * Stored as the literal attribute string (`"true"` / `"false"`) so a
   * `null → "true"` flip is unambiguous (vs. attribute that just appeared).
   */
  expandedChain: Record<number, string>;
  /** Same shape as expandedChain but for `data-state` (Radix / Vaul / shadcn). */
  dataStateChain: Record<number, string>;
}

/** Result of comparing pre/post hover snapshots. */
export interface HoverEffectDiff {
  /** post.interactiveCount - pre.interactiveCount (can be negative on close). */
  newInteractive: number;
  /**
   * post.visualInteractiveCount - pre.visualInteractiveCount.  Catches the
   * row-affordance pattern where opacity:0 → 1 reveals an existing-in-DOM
   * button without changing layout-visibility count.  Use this for the
   * primary "did something appear?" signal — interactiveCount is kept as
   * a backup for the rare case where opacity probing is unreliable.
   */
  newVisualInteractive: number;
  /** Any `aria-expanded` flipped to "true" (or appeared as "true"). */
  expandedTriggered: boolean;
  /** Any `data-state` flipped to an "open"-family value (open/active/checked/on). */
  dataStateOpened: boolean;
}

/**
 * In-page evaluator. Runs in the browser, must be self-contained — no closures
 * over outer scope, no imports. Receives target coordinates because we cannot
 * pass element handles through page.evaluate.
 *
 * Strategy:
 *   1. Locate target via elementFromPoint(x, y) — same anchor the recorder used.
 *   2. Walk up to commonAncestor (3 levels) — covers dropdowns, row affordances,
 *      adjacent accordions.
 *   3. Within that subtree, count visible interactives and read aria-expanded /
 *      data-state along [target, ...ancestors].
 *
 * Failure modes (return null):
 *   - elementFromPoint outside viewport / detached document
 *   - target was removed between dwell and probe (rare, fail open)
 */
const PROBE_FN = `
(function(px, py) {
  var target = document.elementFromPoint(px, py);
  if (!target) return null;

  // Walk up to find subtree root — 3 levels max.  We don't go higher because
  // body-level changes (modals, toasts) are not hover effects of THIS element.
  var subtreeRoot = target;
  for (var i = 0; i < 3 && subtreeRoot.parentElement; i++) {
    subtreeRoot = subtreeRoot.parentElement;
  }

  // Visibility check — mirrors snapshot-collector's "is this rendered" test.
  // offsetParent === null catches display:none AND detached subtrees.
  // Zero rect catches visibility:hidden with width/height collapsed.
  function isLayoutVisible(el) {
    if (!el) return false;
    if (el.offsetParent === null && el.tagName !== 'BODY') return false;
    var rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // "Visually rendered" — stricter check that also catches opacity:0 and
  // visibility:hidden.  Used to detect row-affordance patterns where the
  // delete button is always in the DOM but opacity-0 until tr:hover.
  function isVisuallyVisible(el) {
    if (!isLayoutVisible(el)) return false;
    var cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    var op = parseFloat(cs.opacity);
    if (!isNaN(op) && op < 0.05) return false;
    return true;
  }

  // Count visible interactives inside subtree.  Selector matches the recorder
  // and resolver — keep this list aligned with snapshot-collector Tier-1 if
  // it ever changes.  Static set: button, anchor with href, form input,
  // ARIA roles, or anything explicitly tab-stoppable.
  var INTERACTIVE_SEL =
    'button, a[href], input, select, textarea, summary, '
    + '[role=button], [role=link], [role=menuitem], [role=tab], '
    + '[role=option], [role=checkbox], [role=radio], '
    + '[tabindex]:not([tabindex="-1"])';

  // Walk subtree including shadow roots — querySelectorAll does NOT pierce
  // shadow boundaries, but the recorder's PROBE_AT_POINT_FN does, so the
  // probe target may live inside a shadow tree (Documentolog Market, any
  // <ion-*> Ionic component, lit-element widgets, native <video>/<dialog>).
  // Without piercing, dropdowns inside shadow widgets get "no effect" and
  // are dropped.  Cap depth at 5 — same as PROBE_AT_POINT_FN's shadow walk.
  var interactiveCount = 0;
  var visualInteractiveCount = 0;
  function walk(root, depth) {
    if (depth > 5) return;
    var nodes = root.querySelectorAll(INTERACTIVE_SEL);
    for (var n = 0; n < nodes.length; n++) {
      if (isLayoutVisible(nodes[n])) {
        interactiveCount++;
        if (isVisuallyVisible(nodes[n])) visualInteractiveCount++;
      }
    }
    // Descend into open shadow roots of every element under root (closed
    // shadow is impenetrable per spec — el.shadowRoot is null from outside).
    var allEls = root.querySelectorAll('*');
    for (var e = 0; e < allEls.length; e++) {
      if (allEls[e].shadowRoot) walk(allEls[e].shadowRoot, depth + 1);
    }
  }
  walk(subtreeRoot, 0);

  // Read aria-expanded / data-state along target → 3 ancestors.
  // These two attributes are the canonical signals for "I just opened":
  //   - aria-expanded: native ARIA, used by Headless UI / vanilla a11y code.
  //   - data-state="open": Radix / shadcn / Vaul convention, NOT mirrored
  //     to aria-expanded consistently — we MUST track it separately or
  //     miss every Radix dropdown.
  var expandedChain = {};
  var dataStateChain = {};
  var cursor = target;
  for (var d = 0; d < 4 && cursor; d++) {
    var ae = cursor.getAttribute && cursor.getAttribute('aria-expanded');
    var ds = cursor.getAttribute && cursor.getAttribute('data-state');
    if (ae !== null && ae !== undefined) expandedChain[d] = ae;
    if (ds !== null && ds !== undefined) dataStateChain[d] = ds;
    cursor = cursor.parentElement;
  }

  return {
    interactiveCount: interactiveCount,
    visualInteractiveCount: visualInteractiveCount,
    expandedChain: expandedChain,
    dataStateChain: dataStateChain,
  };
})
`;

/**
 * Probe the page once.  Fires inside `page.evaluate` and returns null on any
 * failure (detached target, evaluate threw, page already navigated).  Caller
 * is expected to fail open — a failed probe means "we don't know" which lands
 * as `hadDomEffect: false` in the gate.  Recording-only path; never blocking.
 *
 * Timing: ~5–15 ms on a typical page, ~30 ms on dense SPAs.  Always
 * fire-and-forget from the recording loop — we never await before the user
 * sees their next move.
 */
export async function probeHoverEffect(
  page: Page,
  x: number,
  y: number,
): Promise<HoverEffectSnapshot | null> {
  try {
    const result = await page.evaluate(`${PROBE_FN}(${x}, ${y})`) as HoverEffectSnapshot | null;
    if (!result) return null;
    // Defensive coercion — page may return `undefined` for empty maps in some
    // serialisations.  Normalise so callers can safely Object.keys() etc.
    return {
      interactiveCount: typeof result.interactiveCount === 'number' ? result.interactiveCount : 0,
      visualInteractiveCount: typeof result.visualInteractiveCount === 'number' ? result.visualInteractiveCount : 0,
      expandedChain: result.expandedChain || {},
      dataStateChain: result.dataStateChain || {},
    };
  } catch (err) {
    logger.debug('[HOVER_EFFECT] probe failed', {
      x, y, error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Compute the diff between pre-hover and post-hover snapshots.  The result
 * is what the recorder uses to decide whether to keep the hover step.
 *
 * Strict rules (intentional — false positives are worse than false negatives):
 *   - newInteractive must be > 0 — interactive count went UP (not just shifted).
 *     A negative delta means a popup CLOSED during dwell — also not a hover
 *     trigger we want to record.
 *   - expandedTriggered: any aria-expanded transitioned to "true".  The "false → true"
 *     direction is the only one that means "this hover opened something".
 *   - dataStateOpened: any data-state moved into the "open" family.  Radix
 *     uses "open" for dialogs/menus, "active" for tabs, "checked" for checkboxes,
 *     "on" for toggles.  We accept all of them — any is a meaningful state shift
 *     that the user likely intends to trigger via hover.
 *
 * Both null inputs (probe failed): returns a "no effect" diff so the gate
 * falls back to popup-trigger heuristic alone.
 */
export function diffHoverEffect(
  pre: HoverEffectSnapshot | null,
  post: HoverEffectSnapshot | null,
): HoverEffectDiff {
  if (!pre || !post) {
    return { newInteractive: 0, newVisualInteractive: 0, expandedTriggered: false, dataStateOpened: false };
  }

  const newInteractive = post.interactiveCount - pre.interactiveCount;
  const newVisualInteractive = post.visualInteractiveCount - pre.visualInteractiveCount;

  let expandedTriggered = false;
  // Compare every index that exists in EITHER snapshot — a key appearing only
  // in post (attribute didn't exist before, now exists with "true") still
  // counts as a flip.
  const expandedKeys = new Set([
    ...Object.keys(pre.expandedChain),
    ...Object.keys(post.expandedChain),
  ]);
  for (const k of expandedKeys) {
    const before = pre.expandedChain[k as unknown as number];
    const after = post.expandedChain[k as unknown as number];
    if (after === 'true' && before !== 'true') {
      expandedTriggered = true;
      break;
    }
  }

  let dataStateOpened = false;
  const OPEN_STATES = new Set(['open', 'active', 'checked', 'on']);
  const dsKeys = new Set([
    ...Object.keys(pre.dataStateChain),
    ...Object.keys(post.dataStateChain),
  ]);
  for (const k of dsKeys) {
    const before = pre.dataStateChain[k as unknown as number];
    const after = post.dataStateChain[k as unknown as number];
    if (after && OPEN_STATES.has(after) && before !== after) {
      dataStateOpened = true;
      break;
    }
  }

  return { newInteractive, newVisualInteractive, expandedTriggered, dataStateOpened };
}

/**
 * Convenience predicate — true if the diff shows ANY structural effect we care
 * about.  Centralised so the gate logic in preview.handler stays one boolean.
 *
 * Visual count is the primary signal (catches opacity-revealed affordances).
 * Layout count is kept as a fallback in case opacity probing was unreliable
 * (some browsers report transitional opacity values mid-CSS-transition).
 */
export function hasHoverEffect(diff: HoverEffectDiff): boolean {
  return diff.newVisualInteractive >= 1
    || diff.newInteractive >= 1
    || diff.expandedTriggered
    || diff.dataStateOpened;
}
