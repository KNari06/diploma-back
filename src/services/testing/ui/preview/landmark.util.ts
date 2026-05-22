/**
 * ARIA landmark detection — single source of truth.
 *
 * `nearestLandmark` is the role of the first WAI-ARIA landmark on an
 * element's ancestor chain (banner, navigation, main, complementary,
 * contentinfo, search, form, region). Drives:
 *
 *   - locator-plan-builder "scoped text" strategy
 *     (`[role="navigation"] >> text="…"`),
 *   - recorded fingerprint region match at replay / auto-heal,
 *   - recorded-description-llm prompt context,
 *   - intent-resolve-audit diagnostics.
 *
 * Before this util the same constants were duplicated in:
 *
 *   • snapshot-collector.ts          (preview snapshot)
 *   • cdp-snapshot.service.ts        (CDP snapshot — Etap 2)
 *   • background-dom-collector.ts    (background replay snapshot)
 *   • recording-capture.service.ts   (recorder probe)
 *
 * Divergence between any two of these breaks invariant #5 (recorder ↔
 * collector symmetry) — same element gets `nearestLandmark="form"` at
 * record time and `undefined` at apply time → identity match silently
 * loses the region anchor → wrong-element bug on pages with duplicate
 * labels across landmarks.
 *
 * Source of truth for the constants is the W3C HTML-AAM mapping:
 *   https://www.w3.org/TR/html-aam/#html-element-role-mappings
 *
 * BROWSER-SIDE CALLERS that run in `page.evaluate` cannot import this
 * module. They MUST stay in sync via one of two channels:
 *
 *   1. Inline literals with a `MUST MATCH landmark.util.ts` comment
 *      (mirrors the dynamic-id.util.ts pattern). Used by recorder.
 *   2. Build-time injection — wrap the call as
 *      `page.evaluate(({ROLES, TAGS}) => …, { ROLES: [...LANDMARK_ROLES], TAGS: LANDMARK_TAG_TO_ROLE })`
 *      so the literal flows from this module into the browser context.
 *      Used by snapshot-collector / cdp-snapshot.
 *
 * Pick whichever fits the caller's existing pattern. Both are checked
 * by the cdp-evaluate-symmetry integration test.
 */

import { computeImplicitRole } from './implicit-role.util';

/**
 * Explicit ARIA landmark roles (W3C ARIA 1.2 Section 5.3).
 *
 * Frozen so consumers can't accidentally mutate the shared set.
 */
export const LANDMARK_ROLES: ReadonlySet<string> = Object.freeze(new Set([
  'banner',
  'navigation',
  'main',
  'complementary',
  'contentinfo',
  'search',
  'form',
  'region',
]));

/**
 * HTML tag → implicit ARIA landmark role mapping.
 *
 * Derived from `computeImplicitRole` in `./implicit-role.util` — the
 * single source of truth for the full W3C HTML-AAM table. We project
 * that table down to the landmark subset at module-load time so:
 *
 *   1. Adding a new implicit role mapping in `implicit-role.util.ts`
 *      automatically propagates here without code duplication.
 *   2. The two tables can never drift — only one place to edit.
 *
 * Keys are uppercase to match `Element.tagName` directly without extra
 * normalisation at call sites.
 *
 * Notes on completeness:
 *   - `<form>` IS included via `computeImplicitRole` (which returns
 *     `'form'` for any `<form>` tag — lenient interpretation of
 *     HTML-AAM). Strict HTML-AAM only assigns `role=form` when the
 *     form has an accessible name; our lenient mapping matches the
 *     existing recorder/collector behaviour project-wide.
 *   - `<section>` returns `'region'` for the same reason.
 *
 * If you want strict HTML-AAM behaviour (skip nameless `<form>` /
 * `<section>`), filter at the call site by checking accessible name.
 */
export const LANDMARK_TAG_TO_ROLE: Readonly<Record<string, string>> = Object.freeze(
  // Project a fixed list of HTML tags down to their landmark role.
  // Values come from `computeImplicitRole` (single source of truth)
  // so any change to the canonical W3C table flows here automatically.
  //
  // The list of tags mirrors the in-the-wild collector behaviour:
  //   - 5 historic tags (NAV/MAIN/HEADER/FOOTER/ASIDE) — always treated
  //     as landmarks by all three collectors.
  //   - `<form>` was originally only on the recorder side; the CDP
  //     wrapper `tagToImplicitLandmarkRole` had a local fallback for it.
  //     Adding it here closes that symmetry gap (B6 in May 2026 audit):
  //     recorded `nearestLandmark='form'` for inputs in a <form> now
  //     matches what snapshot-collector / background-dom-collector /
  //     ai-selector emit. Strict HTML-AAM only assigns role=form when
  //     the form has an accessible name, but our lenient mapping
  //     matches the project-wide collector behaviour so the resolver's
  //     fingerprint match treats them as the same anchor.
  //   - `<section>` deliberately left OFF — it would map to 'region'
  //     and turn every nameless content section into a landmark, which
  //     would over-tag massive parts of dense pages. Recorder also
  //     excludes it. If we ever need it, add here AND in
  //     recording-capture.service.ts:1255 (the inline copy) together.
  (['nav', 'main', 'header', 'footer', 'aside', 'form'] as const)
    .reduce<Record<string, string>>((acc, tag) => {
      const role = computeImplicitRole({ tag });
      if (role && LANDMARK_ROLES.has(role)) {
        acc[tag.toUpperCase()] = role;
      }
      return acc;
    }, {}),
);

/**
 * Serializable bundle for `page.evaluate` injection.
 *
 * Usage:
 *   ```ts
 *   await page.evaluate(({ ROLES, TAGS }) => {
 *     // ...walk ancestors, call lookups with ROLES / TAGS...
 *   }, LANDMARK_EVALUATE_BUNDLE);
 *   ```
 *
 * The receiving callback gets a plain array (not Set — Set doesn't
 * cross the serialization boundary) and the plain record. Convert to
 * a Set inside the callback if you need O(1) lookup.
 */
export const LANDMARK_EVALUATE_BUNDLE = Object.freeze({
  ROLES: Array.from(LANDMARK_ROLES),
  TAGS: LANDMARK_TAG_TO_ROLE,
});
