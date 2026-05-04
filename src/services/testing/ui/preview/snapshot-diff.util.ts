/**
 * Snapshot Diff utility (Etap 2 — shadow mode validation harness)
 *
 * Compares two `LiteSnapshot` results from different sources (CDP vs
 * evaluate) and produces a structured divergence report. Used in Week 3
 * shadow mode where the router runs both paths in parallel for the same
 * page and we need to know whether they agree before flipping CDP to
 * primary.
 *
 * Comparison philosophy:
 *   - Element identity is by `ref` (a counter-based attribute set on
 *     both paths — should agree if both walk DOM in the same order).
 *   - Field-level diffs are surfaced per-element, not aggregated, so
 *     analysis can spot patterns ("CDP misses `frameworkClickable` on
 *     React divs only").
 *   - Numeric tolerances: bbox coords within 1px, durations are not
 *     compared (different sources have different latency profiles).
 *   - Order matters for some fields (`parentRefChain`, `containerTitles`)
 *     and we compare them as ordered lists.
 *
 * Output is intentionally verbose — shadow analysis runs offline against
 * production logs, so token / log-line cost is acceptable. Production
 * callers should never invoke this on the hot path.
 *
 * NOT a JSON diff library replacement: we know the shape, so direct
 * field-by-field comparison gives better signal than a generic diff.
 */

import type { LiteElement, LiteSnapshot } from '@/agent/core/lite/lite-types';

export interface SnapshotDiffReport {
  /** Whether the two snapshots match within tolerances. */
  match: boolean;
  /** Top-level (LiteSnapshot itself) divergences — url, viewport, etc. */
  topLevelDiffs: TopLevelDiff[];
  /** Refs that exist in `a` but not in `b`. */
  onlyInA: string[];
  /** Refs that exist in `b` but not in `a`. */
  onlyInB: string[];
  /** Per-element field differences for refs present in both. */
  elementDiffs: ElementFieldDiff[];
  /** Quick summary numbers for dashboards. */
  summary: {
    aElementCount: number;
    bElementCount: number;
    matchedElementCount: number;
    elementsWithFieldDiffs: number;
    /** Histogram: how many divergences per field name (e.g., `frameworkClickable: 47`). */
    fieldDivergenceHistogram: Record<string, number>;
  };
}

export interface TopLevelDiff {
  field: keyof LiteSnapshot;
  a: unknown;
  b: unknown;
}

export interface ElementFieldDiff {
  ref: string;
  /** For diagnostics: tag of the element in `a` (helps recognise patterns). */
  tag?: string;
  diffs: Array<{ field: keyof LiteElement; a: unknown; b: unknown }>;
}

/**
 * Bounding box pixel tolerance. CDP layout.bounds and getBoundingClientRect
 * both report subpixel values; rounding differences below this are noise.
 */
const BBOX_TOLERANCE_PX = 1;

/**
 * Fields skipped during element comparison — either non-deterministic or
 * not meaningful for source equivalence:
 *   - `value`: privacy-masked, never compared raw
 *   - timing-derived (none in LiteElement currently, but reserved)
 */
const ELEMENT_FIELDS_SKIP = new Set<keyof LiteElement>([
  'value',
]);

/**
 * Compare two snapshots and produce a diff report.
 *
 * Pure function — no logging, no side effects. Caller decides what to
 * do with the result (log, alert, persist for offline analysis).
 */
export function diffSnapshots(a: LiteSnapshot, b: LiteSnapshot): SnapshotDiffReport {
  const topLevelDiffs = compareTopLevel(a, b);

  const aByRef = new Map(a.elements.map((e) => [e.ref, e]));
  const bByRef = new Map(b.elements.map((e) => [e.ref, e]));

  const onlyInA: string[] = [];
  const onlyInB: string[] = [];
  for (const ref of aByRef.keys()) {
    if (!bByRef.has(ref)) onlyInA.push(ref);
  }
  for (const ref of bByRef.keys()) {
    if (!aByRef.has(ref)) onlyInB.push(ref);
  }

  const elementDiffs: ElementFieldDiff[] = [];
  const histogram: Record<string, number> = {};
  let elementsWithDiffs = 0;

  for (const [ref, aEl] of aByRef.entries()) {
    const bEl = bByRef.get(ref);
    if (!bEl) continue; // already in onlyInA
    const fieldDiffs = compareElementFields(aEl, bEl);
    if (fieldDiffs.length > 0) {
      elementDiffs.push({ ref, tag: aEl.tag, diffs: fieldDiffs });
      elementsWithDiffs++;
      for (const fd of fieldDiffs) {
        histogram[fd.field as string] = (histogram[fd.field as string] ?? 0) + 1;
      }
    }
  }

  const matchedElementCount = aByRef.size - onlyInA.length;
  const match =
    topLevelDiffs.length === 0
    && onlyInA.length === 0
    && onlyInB.length === 0
    && elementDiffs.length === 0;

  return {
    match,
    topLevelDiffs,
    onlyInA,
    onlyInB,
    elementDiffs,
    summary: {
      aElementCount: a.elements.length,
      bElementCount: b.elements.length,
      matchedElementCount,
      elementsWithFieldDiffs: elementsWithDiffs,
      fieldDivergenceHistogram: histogram,
    },
  };
}

function compareTopLevel(a: LiteSnapshot, b: LiteSnapshot): TopLevelDiff[] {
  const out: TopLevelDiff[] = [];
  if (a.url !== b.url) out.push({ field: 'url', a: a.url, b: b.url });
  if (a.title !== b.title) out.push({ field: 'title', a: a.title, b: b.title });
  if (a.activeModalRef !== b.activeModalRef) {
    out.push({ field: 'activeModalRef', a: a.activeModalRef, b: b.activeModalRef });
  }
  // viewport: rarely diverges, but matters for buildAllowedSets.
  const av = a.viewport;
  const bv = b.viewport;
  if (av?.width !== bv?.width || av?.height !== bv?.height) {
    out.push({ field: 'viewport', a: av, b: bv });
  }
  // timestamp intentionally NOT compared — sources have inherent skew.
  return out;
}

function compareElementFields(a: LiteElement, b: LiteElement): Array<{ field: keyof LiteElement; a: unknown; b: unknown }> {
  const diffs: Array<{ field: keyof LiteElement; a: unknown; b: unknown }> = [];
  const fieldNames = new Set<keyof LiteElement>([
    ...(Object.keys(a) as Array<keyof LiteElement>),
    ...(Object.keys(b) as Array<keyof LiteElement>),
  ]);
  for (const field of fieldNames) {
    if (ELEMENT_FIELDS_SKIP.has(field)) continue;
    const av = a[field];
    const bv = b[field];
    if (!fieldEquals(field, av, bv)) {
      diffs.push({ field, a: av, b: bv });
    }
  }
  return diffs;
}

function fieldEquals(field: keyof LiteElement, av: unknown, bv: unknown): boolean {
  // bounds — pixel tolerance
  if (field === 'bounds') {
    if (!av && !bv) return true;
    if (!av || !bv) return false;
    const a = av as { x: number; y: number; width: number; height: number };
    const b = bv as { x: number; y: number; width: number; height: number };
    return (
      Math.abs(a.x - b.x) <= BBOX_TOLERANCE_PX
      && Math.abs(a.y - b.y) <= BBOX_TOLERANCE_PX
      && Math.abs(a.width - b.width) <= BBOX_TOLERANCE_PX
      && Math.abs(a.height - b.height) <= BBOX_TOLERANCE_PX
    );
  }
  // ordered arrays (parentRefChain, containerTitles)
  if (Array.isArray(av) && Array.isArray(bv)) {
    if (av.length !== bv.length) return false;
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return false;
    }
    return true;
  }
  // both undefined / null — treat as equal (sparse fields are normal)
  if ((av === undefined || av === null) && (bv === undefined || bv === null)) {
    return true;
  }
  // Boolean-falsy normalisation: collectors disagree on how to encode
  // "no" — evaluate-side uses `value || undefined` (false → undefined),
  // CDP-side writes literal `false`. Both representations describe the
  // same state, and every consumer (resolver, lint, apply) reads these
  // via truthy checks, so `false`, `undefined` and `null` are equivalent
  // at the consumption layer. Without this normalisation the divergence
  // logger drowns in noise — every non-required input across 100+ nodes
  // gets flagged for `required`/`readOnly`/`invalid`/`isInsideActiveModal`/
  // `isSlotted`. Real divergences (one side `true`, the other not) still
  // surface because we only collapse the falsy bucket.
  const aFalsy = av === false || av === undefined || av === null;
  const bFalsy = bv === false || bv === undefined || bv === null;
  if (aFalsy && bFalsy) return true;
  // strict equality for primitives — booleans, strings, numbers
  return av === bv;
}
