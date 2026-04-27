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
 * they must inline the equivalent regex set. Today these inline copies exist:
 *   - `background-dom-collector.ts` — DOM snapshot during apply/replay
 *   - `recording-capture.service.ts` — inline `IS_GENERATED_ID` in PROBE_AT_POINT_FN
 *     (used to filter ids extracted into ancestorChain at recording time)
 * Each copy carries a MUST MATCH comment pointing back here so drift becomes
 * visible at review time. Adding a new pattern? Update both inline copies.
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
  // Earlier loose patterns (`/^react-[a-z0-9]+/i`, `/^v-[a-z0-9]{6,}$/i`)
  // were over-greedy and rejected legitimate human-named ids like
  // `react-tutorial-link` or `v-account-list`. Tightened in V22 to only
  // match the specific generated forms each library actually emits.
  /^react-select-\d+-/i,                 // React Select internals
  /^react-(?:tabs|router|aria|focus-lock|portal|datepicker)-/i, // narrow react-* matches only known libs
  /^ember\d+/i,                          // Ember auto ids
  /^ng-[a-z0-9-]+/i,                     // AngularJS generated ids
  /^_[a-zA-Z0-9]{12,}$/,                 // strict: long underscore-prefixed (Emotion, etc.) — no dashes, ≥12 chars
  /:r[a-z0-9]+:?$/i,                     // React 18 useId (`:r0:`, `:R5t:`)
  /:R[A-Za-z0-9]+:?$/,                   // React 18 SSR alt casing
  // ── UI library auto-generated ids ─────────────────────────────────────
  /^el-id-[\w-]+$/i,                     // Element Plus (e.g. "el-id-6868-3")
  /^radix-[a-z0-9-]+/i,                  // Radix UI primitives (shadcn / Radix-based stacks)
  /^mui-[\w-]+$/i,                       // Material UI
  /^headlessui-[\w-]+$/i,                // Tailwind Headless UI
  /^chakra-[\w-]+$/i,                    // Chakra UI
  /^downshift-\d+-/i,                    // Downshift (combobox / select primitive)
  // V22 additions — common UI libraries that emit unstable counter-ids.
  /^cdk-(?:overlay|describedby|focus-trap|live)-/i,    // Angular CDK
  /^mat-(?:input|tab|menu|select|dialog|chip|mdc)-\d/i, // Angular Material
  /^rc-[a-z]+-\d/i,                                    // rc-* (Ant Design internals)
  /^ant-[a-z-]+-\d/i,                                  // Ant Design
  /^pv_id_\d+$/,                                       // PrimeVue
  /^pn_id_\d+$/,                                       // PrimeNG
  /^__BVID__\d+$/,                                     // BootstrapVue
  /^vs__/,                                             // vue-select
  /^lit-element-\d+$/i,                                // Lit
  /^lit\$/,                                            // Lit shadow IDs
  /^sc-[a-z0-9-]+-h-/i,                                // Stencil / Ionic
  /^sc-[a-zA-Z0-9]{6,}$/,                              // styled-components scoped class (sc-jJLAfE, sc-hjsuWn)
  /^css-[a-z0-9]{6,}$/i,                               // Emotion css-* hashes (filtered when used as id)
  /^jss\d+$/,                                          // MUI v4 / JSS counter classes (jss1, jss42)
  /^makeStyles-[a-zA-Z]+-\d+$/,                        // MUI v4 makeStyles full form (makeStyles-root-12)
  // NOTE: bare styled-components display-name hashes (kAtEng, hpEYiQ,
  // dEnzIq) cannot be filtered by regex without false-positives on
  // legitimate camelCase ids like "submitBtn" or "userName". They get
  // suppressed instead at extraction time: the className utility-class
  // strip in probe drops single tokens that look like 5-8-char mixed-case
  // gibberish only when paired with a sc-* sibling (see cssClass strip
  // logic in recording-capture.service.ts).
  /^q-[a-z]+-\d+$/i,                                   // Quasar
  /^n-[a-z]+-\d+$/i,                                   // Naive UI
  /^lightning-[a-z]+-\d+/i,                            // Salesforce Lightning
  /^slds-[a-z-]+-\d+$/i,
  /^aria-id-\d+$/i,                                    // generic aria-id counter (Reach UI / downshift utils)
  /^descid-\d+$/i,                                     // generic descid counter
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
