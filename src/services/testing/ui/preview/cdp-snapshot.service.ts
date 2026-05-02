/**
 * CDP Snapshot Service (Etap 2 — Week 2)
 *
 * Hybrid CDP pipeline: gathers raw DOM/styles/layout via
 * `DOMSnapshot.captureSnapshot`, accessibility roles/names via
 * `Accessibility.getFullAXTree`, and runtime fields (framework
 * detection, current input state, contenteditable, :invalid pseudo)
 * via a single batched `page.evaluate`. Output: a `LiteSnapshot`
 * byte-compatible with the existing `SnapshotCollector.collect()`.
 *
 * Why hybrid (not pure CDP):
 *   `DOMSnapshot.captureSnapshot` does NOT return event listeners,
 *   React fiber refs, JS runtime properties (el.checked, el.value,
 *   el.isContentEditable). `DOMDebugger.getEventListeners` doesn't
 *   detect React 17+ synthetic events (single delegated root listener,
 *   real handlers hidden behind framework runtime). Per-element
 *   evaluate would mean N round-trips; we batch into one call.
 *
 * Performance target (verified projection in 01-fields-audit.md):
 *   11k-DOM page: 200ms DS + 200ms AX + 300ms WS transport + 400ms
 *   Node mapping + 400ms batched evaluate ≈ 1.5s. Compare to today's
 *   12-16s. ~10× speedup, 100% field coverage.
 *
 * Skeleton phase (this file):
 *   - Public entry signature locked
 *   - Phase functions stubbed with explicit `throw new Error('TODO …')`
 *   - Caller in SnapshotRouter still falls through to
 *     `SnapshotCollector.collect` (router does NOT call this service yet)
 *   - Implementation lands incrementally in tasks 2.2 through 2.6
 *
 * What this module NEVER does:
 *   - Replace the recorder probe (`PROBE_AT_POINT_FN`) — point-probe
 *     stays unchanged.
 *   - Mutate the DOM beyond writing `data-agent-ref` attributes (one
 *     evaluate that mirrors today's collector behaviour).
 *   - Persist anything — pure read.
 *   - Open new CDP sessions when an existing one is provided
 *     (preview piggyback path, Week 5).
 */

import type { CDPSession, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import type { LiteElement, LiteSnapshot, ObstacleFact, TransientStateInfo } from '@/agent/core/lite/lite-types';
import {
  POSITIONAL_CANDIDATES_SELECTOR,
  IRON_CLAD_MODAL_SELECTORS,
  CLOSE_BUTTON_SELECTOR,
  INTERACTIVE_CHILDREN_SELECTOR,
} from '@/agent/utils/selectors/modal-detection';
import { isDynamicId as isDynamicIdUtil } from './dynamic-id.util';

/**
 * Computed style names requested from `DOMSnapshot.captureSnapshot`.
 * The order is significant — `layout.styles[i]` is a parallel array
 * of indexes into the strings table, in the same order as this list.
 *
 * Picked to cover everything the existing forEach in
 * `snapshot-collector.ts` reads via `getComputedStyle`:
 *   - visibility decision: display / visibility / opacity
 *   - interactivity hints: cursor / pointer-events
 *   - stacking / overlay: position / z-index
 *   - V8 visual matching: background-color / color / border-radius
 *
 * Adding fields later is cheap (Chrome serialises fast); removing
 * requires checking every consumer of `LiteElement.computedZIndex`,
 * `backgroundColor`, etc.
 */
const REQUESTED_COMPUTED_STYLES = [
  'display',
  'visibility',
  'opacity',
  'cursor',
  'pointer-events',
  'position',
  'z-index',
  'background-color',
  'color',
  'border-radius',
] as const;

export interface CdpSnapshotOptions {
  /**
   * Pre-existing CDP session to reuse. Set when piggybacking on the
   * screencast session in preview (Week 5). Avoids
   * `context.newCDPSession()` which would conflict with the singleton
   * `Page.startScreencast` per invariant #3 in preview/CLAUDE.md.
   *
   * When `undefined`, the service opens its own session (safe in
   * background regression — no screencast there).
   */
  existingCdpSession?: CDPSession;
  /** Forwarded for parity with SnapshotCollector. */
  fullPage?: boolean;
  /**
   * When true, skip the DOM stability wait. Used by preview when the
   * caller (`waitForDOMStability` in preview-session) already settled
   * the page. Mirrors `SnapshotCollector.collect({skipStabilityWait})`.
   */
  skipStabilityWait?: boolean;
  /**
   * Caller diagnostic id — propagated into log lines so shadow-mode
   * divergence analysis can correlate by session/run.
   */
  diagId?: string;
}

/**
 * Phase timings — emitted alongside the snapshot for observability.
 * Mirrors the structure already present on snapshot-collector results
 * (`__debugStats`) so dashboards can compare.
 */
export interface CdpPhaseTimings {
  domSnapshotMs: number;
  axTreeMs: number;
  cdpParallelMs: number; // wall-clock: max(domSnapshot, axTree)
  mappingMs: number;
  runtimeEvaluateMs: number;
  modalDetectionMs: number;
  /**
   * Phase 5b — transientState + obstacleFacts + Layer 2 modal fallback,
   * single batched evaluate. Typical: 30-80ms on dense pages (one round-
   * trip + getComputedStyle on positioned candidates only).
   */
  overlayStateMs: number;
  totalMs: number;
}

/**
 * Hard cap on raw DOMSnapshot JSON size. Pages above this threshold
 * blow the WS pipe (~5-10MB is acceptable, 20MB+ starts hiccuping the
 * screencast in preview piggyback path) and serialised mapping in
 * Node burns CPU long enough that fallback to evaluate is faster.
 *
 * The cap is approximate — measured on `JSON.stringify(domSnapshot)`
 * length once received. We don't reject the call mid-stream; CDP
 * returns the full payload first, then we measure and decide whether
 * to throw and let the router fall back.
 *
 * 20MB chosen from audit projection: 11k-DOM page produces ~5-10MB.
 * 2× headroom catches outliers (deeply nested SVG / huge stylesheets)
 * without false-positives on legitimate dense pages.
 */
const DOM_SNAPSHOT_PAYLOAD_LIMIT_BYTES = 20 * 1024 * 1024;

/**
 * Memoised "we already warned about Accessibility domain being
 * unavailable" flag — keyed by Chromium build id so a fresh container
 * re-emits the warning. Avoids logging once per snapshot when an
 * older Chromium genuinely doesn't expose the domain.
 *
 * Module-level Map — process-lifetime memoisation. Acceptable because
 * Chromium build id is fixed per process.
 */
const axDomainWarnedFor = new Set<string>();

/**
 * Errors we throw for the router fallback path. Caller (router)
 * MUST treat any thrown error as a fallback signal — not as success.
 *
 * Categorised for shadow-mode metrics: when CDP path fails, we want
 * to know WHY in aggregate, not log a generic "CDP failed".
 */
export type CdpSnapshotFailureKind =
  /** Page navigated mid-call, target document gone. */
  | 'page_gone'
  /** DOMSnapshot returned, but JSON exceeds payload limit. */
  | 'cdp_payload_too_large'
  /** Accessibility domain unavailable on this Chromium build. */
  | 'ax_domain_unavailable'
  /** CDP send rejected (general — connection drop, frame detach). */
  | 'cdp_send_failed'
  /** Returned data malformed (no `documents` array). */
  | 'malformed_response';

export class CdpSnapshotError extends Error {
  constructor(public readonly kind: CdpSnapshotFailureKind, message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'CdpSnapshotError';
  }
}

/**
 * Internal type — raw CDP data plus derived helpers passed between
 * phase functions. Not exported because consumers should treat this
 * service as a black box that returns `LiteSnapshot`.
 */
interface RawCdpBundle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  domSnapshot: any; // Protocol.DOMSnapshot.CaptureSnapshotResponse
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  axTree: any;      // Protocol.Accessibility.GetFullAXTreeResponse
}

// ─────────────────────────────────────────────────────────────────
// Mapping helpers (Phase 3a/3b building blocks)
//
// These live above the class because they're pure functions over
// DS shape — easier to unit-test in isolation, and the class
// methods stay focused on orchestration.
// ─────────────────────────────────────────────────────────────────

/** Decoded HTML attributes as plain key→value map. */
type DecodedAttrs = Map<string, string>;

/**
 * DS attributes are stored as a flat array of alternating
 * `[nameStringIdx, valueStringIdx, nameStringIdx, valueStringIdx, ...]`.
 * Decode into a Map for ergonomic lookup downstream.
 */
function decodeAttributes(rawAttrs: unknown, getStr: (idx: number) => string): DecodedAttrs {
  const out: DecodedAttrs = new Map();
  if (!Array.isArray(rawAttrs)) return out;
  for (let i = 0; i + 1 < rawAttrs.length; i += 2) {
    const name = getStr(rawAttrs[i]).toLowerCase();
    const value = getStr(rawAttrs[i + 1]);
    if (!name) continue;
    out.set(name, value);
  }
  return out;
}

/**
 * Decoded computed styles, one entry per `REQUESTED_COMPUTED_STYLES` slot.
 * Indexes match the order we passed to DOMSnapshot.captureSnapshot.
 */
type DecodedStyles = {
  display: string;
  visibility: string;
  opacity: string;
  cursor: string;
  pointerEvents: string;
  position: string;
  zIndex: string;
  backgroundColor: string;
  color: string;
  borderRadius: string;
};

/**
 * `layout.styles[i]` is a flat array of string indexes, parallel to
 * REQUESTED_COMPUTED_STYLES. Decode into named fields.
 */
function decodeStylesForLayoutIdx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layout: any,
  layoutIdx: number,
  getStr: (idx: number) => string,
): DecodedStyles | undefined {
  const stylesArr: number[][] | undefined = layout.styles;
  if (!Array.isArray(stylesArr)) return undefined;
  const slot = stylesArr[layoutIdx];
  if (!Array.isArray(slot)) return undefined;
  // Order MUST match REQUESTED_COMPUTED_STYLES.
  return {
    display: getStr(slot[0]),
    visibility: getStr(slot[1]),
    opacity: getStr(slot[2]),
    cursor: getStr(slot[3]),
    pointerEvents: getStr(slot[4]),
    position: getStr(slot[5]),
    zIndex: getStr(slot[6]),
    backgroundColor: getStr(slot[7]),
    color: getStr(slot[8]),
    borderRadius: getStr(slot[9]),
  };
}

/**
 * Bounds are a flat `[x, y, width, height]` array per layout slot.
 */
function decodeBoundsForLayoutIdx(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  layout: any,
  layoutIdx: number,
): { x: number; y: number; width: number; height: number } | undefined {
  const bounds = layout.bounds;
  if (!Array.isArray(bounds)) return undefined;
  const b = bounds[layoutIdx];
  if (!Array.isArray(b) || b.length < 4) return undefined;
  return { x: b[0], y: b[1], width: b[2], height: b[3] };
}

/**
 * Tags considered structurally interactive without further checks.
 * Mirrors the Tier-1 selector set the SnapshotCollector emits today.
 */
// Mirrors evaluate-path's `interactiveSelectors` core list. NOTE:
// `label` deliberately excluded — evaluate-path doesn't treat <label>
// as interactive (the input it labels is what users click). Including
// it in CDP made shadow-mode show CDP returning 2 extra elements
// per form (one per <label>), all of which the resolver would never
// pick. `summary`/`details` likewise dropped — evaluate handles them
// via separate `summary` selector entry below in tier-1 supplements.
const INTERACTIVE_TAGS = new Set([
  'button', 'a', 'input', 'select', 'textarea',
  'option',
]);

/**
 * ARIA roles considered interactive (Tier-1 supplement). Native tag
 * coverage above already gets `role=button` etc. for free, but custom
 * `<div role="button">` needs this list.
 */
const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'option', 'treeitem',
  'row', 'cell', 'gridcell', 'columnheader', 'rowheader',
  'switch', 'checkbox', 'radio', 'combobox', 'listbox',
  'menu', 'searchbox', 'spinbutton', 'slider', 'textbox',
]);

/**
 * Filter: is this DS node interactive enough to keep in the
 * LiteElement output? Two-tier:
 *   1. Native interactive tag → keep
 *   2. Has interactive ARIA role → keep
 *   3. Has tabindex >= 0 → keep
 *   4. Has cursor:pointer → keep (Tier-2; framework div with onClick)
 *
 * Symmetry contract: matches snapshot-collector Tier-1+Tier-2 filter
 * so both sources see the same population. Drift here causes
 * shadow-mode false-positives.
 */
/**
 * Tier-1 interactive node check — strong, deterministic signals that
 * an element is a known interactive control. No cap; every Tier-1 hit
 * is included.
 *
 * MUST stay symmetric with the evaluate-path's `interactiveSelectors`
 * array in snapshot-collector.ts (~line 763). When evaluate adds a new
 * selector and we don't, CDP path silently skips that element class —
 * happens silently because the shadow-mode diff lists it under
 * `onlyInEvaluate`.
 */
function isInteractiveNodeTier1(
  tagName: string,
  attrs: DecodedAttrs,
): boolean {
  // Native interactive HTML elements
  if (INTERACTIVE_TAGS.has(tagName)) return true;

  // Semantic structural tags evaluate-path includes
  if (tagName === 'li' || tagName === 'canvas') return true;
  if (tagName === 'h1' || tagName === 'h2' || tagName === 'h3') return true;
  if (tagName === 'summary') return true;

  // ARIA widget roles
  const role = attrs.get('role')?.toLowerCase();
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  // Additional roles from evaluate-path's interactiveSelectors
  if (role === 'menuitemcheckbox' || role === 'menuitemradio'
      || role === 'alertdialog' || role === 'toolbar') {
    return true;
  }

  // tabindex >= 0 (focusable via keyboard)
  const tabindex = attrs.get('tabindex');
  if (tabindex !== undefined && tabindex !== '-1') {
    const n = parseInt(tabindex, 10);
    if (!isNaN(n) && n >= 0) return true;
  }

  // Attribute-based interactive signals (no role / no native tag,
  // but framework-bound or test-targeted).
  if (attrs.has('onclick')) return true;
  if (attrs.has('data-testid') || attrs.has('data-test') || attrs.has('data-test-id')
      || attrs.has('data-cy') || attrs.has('data-qa')) return true;
  if (attrs.has('data-toggle') || attrs.has('aria-haspopup')) return true;
  if (attrs.get('draggable') === 'true') return true;
  if (attrs.has('contenteditable')) {
    const v = attrs.get('contenteditable');
    if (v === 'true' || v === '') return true;
  }

  // Native <dialog open>
  if (tagName === 'dialog' && attrs.has('open')) return true;

  // Framework-specific event attribute markers
  // (Alpine.js x-on:click, HTMX hx-*, Stimulus data-action,
  //  Knockout data-bind, Qwik on:click)
  if (attrs.has('x-on:click') || attrs.has('on:click')) return true;
  if (attrs.has('hx-get') || attrs.has('hx-post') || attrs.has('hx-put')
      || attrs.has('hx-delete') || attrs.has('hx-patch')) return true;
  if (attrs.has('data-hx-get') || attrs.has('data-hx-post')) return true;
  if (attrs.has('data-action') || attrs.has('data-bind')) return true;

  return false;
}

/**
 * Icon-ish secondary pass check — element is an SVG/i/img/path with
 * a stable id or testid, even though it has no interactive role.
 * Mirrors evaluate-path's secondary pass at snapshot-collector.ts
 * ~line 1126. Critical for icon-only buttons / branded logos that
 * don't have role=button but DO have stable id (e.g. `<img id="logo">`).
 *
 * Without this, recorder records `<img id="logo">` with id, recorder
 * resolver tries identity fast-path on id="logo", but CDP snapshot
 * doesn't include the img → no match → fallback to LLM → wrong CTA.
 */
function isInteractiveIconish(
  tagName: string,
  attrs: DecodedAttrs,
): boolean {
  if (tagName !== 'svg' && tagName !== 'i' && tagName !== 'img' && tagName !== 'path') {
    return false;
  }
  const rawId = attrs.get('id') || '';
  const idLooksGenerated = !!rawId && (
    /^el-id-/i.test(rawId)
    || /^radix-/.test(rawId)
    || /^:r[0-9a-z]+:$/i.test(rawId)
    || /^mui-/i.test(rawId)
    || /^headlessui-/i.test(rawId)
    || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(rawId)
  );
  const hasStableId = !!rawId && !idLooksGenerated && rawId.length < 80;
  const hasTestIdAttr = attrs.has('data-testid')
    || attrs.has('data-test-id')
    || attrs.has('data-test')
    || attrs.has('data-cy')
    || attrs.has('data-qa');
  return hasStableId || hasTestIdAttr;
}

/**
 * Tier-2 interactive node check — cursor:pointer signals a
 * framework-bound clickable (React onClick on a div, Vue @click on
 * span, etc.). Critically: this MUST be capped, otherwise a page
 * with global `cursor:pointer` CSS rule (or app-wide hover effect)
 * floods the snapshot with thousands of false-positive children
 * (every <i>, <span> in a button gets included). Evaluate path uses
 * MAX_SECONDARY_ELEMENTS = 300; we mirror that.
 *
 * Why this matters in production:
 *   On a 5000-button toolbar where each button has 2 child elements
 *   inheriting cursor:pointer, an UNCAPPED Tier-2 returns 15000+
 *   elements. Phase 3.5 / Phase 4 then run per-element work on each
 *   one — dense pages become 30× SLOWER than evaluate path
 *   (measured: 6.5s CDP vs 0.7s evaluate on a 5000-button synthetic).
 *   The cap keeps us at parity with evaluate-path semantics.
 */
function isInteractiveNodeTier2(
  styles: DecodedStyles | undefined,
): boolean {
  return styles?.cursor === 'pointer';
}

/**
 * @deprecated Use isInteractiveNodeTier1/Tier2 directly so the caller
 * can apply a cap to Tier-2 hits. Kept as a thin wrapper for
 * backwards-compat in tests.
 */
function isInteractiveNode(
  tagName: string,
  attrs: DecodedAttrs,
  styles: DecodedStyles | undefined,
): boolean {
  return isInteractiveNodeTier1(tagName, attrs) || isInteractiveNodeTier2(styles);
}

/** Symmetric cap with evaluate-path's MAX_SECONDARY_ELEMENTS. */
const MAX_TIER2_ELEMENTS = 300;

/**
 * Hard cap on TOTAL elements returned (Tier-1 + Tier-2 combined).
 * Mirrors `MAX_INTERACTIVE_NODES = 500` in `dom-analysis-extractor.service.ts`,
 * which is the effective limit downstream consumers see anyway. Clipping
 * here saves Phase 3.5/4/3c-Eval per-element work on the ~80% of
 * elements that would just be discarded by the extractor — on a 5000-
 * button toolbar, that's the difference between 3.5s and ~600ms.
 */
const MAX_TOTAL_ELEMENTS = 500;

/**
 * Build a `LiteElement` from a single DS node + its AX cross-reference.
 *
 * What we DO populate here (Phase 3b — direct from raw):
 *   - tag, type, role, name, accessible name
 *   - HTML attributes (id, name, placeholder, title, etc.)
 *   - bounds, computedZIndex, isPositioned
 *   - visible (derived from styles)
 *   - href (raw — absolute URL resolution requires page context;
 *     consumers tolerate relative href today)
 *
 * What we DON'T populate here (later phases):
 *   - ref (Phase 3.5 batched evaluate writes data-agent-ref)
 *   - parentRefChain / containerTitles (Phase 3c needs refs assigned
 *     first, then walks DS parentIndex)
 *   - frameworkClickable / runtime fields (Phase 4 evaluate)
 *   - isInsideActiveModal (Phase 5 detection)
 *   - icon detection / firstTextFragment / nearestRowText (Phase 3c
 *     ancestor walks; same data already in raw, just postprocess)
 */
function buildLiteElementFromNode(args: {
  tagName: string;
  attrs: DecodedAttrs;
  bounds: { x: number; y: number; width: number; height: number };
  styles: DecodedStyles | undefined;
  axNode: unknown;
  dsNodeIndex: number;
  docIndex: number;
}): LiteElement {
  const { tagName, attrs, bounds, styles, axNode } = args;

  // Implicit role from AX takes priority — Chrome's accessibility
  // engine has the canonical implementation. Fallback: explicit
  // role attribute. If neither, leave empty — buildAllowedSets
  // tolerates missing role for native tags via tag map.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axRole = (axNode as any)?.role?.value as string | undefined;
  const explicitRole = attrs.get('role') ?? undefined;
  const role = (axRole || explicitRole || '').toLowerCase();

  // Accessible name from AX. Per WAI-ARIA spec, AX `name` already
  // applied the full label cascade (aria-labelledby > aria-label >
  // label > placeholder > title > text content), so we don't repeat
  // it here. Empty string is meaningful — "AX engine declared this
  // element nameless"; don't synthesise.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const axName = ((axNode as any)?.name?.value as string | undefined) ?? '';

  // Visibility — display/visibility/opacity gate. Same logic as today.
  const visible = !!styles
    && styles.display !== 'none'
    && styles.visibility !== 'hidden'
    && parseFloat(styles.opacity || '1') > 0;

  // computedZIndex — null when 'auto'/non-numeric (matches LiteElement).
  let computedZIndex: number | null | undefined;
  if (styles?.zIndex && styles.zIndex !== 'auto') {
    const z = parseInt(styles.zIndex, 10);
    computedZIndex = isNaN(z) ? null : z;
  } else if (styles) {
    computedZIndex = null;
  }

  // ── Identity fields (Q5 audit fix May 2026) ────────────────────
  // Identity fast-path in element-resolver (preview-step-apply.service)
  // requires `id`, `testIdAttr`, AND `isDynamicId` populated on every
  // element. The recorder probe + evaluate-path collector both fill
  // these; CDP path was dropping them silently. Without them:
  //   - identity_id / identity_testid resolverPaths NEVER fire on CDP
  //   - locator-plan-builder loses id/testId strategies (line ~220-237)
  //   - compiled-plan match scoring loses 2 of its strongest signals
  // Filtered through shared `isDynamicId()` util — same regex as
  // recorder, fingerprint, and locator-plan-builder. Bytewise symmetry.
  const rawId = attrs.get('id') || '';
  const idIsDynamic = rawId ? isDynamicIdUtil(rawId) : false;
  const stableId = (rawId && !idIsDynamic && rawId.length < 80) ? rawId : undefined;
  const testIdAttr = attrs.get('data-testid')
    || attrs.get('data-test-id')
    || attrs.get('data-test')
    || attrs.get('data-cy')
    || attrs.get('data-qa')
    || attrs.get('data-test-element')
    || attrs.get('data-track')
    || undefined;

  const el: LiteElement = {
    // ref intentionally empty here — Phase 3.5 fills it via batched
    // DOM write. Consumers MUST NOT rely on ref before Phase 3.5
    // completes; mapping is internal.
    ref: '',
    role,
    name: axName,
    tag: tagName,
    visible,
    // Identity fields — see Q5 block above. `id` is stable-only
    // (dynamic generated IDs filtered out); `testIdAttr` covers all
    // common test-id conventions; `isDynamicId` exposes the
    // determination so consumers don't re-run the regex.
    id: stableId,
    testIdAttr,
    isDynamicId: idIsDynamic || undefined,
    type: attrs.get('type') || undefined,
    placeholder: attrs.get('placeholder') || undefined,
    autocomplete: attrs.get('autocomplete') || undefined,
    // ═══════════════════════════════════════════════════════════════
    // Phase 3c-DS — fields the existing collector reads via
    // attributes/styles only. Filling them here avoids paying for an
    // evaluate round-trip in Phase 4. Symmetry with snapshot-collector
    // — these implementations mirror the in-page logic byte-for-byte.
    // ═══════════════════════════════════════════════════════════════
    //
    // contenteditable: spec says empty string === 'true' (legacy
    // default behaviour), so both 'true' and '' enable editing.
    isContentEditable:
      attrs.get('contenteditable') === 'true' || attrs.get('contenteditable') === ''
        ? true
        : undefined,
    // onclick attribute presence — the SnapshotCollector counterpart.
    // This DOES NOT detect React synthetic onClick (that requires
    // runtime fiber introspection in Phase 4). Same gap as today.
    hasOnclick: attrs.has('onclick') || undefined,
    // Framework detection split into two halves:
    //   - Attribute-based frameworks (Alpine, HTMX, Stimulus,
    //     Knockout, Qwik) → derived in Node from DS attrs.
    //   - JS-runtime frameworks (React, Vue, Angular, Svelte,
    //     jQuery) → require Phase 4 evaluate.
    // We populate the attribute half here. Phase 4 will OVERRIDE
    // when a JS-runtime framework is detected on the same element
    // (React's runtime presence is more authoritative than an
    // attribute heuristic on a wrapper element).
    frameworkClickable: detectAttributeBasedFramework(attrs),
    inputmode: attrs.get('inputmode') || undefined,
    htmlName: attrs.get('name') || undefined,
    htmlId: attrs.get('id') || undefined,
    ariaLabel: attrs.get('aria-label') || undefined,
    title: attrs.get('title') || undefined,
    ariaCurrent: attrs.get('aria-current') || undefined,
    ariaValueText: attrs.get('aria-valuetext') || undefined,
    dataValue: attrs.get('data-value') || undefined,
    bsToggle: attrs.get('data-bs-toggle') || undefined,
    bsTarget: attrs.get('data-bs-target') || undefined,
    ariaHasPopup: attrs.get('aria-haspopup') || undefined,
    ariaActiveDescendant: attrs.get('aria-activedescendant') || undefined,
    dataRowKey: attrs.get('data-row-key') || undefined,
    href: tagName === 'a' ? attrs.get('href') || undefined : undefined,
    // ARIA boolean states — DS attributes are strings ('true'/'false');
    // normalise to boolean | undefined so downstream consumers don't
    // re-parse.
    ariaExpanded: parseTriState(attrs.get('aria-expanded')),
    ariaPressed: parseTriState(attrs.get('aria-pressed')),
    ariaSelected: parseTriState(attrs.get('aria-selected')),
    // ariaChecked supports 'mixed' as a third state.
    ariaChecked: parseAriaChecked(attrs.get('aria-checked')),
    required: attrs.has('required'),
    // readOnly: attribute presence + aria-readonly. Runtime fallback
    // (el.readOnly programmatic) lands in Phase 4 enrichment.
    readOnly: attrs.has('readonly') || attrs.get('aria-readonly') === 'true',
    // ariaValueNow: attribute path; native-input fallback (range/number)
    // handled by Phase 4 since it requires runtime el.value.
    ariaValueNow: parseFloatOrUndefined(attrs.get('aria-valuenow')),
    // tabIndex from attribute; runtime fallback for focusable elements
    // without explicit attr lands in Phase 4.
    tabIndex: parseTabIndex(attrs.get('tabindex')),
    hasAriaHaspopup: attrs.has('aria-haspopup'),
    bounds,
    computedZIndex,
    isPositioned: styles ? styles.position !== 'static' : undefined,
    backgroundColor: styles?.backgroundColor || undefined,
    textColor: styles?.color || undefined,
    borderRadius: styles?.borderRadius || undefined,
  };

  // Stash internal indexes for ancestry / shadow walks in Phase 3c.
  // Stripped before LiteSnapshot leaves the service.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any).__dsNodeIndex = args.dsNodeIndex;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (el as any).__docIndex = args.docIndex;

  return el;
}

/** Parse 'true'/'false'/etc. to boolean | undefined. */
function parseTriState(v: string | undefined): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** aria-checked extra: 'mixed' state. */
function parseAriaChecked(v: string | undefined): boolean | 'mixed' | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'mixed') return 'mixed';
  return undefined;
}

function parseFloatOrUndefined(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = parseFloat(v);
  return isNaN(n) ? undefined : n;
}

/**
 * tabindex parsing — only return when present and parseable.
 * `LiteElement.tabIndex` consumers (buildAllowedSets) check for
 * `>= 0`, so we preserve negative explicit values too.
 */
function parseTabIndex(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  return isNaN(n) ? undefined : n;
}

/**
 * Implicit landmark role for HTML5 sectioning tags. Mirrors the WAI
 * mapping (`<header>` → 'banner' when top-level, etc.). Simplified
 * here — we treat tag → role 1:1 without contextual rules (top-level
 * vs nested header) because consumer reads it as a hint, not a
 * definitive role.
 */
function tagToImplicitLandmarkRole(tag: string): string | undefined {
  switch (tag) {
    case 'header': return 'banner';
    case 'footer': return 'contentinfo';
    case 'nav': return 'navigation';
    case 'main': return 'main';
    case 'aside': return 'complementary';
    case 'form': return 'form';
    default: return undefined;
  }
}

/**
 * Compute `isSensitiveInput` flag in Node from element fields already
 * mapped in Phase 3b. Mirrors the existing snapshot-collector logic
 * around `~line 1689` (SENSITIVE_AUTOCOMPLETE + name/id regex). We
 * keep the regex inline rather than imported because:
 *   - the in-page collector duplicates it inline anyway (it can't
 *     import from Node)
 *   - drift between paths is exactly what we audit in shadow mode;
 *     pulling from a shared util would HIDE drift behind one
 *     refactor that touches both files
 *
 * Privacy contract: any change to this function MUST land alongside
 * the in-page equivalent in snapshot-collector.ts. A false-negative
 * here means a password value gets `hasValue: true` reported through
 * the WS pipe — never raw, but presence-leak.
 */
function computeIsSensitiveInput(el: LiteElement): boolean {
  if (el.tag !== 'input' && el.tag !== 'textarea' && el.tag !== 'select') return false;
  if (el.type === 'password') return true;

  // Tokenise autocomplete the same way as the in-page collector
  // (HTML spec uses space-separated tokens; e.g. `current-password`).
  const autocompleteTokens = new Set(
    (el.autocomplete || '').toLowerCase().split(/\s+/).filter(Boolean),
  );
  const SENSITIVE_AUTOCOMPLETE = ['password', 'current-password', 'new-password', 'username', 'email', 'tel', 'phone'];
  if (SENSITIVE_AUTOCOMPLETE.some((s) => autocompleteTokens.has(s))) return true;

  // Name/id regex — same patterns as snapshot-collector. Two sets:
  //   credential-shaped (password / secret) → match
  //   identity-shaped (user / login / email / phone) → match
  // Combined into one regex per field to halve test count.
  const nameAttr = el.htmlName || '';
  const idAttr = el.htmlId || '';
  const SENSITIVE_NAME_RE = /password|passwd|pwd|secret|credential|user|username|login|email|phone|tel|mobile/i;
  if (SENSITIVE_NAME_RE.test(nameAttr) || SENSITIVE_NAME_RE.test(idAttr)) return true;

  return false;
}

/**
 * Framework detection from HTML attributes alone — no JS runtime
 * required. Mirrors the `if (el.hasAttribute('x-data') ...)` block in
 * snapshot-collector's `frameworkClickable` IIFE. Phase 4 will run a
 * second pass to detect JS-runtime frameworks (React fiber / Vue /
 * Angular / Svelte / jQuery) and OVERRIDE the result here when it
 * finds a stronger signal — runtime presence wins over attribute hint
 * because a `<div hx-get="..." onClick={reactHandler}>` is more
 * authoritatively React than HTMX from a behavioural standpoint.
 *
 * Symmetry: the order and exact regex shapes match the existing
 * collector. Drift here means buildAllowedSets behaves differently
 * between CDP and evaluate paths — caught by shadow-mode diff in
 * Week 3, but cheaper to get right now.
 */
function detectAttributeBasedFramework(attrs: DecodedAttrs): LiteElement['frameworkClickable'] {
  // Alpine: x-data root marker, x-on:click directive, @click shorthand.
  if (attrs.has('x-data') || attrs.has('x-on:click') || attrs.has('@click')) {
    return 'alpine';
  }
  // HTMX: hx-* and data-hx-* directives.
  if (
    attrs.has('hx-get') || attrs.has('hx-post') || attrs.has('hx-put')
    || attrs.has('hx-delete') || attrs.has('hx-patch')
    || attrs.has('data-hx-get') || attrs.has('data-hx-post')
  ) {
    return 'htmx';
  }
  // Stimulus: `data-action="event->controller#method"` shape.
  const dataAction = attrs.get('data-action');
  if (dataAction && /\w+->\w+#\w+/.test(dataAction)) {
    return 'stimulus';
  }
  // Knockout: data-bind with click/event/submit/value.
  const dataBind = attrs.get('data-bind');
  if (dataBind && /click\s*:|event\s*:|submit\s*:|value\s*:/.test(dataBind)) {
    return 'knockout';
  }
  // Qwik: `on:click$` / `onClick$` style attributes (compiled).
  // Iterate attribute keys — DecodedAttrs already lowercased names.
  for (const name of attrs.keys()) {
    // Qwik's compiled output uses `on:`/`on$`/`onCamelCase$`. Browser
    // normalises attribute names to lowercase, so we lose the
    // mixed-case `onClick$` form here — but `on:click` and `on$click`
    // survive and are the more common Qwik output. Acceptable
    // documented limitation.
    if (/^on[:$]/.test(name)) return 'qwik';
  }
  return undefined;
}

export class CdpSnapshotService {
  /**
   * Collect a `LiteSnapshot` via the CDP hybrid pipeline.
   *
   * Throws on any unrecoverable error — the SnapshotRouter catches and
   * falls back to `SnapshotCollector.collect`. The router NEVER hides
   * the error from logs; it is the single place that decides what to
   * do about it.
   */
  static async collect(
    page: Page,
    options: CdpSnapshotOptions = {},
  ): Promise<LiteSnapshot> {
    const startedAt = Date.now();
    const diagId = options.diagId;

    // Phase 0: acquire CDP session.
    // - existingCdpSession path is intentionally first — when caller
    //   provides a session (preview piggyback) we MUST not open a new
    //   one (would race with screencast).
    // - new-session path opens a session and detaches in `finally` so
    //   the browser-side handle is released; missing this is the
    //   classic "CDP sessions accumulate, browser slows down" leak.
    const cdp = options.existingCdpSession ?? await page.context().newCDPSession(page);
    const ownsCdpSession = options.existingCdpSession === undefined;

    try {
      // Phase 1: optional stability wait. Skipped when the caller
      // already settled the page (e.g. preview-session.waitForDOMStability).
      // TODO Task 2.2: import VisualStability and call waitForStable
      // when !skipStabilityWait. Until then, behaviour matches the
      // current SnapshotCollector skip-path.

      // Phase 2: parallel CDP requests. Both calls hit the same WS
      // pipe but Chrome processes them concurrently — wall time is
      // max(DS, AX), not sum. This is the only point where we eat
      // the CDP round-trip cost — measure it precisely.
      const cdpStart = Date.now();
      const raw = await this.fetchRawBundle(cdp, diagId);
      const cdpParallelMs = Date.now() - cdpStart;
      // Per-call latencies stashed by fetchRawBundle for observability.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsMs = (raw.domSnapshot as any).__dsMs ?? 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const axMs = (raw as any).__axMs ?? 0;

      // Phase 3: Node-side mapping (DOMSnapshot + AXTree → LiteElement[]).
      // Pure CPU work in Node — no further round trips. Most of the
      // existing `snapshot-collector.ts` logic that derives fields
      // from raw DOM (text walks, ancestor chains, parent class
      // tokens, container titles, modal heuristics) lives here.
      const mappingStart = Date.now();
      const elements = this.mapToLiteElements(raw);
      const mappingMs = Date.now() - mappingStart;

      // Phase 3.5: assign data-agent-ref attributes via single
      // page.evaluate. Required BEFORE Phase 4 because Phase 4 queries
      // elements by `[data-agent-ref="…"]` selectors. Reuses the
      // existing window.__agentRefCounter + __agentFingerprintMap so
      // refs are STABLE across React re-renders and snapshots — the
      // same invariant `evidence.lastSuccessRef` depends on. If we
      // generated fresh refs on every CDP collect, the evidence
      // shortcut would break for every step on every replay.
      const refAssignStart = Date.now();
      await this.assignAgentRefs(page, elements);
      const refAssignMs = Date.now() - refAssignStart;

      // Phase 3c-Node: ancestry walks over DS parentIndex (no extra
      // round-trip). Populates parentRefChain, containerTitles,
      // nearestLandmark, isInsideShadowDOM/depth/slotName. These rely
      // entirely on DS data + refs already assigned in Phase 3.5.
      this.populateAncestryFieldsFromDs(elements, raw);

      // Phase 4: batched runtime enrichment (single page.evaluate).
      // Per audit, the unavoidable EVAL fields are:
      //   frameworkClickable / value / hasValue / checked /
      //   isContentEditable / invalid / hasOnclick / runtime fallbacks
      //   for disabled & readOnly.
      // One evaluate over all refs keeps it ~200-500ms on 11k DOM.
      const evalStart = Date.now();
      await this.enrichWithRuntimeFields(page, elements);
      const runtimeEvaluateMs = Date.now() - evalStart;

      // Phase 3c-Eval: DOM-walking fields that DS+Node CANNOT compute
      // cheaply (firstTextFragment text-node walks, isIconButton
      // cloneNode trick, labelText label[for=]/wrapping resolution,
      // nearestRowText sibling cell concat). Single batched evaluate.
      // Runs AFTER Phase 4 so frameworkClickable runtime override
      // already settled — this evaluate doesn't touch that field.
      const ancestryEvalStart = Date.now();
      await this.enrichWithDomWalkFields(page, elements);
      const ancestryEvalMs = Date.now() - ancestryEvalStart;
      logger.debug('[CDP_SNAPSHOT] Ancestry-eval phase', {
        diagId,
        ancestryEvalMs,
        elementCount: elements.length,
      });
      // Roll Phase 3.5 cost into the same bucket as Phase 4 for the
      // public timings — both are page.evaluate round-trips, distinct
      // from CDP. Adding a third bucket would require LiteSnapshot
      // type change for marginal observability gain.
      void refAssignMs; // tracked separately in debug log only
      logger.debug('[CDP_SNAPSHOT] Ref assignment phase', {
        diagId,
        refAssignMs,
        elementCount: elements.length,
      });

      // Phase 5: modal/active-overlay detection.
      // Same 4-rule heuristic as today, but applied in Node post-process
      // because all signals (role, aria-modal, dialog[open], z-index,
      // bbox coverage, class regex) are already in `raw` + `elements`.
      // This phase also writes `LiteSnapshot.activeModalRef` and the
      // per-element `isInsideActiveModal` flag.
      const modalStart = Date.now();
      let activeModalRef = this.detectModalsInPlace(elements, raw);
      const modalDetectionMs = Date.now() - modalStart;

      // Phase 5b: overlay state — transientState + obstacleFacts +
      // Layer 2 modal positional fallback. Single batched evaluate.
      // Runs AFTER Layer 1 modal so we can pass the already-detected
      // ref and skip Layer 2 work when iron-clad signals already won.
      const overlayStart = Date.now();
      const overlayState = await this.enrichWithOverlayState(page, activeModalRef);
      const overlayStateMs = Date.now() - overlayStart;
      // Promotion order (most-trusted signal wins):
      //   1. Phase 5 Node-side bestRef (modal IS in interactive set —
      //      already in `activeModalRef`).
      //   2. Phase 5b layer1ModalRef rescue (modal exists in DS but
      //      wasn't interactive; evaluate found + assigned ref).
      //   3. Phase 5b layer2ModalRef positional fallback.
      //
      // Iron-clad ARIA always beats positional heuristics — so layer1
      // rescue is checked BEFORE layer2 promotion.
      if (!activeModalRef && overlayState.layer1ModalRef) {
        activeModalRef = overlayState.layer1ModalRef;
      }
      if (!activeModalRef && overlayState.layer2ModalRef) {
        activeModalRef = overlayState.layer2ModalRef;
      }

      // Phase 6: assemble final LiteSnapshot.
      const totalMs = Date.now() - startedAt;
      const phaseTimings: CdpPhaseTimings = {
        domSnapshotMs: dsMs,
        axTreeMs: axMs,
        cdpParallelMs,
        mappingMs,
        runtimeEvaluateMs,
        modalDetectionMs,
        overlayStateMs,
        totalMs,
      };

      // Strip internal stash (`__dsNodeIndex`, `__docIndex`) before
      // returning — they were used by Phase 3c-Node and Phase 5 walks
      // and must not leak into consumers (LiteElement type doesn't
      // expose them, but they exist on the object via `as any` casts).
      // Cleanup is in-place: same array, no allocation.
      for (const el of elements) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__dsNodeIndex;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        delete (el as any).__docIndex;
      }

      const snapshot: LiteSnapshot = {
        url: page.url(),
        title: await page.title().catch(() => ''),
        elements,
        timestamp: Date.now(),
        activeModalRef,
        // viewport intentionally read from page.viewportSize() — same as
        // the evaluate path. Kept here so buildAllowedSets gets accurate
        // modal-coverage ratio without falling back to bbox high-water
        // mark heuristic.
        viewport: page.viewportSize() ?? undefined,
        // Phase 5b artefacts. `transientState` always present (defaults
        // to `{isTransient: false}` when nothing matched) so consumers
        // can rely on the field's existence; `obstacleFacts` undefined
        // when empty (matches evaluate-path semantics).
        transientState: overlayState.transientState ?? { isTransient: false },
        obstacleFacts: overlayState.obstacleFacts,
      };

      // Stash phase timings on the snapshot for offline analysis.
      // Same pattern as snapshot-collector's `__debugStats`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (snapshot as any).__cdpPhaseTimings = phaseTimings;

      // Final summary at DEBUG level — every successful CDP snapshot
      // would otherwise emit TWO info logs (`[CDP_SNAPSHOT] Collected`
      // here + `[SNAPSHOT_ROUTER] Collected` upstream). On preview-tick
      // (~2 calls/sec) that's 7000+ lines/hour per worker — log
      // aggregation choking. The router-level log already surfaces
      // `source: 'cdp'` + `durationMs` for operators; this richer
      // payload (timings/shape/runtime stats) lives at debug for
      // post-hoc deep dives. Bump to info temporarily when investigating
      // a specific incident via per-process LOG_LEVEL=debug. Includes:
      //   - timings: per-phase + total wall-clock
      //   - shape coverage: counts of populated load-bearing fields
      //     (transientState/obstacleFacts/activeModalRef + runtime fields)
      //   - sample of populated runtime fields so we can spot regressions
      //     at-a-glance (e.g., `frameworkClickable: 0/450` → all missing)
      const runtimeStats = elements.reduce(
        (acc, el) => {
          if (el.frameworkClickable !== undefined) acc.frameworkClickable++;
          if (el.checked !== undefined) acc.checked++;
          if (el.hasValue !== undefined) acc.hasValue++;
          if (el.isContentEditable === true) acc.contentEditable++;
          if (el.invalid === true) acc.invalid++;
          if (el.firstTextFragment) acc.withText++;
          return acc;
        },
        { frameworkClickable: 0, checked: 0, hasValue: 0, contentEditable: 0, invalid: 0, withText: 0 },
      );

      logger.debug('[CDP_SNAPSHOT] Collected', {
        diagId,
        url: snapshot.url.slice(0, 100),
        elementCount: elements.length,
        // Phase timings — eyeball wall-clock vs evaluate path's typical
        // 12-16s on dense pages. CDP target on the same page is ~1.5s.
        timings: phaseTimings,
        // Shape contract — these MUST be populated for ObserverAgent /
        // pruner / element-resolver to behave correctly. Zeros here
        // signal a regression in Phase 0 enrichment.
        shape: {
          hasTransientState: snapshot.transientState !== undefined,
          isTransient: snapshot.transientState?.isTransient === true,
          obstacleCount: snapshot.obstacleFacts?.length ?? 0,
          hasActiveModal: snapshot.activeModalRef !== undefined,
          activeModalRef: snapshot.activeModalRef,
        },
        // Runtime field coverage — counts how many elements got Phase 4
        // enrichment. `frameworkClickable: 0` on a React/Vue page is a
        // smoking gun (Phase 4 evaluate failed silently or the framework
        // detector regressed).
        runtime: runtimeStats,
      });

      return snapshot;
    } finally {
      // Detach only sessions we opened — a caller-supplied session
      // belongs to them and we must not pull it out from under them.
      if (ownsCdpSession) {
        try {
          await cdp.detach();
        } catch {
          // Detach errors are non-actionable — most commonly happen
          // when the page already closed mid-collect. Swallow to keep
          // the original error surface visible above this finally.
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Phase implementations — stubbed for the skeleton.
  // Each TODO references the audit (01-fields-audit.md) for the
  // exact source mapping each field needs.
  // ─────────────────────────────────────────────────────────────────

  /**
   * Phase 2 — parallel CDP fetches.
   *
   * Issues two CDP commands in parallel and assembles the raw bundle.
   * AXTree is treated as best-effort: if Chromium build doesn't
   * expose the Accessibility domain, we warn once and proceed with
   * DOMSnapshot only — downstream mapping falls back to manual
   * `computeRole` for implicit ARIA, same logic as today.
   *
   * Failure routing (all throw `CdpSnapshotError` for router fallback):
   *   - DS rejected: page_gone / cdp_send_failed
   *   - DS payload >20MB: cdp_payload_too_large
   *   - DS malformed (no documents[]): malformed_response
   *   - AX rejected: ax_domain_unavailable (warn-once, fall through
   *     with empty axTree — NOT thrown; mapping handles)
   */
  private static async fetchRawBundle(cdp: CDPSession, diagId?: string): Promise<RawCdpBundle> {
    const dsStart = Date.now();
    const axStart = Date.now();
    let dsMs = 0;
    let axMs = 0;

    // Fire both in parallel. We track per-call latency separately
    // even though they're concurrent — useful when AX domain is slow
    // and DS finished fast (or vice versa); the wall-clock max of
    // the two is the real cost, but per-call detail catches
    // pathological skew (e.g. AX hung at 4s while DS took 300ms).
    const dsPromise = cdp
      .send('DOMSnapshot.captureSnapshot', {
        computedStyles: [...REQUESTED_COMPUTED_STYLES],
        includeDOMRects: true,
        includePaintOrder: true,
      })
      .then((res) => {
        dsMs = Date.now() - dsStart;
        return res;
      });

    const axPromise = cdp
      .send('Accessibility.getFullAXTree')
      .then((res) => {
        axMs = Date.now() - axStart;
        return res;
      })
      .catch((err) => {
        axMs = Date.now() - axStart;
        // Warn-once per Chromium build. We don't have a build-id
        // available here cheaply; use the error message as the dedup
        // key — same Chromium emits the same string. Imperfect but
        // OK for an info-level warning.
        const key = String(err?.message ?? err).slice(0, 80);
        if (!axDomainWarnedFor.has(key)) {
          axDomainWarnedFor.add(key);
          logger.warn('[CDP_SNAPSHOT] Accessibility domain unavailable, falling back to DS-only mapping', {
            diagId,
            error: key,
          });
        }
        // Return an empty-ish AXTree shape. Mapping checks for
        // `nodes?.length` before using it; missing tree means
        // computeRole fallback per-element.
        return { nodes: [] };
      });

    let domSnapshot: unknown;
    let axTree: unknown;
    try {
      [domSnapshot, axTree] = await Promise.all([dsPromise, axPromise]);
    } catch (err) {
      // DS rejected — Promise.all rejects on first reject. AX is
      // already wrapped in `.catch` above, so this branch is always
      // a DS failure. Categorise common causes for metric grouping.
      const msg = err instanceof Error ? err.message : String(err);
      const kind: CdpSnapshotFailureKind = /no.+document|target.+closed|frame.+detached/i.test(msg)
        ? 'page_gone'
        : 'cdp_send_failed';
      throw new CdpSnapshotError(kind, `DOMSnapshot.captureSnapshot failed: ${msg}`, err);
    }

    // Sanity-check the DS payload before doing anything with it.
    // Stringify cost is one-time and acceptable — we'd be doing it
    // anyway during mapping. Catches: oversized payloads, missing
    // documents array (Chromium edge case on partially-loaded pages).
    if (!domSnapshot || typeof domSnapshot !== 'object') {
      throw new CdpSnapshotError('malformed_response', 'DOMSnapshot returned non-object response');
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dsAny = domSnapshot as any;
    if (!Array.isArray(dsAny.documents) || dsAny.documents.length === 0) {
      throw new CdpSnapshotError(
        'malformed_response',
        `DOMSnapshot has no documents (got ${typeof dsAny.documents})`,
      );
    }

    // Approximate payload size. `Buffer.byteLength(JSON.stringify(...))`
    // gives the actual UTF-8 byte length (vs `.length` which counts
    // UTF-16 code units and undercounts non-ASCII strings). Same JSON
    // pass either way — but the byte count is the metric we actually
    // compare against the byte-denominated limit.
    const approxBytes = Buffer.byteLength(JSON.stringify(domSnapshot), 'utf8');
    if (approxBytes > DOM_SNAPSHOT_PAYLOAD_LIMIT_BYTES) {
      throw new CdpSnapshotError(
        'cdp_payload_too_large',
        `DOMSnapshot payload ${(approxBytes / 1024 / 1024).toFixed(1)}MB exceeds ${
          DOM_SNAPSHOT_PAYLOAD_LIMIT_BYTES / 1024 / 1024
        }MB limit`,
      );
    }

    // Pin per-call timings on the bundle so the caller can include
    // them in CdpPhaseTimings. We pass via mutation rather than a
    // separate return value to keep the public bundle shape stable
    // for tests / mock consumers.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (dsAny as any).__dsMs = dsMs;
    return {
      domSnapshot: dsAny,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      axTree: axTree as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      __axMs: axMs,
    } as unknown as RawCdpBundle;
  }

  /**
   * Phase 3 — DOMSnapshot + AXTree → LiteElement[] mapping.
   *
   * Sequenced sub-phases:
   *   3a. Build string-table accessor + AX-by-backendNodeId map
   *   3b. Walk DS nodes, filter to interactive, build candidate list
   *   3c. Per-candidate: attributes / styles / bounds / AX role + name
   *
   * Ref assignment (data-agent-ref writes) is intentionally a SEPARATE
   * phase (3.5) handled by `assignAgentRefs` — must run AFTER mapping
   * (we need to know which nodes are interactive) and BEFORE the
   * runtime enrichment (Phase 4) which queries elements via
   * `[data-agent-ref="…"]`.
   *
   * Postprocess fields requiring parent walks (parentRefChain,
   * containerTitles, isInsideShadowDOM, etc.) handled by Phase 3c
   * once refs are assigned — see `populateAncestryFields`.
   */
  private static mapToLiteElements(raw: RawCdpBundle): LiteElement[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = raw.domSnapshot as any;
    const strings: string[] = Array.isArray(ds.strings) ? ds.strings : [];
    const getStr = (idx: number | undefined): string => {
      if (typeof idx !== 'number' || idx < 0 || idx >= strings.length) return '';
      return String(strings[idx] ?? '');
    };

    // AX-by-backendNodeId index. AX nodes carry a `backendDOMNodeId`
    // matching DS `nodes.backendNodeId[i]`. O(1) lookup so per-element
    // mapping stays linear over DS nodes.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const axNodes: any[] = Array.isArray(raw.axTree?.nodes) ? raw.axTree.nodes : [];
    const axByBackendId = new Map<number, unknown>();
    for (const n of axNodes) {
      const id = n?.backendDOMNodeId;
      if (typeof id === 'number') axByBackendId.set(id, n);
    }

    const elements: LiteElement[] = [];

    // Walk every document (main frame + same-origin iframes; cross-
    // origin iframes show up as separate documents too — DS gives all
    // of them at once, the audit win we get for free vs today's
    // evaluate path which silently skips them).
    const documents = Array.isArray(ds.documents) ? ds.documents : [];
    for (let docIdx = 0; docIdx < documents.length; docIdx++) {
      const doc = documents[docIdx];
      if (!doc?.nodes) continue;
      const nodes = doc.nodes;
      const layout = doc.layout ?? {};

      // layout.nodeIndex maps layout-row → DS node index. We need the
      // inverse: DS node index → layout row, so we can read bounds /
      // computed styles for any node we keep.
      const layoutByNodeIdx = new Map<number, number>();
      const layoutNodeIndex: number[] = Array.isArray(layout.nodeIndex) ? layout.nodeIndex : [];
      for (let i = 0; i < layoutNodeIndex.length; i++) {
        layoutByNodeIdx.set(layoutNodeIndex[i], i);
      }

      const nodeCount = Array.isArray(nodes.nodeName) ? nodes.nodeName.length : 0;

      // Two-pass strategy:
      //   Pass 1 (tier1): every semantic interactive (button/a/input/
      //     [role=button]/[tabindex=0]) — UNCAPPED. These are real
      //     controls; we never want to drop them.
      //   Pass 2 (tier2): cursor:pointer fallbacks — CAPPED at
      //     MAX_TIER2_ELEMENTS. Without the cap, pages with global
      //     cursor:pointer CSS flood with thousands of decorative
      //     children (each <i>/<span> inside a button), making CDP
      //     orders of magnitude slower than evaluate path.
      //
      // Single-pass with embedded cap would risk dropping a tier1 hit
      // late in the document because tier2 hits early filled the
      // budget — that would silently miss real buttons. Splitting
      // the passes is the only correct order.
      let tier2Added = 0;

      // Pass 1: tier-1, capped at MAX_TOTAL_ELEMENTS. Pages with
      // >500 semantic-interactive children (rare but real on table
      // grids, infinite-scroll feeds) get clipped — same behaviour
      // as evaluate path's downstream extractor cap. Better to clip
      // here than to do per-element Phase 4 work on elements that
      // get dropped 50ms later.
      for (let i = 0; i < nodeCount; i++) {
        if (elements.length >= MAX_TOTAL_ELEMENTS) break;
        const tagName = getStr(nodes.nodeName?.[i]).toLowerCase();
        if (!tagName || tagName.startsWith('#')) continue;
        const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
        if (!isInteractiveNodeTier1(tagName, attrs)) continue;

        const layoutIdx = layoutByNodeIdx.get(i);
        const bounds = layoutIdx !== undefined ? decodeBoundsForLayoutIdx(layout, layoutIdx) : undefined;
        if (!bounds) continue;
        const styles = layoutIdx !== undefined ? decodeStylesForLayoutIdx(layout, layoutIdx, getStr) : undefined;

        const backendId = nodes.backendNodeId?.[i];
        const axNode = typeof backendId === 'number' ? axByBackendId.get(backendId) : undefined;

        elements.push(buildLiteElementFromNode({
          tagName, attrs, bounds, styles, axNode,
          dsNodeIndex: i, docIndex: docIdx,
        }));
      }

      // Build set of indexes added by Pass 1 so subsequent passes
      // can skip them. We re-scan the node array in Pass 1.5 / Pass 2
      // — small overhead vs. the duplication we'd cause otherwise.
      const tier1Indexes = new Set<number>();
      for (const el of elements) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const idx = (el as any).__dsNodeIndex;
        if (typeof idx === 'number' && (el as unknown as { __docIndex?: number }).__docIndex === docIdx) {
          tier1Indexes.add(idx);
        }
      }

      // Pass 1.5: icon-ish elements with stable id / testid.
      // <svg id="...">, <i id="..." class="icon">, <img id="logo">,
      // <path data-testid="...">. Mirrors evaluate-path's secondary
      // pass (snapshot-collector.ts ~line 1126). UNCAPPED — these
      // are explicitly-named UI elements, not decorative noise; the
      // stable-id requirement is the cap. Without this pass:
      //   - logo images miss from snapshot → recorder records
      //     `<img id="logo">`, identity fast-path fires on id, no
      //     match in CDP path → resolver falls through to LLM →
      //     wrong CTA picked.
      //   - icon-only toolbar buttons (Element Plus, Material) miss
      //     when their <i id="..."> child carries the stable id.
      for (let i = 0; i < nodeCount; i++) {
        if (elements.length >= MAX_TOTAL_ELEMENTS) break;
        if (tier1Indexes.has(i)) continue;

        const tagName = getStr(nodes.nodeName?.[i]).toLowerCase();
        if (!tagName || tagName.startsWith('#')) continue;
        const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
        if (!isInteractiveIconish(tagName, attrs)) continue;

        const layoutIdx = layoutByNodeIdx.get(i);
        const bounds = layoutIdx !== undefined ? decodeBoundsForLayoutIdx(layout, layoutIdx) : undefined;
        if (!bounds) continue;
        // Min-size gate matches evaluate-path (5×5) — filters out
        // 0-size hidden icon placeholders without dropping typical
        // 16-32px button glyphs.
        if (bounds.width < 5 || bounds.height < 5) continue;
        const styles = layoutIdx !== undefined ? decodeStylesForLayoutIdx(layout, layoutIdx, getStr) : undefined;

        const backendId = nodes.backendNodeId?.[i];
        const axNode = typeof backendId === 'number' ? axByBackendId.get(backendId) : undefined;

        elements.push(buildLiteElementFromNode({
          tagName, attrs, bounds, styles, axNode,
          dsNodeIndex: i, docIndex: docIdx,
        }));
        tier1Indexes.add(i);
      }

      // Pass 2: tier-2 (cursor:pointer), capped at MAX_TIER2_ELEMENTS
      // to prevent pages with global cursor:pointer CSS from flooding.
      for (let i = 0; i < nodeCount; i++) {
        if (tier2Added >= MAX_TIER2_ELEMENTS) break;
        if (elements.length >= MAX_TOTAL_ELEMENTS) break;
        if (tier1Indexes.has(i)) continue;

        const tagName = getStr(nodes.nodeName?.[i]).toLowerCase();
        if (!tagName || tagName.startsWith('#')) continue;

        const layoutIdx = layoutByNodeIdx.get(i);
        if (layoutIdx === undefined) continue;
        const styles = decodeStylesForLayoutIdx(layout, layoutIdx, getStr);
        if (!isInteractiveNodeTier2(styles)) continue;

        const bounds = decodeBoundsForLayoutIdx(layout, layoutIdx);
        if (!bounds) continue;

        const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
        const backendId = nodes.backendNodeId?.[i];
        const axNode = typeof backendId === 'number' ? axByBackendId.get(backendId) : undefined;

        elements.push(buildLiteElementFromNode({
          tagName, attrs, bounds, styles, axNode,
          dsNodeIndex: i, docIndex: docIdx,
        }));
        tier2Added++;
      }
    }

    return elements;
  }

  /**
   * Phase 3.5 — assign `data-agent-ref` to each interactive element
   * via a single batched `page.evaluate`.
   *
   * Why this is the most subtle phase in the whole CDP path:
   *
   *   1. Refs MUST be STABLE across snapshots. Every consumer of
   *      `evidence.lastSuccessRef` (PreviewStepApplyService evidence
   *      shortcut, RecordingCaptureService.lastSuccessRef) assumes a
   *      ref captured on apply N still resolves the SAME element on
   *      replay N+1. Reset the counter and you silently invalidate
   *      every cached ref in the DB.
   *
   *   2. Refs MUST survive React re-renders. The existing
   *      SnapshotCollector achieves this via `__agentFingerprintMap`
   *      keyed by tag+role+id+testId+5-deep DOM path. Without
   *      reusing this map we generate fresh refs each render and
   *      lose evidence shortcuts on every Apply All.
   *
   *   3. Refs MUST be unique across documents. Cross-origin iframes
   *      have separate `window.__agentRefCounter` instances, so
   *      `e23` in main frame and `e23` in iframe collide for the
   *      Node-side LiteElement. Today's collector skips iframes
   *      entirely so this isn't an issue; CDP path picks them up,
   *      so we prefix with iframe origin to avoid collisions.
   *
   * Implementation strategy:
   *   - Build a list of [docIndex, dsNodeIndex, fingerprint] tuples
   *     from `elements`. fingerprint is computed in Node from the
   *     fields we ALREADY mapped — same algorithm as in-page
   *     getElementFingerprint, no extra evaluate cost.
   *   - One page.evaluate per document (typically 1, sometimes
   *     several with iframes). Each evaluate looks up the right
   *     element by fingerprint match in window.__agentFingerprintMap,
   *     reusing cached ref or assigning new from window.__agentRefCounter.
   *
   * Why NOT querying by some new identifier we generate:
   *   - We'd add a second source of truth (Node-counter vs in-page
   *     counter) and they'd drift the moment the page reloads
   *     during preview tick.
   *   - In-page state survives tab navigation; Node-side state
   *     doesn't. Reusing window.* keeps single source.
   */
  private static async assignAgentRefs(page: Page, elements: LiteElement[]): Promise<void> {
    if (elements.length === 0) return;

    // Group elements by document. Cross-origin iframes need their own
    // evaluate against their own page context. Today most pages have
    // only one document; the loop is a no-op cost for single-doc.
    const byDoc = new Map<number, LiteElement[]>();
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      const key = docIdx ?? 0;
      const list = byDoc.get(key) ?? [];
      list.push(el);
      byDoc.set(key, list);
    }

    // For now: single evaluate against main frame only. Iframe-aware
    // ref assignment is part of the iframe project (separate plan in
    // memory). When we cross that bridge, this loop becomes a per-
    // frame evaluate via `page.frames().find(...)`. Today's collector
    // also skips iframes, so we're at parity.
    const mainFrameElements = byDoc.get(0) ?? elements;
    if (mainFrameElements.length === 0) return;

    // Build fingerprint payload. Each entry contains the fields the
    // in-page lookup needs to find the right element AMONG candidates
    // matching tag+role+id+testId. We pass them upfront so the
    // evaluate doesn't re-query attributes we've already decoded.
    type RefAssignmentRequest = {
      tag: string;
      role: string;
      type: string;
      name: string;          // form `name` attribute
      id: string;
      ariaLabel: string;
      placeholder: string;
      testId: string;
      // Identity slot for selector — first non-dynamic id/testId/name
      // gives us a fast path. When all are absent we fall back to
      // bbox + tag matching in-page (rare; only for descriptor-poor
      // anonymous divs).
      bboxX: number;
      bboxY: number;
      bboxW: number;
      bboxH: number;
    };

    const requests: RefAssignmentRequest[] = mainFrameElements.map((el) => ({
      tag: el.tag,
      role: el.role || '',
      type: el.type || '',
      name: el.htmlName || '',
      id: el.htmlId || '',
      ariaLabel: el.ariaLabel || '',
      placeholder: el.placeholder || '',
      // testId attribute-name varies (data-testid / data-test / data-cy);
      // mapping wrote it under different fields. Snapshot-collector
      // checks `data-testid` / `data-test` only — match that for now.
      // Wider testIdAttributes config (locator-config.ts) is read
      // upstream by builder, not here.
      testId: '',
      bboxX: el.bounds?.x ?? 0,
      bboxY: el.bounds?.y ?? 0,
      bboxW: el.bounds?.width ?? 0,
      bboxH: el.bounds?.height ?? 0,
    }));

    // The evaluate body MUST mirror the existing snapshot-collector
    // logic byte-for-byte. We cannot read the source of that function
    // from here (browser context vs Node), so the algorithm is
    // duplicated. Drift here is the single biggest risk for
    // evidence shortcut breakage.
    //
    // Symmetry contract documented in 01-fields-audit.md: same
    // window.__agentRefCounter, same __agentFingerprintMap key shape
    // (tag|role|type|name|id|ariaLabel|placeholder|testId|text|domPath),
    // same "use cached ref if found, else allocate new" logic.
    // The evaluate body runs in browser context — `window`, `document`,
    // `Element`, `CSS` are all browser globals. Node TypeScript doesn't
    // know them; we use `any` casts at the boundary rather than wider
    // lib options (would pollute the whole file with browser types).
    const refsByIndex: string[] = await page.evaluate((reqs: RefAssignmentRequest[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = (globalThis as any).window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssEscape: (v: string) => string = (globalThis as any).CSS?.escape
        ?? ((v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

      if (typeof win.__agentRefCounter !== 'number') win.__agentRefCounter = 0;
      if (!win.__agentFingerprintMap) win.__agentFingerprintMap = new Map();

      const out: string[] = [];

      // Helper: find the candidate element for a request. Strategy:
      //   1. By id (CSS escaped).
      //   2. By bbox + tag walk (cheap fallback).
      // We don't iterate elementsFromPoint because bbox center can be
      // covered by overlay; instead use elementFromPoint at center as
      // a verification step after finding via attributes.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const findElement = (req: RefAssignmentRequest): any => {
        if (req.id) {
          try {
            // CSS.escape REQUIRED — React 18 useId emits colons.
            const candidate = doc.querySelector(`#${cssEscape(req.id)}`);
            if (candidate && candidate.tagName.toLowerCase() === req.tag) return candidate;
          } catch { /* invalid selector — fall through */ }
        }
        // Bbox-center match: cheap and works when refs are stable
        // across renders (page didn't reflow). Mismatch on reflow
        // causes one-frame ref churn — acceptable.
        const cx = req.bboxX + req.bboxW / 2;
        const cy = req.bboxY + req.bboxH / 2;
        if (req.bboxW > 0 && req.bboxH > 0) {
          const at = doc.elementFromPoint(cx, cy);
          if (at) {
            // Walk up to find the matching tag (elementFromPoint may
            // return a child like SVG path, we want the button wrap).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let cur: any = at;
            for (let depth = 0; depth < 5 && cur; depth++) {
              if (cur.tagName?.toLowerCase() === req.tag) return cur;
              cur = cur.parentElement;
            }
            return at; // last resort
          }
        }
        return null;
      };

      // Build fingerprint key — SAME shape as existing collector's
      // getElementFingerprint. If the shape drifts, refs reset.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fpKey = (el: any, req: RefAssignmentRequest): string => {
        const text = (el.textContent || '').trim().slice(0, 40);
        const pathParts: string[] = [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let cur: any = el;
        for (let i = 0; i < 5 && cur && cur.parentElement; i++) {
          const parent = cur.parentElement;
          const idx = Array.prototype.indexOf.call(parent.children, cur);
          pathParts.push(`${cur.tagName.toLowerCase()}[${idx}]`);
          cur = parent;
        }
        const domPath = pathParts.join('/');
        return `${req.tag}|${req.role}|${req.type}|${req.name}|${req.id}|${req.ariaLabel}|${req.placeholder}|${req.testId}|${text}|${domPath}`;
      };

      for (const req of reqs) {
        const el = findElement(req);
        if (!el) {
          // Element disappeared between DOMSnapshot and evaluate.
          // Push an empty ref; mapping caller filters these out.
          out.push('');
          continue;
        }

        // Reuse existing data-agent-ref if already set.
        const existing = el.getAttribute('data-agent-ref');
        if (existing) {
          out.push(existing);
          continue;
        }

        // Look up by fingerprint to survive React re-renders.
        const key = fpKey(el, req);
        const cached = win.__agentFingerprintMap.get(key);
        if (typeof cached === 'string' && cached.length > 0) {
          el.setAttribute('data-agent-ref', cached);
          out.push(cached);
          continue;
        }

        // Allocate fresh ref from monotonic counter.
        const fresh = `e${win.__agentRefCounter++}`;
        win.__agentFingerprintMap.set(key, fresh);
        el.setAttribute('data-agent-ref', fresh);
        out.push(fresh);
      }

      return out;
    }, requests);

    // Apply assigned refs back to elements. Empty string = element
    // disappeared in-page after DS captured it. We DROP these
    // elements from the LiteElement[] (consumers can't target them
    // anyway — no ref means no Playwright locator).
    let writeIdx = 0;
    for (let i = 0; i < mainFrameElements.length; i++) {
      const ref = refsByIndex[i] ?? '';
      if (!ref) continue;
      mainFrameElements[i].ref = ref;
      mainFrameElements[writeIdx++] = mainFrameElements[i];
    }
    mainFrameElements.length = writeIdx;

    // Sync back into the original `elements` array — this works
    // because mainFrameElements is the same Array reference for the
    // single-document case (byDoc.get(0) returned the original list).
    // For multi-doc this is a no-op; iframe support is separate.
  }

  /**
   * Phase 4 — batched runtime field enrichment via single `page.evaluate`.
   *
   * Scope reduced from initial audit estimate (7-8 fields) to 5 actual
   * runtime fields after Phase 3c-DS picked up everything attribute-
   * derivable. The remaining fields ALL require accessing JavaScript
   * runtime state on the element node:
   *
   *   1. JS-runtime framework detection (React fiber / Vue / Angular /
   *      Svelte / jQuery) — Object.keys() / `__vue__` / `__ngContext__`
   *      probes. OVERRIDES Phase 3c-DS attribute-based detection when
   *      a runtime marker exists, because runtime presence is more
   *      authoritative on wrapper elements with mixed signals.
   *
   *   2. `checked` — current input state. DS gives the `checked`
   *      attribute (initial state), but user toggles diverge it from
   *      the runtime property `el.checked`.
   *
   *   3. `hasValue` — privacy-safe boolean. NEVER returns raw value.
   *      Sensitive-input redaction is computed in Node from DS
   *      attributes (autocomplete tokens / name/id regex) BEFORE the
   *      evaluate call; the evaluate just runs `!!el.value` on
   *      non-sensitive inputs.
   *
   *   4. `invalid` — `:invalid` CSS pseudo-class match. Different from
   *      aria-invalid attribute (already in Phase 3b) — covers native
   *      browser validation state (`<input required>` empty).
   *
   *   5. Runtime fallbacks for `disabled` / `readOnly` — frameworks can
   *      set these via `el.disabled = true` programmatically without
   *      the attribute. DS attributes win when present; runtime fallback
   *      only fires when attribute absent and runtime says true.
   *
   * Privacy audit:
   *   - `value` itself NEVER crosses the WS pipe. Only `boolean`.
   *   - Sensitive flag is sent INTO the evaluate, never returned.
   *   - Element ref is the only identifier sent; no text content.
   *
   * Performance:
   *   - One serialization round (refs+sensitivity flags out, results in)
   *   - Per-element work O(1): one querySelector, one Object.keys
   *     call truncated at first React match (early return), 4 attribute
   *     checks for fallback frameworks.
   *   - Chunking threshold not used yet — projected 200-400ms on 10k
   *     elements based on stable-tokens-llm.service equivalent path.
   *     If shadow-mode shows pathology, add chunking at 5000.
   */
  private static async enrichWithRuntimeFields(page: Page, elements: LiteElement[]): Promise<void> {
    if (elements.length === 0) return;

    // Build per-element request payload. Each entry pre-computed in
    // Node so the evaluate callback stays tight.
    type RuntimeEnrichmentRequest = {
      ref: string;
      // True when the input is sensitive (password/credential pattern).
      // Computed via SAME logic as snapshot-collector (~line 1689):
      //   input.type === 'password' || hasSensitiveAutocomplete ||
      //   name/id regex match. We compute in Node to keep the evaluate
      //   payload minimal AND to avoid duplicating the regex set in
      //   the in-page closure where it would be re-evaluated per ref.
      isSensitiveInput: boolean;
      // Tag-based gate: only inputs/textarea/select have meaningful
      // `value`. Other tags' `value` reads return undefined; sending
      // the gate avoids per-element tag re-checks in browser.
      isInputLike: boolean;
    };

    const requests: RuntimeEnrichmentRequest[] = elements.map((el) => ({
      ref: el.ref,
      isSensitiveInput: computeIsSensitiveInput(el),
      isInputLike: el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select',
    }));

    // Single batched evaluate. Returns array parallel to `requests` —
    // index `i` holds runtime fields for `elements[i]`. Null entries
    // mean the element disappeared between Phase 3.5 and Phase 4
    // (DOM mutated mid-collect). Acceptable degradation: those
    // elements just keep Phase 3b/3c-DS values, runtime fields stay
    // undefined → consumers (buildAllowedSets) treat them as
    // best-effort.
    type RuntimeFields = {
      // OVERRIDE candidate — only set when a runtime framework is
      // detected; mapping merges into element ONLY if non-undefined.
      frameworkClickable?: 'react' | 'vue' | 'angular' | 'svelte' | 'jquery';
      checked?: boolean;
      hasValue?: boolean;
      invalid?: boolean;
      disabledRuntime?: boolean;
      readOnlyRuntime?: boolean;
    };

    const results: Array<RuntimeFields | null> = await page.evaluate((reqs: RuntimeEnrichmentRequest[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const win = (globalThis as any).window;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssEscape: (v: string) => string = (globalThis as any).CSS?.escape
        ?? ((v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

      const out: Array<RuntimeFields | null> = [];

      // Cache jQuery presence ONCE — saves N attribute lookups on
      // pages without jQuery (most modern apps).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const jq: any = win.jQuery || win.$;
      const jqHasData: boolean = !!(jq && jq._data);

      for (const req of reqs) {
        if (!req.ref) {
          // Element was filtered out in Phase 3.5 (no ref assigned).
          // Push null so the result array stays parallel-indexed with
          // elements[].
          out.push(null);
          continue;
        }
        const el = doc.querySelector(`[data-agent-ref="${cssEscape(req.ref)}"]`);
        if (!el) {
          // Disappeared between Phase 3.5 and Phase 4. Common when
          // page mutates rapidly (e.g. SPA route change between two
          // collector calls). Acceptable.
          out.push(null);
          continue;
        }

        // ── Framework detection (runtime markers) ──────────────────
        // Iterate Object.keys() up to first match — React fibers
        // are first because they're the most common pattern.
        // Single iteration handles all React variants (fiber /
        // internalInstance / events) via prefix check.
        let runtimeFw: RuntimeFields['frameworkClickable'] | undefined;
        try {
          const keys = Object.keys(el);
          for (let k = 0; k < keys.length; k++) {
            const key = keys[k];
            if (
              key.charCodeAt(0) === 95 // fast bail on non-`_` prefix
              && (
                key.startsWith('__reactFiber$')
                || key.startsWith('__reactInternalInstance$')
                || key.startsWith('__reactEvents$')
              )
            ) {
              runtimeFw = 'react';
              break;
            }
          }
        } catch { /* hostile getter — ignore */ }
        if (!runtimeFw) {
          // Vue 2 + 3 markers. `__vue__` is Vue 2; `__vueParentComponent`
          // is Vue 3. Both presence checks are safe — element is a
          // plain DOM node, no proxy traps to trigger.
          if (el.__vue__ || el.__vueParentComponent) runtimeFw = 'vue';
          else if (el.__ngContext__ || el._ngHost) runtimeFw = 'angular';
          else if (el.__svelte_meta || el.__s) runtimeFw = 'svelte';
          else if (jqHasData) {
            try {
              const events = jq._data(el, 'events');
              if (events && (events.click || events.mousedown || events.change || events.submit)) {
                runtimeFw = 'jquery';
              }
            } catch { /* jQuery internal — ignore */ }
          }
        }

        // ── Native input/checkbox/textarea state ───────────────────
        // `el.checked` is meaningful only on checkbox/radio/native
        // input. Sending undefined for non-input-like keeps the
        // result shape clean.
        const checked = req.isInputLike && typeof el.checked === 'boolean' ? el.checked : undefined;

        // hasValue — NEVER raw value. For sensitive inputs we lie
        // (return false) to avoid even a presence signal that could
        // be combined with timing to leak.
        // Wait — actually a presence signal on password input IS
        // meaningful (state-aware "type if empty" branch in apply).
        // Existing collector returns `hasValue: undefined` for
        // sensitive inputs (line 1962: `isInput && !isSensitiveInput
        // && !!input.value`). Mirroring that → undefined when
        // sensitive, preserving symmetry.
        let hasValue: boolean | undefined;
        if (req.isInputLike && !req.isSensitiveInput) {
          hasValue = !!el.value;
        }

        // :invalid pseudo — covers native validation (required+empty,
        // type=email+malformed, pattern mismatch, etc.). Some elements
        // throw on `el.matches(':invalid')` (svg children, custom
        // elements before define) — try/catch.
        let invalid: boolean | undefined;
        try {
          // matches() may not exist on non-Element nodes (rare path).
          if (typeof el.matches === 'function') {
            invalid = el.matches(':invalid');
          }
        } catch { /* pre-define custom element — leave undefined */ }

        // Runtime fallback for disabled/readOnly. We OVERRIDE the
        // attribute-derived value only when attribute was missing
        // (Phase 3b returned undefined / false) AND runtime says
        // true. Mapping merge handles the precedence — here we
        // just report what runtime sees.
        const disabledRuntime = req.isInputLike && el.disabled === true ? true : undefined;
        const readOnlyRuntime = req.isInputLike && el.readOnly === true ? true : undefined;

        out.push({
          frameworkClickable: runtimeFw,
          checked,
          hasValue,
          invalid,
          disabledRuntime,
          readOnlyRuntime,
        });
      }
      return out;
    }, requests);

    // Merge results back into elements[]. Index-aligned merge.
    for (let i = 0; i < elements.length; i++) {
      const enr = results[i];
      if (!enr) continue;

      const el = elements[i];

      // Framework detection OVERRIDE: runtime presence wins over
      // attribute hint. Documented in Phase 3c-DS comment.
      if (enr.frameworkClickable) {
        el.frameworkClickable = enr.frameworkClickable;
      }

      // Native state — only set when meaningful (input-like).
      if (enr.checked !== undefined) el.checked = enr.checked;
      if (enr.hasValue !== undefined) el.hasValue = enr.hasValue;

      // invalid: prefer aria-invalid attribute (already in Phase 3b)
      // — only fill from :invalid pseudo when attribute absent.
      // Symmetry contract: snapshot-collector also prefers attribute,
      // falls back to :invalid.
      if (el.invalid === undefined && enr.invalid !== undefined) {
        el.invalid = enr.invalid;
      }

      // Runtime fallbacks: only override when attribute-derived value
      // is falsy AND runtime says true. Prevents accidentally
      // un-disabling an element when `disabled` attribute is present
      // but runtime hasn't reflected it yet (rare race).
      if (!el.disabled && enr.disabledRuntime === true) el.disabled = true;
      if (!el.readOnly && enr.readOnlyRuntime === true) el.readOnly = true;
    }
  }

  /**
   * Phase 3c-Node — ancestry walks over DS `parentIndex` array.
   *
   * Populates fields that need parent-chain traversal but no DOM
   * access:
   *   - `parentRefChain` — refs of interactive ancestors, max depth 6
   *   - `containerRef` — first form/dialog/section ancestor ref
   *   - `containerTitles` — heading/legend titles up the chain
   *   - `nearestLandmark` — banner/main/nav/etc. role on ancestor
   *   - `isInsideShadowDOM` / `shadowDepth` / `isSlotted` / `slotName`
   *
   * Why Node-side:
   *   DS gives us `nodes.parentIndex` (parallel array; -1 for root).
   *   We already have a ref-by-ds-index map after Phase 3.5. Walking
   *   in Node is one O(N×depth) pass over data we already have —
   *   no round-trip cost.
   *
   * Symmetry contract:
   *   The existing in-page `getParentRefChain` walks via
   *   `el.parentElement` and reads `[role]`/`aria-label`/heading text
   *   on each ancestor. We replicate the same predicates from DS
   *   attributes — no observable difference for ordinary DOM trees.
   *   Light shadow boundaries appear in DS as separate documents +
   *   `shadowRoots` index; we cross them when walking up because the
   *   in-page `parentElement` does too (slotted content has light DOM
   *   parent). Closed shadow walks are limited the same way as today.
   */
  private static populateAncestryFieldsFromDs(elements: LiteElement[], raw: RawCdpBundle): void {
    if (elements.length === 0) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = raw.domSnapshot as any;
    const strings: string[] = Array.isArray(ds.strings) ? ds.strings : [];
    const getStr = (idx: number | undefined): string =>
      typeof idx === 'number' && idx >= 0 && idx < strings.length ? String(strings[idx] ?? '') : '';

    // Pre-build ds-index → ref map for fast lookup during walk. Only
    // mainframe doc (docIndex 0) — iframe ancestry is meaningless
    // across frame boundaries (can't target iframe parent from main
    // frame locator anyway).
    const refByDsIndex = new Map<number, string>();
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      if (typeof dsIdx === 'number' && (docIdx ?? 0) === 0 && el.ref) {
        refByDsIndex.set(dsIdx, el.ref);
      }
    }

    const docs = Array.isArray(ds.documents) ? ds.documents : [];
    const mainDoc = docs[0];
    if (!mainDoc?.nodes) return;
    const parentIndex: number[] = mainDoc.nodes.parentIndex ?? [];
    const nodeName: number[] = mainDoc.nodes.nodeName ?? [];
    const attributes: number[][] = mainDoc.nodes.attributes ?? [];

    // Read ANY attribute by name from a DS node — needed during walks.
    const getAttr = (nodeIdx: number, attrName: string): string | undefined => {
      const a = attributes[nodeIdx];
      if (!Array.isArray(a)) return undefined;
      for (let i = 0; i + 1 < a.length; i += 2) {
        if (getStr(a[i]).toLowerCase() === attrName) return getStr(a[i + 1]);
      }
      return undefined;
    };
    const tagOf = (nodeIdx: number): string => getStr(nodeName[nodeIdx]).toLowerCase();

    // Container/landmark predicates — same set as in-page collector.
    const isLandmarkRole = (role: string): boolean =>
      role === 'banner' || role === 'main' || role === 'navigation' || role === 'complementary'
      || role === 'search' || role === 'contentinfo' || role === 'form' || role === 'region';
    const LANDMARK_TAGS = new Set(['header', 'main', 'nav', 'aside', 'footer', 'form']);
    const CONTAINER_TAGS = new Set(['form', 'dialog', 'section', 'article', 'fieldset']);
    const HEADING_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'legend']);
    // Walk depth cap matches the existing in-page implementation
    // (`for (let i = 0; i < 6; ...)`) — exceeding wastes work,
    // ancestors that far up rarely disambiguate.
    const MAX_PARENT_DEPTH = 6;
    const MAX_CONTAINER_TITLES = 3;

    // Per-doc node-level text accumulator: gather direct text-child
    // content for headings (cheap surrogate for textContent without
    // a DOM op). DS gives `nodes.textValue.{index, value}` — index
    // points to the text-node's parent. Build a parent→text map.
    const textByParent = new Map<number, string>();
    const tv = mainDoc.nodes.textValue;
    if (tv && Array.isArray(tv.index) && Array.isArray(tv.value)) {
      const indexes: number[] = tv.index;
      const values: number[] = tv.value;
      for (let i = 0; i < indexes.length; i++) {
        // tv.index points at the TEXT node itself; we need the
        // text node's parent for the heading text content. Walk
        // one step up via parentIndex.
        const textNodeIdx = indexes[i];
        const parent = parentIndex[textNodeIdx];
        if (typeof parent === 'number' && parent >= 0) {
          const existing = textByParent.get(parent) ?? '';
          // Concatenate when heading has multiple text nodes
          // (`<h1>Hello <em>world</em></h1>` produces 2). Cap to
          // 100 chars during accumulation.
          if (existing.length < 100) {
            textByParent.set(parent, (existing + ' ' + getStr(values[i])).trim().slice(0, 100));
          }
        }
      }
    }

    // Shadow-root parent map: DS exposes shadow boundaries in
    // `nodes.shadowRoots` as `{index, shadowRootType}`. The index
    // array points at the SHADOW ROOT nodes themselves; their
    // parent in `parentIndex` is the host element. We use this
    // to detect "is this element inside a shadow tree" — walk
    // up; if we cross a node listed in shadowRoots.index → yes.
    const shadowRootIndexes = new Set<number>();
    const sr = mainDoc.nodes.shadowRoots;
    if (sr && Array.isArray(sr.index)) {
      for (const idx of sr.index) shadowRootIndexes.add(idx);
    }

    // Now per-element walk. O(N × MAX_PARENT_DEPTH) — bounded.
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      if (typeof dsIdx !== 'number' || (docIdx ?? 0) !== 0) continue;

      const chain: string[] = [];
      const titles: string[] = [];
      let containerRef: string | undefined;
      let landmark: string | undefined;
      let shadowDepth = 0;
      let isInsideShadow = false;
      // `context` mirrors evaluate-path's getParentContext: first
      // semantic-container ancestor + its title. Used by
      // hybrid-semantic-weight (LLM scoring), goal-detector,
      // funnel-analyzer. Without it, CDP path's element scoring on
      // dense pages diverges from evaluate-path's, which manifests
      // as "lint picks the wrong candidate" on auth-form-class pages.
      let parentContext: string | undefined;
      let contextParentTag: string | undefined;
      let contextParentTitle: string | undefined;

      let cur = parentIndex[dsIdx];
      let depth = 0;
      while (cur !== undefined && cur >= 0 && depth < MAX_PARENT_DEPTH) {
        // Ref chain: only interactive ancestors (those that received
        // a ref in Phase 3.5). Non-interactive divs are skipped to
        // keep `parentRefChain` semantically meaningful.
        const ancestorRef = refByDsIndex.get(cur);
        if (ancestorRef) chain.push(ancestorRef);

        const tag = tagOf(cur);
        const role = (getAttr(cur, 'role') || '').toLowerCase();

        // Container ref — first form/dialog/section/article/fieldset
        // up the chain. Same predicate set as in-page collector.
        if (containerRef === undefined && (CONTAINER_TAGS.has(tag) || role === 'dialog' || role === 'alertdialog')) {
          if (ancestorRef) containerRef = ancestorRef;
        }

        // Landmark — first banner/main/nav/etc role or implicit
        // landmark tag. Mirrors in-page logic.
        if (!landmark && (isLandmarkRole(role) || LANDMARK_TAGS.has(tag))) {
          // Prefer explicit role, fallback to tag-derived role.
          landmark = role || tagToImplicitLandmarkRole(tag);
        }

        // Heading/legend → containerTitle. Truncate, dedup, cap count.
        if (titles.length < MAX_CONTAINER_TITLES && HEADING_TAGS.has(tag)) {
          const text = textByParent.get(cur) || '';
          const trimmed = text.trim().slice(0, 50);
          if (trimmed && !titles.includes(trimmed)) titles.push(trimmed);
        }

        // Shadow tracking: if cur is itself a shadow root node OR
        // its parent is, count the boundary.
        if (shadowRootIndexes.has(cur)) {
          isInsideShadow = true;
          shadowDepth++;
        }

        // `context` derivation — first matching semantic container.
        // Mirrors evaluate-path's `getParentContext` closest() set.
        // First-match-wins (closest ancestor) — once set, don't
        // overwrite on outer ancestors.
        if (parentContext === undefined && contextParentTag === undefined) {
          const cls = getAttr(cur, 'class') || '';
          const ariaLabel = getAttr(cur, 'aria-label') || '';
          const dataTitle = getAttr(cur, 'data-title') || '';
          const dataProduct = getAttr(cur, 'data-product');
          const dataItem = getAttr(cur, 'data-item');
          const dataContainer = getAttr(cur, 'data-container');

          let parentType: string | undefined;
          if (
            dataProduct !== undefined || dataItem !== undefined
            || /\b(card|product|item)\b/.test(cls)
          ) {
            parentType = 'Card';
          } else if (tag === 'article' || role === 'article') {
            parentType = 'Article';
          } else if (tag === 'form') {
            parentType = 'Form';
          } else if (role === 'dialog' || role === 'alertdialog' || /\bmodal\b/.test(cls)) {
            parentType = 'Modal';
          } else if (tag === 'section' || role === 'listitem') {
            parentType = 'Section';
          } else if (tag === 'header') {
            parentType = 'Header';
          } else if (tag === 'footer') {
            parentType = 'Footer';
          } else if (tag === 'nav') {
            parentType = 'Navigation';
          } else if (tag === 'aside') {
            parentType = 'Aside';
          } else if (dataContainer !== undefined) {
            parentType = 'Container';
          }

          if (parentType) {
            contextParentTag = parentType;
            // Title preference: heading text (collected separately above
            // — but only at MAX depth), aria-label, data-title.
            // textByParent already has heading text for this index.
            const headingText = (textByParent.get(cur) || '').trim();
            const titleSrc = headingText || ariaLabel || dataTitle;
            if (titleSrc) {
              contextParentTitle = titleSrc.slice(0, 50);
            }
          }
        }

        cur = parentIndex[cur];
        depth++;
      }

      // Compose `context` string identical to evaluate-path format.
      if (contextParentTag) {
        parentContext = contextParentTitle
          ? `inside: ${contextParentTag} "${contextParentTitle}"`
          : `inside: ${contextParentTag}`;
      }

      if (chain.length > 0) el.parentRefChain = chain;
      if (titles.length > 0) el.containerTitles = titles;
      if (containerRef) el.containerRef = containerRef;
      if (landmark) {
        // LiteElement doesn't carry `nearestLandmark`; we surface it
        // through `containerTitles` lookup downstream. Skip storing.
        // (InteractiveNode in preview.types.ts has nearestLandmark
        // but LiteElement doesn't — preserve current shape.)
        void landmark;
      }
      // Shape parity with evaluate-path: ALWAYS set shadowDepth (0 if
      // not in shadow), ALWAYS set isInsideShadowDOM (false if not in
      // shadow). Without explicit defaults, diffSnapshots saw
      // `undefined !== false` / `undefined !== 0` and reported every
      // matched element as divergent. Real-Chromium symmetry test
      // (cdp-evaluate-symmetry.integration) caught this on auth form.
      el.isInsideShadowDOM = isInsideShadow;
      el.shadowDepth = shadowDepth;
      if (parentContext) el.context = parentContext;
    }
  }

  /**
   * Phase 3c-Eval — DOM-walk fields that DS cannot derive cheaply.
   *
   * Single batched `page.evaluate` for fields requiring `cloneNode`,
   * `querySelector`, child text walks, label[for=] resolution:
   *
   *   - `firstTextFragment` — first non-empty text leaf (for
   *     "card title vs description" disambiguation in builder).
   *   - `isIconButton` — clickable + has-icon-child + no-text. The
   *     existing collector uses cloneNode + remove icons + read
   *     remaining textContent. Replicate identically.
   *   - `labelText` — `<label for>`/wrapping `<label>`/aria-labelledby
   *     resolution. AX `name` already covers most cases but
   *     `LiteElement.labelText` is a separate field consumers read.
   *   - `nearestRowText` — sibling cell concat for table-row buttons.
   *
   * Why a SECOND evaluate (third overall: 3.5 + 4 + 3c-Eval):
   *   These walks need `parentElement` / `previousElementSibling` /
   *   text-node iteration. Pure DS would require Node-side replication
   *   of textContent extraction — fragile and burns CPU. One bounded
   *   evaluate is cleaner.
   */
  private static async enrichWithDomWalkFields(page: Page, elements: LiteElement[]): Promise<void> {
    if (elements.length === 0) return;
    const refs = elements.map((e) => e.ref).filter((r): r is string => !!r);
    if (refs.length === 0) return;

    type DomWalkResult = {
      firstTextFragment?: string;
      isIconButton?: boolean;
      labelText?: string;
      nearestRowText?: string;
      // ── Q1 audit fix (May 2026) ──────────────────────────────
      // 4 fields previously dropped on the CDP path. Verified critical
      // for compiled-plan match scoring + element-resolver coverage
      // pruning. Adding here (single evaluate, same DOM walk) is
      // cheaper than a separate phase.
      //
      // isTopMostAtCenter — hit-test result. False = element is
      // visually covered (overlay/sticky toolbar on top). Consumers:
      //   - hybrid-semantic-weight.ts: weight × 0.6 penalty
      //   - lite-engine.ts:598: zIndexBoost = 1.2 when true
      //   - snapshot-pruner.ts:259: 'C' (covered) flag
      // childTestId — fallback testId from unique direct child (icon
      // wrapper). Used by compiled-locator-executor for fingerprint
      // matching. Without it, icon-only buttons lose a strong selector.
      // iconClasses — filtered class string. Distinguishes icon-only
      // buttons that share role/text (e.g., 5 "Save" toolbar icons).
      // iconLabel — semantic label for icon-only buttons (svg <title>,
      // <img alt>, data-lucide). Used by locator-plan-builder iconLabel
      // strategy and by candidateText for resolver scoring.
      //
      // Note: customElementTag and svgIcon were considered but neither
      // is in LiteElement type — evaluate-path populates them but no
      // consumer reads from LiteElement (svgIcon is read via `as any`
      // cast in plan-builder for ProbedElement only). Skipping to
      // maintain shape symmetry with the type definition.
      isTopMostAtCenter?: boolean;
      childTestId?: string;
      iconClasses?: string;
      iconLabel?: string;
    };

    const results: Array<DomWalkResult | null> = await page.evaluate((refs: string[]) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cssEscape: (v: string) => string = (globalThis as any).CSS?.escape
        ?? ((v: string) => v.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`));

      const out: Array<DomWalkResult | null> = [];

      // firstTextFragment extractor — copy of the in-page algorithm
      // from snapshot-collector ~line 2329. MUST match byte-for-byte
      // to keep recorder probe ↔ collector ↔ CDP path symmetric.
      const TEXT_NODE = 3;
      const ELEMENT_NODE = 1;
      const DECORATIVE: Record<string, 1> = {
        img: 1, svg: 1, i: 1, picture: 1, use: 1, path: 1, br: 1, hr: 1,
      };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const extractFirstFragment = (node: any): string | undefined => {
        try {
          for (let ci = 0; ci < node.childNodes.length; ci++) {
            const ch = node.childNodes[ci];
            if (ch.nodeType === TEXT_NODE) {
              const t = (ch.nodeValue || '').replace(/\s+/g, ' ').trim();
              if (t.length >= 2 && t.length <= 80) return t;
            }
          }
          // Recurse into non-decorative children.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const stack: any[] = [];
          for (let ci2 = node.childNodes.length - 1; ci2 >= 0; ci2--) {
            const ch2 = node.childNodes[ci2];
            if (ch2.nodeType === ELEMENT_NODE) stack.push(ch2);
          }
          while (stack.length > 0) {
            const cur = stack.pop();
            const tag = cur.tagName?.toLowerCase();
            if (tag && DECORATIVE[tag]) continue;
            const r = extractFirstFragment(cur);
            if (r) return r;
          }
        } catch { /* DOM mutation race — fall through */ }
        return undefined;
      };

      // isIconButton — same algorithm as in-page (~line 2092).
      const ICON_SELECTOR = 'svg, img, i[class*="icon"], i[class^="fa"], i[class*=" fa"], i.material-icons, i.material-symbols-outlined, span.icon, [data-icon]';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIsIconButton = (el: any): boolean => {
        try {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role');
          const tabIdx = el.getAttribute('tabindex');
          const isClickable = tag === 'button' || tag === 'a'
            || role === 'button' || role === 'link' || role === 'menuitem'
            || el.hasAttribute('onclick')
            || (tabIdx !== null && parseInt(tabIdx, 10) >= 0);
          if (!isClickable) return false;
          const hasIconChild = el.querySelector(ICON_SELECTOR) !== null;
          if (!hasIconChild) return false;
          // cloneNode + remove icons + read remaining text — same trick.
          const clone = el.cloneNode(true);
          clone.querySelectorAll(ICON_SELECTOR).forEach((icon: { remove: () => void }) => icon.remove());
          const remainingText = (clone.textContent || '').replace(/\s+/g, '').trim();
          return remainingText.length === 0;
        } catch { return false; }
      };

      // labelText resolution: <label for>, wrapping <label>,
      // aria-labelledby. Skip raw textContent — that's `name`
      // (already in AX from Phase 3b).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getLabelText = (el: any): string | undefined => {
        try {
          // aria-labelledby — space-separated ids, concat their text.
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const parts: string[] = [];
            for (const id of labelledBy.split(/\s+/)) {
              if (!id) continue;
              const ref = doc.getElementById(id);
              if (ref) parts.push((ref.textContent || '').trim());
            }
            const joined = parts.join(' ').slice(0, 100);
            if (joined.length > 0) return joined;
          }
          // <label for=id>
          const id = el.id || el.getAttribute('id');
          if (id) {
            const lbl = doc.querySelector(`label[for="${cssEscape(id)}"]`);
            if (lbl) {
              const t = (lbl.textContent || '').trim().slice(0, 100);
              if (t) return t;
            }
          }
          // Wrapping <label>
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let cur: any = el.parentElement;
          for (let d = 0; d < 4 && cur; d++) {
            if (cur.tagName?.toLowerCase() === 'label') {
              // Strip the input itself before reading text.
              const clone = cur.cloneNode(true);
              clone.querySelectorAll('input, textarea, select').forEach((c: { remove: () => void }) => c.remove());
              const t = (clone.textContent || '').trim().slice(0, 100);
              if (t) return t;
              break;
            }
            cur = cur.parentElement;
          }
        } catch { /* DOM race — fall through */ }
        return undefined;
      };

      // nearestRowText: walk up to <tr>/[role=row]/li[role=option],
      // concat sibling cell text excluding self subtree.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const getNearestRowText = (el: any): string | undefined => {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let row: any = el.parentElement;
          for (let d = 0; d < 6 && row; d++) {
            const tag = row.tagName?.toLowerCase();
            const role = row.getAttribute('role');
            if (tag === 'tr' || role === 'row' || (tag === 'li' && role === 'option')) {
              break;
            }
            row = row.parentElement;
          }
          if (!row) return undefined;
          // Read row textContent without our subtree.
          const clone = row.cloneNode(true);
          // Remove the analogue of `el` from clone — match by ref.
          const ourRef = el.getAttribute('data-agent-ref');
          if (ourRef) {
            const dup = clone.querySelector(`[data-agent-ref="${cssEscape(ourRef)}"]`);
            if (dup) dup.remove();
          }
          const cells = clone.children
            ? Array.from(clone.children) as Array<{ textContent?: string }>
            : [];
          const parts: string[] = [];
          for (const cell of cells.slice(0, 4)) {
            const t = (cell.textContent || '').trim().slice(0, 50);
            if (t) parts.push(t);
          }
          const joined = parts.join(' | ').slice(0, 200);
          return joined.length >= 3 ? joined : undefined;
        } catch { return undefined; }
      };

      // ── isTopMostAtCenter — hit-test at element's center ─────
      // Byte-identical with snapshot-collector + background-dom-collector.
      // Returns true when the element (or its descendant) is at the
      // top of the stacking order at its visual center. Used by
      // resolver/pruner to demote covered elements.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIsTopMostAtCenter = (el: any): boolean | undefined => {
        try {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return undefined;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const w = (globalThis as any).window;
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          // Skip if center is off-viewport — hit-test would return null
          // and we'd report false positives. Off-viewport != covered.
          if (cx < 0 || cy < 0 || cx > w.innerWidth || cy > w.innerHeight) {
            return undefined;
          }
          const top = doc.elementFromPoint(cx, cy);
          if (!top) return undefined;
          return top === el || el.contains(top);
        } catch { return undefined; }
      };

      // ── childTestId — fallback testId from unique direct child ──
      // Byte-identical with snapshot-collector ~line 1763. Lifts a
      // testid from a single icon child (svg/i/img/span) when the
      // element itself is "descriptor-poor" (no own text/label/title/
      // alt/testid). Used by compiled-locator-executor: matches fingerprint
      // when the parent is too generic but the child is uniquely tagged.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeChildTestId = (el: any): string | undefined => {
        try {
          const ownLabelLikeText = (el.innerText || el.textContent || '').trim();
          const ownAriaLabel = el.getAttribute('aria-label');
          const ownTitle = el.getAttribute('title');
          const ownAlt = el.getAttribute('alt');
          const ownTestIdAttr = el.getAttribute('data-testid')
            || el.getAttribute('data-test')
            || el.getAttribute('data-cy')
            || el.getAttribute('data-qa-test-id');
          const elIsDescriptorPoor = !ownLabelLikeText && !ownAriaLabel && !ownTitle && !ownAlt && !ownTestIdAttr;
          if (!elIsDescriptorPoor) return undefined;
          const directKids = el.children || [];
          const childCands: string[] = [];
          for (let dki = 0; dki < directKids.length && childCands.length < 3; dki++) {
            const dk = directKids[dki];
            const dkTag = (dk.tagName || '').toLowerCase();
            if (dkTag === 'svg' || dkTag === 'i' || dkTag === 'img' || dkTag === 'span') {
              const dkTestId = dk.getAttribute('data-testid')
                || dk.getAttribute('data-test')
                || dk.getAttribute('data-cy')
                || dk.getAttribute('data-qa-test-id')
                || '';
              if (dkTestId) childCands.push(dkTestId);
              if (!dkTestId && dkTag === 'span' && dk.children && dk.children.length === 1) {
                const dkc = dk.children[0];
                const dkcTag = (dkc.tagName || '').toLowerCase();
                if (dkcTag === 'svg' || dkcTag === 'i' || dkcTag === 'img') {
                  const dkcTestId = dkc.getAttribute('data-testid')
                    || dkc.getAttribute('data-test')
                    || dkc.getAttribute('data-cy')
                    || dkc.getAttribute('data-qa-test-id')
                    || '';
                  if (dkcTestId) childCands.push(dkcTestId);
                }
              }
            }
          }
          // Symmetric with evaluate-path: only return when EXACTLY ONE
          // candidate (more = ambiguous, drop the field).
          return childCands.length === 1 ? childCands[0] : undefined;
        } catch { return undefined; }
      };

      // ── iconLabel — semantic label fallback for icon-only buttons ──
      // Byte-identical port of snapshot-collector ~line 2119. Tries
      // (in order): <img alt>, <svg><title>, <svg><desc>, <svg><use>
      // href, data-lucide/feather/icon/iconify-name. Only fires when
      // element has no aria-label/title (i.e., truly descriptor-poor).
      // Used by locator-plan-builder strategy 6 (iconLabel CSS attr
      // selector) and by candidateText for LLM resolver scoring.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIconLabel = (el: any): string | undefined => {
        try {
          const ariaLabel = el.getAttribute('aria-label');
          const titleAttr = el.getAttribute('title');
          if (ariaLabel || titleAttr) return undefined; // not descriptor-poor
          // <img alt>
          const img = el.querySelector('img[alt]');
          if (img) {
            const alt = (img.getAttribute('alt') || '').trim();
            if (alt.length > 0 && alt.length <= 100) return alt;
          }
          const svg = el.querySelector('svg');
          if (svg) {
            // <title>
            const svgTitle = svg.querySelector('title');
            if (svgTitle) {
              const t = (svgTitle.textContent || '').trim();
              if (t.length > 0 && t.length <= 100) return t;
            }
            // <desc>
            const svgDesc = svg.querySelector('desc');
            if (svgDesc) {
              const t = (svgDesc.textContent || '').trim();
              if (t.length > 0 && t.length <= 100) return t;
            }
            // <use href="#icon-folder"> — sprite reference
            const useEl = svg.querySelector('use');
            if (useEl) {
              const href = useEl.getAttribute('href') || useEl.getAttribute('xlink:href') || '';
              const iconRef = href.replace(/^#/, '').replace(/^icon[-_]/, '').replace(/[-_]/g, ' ').trim();
              if (iconRef.length > 0 && iconRef.length <= 50) return iconRef;
            }
          }
          // data-lucide / data-feather / data-icon / data-iconify-name
          const iconHolder = el.querySelector('[data-lucide], [data-feather], [data-icon], [data-iconify-name]')
            || (el.matches?.('[data-lucide], [data-feather], [data-icon], [data-iconify-name]') ? el : null);
          if (iconHolder) {
            const raw = iconHolder.getAttribute('data-lucide')
              || iconHolder.getAttribute('data-feather')
              || iconHolder.getAttribute('data-icon')
              || iconHolder.getAttribute('data-iconify-name')
              || '';
            const cleaned = raw.replace(/[-_:]/g, ' ').trim();
            if (cleaned.length > 0 && cleaned.length <= 50) return cleaned;
          }
        } catch { /* best-effort */ }
        return undefined;
      };

      // ── iconClasses — filtered icon-related class names ──
      // Byte-identical with snapshot-collector ~line 2588. Pulls
      // icon-library-prefixed classes from the element AND its
      // direct icon child (i, svg, span[class*=icon|fa-]) plus
      // data-* runtime icon attrs (Lucide/Feather/Iconify). Used
      // to disambiguate icon-only buttons that share role/text.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const computeIconClasses = (el: any): string | undefined => {
        try {
          const classStr = el.getAttribute('class') || '';
          const iconChild = el.querySelector('i, svg, span[class*="icon"], span[class*="fa-"]');
          const childClassStr = iconChild?.getAttribute('class') || '';
          const dataIconAttrs = [
            iconChild?.getAttribute('data-lucide'),
            iconChild?.getAttribute('data-feather'),
            iconChild?.getAttribute('data-icon'),
            iconChild?.getAttribute('data-iconify-name'),
            el.getAttribute('data-lucide'),
            el.getAttribute('data-feather'),
            el.getAttribute('data-icon'),
            el.getAttribute('data-iconify-name'),
          ].filter(Boolean).join(' ');
          const allClasses = `${classStr} ${childClassStr} ${dataIconAttrs}`.trim();
          if (!allClasses) return undefined;
          const iconMatches = allClasses.split(/\s+/).filter((c: string) =>
            /^(fa-|fa[srltdb]-|material-icons|mdi-|bi-|icon-|lucide-|heroicon|ri-|ti-|bx-|ph-|tabler-)/i.test(c)
            || /icon/i.test(c)
            || /[a-z]+-icon$/i.test(c)
            || /^[a-z]+:[a-z-]+$/i.test(c),
          );
          return iconMatches.length > 0 ? iconMatches.join(' ') : undefined;
        } catch { return undefined; }
      };

      for (const ref of refs) {
        const el = doc.querySelector(`[data-agent-ref="${cssEscape(ref)}"]`);
        if (!el) {
          out.push(null);
          continue;
        }
        const result: DomWalkResult = {
          firstTextFragment: extractFirstFragment(el),
          isIconButton: computeIsIconButton(el),
          labelText: getLabelText(el),
          nearestRowText: getNearestRowText(el),
          // Q1 audit additions — same DOM walk, no extra round-trip.
          isTopMostAtCenter: computeIsTopMostAtCenter(el),
          childTestId: computeChildTestId(el),
          iconClasses: computeIconClasses(el),
          iconLabel: computeIconLabel(el),
        };
        out.push(result);
      }
      return out;
    }, refs);

    // Merge results back. Build ref→element map ONCE — refs may not
    // be in the same order if Phase 3.5 dropped some elements.
    const elByRef = new Map<string, LiteElement>();
    for (const el of elements) {
      if (el.ref) elByRef.set(el.ref, el);
    }
    for (let i = 0; i < refs.length; i++) {
      const result = results[i];
      if (!result) continue;
      const el = elByRef.get(refs[i]);
      if (!el) continue;
      if (result.firstTextFragment) {
        // Skip when fragment === name to keep consumer logic simple
        // (LiteElement convention: fragment is meaningful only when
        // distinct from name).
        if (result.firstTextFragment !== el.name) {
          el.firstTextFragment = result.firstTextFragment;
        }
      }
      if (result.isIconButton) el.isIconButton = true;
      if (result.labelText) el.labelText = result.labelText;
      if (result.nearestRowText) el.nearestRowText = result.nearestRowText;
      // Q1 audit — only assign when defined to preserve "absent vs
      // false" distinction. `isTopMostAtCenter === undefined` (e.g.,
      // off-viewport) is meaningful: consumers treat undefined as
      // "didn't measure", false as "definitely covered". Don't conflate.
      if (typeof result.isTopMostAtCenter === 'boolean') {
        el.isTopMostAtCenter = result.isTopMostAtCenter;
      }
      if (result.childTestId) el.childTestId = result.childTestId;
      if (result.iconClasses) el.iconClasses = result.iconClasses;
      if (result.iconLabel) el.iconLabel = result.iconLabel;
    }
  }

  /**
   * Phase 5 — modal / active-overlay detection. Sets per-element
   * `isInsideActiveModal` and returns the active modal's ref if any.
   *
   * TODO Task 2.5: port the existing 4-rule heuristic from
   * snapshot-collector.ts (`detectActiveModal`):
   *   Rule 1: native `<dialog open>` (DS attribute presence)
   *   Rule 2: role=dialog / role=alertdialog / aria-modal=true
   *   Rule 3: positional fallback (z-index ≥ 1000 +
   *           ≥30% viewport coverage + cursor:pointer + class regex)
   *   Rule 4: detected via class-name patterns (Radix dialog,
   *           Headless UI dialog, etc.)
   *
   * After detection: walk every element's parent chain via
   * `parentRefChain` (already populated in mapping). If any ancestor
   * is the active modal, set `isInsideActiveModal = true`.
   *
   * Why Node-side and not in evaluate: the 4-rule heuristic walks
   * computed styles and bbox already in `raw`. Doing it in evaluate
   * would mean a second DOM walk after we already paid for the CDP
   * snapshot. Keep evaluate strictly for runtime-only fields.
   */
  private static detectModalsInPlace(elements: LiteElement[], raw: RawCdpBundle): string | undefined {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ds = raw.domSnapshot as any;
    const docs = Array.isArray(ds.documents) ? ds.documents : [];
    if (docs.length === 0) return undefined;

    // Conscious scope: implement Layer 1 (iron-clad ARIA / native
    // dialog signals) only. The existing collector also has Layer 2
    // (positional fallback with sidebar/header/footer exclusion +
    // viewport math). Layer 2 is ~80 lines of geometric heuristics
    // depending on the bbox high-water-mark and several edge-case
    // class regexes; porting it byte-for-byte without DOM access
    // turns into a re-implementation that's hard to keep symmetric.
    //
    // Decision: ship Layer 1 in CDP path. Shadow mode will report
    // divergence when Layer 2 catches a modal CDP missed; we
    // analyse the gap and decide based on real frequency whether
    // to port Layer 2, accept degradation, or fall back to evaluate
    // for pages where iron-clad signals are absent.
    //
    // Iron-clad signals (Layer 1):
    //   - role="dialog" / role="alertdialog"
    //   - aria-modal="true"
    //   - native <dialog> with `open` attribute
    //
    // Picking ONE modal among matches: highest computedZIndex wins
    // (same tiebreaker as in-page collector).

    let bestRef: string | undefined;
    let bestZ = -Infinity;

    // Build ds-index → element map for fast lookup. We need this
    // because the elements[] is filtered to interactive set; modal
    // CONTAINERS often aren't interactive themselves but appear as
    // separate DS nodes. So we walk DS directly here, not elements[].
    const elementByDsIdx = new Map<number, LiteElement>();
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const docIdx = (el as any).__docIndex as number | undefined;
      if (typeof dsIdx === 'number' && (docIdx ?? 0) === 0) {
        elementByDsIdx.set(dsIdx, el);
      }
    }

    const mainDoc = docs[0];
    const strings: string[] = Array.isArray(ds.strings) ? ds.strings : [];
    const getStr = (idx: number | undefined): string =>
      typeof idx === 'number' && idx >= 0 && idx < strings.length ? String(strings[idx] ?? '') : '';
    const nodes = mainDoc.nodes;
    const layout = mainDoc.layout ?? {};
    const layoutNodeIndex: number[] = layout.nodeIndex ?? [];
    const layoutByNodeIdx = new Map<number, number>();
    for (let i = 0; i < layoutNodeIndex.length; i++) {
      layoutByNodeIdx.set(layoutNodeIndex[i], i);
    }

    const nodeCount = nodes.nodeName?.length ?? 0;
    for (let i = 0; i < nodeCount; i++) {
      const tag = getStr(nodes.nodeName?.[i]).toLowerCase();
      if (!tag) continue;

      const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
      const role = (attrs.get('role') || '').toLowerCase();
      const ariaModal = attrs.get('aria-modal') === 'true';
      const isNativeDialog = tag === 'dialog' && attrs.has('open');

      const isModal = isNativeDialog || ariaModal || role === 'dialog' || role === 'alertdialog';
      if (!isModal) continue;

      // Visibility gate via computed styles. If element is hidden,
      // don't treat it as the active modal even if it has the role.
      const layoutIdx = layoutByNodeIdx.get(i);
      const styles = layoutIdx !== undefined ? decodeStylesForLayoutIdx(layout, layoutIdx, getStr) : undefined;
      if (styles) {
        if (styles.display === 'none' || styles.visibility === 'hidden') continue;
        if (parseFloat(styles.opacity || '1') < 0.1) continue;
      }

      // Tiebreaker: highest z-index wins (matches in-page Layer 1
      // logic at line ~198). Native <dialog> with showModal() goes
      // into the top layer, browser handles z-index implicitly —
      // give them +Infinity so they always win.
      let z = 0;
      if (isNativeDialog) z = Number.POSITIVE_INFINITY;
      else if (styles?.zIndex && styles.zIndex !== 'auto') {
        const parsed = parseInt(styles.zIndex, 10);
        if (!isNaN(parsed)) z = parsed;
      }
      if (z <= bestZ) continue;

      // Modal node may or may not be interactive (in elements[]).
      // If it has a ref already (from Phase 3.5 because it passed
      // interactive filter), use that. Otherwise the modal container
      // doesn't have a ref — we leave activeModalRef as the
      // ds-index-derived placeholder. In practice modal containers
      // tend to be non-interactive divs without refs, so we fall
      // back to scanning interactive descendants when ref is absent.
      const directRef = elementByDsIdx.get(i)?.ref;
      if (directRef) {
        bestRef = directRef;
        bestZ = z;
      } else {
        // No direct ref — check if any descendant element is in our
        // interactive set; use the first match's ancestor chain to
        // confirm modal-ness. This is a degraded path; ideally we'd
        // assign the modal a ref via a separate evaluate, but that
        // costs another round-trip just for the modal container.
        // Defer to evaluate fallback if shadow mode shows this case
        // matters in practice.
        // For now: skip this modal in CDP path output. The
        // per-element `isInsideActiveModal` flag below uses ds
        // ancestry instead of needing a single bestRef.
        // (z still tracked above; bestRef stays undefined.)
      }
    }

    // Per-element walk: mark `isInsideActiveModal=true` for any
    // element whose DS ancestor chain crosses ANY iron-clad modal
    // node (not just bestRef — we want to flag elements inside the
    // currently-shown modal even if its container doesn't have a
    // LiteElement entry). This matches the in-page collector's
    // isInsideActiveModal field semantics (line ~2487).
    const modalDsIndexes = new Set<number>();
    for (let i = 0; i < nodeCount; i++) {
      const tag = getStr(nodes.nodeName?.[i]).toLowerCase();
      const attrs = decodeAttributes(nodes.attributes?.[i], getStr);
      const role = (attrs.get('role') || '').toLowerCase();
      const ariaModal = attrs.get('aria-modal') === 'true';
      const isNativeDialog = tag === 'dialog' && attrs.has('open');
      if (isNativeDialog || ariaModal || role === 'dialog' || role === 'alertdialog') {
        modalDsIndexes.add(i);
      }
    }

    if (modalDsIndexes.size === 0) return bestRef;

    const parentIndex: number[] = nodes.parentIndex ?? [];
    for (const el of elements) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const dsIdx = (el as any).__dsNodeIndex as number | undefined;
      if (typeof dsIdx !== 'number') continue;
      let cur = parentIndex[dsIdx];
      // Walk up to depth 12 — modal nesting depth practical cap;
      // matches in-page DOM walk-up semantics.
      let depth = 0;
      while (cur !== undefined && cur >= 0 && depth < 12) {
        if (modalDsIndexes.has(cur)) {
          el.isInsideActiveModal = true;
          break;
        }
        cur = parentIndex[cur];
        depth++;
      }
    }

    return bestRef;
  }

  /**
   * Phase 5b — overlay state enrichment (transientState + obstacleFacts +
   * Layer 2 modal positional fallback) in ONE batched evaluate.
   *
   * Why one combined evaluate (not three):
   *   All three artefacts walk the same set of positioned elements and
   *   read the same getComputedStyle. Three separate evaluates means
   *   three round-trips and three style recalcs. Bundling shaves 100-300ms
   *   on dense pages and keeps the contract simple — one phase, one result.
   *
   * Symmetry contract with snapshot-collector.ts:
   *   - transientState: 6-level cascade is byte-identical (progressbar,
   *     aria-busy, aria-live + loading text, skeleton, spinner+animation,
   *     loading-text walk).
   *   - obstacleFacts: same selectors (POSITIONAL_CANDIDATES_SELECTOR +
   *     IRON_CLAD_MODAL_SELECTORS), same filters (position, opacity,
   *     z-index, coverage ≥ 3%), same hintType signals (W3C ARIA spec
   *     only — modal/sticky_header/sticky_footer; everything else is
   *     'unknown' for Observer LLM to classify), same top-15 cap by
   *     z-index descending.
   *   - layer2ModalRef: same logic — pick highest-z obstacle whose
   *     coverage ≥ 30% and that contains interactive children. ONLY
   *     applied when Layer 1 (iron-clad) didn't already pick a modal.
   *
   * Refs:
   *   Element refs are reused — `data-agent-ref` was already assigned
   *   in Phase 3.5. Each artefact's `ref` field is the existing ref
   *   string; for elements outside the interactive set we don't synthesise
   *   new refs (matches evaluate-path behaviour for transientState
   *   targets that are NOT interactive — recorder lookup tolerates this
   *   because transient state is consumed by ObserverAgent, not by
   *   element resolver).
   *
   * Failure mode: if the evaluate throws (page closed mid-collect, etc.),
   * we swallow and return empty values. The snapshot stays usable — the
   * downstream Observer/Pruner just won't see loading/overlay state for
   * this tick. Same forgiving behaviour as `enrichWithDomWalkFields`.
   */
  private static async enrichWithOverlayState(
    page: Page,
    activeModalRefAlreadyDetected: string | undefined,
  ): Promise<{
    transientState?: TransientStateInfo;
    obstacleFacts?: ObstacleFact[];
    layer2ModalRef?: string;
    /**
     * Layer 1 ref RESCUE — when Phase 5 detected an iron-clad modal in
     * DS but couldn't return a `bestRef` because the modal container
     * isn't in the interactive elements[] set (typical for `<dialog>`
     * which has no role/tabindex/onclick by default). Phase 5b's evaluate
     * is already walking the DOM, so it cheaply assigns `data-agent-ref`
     * to the modal node itself and returns it here. Phase 6 then promotes
     * this into `LiteSnapshot.activeModalRef`. Without this rescue, real
     * Chromium pages with `<dialog open>` left activeModalRef undefined
     * → ObserverAgent / Pruner couldn't tell which modal was active.
     * Caught by integration test on real browser.
     */
    layer1ModalRef?: string;
  }> {
    type Result = {
      transientState?: TransientStateInfo;
      obstacleFacts?: ObstacleFact[];
      layer2ModalRef?: string;
      layer1ModalRef?: string;
    };

    // Resilience: hard wall-clock cap on the entire Phase 5b evaluate.
    // If the page's JS event loop is jammed (infinite redirect loop in
    // a third-party SDK, runaway useEffect, blocked main thread), the
    // evaluate would otherwise wait the full Playwright default timeout
    // (~30s) before failing. We cap it at 5s — long enough for legit
    // dense-page detection, short enough that snapshot-collect stays
    // bounded even under a misbehaving page. Defaults applied on
    // timeout (snapshot still returned; just no overlay context this
    // tick).
    const PHASE_5B_HARD_TIMEOUT_MS = 5000;

    // Watchdog budgets passed INTO the evaluate. The browser code uses
    // these as soft deadlines — if a level takes longer than its slice,
    // the cascade short-circuits to {isTransient:false}. Defence in
    // depth: even if Promise.race fails to fire (e.g., evaluate already
    // serialising the result), the inner watchdog stops runaway DOM
    // walks. Numbers chosen so that under healthy conditions all 6
    // levels finish well under budget on an 11k-DOM page.
    const PHASE_5B_INNER_BUDGET_MS = 4000; // < hard timeout so race winner is the inner timeout
    const LEVEL_6_TEXT_NODE_CAP = 500;     // text-node walk hard cap
    const LEVEL_6_PATTERN_NODE_CAP = 100;  // per-pattern attempts within Level 6

    const overlayPromise = page.evaluate(
      ({
        positionalSelector,
        ironCladSelectors,
        closeButtonSelector,
        interactiveSelector,
        alreadyHaveModal,
        innerBudgetMs,
        textNodeCap,
        patternNodeCap,
      }: {
        positionalSelector: string;
        ironCladSelectors: string;
        closeButtonSelector: string;
        interactiveSelector: string;
        alreadyHaveModal: boolean;
        innerBudgetMs: number;
        textNodeCap: number;
        patternNodeCap: number;
      }): Result => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const win = (globalThis as any).window;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const doc = (globalThis as any).document;
        if (!doc || !win) return {};

        // Inner wall-clock budget. Sampled at every cascade boundary
        // so a runaway level can never exceed `innerBudgetMs` without
        // bailing. `performance.now()` is monotonic and unaffected by
        // page time changes; falls back to Date.now() if unavailable
        // (rare; some sandboxed iframes).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nowFn: () => number = (win as any).performance?.now
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ? () => (win as any).performance.now()
          : () => Date.now();
        const startedAt = nowFn();
        const overBudget = (): boolean => nowFn() - startedAt > innerBudgetMs;

        // Reuse the existing recorder/snapshot-collector counter so
        // refs interleave deterministically. Init at 0 to match the
        // evaluate-path (snapshot-collector starts at 0); if the
        // counter is already a number we trust whatever value Phase
        // 3.5 / recorder set. Initialising at 1 (previous version)
        // could collide with `e0` assignments in fresh sessions.
        if (typeof win.__agentRefCounter !== 'number') {
          win.__agentRefCounter = 0;
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ensureRef = (el: any): string => {
          let ref = el.getAttribute('data-agent-ref');
          if (!ref) {
            ref = `e${win.__agentRefCounter++}`;
            el.setAttribute('data-agent-ref', ref);
          }
          return ref;
        };

          // ─────────────────────────────────────────────────────────
          // 1. Transient state detection (6-level cascade)
          // Byte-identical port of snapshot-collector.ts
          // detectTransientState (lines 363-461) PLUS:
          //   - fast-path early exit when no candidate selector matches
          //   - inner watchdog (overBudget) at every cascade boundary
          //   - Level 6 uses textContent (no layout flush) + node cap
          // ─────────────────────────────────────────────────────────
          const detectTransientState = (): TransientStateInfo => {
            const loadingPatterns = [
              'loading', 'загрузка', 'please wait', 'подождите',
              'spinner', 'processing', 'обработка', 'loading...',
              'загружается', 'пожалуйста, подождите',
            ];

            // Fast-path: combined cheap probe. If NONE of the candidate
            // selectors match anywhere on the page, Levels 1-5 cannot
            // fire — and we skip Level 6 (the expensive text walk) when
            // a quick body.textContent scan also has no loading text.
            // Saves ~50-200ms on the typical "calm page" tick.
            const FAST_PATH_SELECTOR =
              '[role="progressbar"]:not([aria-hidden="true"]),'
              + '[aria-busy="true"],'
              + '[aria-live],'
              + '.skeleton,.skeleton-loader,[data-skeleton],.placeholder-glow,'
              + '.spinner,.loader,.loading,[class*="spinner"],[class*="loader"],[data-loading]';
            let hasCandidate = false;
            try {
              hasCandidate = !!doc.querySelector(FAST_PATH_SELECTOR);
            } catch {
              // querySelector on mid-navigation document can throw —
              // assume worst case and proceed.
              hasCandidate = true;
            }
            if (!hasCandidate) {
              // Level 6 also needs to check for bare "Loading…" text
              // even when no class hints exist — but only if a quick
              // textContent peek hints at one of the patterns. textContent
              // is layout-free (vs innerText), so this check costs O(text
              // length) without forcing a reflow.
              const bodyText = (doc.body?.textContent || '').toLowerCase();
              const anyPattern = loadingPatterns.some((p) => bodyText.includes(p));
              if (!anyPattern) {
                return { isTransient: false };
              }
              // Else: fall through to Level 6 only.
            }

            // Level 1: role=progressbar (W3C ARIA spec)
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const progressbar = doc.querySelector('[role="progressbar"]:not([aria-hidden="true"])');
              if (progressbar) {
                const style = win.getComputedStyle(progressbar);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return { isTransient: true, type: 'progressbar', ref: ensureRef(progressbar) };
                }
              }
            }

            // Level 2: aria-busy=true (W3C ARIA spec)
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const busyElement = doc.querySelector('[aria-busy="true"]');
              if (busyElement) {
                const style = win.getComputedStyle(busyElement);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return { isTransient: true, type: 'aria-busy', ref: ensureRef(busyElement) };
                }
              }
            }

            // Level 3: aria-live region with loading text (W3C ARIA spec
            // + multilingual patterns).
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const liveRegions = doc.querySelectorAll('[aria-live]');
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const region of Array.from(liveRegions) as any[]) {
                if (overBudget()) return { isTransient: false };
                const text = (region.textContent || '').toLowerCase();
                if (loadingPatterns.some((p) => text.includes(p))) {
                  return {
                    isTransient: true,
                    type: 'aria-live',
                    ref: ensureRef(region),
                    text: text.slice(0, 50),
                  };
                }
              }
            }

            // Level 4: skeleton loaders (industry convention).
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const skeleton = doc.querySelector(
                '.skeleton, .skeleton-loader, [data-skeleton], .placeholder-glow',
              );
              if (skeleton) {
                const style = win.getComputedStyle(skeleton);
                if (style.display !== 'none' && style.visibility !== 'hidden') {
                  return { isTransient: true, type: 'skeleton', ref: ensureRef(skeleton) };
                }
              }
            }

            // Level 5: spinner classes + animation. The animation gate
            // prevents false positives on inert ".loader" containers
            // that hold a non-spinning placeholder.
            if (overBudget()) return { isTransient: false };
            if (hasCandidate) {
              const spinnerSelectors =
                '.spinner, .loader, .loading, [class*="spinner"], [class*="loader"], [data-loading]';
              const spinners = doc.querySelectorAll(spinnerSelectors);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const spinner of Array.from(spinners) as any[]) {
                if (overBudget()) return { isTransient: false };
                const style = win.getComputedStyle(spinner);
                if (
                  style.display !== 'none'
                  && style.visibility !== 'hidden'
                  && parseFloat(style.opacity) > 0.3
                ) {
                  const animationName = style.animationName;
                  const animationDuration = parseFloat(style.animationDuration);
                  if (animationName && animationName !== 'none' && animationDuration > 0) {
                    return { isTransient: true, type: 'spinner', ref: ensureRef(spinner) };
                  }
                }
              }
            }

            // Level 6: bare "Loading..." text walk. Last-ditch — no
            // ARIA/class hints, just visible text.
            //
            // Resilience contract:
            //   - textContent (NOT innerText): no layout flush.
            //     5× faster on dense pages, includes hidden text but
            //     we re-validate per parent below.
            //   - Hard cap on total text-node visits across all
            //     patterns (`textNodeCap`, default 500). Prevents
            //     runaway TreeWalker on pages with thousands of text
            //     nodes.
            //   - Per-pattern cap (`patternNodeCap`, default 100) so
            //     a single pattern can't monopolise the budget.
            //   - overBudget() check on every iteration.
            if (overBudget()) return { isTransient: false };
            if (!doc.body) return { isTransient: false };

            const bodyTextSearch = (doc.body.textContent || '').toLowerCase();
            let totalVisited = 0;
            for (const pattern of loadingPatterns) {
              if (overBudget()) break;
              if (totalVisited >= textNodeCap) break;
              if (!bodyTextSearch.includes(pattern)) continue;

              const walker = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */, null);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let node: any;
              let visitedThisPattern = 0;
              while ((node = walker.nextNode())) {
                totalVisited++;
                visitedThisPattern++;
                if (visitedThisPattern > patternNodeCap) break;
                if (totalVisited > textNodeCap) break;
                if (overBudget()) break;
                if (node.textContent?.toLowerCase().includes(pattern)) {
                  const parent = node.parentElement;
                  if (parent) {
                    const style = win.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                      return {
                        isTransient: true,
                        type: 'loading-text',
                        ref: ensureRef(parent),
                        text: pattern,
                      };
                    }
                  }
                  break;
                }
              }
            }

            return { isTransient: false };
          };

          // ─────────────────────────────────────────────────────────
          // 2. Obstacle facts collection (positioned overlay inventory)
          // Byte-identical port of snapshot-collector.ts
          // collectObstacleFacts (lines 470-565).
          // ─────────────────────────────────────────────────────────
          const collectObstacleFacts = (): ObstacleFact[] => {
            const vpW = win.innerWidth;
            const vpH = win.innerHeight;
            const viewportArea = vpW * vpH;
            if (viewportArea === 0) return [];

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const positionalCandidates = Array.from(
              doc.querySelectorAll(positionalSelector),
            ) as any[];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const ironCladMatches = Array.from(
              doc.querySelectorAll(ironCladSelectors),
            ) as any[];

            // Dedup — iron-clad goes first so its order wins for any
            // overlap (deterministic for tests).
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const seen = new WeakSet<any>();
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const candidates: any[] = [];
            for (const el of [...ironCladMatches, ...positionalCandidates]) {
              if (seen.has(el)) continue;
              seen.add(el);
              candidates.push(el);
            }

            const facts: ObstacleFact[] = [];
            for (const el of candidates) {
              // Watchdog: bail out of obstacleFacts collection if the
              // overall budget is exhausted. Returning whatever we have
              // so far is preferable to a runaway walk on pages with
              // thousands of positioned children. Sort + slice(15) below
              // still works on a partial array.
              if (overBudget()) break;
              const style = win.getComputedStyle(el);
              const position = style.position;
              if (position !== 'fixed' && position !== 'absolute' && position !== 'sticky') continue;
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              if (parseFloat(style.opacity) < 0.1) continue;

              const zIndex = parseInt(style.zIndex, 10);
              if (isNaN(zIndex)) continue;
              if (position !== 'sticky' && zIndex < 1) continue;

              const rect = el.getBoundingClientRect();
              const area = rect.width * rect.height;
              const coverage = area / viewportArea;
              if (coverage < 0.03) continue;

              const tag = el.tagName.toLowerCase();
              const className = (el.getAttribute('class') || '').slice(0, 200);
              const textPreview = (el.textContent || '').trim().slice(0, 200);
              const idAttr = (el.getAttribute('id') || '').slice(0, 100);
              const role = (el.getAttribute('role') || '').replace(/["']/g, '').trim() || undefined;
              const ariaModal =
                (el.getAttribute('aria-modal') || '').replace(/["']/g, '').trim() === 'true' || undefined;
              const hasCloseButton = el.querySelector(closeButtonSelector) !== null;
              const hasInteractiveChildren = el.querySelector(interactiveSelector) !== null;
              const ref = ensureRef(el);

              // hintType: ONLY W3C spec signals + geometry. Class-name
              // classification is delegated to ObserverAgent (LLM Layer 2).
              let hintType: ObstacleFact['hintType'] = 'unknown';
              if (role === 'dialog' || role === 'alertdialog' || ariaModal) {
                hintType = 'modal';
              } else if (
                (position === 'sticky' || position === 'fixed')
                && rect.top <= 5
                && rect.height < 120
              ) {
                hintType = 'sticky_header';
              } else if (
                (position === 'sticky' || position === 'fixed')
                && rect.bottom >= vpH - 5
                && rect.height < 120
              ) {
                hintType = 'sticky_footer';
              }

              facts.push({
                ref,
                tag,
                position: position as ObstacleFact['position'],
                zIndex,
                coverage: Math.round(coverage * 1000) / 1000,
                className,
                textPreview,
                id: idAttr || undefined,
                hasCloseButton,
                hasInteractiveChildren,
                role,
                ariaModal,
                rect: {
                  top: Math.round(rect.top),
                  left: Math.round(rect.left),
                  width: Math.round(rect.width),
                  height: Math.round(rect.height),
                },
                hintType,
              });
            }

            facts.sort((a, b) => b.zIndex - a.zIndex);
            return facts.slice(0, 15);
          };

          // ─────────────────────────────────────────────────────────
          // 3. Layer 2 modal positional fallback. Only runs when Layer 1
          // (iron-clad ARIA) didn't already pick a modal — otherwise
          // we'd needlessly second-guess a deterministic signal.
          //
          // Rule: among collected obstacleFacts, pick the highest-z
          // candidate that:
          //   - covers ≥ 30% of viewport, AND
          //   - has interactive children (so it's actionable, not a
          //     decorative banner), AND
          //   - hintType !== 'sticky_header' / 'sticky_footer' (geometry
          //     already disqualified the sticky bars).
          //
          // This is deliberately narrower than evaluate-path Layer 2 to
          // avoid false positives on cookie banners. Shadow logs in
          // production told us false-positive cookie banners were the
          // top divergence source; constraining to ≥30% coverage AND
          // interactive removes that class entirely.
          // ─────────────────────────────────────────────────────────
          const obstacleFacts = collectObstacleFacts();
          let layer2ModalRef: string | undefined;
          if (!alreadyHaveModal) {
            for (const f of obstacleFacts) {
              if (f.coverage < 0.3) continue;
              if (!f.hasInteractiveChildren) continue;
              if (f.hintType === 'sticky_header' || f.hintType === 'sticky_footer') continue;
              layer2ModalRef = f.ref;
              break;
            }
          }

          // ─────────────────────────────────────────────────────────
          // 4. Layer 1 ref RESCUE. Phase 5 (Node-side) sets bestRef
          // ONLY if the modal container is in the interactive elements
          // set. <dialog>, <div role=dialog>, etc., usually aren't —
          // they have no role on tags like <dialog> nor onclick handlers,
          // so the interactive filter skips them. Result before this
          // rescue: real-Chromium pages with <dialog open> had
          // activeModalRef = undefined.
          //
          // Rescue: we're already inside an evaluate, so cheaply find
          // the topmost iron-clad modal element, ensure it has
          // data-agent-ref (synthesise one if missing), and return it.
          // Phase 6 promotes this when activeModalRef is still undefined.
          // ─────────────────────────────────────────────────────────
          let layer1ModalRef: string | undefined;
          if (!alreadyHaveModal) {
            try {
              const ironCladNodes = doc.querySelectorAll(ironCladSelectors);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const visible: any[] = [];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              for (const el of Array.from(ironCladNodes) as any[]) {
                if (overBudget()) break;
                const style = win.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') continue;
                if (parseFloat(style.opacity) < 0.1) continue;
                visible.push(el);
              }
              // Tiebreaker: highest z-index wins (matches Phase 5
              // Node-side ranking). Native <dialog open> has implicit
              // top-layer z, so we treat it as +Infinity.
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let best: any = null;
              let bestZ = -Infinity;
              for (const el of visible) {
                const tag = el.tagName?.toLowerCase();
                const isNativeDialog = tag === 'dialog' && el.hasAttribute('open');
                const style = win.getComputedStyle(el);
                let z = 0;
                if (isNativeDialog) {
                  z = Number.POSITIVE_INFINITY;
                } else if (style.zIndex && style.zIndex !== 'auto') {
                  const parsed = parseInt(style.zIndex, 10);
                  if (!isNaN(parsed)) z = parsed;
                }
                if (z > bestZ) {
                  best = el;
                  bestZ = z;
                }
              }
              if (best) {
                layer1ModalRef = ensureRef(best);
              }
            } catch {
              // Rescue is best-effort. If it throws, we fall back to
              // Layer 2 / undefined activeModalRef — same as before
              // this rescue existed. Never blocks main pipeline.
            }
          }

          return {
            transientState: detectTransientState(),
            obstacleFacts: obstacleFacts.length > 0 ? obstacleFacts : undefined,
            layer2ModalRef,
            layer1ModalRef,
          };
        },
        {
          positionalSelector: POSITIONAL_CANDIDATES_SELECTOR,
          ironCladSelectors: IRON_CLAD_MODAL_SELECTORS,
          closeButtonSelector: CLOSE_BUTTON_SELECTOR,
          interactiveSelector: INTERACTIVE_CHILDREN_SELECTOR,
          alreadyHaveModal: !!activeModalRefAlreadyDetected,
          innerBudgetMs: PHASE_5B_INNER_BUDGET_MS,
          textNodeCap: LEVEL_6_TEXT_NODE_CAP,
          patternNodeCap: LEVEL_6_PATTERN_NODE_CAP,
        },
      );

    // Wall-clock outer guard. The inner watchdog (overBudget) protects
    // against runaway DOM walks; this outer race protects against the
    // evaluate itself failing to return — page event loop fully blocked,
    // CDP transport stalled, etc. We pick a sentinel symbol on timeout
    // so we can distinguish it from a legitimate empty `{}` result.
    const TIMED_OUT = Symbol('phase5b-timeout');
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timeoutHandle = setTimeout(() => resolve(TIMED_OUT), PHASE_5B_HARD_TIMEOUT_MS);
    });

    try {
      const winner = await Promise.race([overlayPromise, timeoutPromise]);
      if (winner === TIMED_OUT) {
        // Don't await overlayPromise — it may finish later but we've
        // already moved on. Attach a no-op error handler to suppress
        // unhandled-rejection warnings in case the page closes mid-walk.
        overlayPromise.catch(() => {});
        logger.warn('[CDP_SNAPSHOT] enrichWithOverlayState hit hard timeout', {
          hardTimeoutMs: PHASE_5B_HARD_TIMEOUT_MS,
        });
        return {};
      }
      return winner;
    } catch (err) {
      // Distinguish kinds of failure for observability — page-closed
      // races are noise (debug); TypeError / ReferenceError signal a
      // logic bug we want to surface (warn). Same swallow-and-default
      // posture either way: the snapshot is still usable without
      // overlay context.
      const message = err instanceof Error ? err.message : String(err);
      const isPageGone =
        err instanceof Error
        && (
          /Target closed|Execution context was destroyed|Page closed|page has been closed/i.test(message)
        );
      if (isPageGone) {
        logger.debug('[CDP_SNAPSHOT] enrichWithOverlayState page-gone (non-fatal)', { error: message });
      } else {
        logger.warn('[CDP_SNAPSHOT] enrichWithOverlayState evaluate failed (non-fatal)', {
          error: message,
          name: err instanceof Error ? err.name : 'unknown',
        });
      }
      return {};
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  }
}

/**
 * Testing-only export of internal helpers. NOT for production
 * consumers — CdpSnapshotService.collect is the public surface.
 * This namespace exists because the helpers are too granular to
 * meaningfully test through the public method (you'd need to mock
 * a full CDP+Page pipeline just to verify `parseTabIndex`).
 *
 * Cost of NOT exporting: tests duplicate parser logic, drift between
 * implementation and assertions, regressions slip through.
 *
 * Cost of exporting: mild API surface bloat. Mitigated by the
 * `__internalsForTesting` name — anyone touching this in production
 * code will see the warning at the call site.
 */
export const __internalsForTesting = {
  decodeAttributes,
  decodeStylesForLayoutIdx,
  decodeBoundsForLayoutIdx,
  isInteractiveNode,
  parseTriState,
  parseAriaChecked,
  parseFloatOrUndefined,
  parseTabIndex,
  tagToImplicitLandmarkRole,
  computeIsSensitiveInput,
  detectAttributeBasedFramework,
};
