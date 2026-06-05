/**
 * Floating corner widget detection — shared, pure, geometry-only.
 *
 * Problem this solves: a small fixed widget pinned to a viewport corner
 * (chat/assistant bubble, support launcher, "back to top", cookie nudge) is
 * NOT a modal — it has no `role=dialog`, no `aria-modal`, and covers far less
 * than the 30% viewport gate `buildAllowedSets` uses for modal background
 * exclusion. So its interactive children leak into the LLM candidate set and
 * compete with the real target. In "Run All" the snapshot is taken before the
 * page settles, so the widget is present and the resolver can pick its buttons
 * ("close hint", "send message") instead of the intended element.
 *
 * Detection is PURE GEOMETRY + W3C signals — no product-name / class-name
 * heuristics (no "intercom" / "crisp" / "AiAssistant" lists). This mirrors how
 * Playwright/Cypress reason about occlusion and the agent-path `obstacleFacts`
 * design: a thing is a floating corner widget because of WHERE and HOW it sits,
 * not WHAT product it is.
 *
 * Single source of truth: both snapshot collectors (the eval-based
 * `snapshot-collector.ts` and the CDP `cdp-snapshot.service.ts`) call
 * `isFloatingCornerWidget` from inside their per-element `page.evaluate`, where
 * `getBoundingClientRect()` and `getComputedStyle().position` are
 * VIEWPORT-relative. That side-steps the document-vs-viewport coordinate
 * hazard (Invariant #18) — we never mix coordinate spaces because the rect is
 * read live in the page. Keeping the rule here, used by both, satisfies the
 * collector-symmetry contract (Invariant #5).
 *
 * Pure / read-only: no DOM mutation, no listeners, no global state.
 *
 * This module is the CANONICAL spec + constants for the rule and is unit-tested
 * directly in Node with synthetic rects. Both collectors evaluate via
 * function-form `page.evaluate` closures (not composed strings), and — like the
 * already-duplicated `computeIsTopMostAtCenter` helper — they inline a tiny
 * geometry copy of this rule rather than serialising this function. The copies
 * MUST stay byte-aligned with `isFloatingCornerWidget` below; the unit test
 * here is the drift guard. Keep the thresholds referenced by name in comments
 * at each inline site so a future change lands in all three places.
 */

/** Viewport-relative rect (what `getBoundingClientRect()` returns). */
export interface WidgetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface WidgetViewport {
  width: number;
  height: number;
}

/**
 * Distance (px) within which a rect edge counts as "hugging" a viewport edge.
 * A real corner widget sits flush against two perpendicular edges with a small
 * gutter (commonly 16–24px). 24px tolerates typical bottom/right offsets while
 * still rejecting elements that merely happen to be near one edge.
 */
export const FLOATING_WIDGET_EDGE_MARGIN_PX = 24;

/**
 * Max viewport-area coverage for a floating widget. Sits BELOW the 0.30 modal
 * blocking gate in `buildAllowedSets` so a real (large, centered) modal is
 * never misread as a widget. A collapsed bubble is ~0.5%; an expanded chat
 * panel is still well under 30%.
 */
export const FLOATING_WIDGET_MAX_COVERAGE = 0.30;

/**
 * Decide whether an element is a floating corner widget purely from geometry.
 *
 * @param rect      viewport-relative bounding rect of the element
 * @param position  computed CSS `position` value
 * @param isModalLike  true if the element is (or is inside) a real modal —
 *                     dialog / alertdialog / aria-modal / active-modal layer.
 *                     A modal is never a widget; callers pass this so the two
 *                     classifications can't overlap.
 * @param viewport  viewport width/height in CSS px
 *
 * Conditions (ALL required):
 *  - `position === 'fixed'` — corner widgets are fixed to the viewport. Sticky
 *    headers/footers are `sticky` and are intentionally NOT widgets; absolute
 *    elements scroll with the page and aren't viewport-pinned launchers.
 *  - not modal-like — never reclassify a dialog as a widget.
 *  - small — coverage strictly below the modal gate.
 *  - corner-anchored — hugs one horizontal AND one vertical viewport edge.
 *    All four corners qualify; bottom-right is the common case.
 */
export function isFloatingCornerWidget(
  rect: WidgetRect,
  position: string,
  isModalLike: boolean,
  viewport: WidgetViewport,
): boolean {
  if (position !== 'fixed') return false;
  if (isModalLike) return false;

  const vw = viewport.width;
  const vh = viewport.height;
  if (!(vw > 0) || !(vh > 0)) return false;
  if (!(rect.width > 0) || !(rect.height > 0)) return false;

  const coverage = (rect.width * rect.height) / (vw * vh);
  if (coverage >= FLOATING_WIDGET_MAX_COVERAGE) return false;

  const m = FLOATING_WIDGET_EDGE_MARGIN_PX;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;

  const hugsLeft = rect.left <= m;
  const hugsRight = right >= vw - m;
  const hugsTop = rect.top <= m;
  const hugsBottom = bottom >= vh - m;

  const hugsHorizontalEdge = hugsLeft || hugsRight;
  const hugsVerticalEdge = hugsTop || hugsBottom;

  return hugsHorizontalEdge && hugsVerticalEdge;
}
