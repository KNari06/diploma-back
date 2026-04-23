/**
 * Heuristic detection of auto-generated / framework-generated element IDs.
 *
 * Dynamic IDs (UUIDs, Mongo ObjectIds, React 18 `:r0:`, Ember `ember42`, etc.)
 * must NEVER be used as stable selectors — they change on every page load,
 * making locator plans brittle. Locator-plan builders check `node.isDynamicId`
 * and skip `#id` / `[id=...]` strategies when true.
 *
 * Before this util, the same concept had THREE independent implementations
 * with different regex sets and match anchoring:
 *
 *   • `dom-analysis-extractor.service.ts` — 8 strictly anchored (^...$) regex
 *     → missed prefixed dynamic ids like "submit-abc12345def".
 *   • `background-dom-collector.ts` — 3 unanchored regex
 *     → marked plausible static ids as dynamic (e.g. id="my-xcafe1234-form").
 *   • `ai-selector-engine.service.ts` — 1 unanchored catch-all
 *     → similar over-match risk.
 *
 * Divergence meant the same element could be "dynamic" in preview and "static"
 * in background (or vice versa), producing inconsistent locator plans on
 * identical DOM. This consolidation uses the union of patterns with strict
 * anchoring where the shape is well-defined, and loose matching only for the
 * framework-specific prefixes that are diagnostic by themselves.
 *
 * BROWSER-SIDE CALLERS that run in `page.evaluate` cannot import this module;
 * they must inline the equivalent regex set. Today the only such caller is
 * `background-dom-collector.ts` — its inline copy carries a MUST MATCH comment
 * pointing back here so drift becomes visible at review time.
 */

/**
 * Patterns that mark an id as auto-generated and therefore unstable across
 * reloads / deployments. Order doesn't matter (short-circuit on first hit).
 *
 * Grouped by rationale:
 *   1. Shape-based (anchored) — id shape alone is diagnostic.
 *   2. Framework-prefix (unanchored) — prefix is diagnostic even mid-string
 *      because these frameworks always emit their token at the start.
 */
export const DYNAMIC_ID_PATTERNS: readonly RegExp[] = [
  // ── Shape-based (strictly anchored) ────────────────────────────────────
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i, // UUID
  /^[a-f0-9]{24,}$/i,                                                 // Mongo ObjectId / long hex
  /^[0-9a-z]{20,}$/i,                                                 // 20+ char random token
  /^\d{10,}$/,                                                        // epoch-like timestamps

  // ── Framework prefixes (anchored at start, tail varies) ────────────────
  /^react-select-\d+-/i,   // React Select internals
  /^react-[a-z0-9]+/i,     // other React-generated ids
  /^ember\d+/i,            // Ember auto ids
  /^ng-[a-z0-9-]+/i,       // AngularJS generated ids
  /^_[\w-]{8,}/i,           // leading underscore + random tail (Emotion, etc.)
  /:r[a-z0-9]+:?$/i,       // React 18 useId (`:r0:`, `:R5t:` — optional trailing colon)
  /:R[A-Za-z0-9]+:?$/,      // React 18 alt casing (SSR hydration form)
];

/**
 * Returns true when `id` looks auto-generated. Null/empty/undefined → false
 * (no id is not a dynamic id — callers can still use the element, just not
 * via #id).
 */
export function isDynamicId(id: string | null | undefined): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  if (trimmed.length === 0) return false;
  return DYNAMIC_ID_PATTERNS.some(pattern => pattern.test(trimmed));
}
