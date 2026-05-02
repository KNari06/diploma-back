/**
 * Locator Config (Etap 1B.1)
 *
 * Centralized allow/deny lists that the locator-plan-builder consults when
 * deciding which attributes/classes are stable enough to anchor a selector
 * on. Prior to this file the same lists were duplicated in 4+ places — see
 * the regex inventory in [.claude/rules/...] history. This config is the
 * single source of truth for Node-side code; browser-side inline copies
 * (page.evaluate contexts in recording-capture.service.ts and
 * snapshot-collector.ts) still mirror these patterns by hand because they
 * cannot import this module — drift between them is the symmetry contract
 * we maintain.
 *
 * What this file owns:
 *   - DEFAULT_LOCATOR_CONFIG        — the global baseline
 *   - resolveLocatorConfig(...)     — merge global + workspace + testCase
 *   - isBannedAttribute / isImportantAttribute / isClassBanned helpers
 *
 * What this file does NOT own (yet):
 *   - DB-backed per-workspace / per-testCase persistence (Etap 1B.3)
 *   - Live-reload subscription
 *   - UI for editing
 *
 * Inspired by Momentic's `importantAttributes` / `bannedAttributes` config
 * (https://momentic.ai/docs/configuration/momentic-config). The semantics
 * are the same: filter, never rank.
 */

import { DYNAMIC_ID_PATTERNS } from '@/services/testing/ui/preview/dynamic-id.util';

/**
 * Resolved config for a single locator-build operation. All fields are
 * required after merge so the builder never has to null-check.
 */
export interface LocatorConfig {
  /**
   * IDs matching any of these patterns are skipped as locator anchors
   * (`#id`, `[id="..."]`). The default set covers UUIDs, framework
   * counters (React 18 `:r0:`, Ember, Radix, MUI, ...), and library
   * scoped hashes (jss / sc-* / css-*). Custom workspaces can EXTEND
   * but should not REPLACE the default — overriding wholesale risks
   * accepting framework-generated ids.
   */
  bannedIdPatterns: readonly RegExp[];
  /**
   * Class names matching any of these patterns are skipped when the
   * builder considers `.${className}` strategies (siblingIndex, future
   * BEM strategy in 1B.2). Default covers CSS-in-JS scoped hashes
   * (jss/sc/css/makeStyles).
   */
  bannedClassPatterns: readonly RegExp[];
  /**
   * Attributes that must never be filtered out from LLM context, plan
   * candidates, or fingerprint hints. Whitelist with the highest priority.
   * Trailing `*` enables prefix matching: `'data-test-*'` matches
   * `data-testid`, `data-test-foo`, etc.
   */
  importantAttributes: readonly string[];
  /**
   * Attributes that must always be filtered out (treated as noise).
   * Defaults cover ARIA refs that point to dynamic ids (aria-controls /
   * aria-describedby / aria-owns) and label-for, which is unreliable
   * because frameworks frequently regenerate the target id.
   * Trailing `*` enables prefix matching.
   */
  bannedAttributes: readonly string[];
  /**
   * Class names that should NEVER be pruned even if they look hash-like.
   * Empty by default — workspaces with BEM conventions can list their
   * stable class roots here (`['btn', 'card', 'page-*']`).
   */
  importantClasses: readonly string[];
  /**
   * Attributes the project uses as test hooks. The builder treats these
   * as IDENTITY-tier anchors and emits `getByTestId` (or attribute-CSS)
   * strategies for them.
   *
   * Default covers the common ecosystem names (`data-testid`, `data-cy`,
   * `data-qa`, ...). Workspaces with custom conventions add their own
   * (`data-automation-id`, `data-test-selector`, etc.) here. Without this
   * override, custom test-attribute projects fall back to weaker
   * strategies (text / role / position) and produce flaky plans.
   *
   * Trailing `*` enables prefix matching: `'data-test-*'` covers any
   * attribute starting with `data-test-`.
   */
  testIdAttributes: readonly string[];
  /**
   * Build-time validation thresholds. Tuning these per-workspace lets us
   * relax the sort+cap logic on sites where ambiguity is structural (e.g.
   * a 50-row AntD table — count=20 is normal, not a sign of weakness).
   *
   * - `maxAmbiguous` — drop locators that match more than this many live
   *   elements (`count > maxAmbiguous`). 0 = drop everything ambiguous,
   *   Infinity = never drop on ambiguity.
   * - `maxLocatorsTotal` — final plan size cap.
   * - `maxPerTier` — diversity cap, locators kept per tier.
   */
  thresholds: {
    maxAmbiguous: number;
    maxLocatorsTotal: number;
    maxPerTier: number;
  };
}

/**
 * Default config — used when no workspace / test-case override exists.
 *
 * Keep this minimal and conservative. Adding patterns here affects ALL
 * users; specific frameworks should be added to per-workspace overrides
 * when 1B.3 lands.
 */
export const DEFAULT_LOCATOR_CONFIG: LocatorConfig = {
  // Pull the canonical id-blacklist from the dedicated util so existing
  // callers (resolver / probe / collector) and the builder agree on what
  // counts as dynamic. Spread into a fresh array to detach the readonly
  // type from the source.
  bannedIdPatterns: [...DYNAMIC_ID_PATTERNS],

  bannedClassPatterns: [
    // MUI v4 / JSS counter classes — `jss1`, `jss42`.
    /^jss\d+$/,
    // styled-components scoped hash — `sc-jJLAfE`.
    /^sc-[a-zA-Z0-9]{6,}$/,
    // Emotion css-* hash.
    /^css-[a-z0-9]{6,}$/i,
    // MUI v4 makeStyles — `makeStyles-root-12`.
    /^makeStyles-/,
    // Stencil / Ionic scoped class — `sc-foo-h-`.
    /^sc-[a-z0-9-]+-h-/i,
  ],

  importantAttributes: [
    // Test hooks — gold standard.
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
    // Identity authored for a11y / forms.
    'aria-label',
    'name',
    'role',
    'placeholder',
    'title',
    'alt',
    // Angular form / router identifiers (used by 1B.2 strategies).
    'formcontrolname',
    'routerlink',
  ],

  bannedAttributes: [
    // ARIA references that point at dynamically-generated ids — using them
    // as locators couples the test to ephemeral framework state.
    'aria-controls',
    'aria-describedby',
    'aria-owns',
    'aria-labelledby',
    'aria-activedescendant',
    // <label for="..."> — the target id is frequently regenerated.
    'for',
    // Generated by Radix / Headless UI / Floating UI primitives — the
    // wildcard prefix variant (see matchesAnyPrefix below) catches
    // `data-radix-*`, `data-headlessui-*`, `data-floating-ui-*` etc.
    'data-radix-*',
    'data-headlessui-*',
    'data-floating-ui-*',
    'data-state',
    'data-orientation',
    // Angular ViewEncapsulation salt — `_ngcontent-iyb-c87`, `_nghost-iyb-c88`.
    // Unique per component, but the salt (`iyb` here) is rebuilt on every
    // production build; using these as anchors guarantees broken plans
    // after every deploy. Captured separately as `*` prefixes because
    // Angular emits them with build-id suffix that varies per project.
    '_ngcontent-*',
    '_nghost-*',
    // Angular runtime template namespace markers — `ng-tns-c89-8`,
    // `ng-trigger`, `ng-trigger-bodyExpansion`. State-dependent and
    // per-build; never stable enough for locators.
    'ng-tns-*',
    'ng-trigger',
    'ng-trigger-*',
    // Angular form-control runtime state classes (DOM attributes form: rare,
    // but Angular sometimes mirrors via attribute selectors). Same drift
    // risk as the cssClass-side filter in the recorder.
    'ng-untouched',
    'ng-touched',
    'ng-pristine',
    'ng-dirty',
    'ng-valid',
    'ng-invalid',
    'ng-pending',
    'ng-submitted',
  ],

  importantClasses: [],

  // Common test-hook attribute names across ecosystems. Workspaces with
  // custom names (e.g. `data-automation-id`) extend via per-workspace
  // override.
  testIdAttributes: [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-cy',
    'data-qa',
  ],

  thresholds: {
    // count > 5 → drop. Tuned for typical pages; tables / lists need
    // a higher value via per-workspace override.
    maxAmbiguous: 5,
    // Final plan size cap after sortAndCap.
    maxLocatorsTotal: 10,
    // Diversity cap inside one tier.
    maxPerTier: 2,
  },
};

/**
 * Merge defaults with optional workspace and per-test-case overrides.
 *
 * Override semantics — REPLACE on top-level arrays, DEEP-MERGE for nested
 * objects (currently only `thresholds`):
 *
 *   - `bannedAttributes: ['for']` REPLACES the full list, dropping defaults.
 *     Callers wanting EXTEND semantics should spread explicitly:
 *     `{ bannedAttributes: [...DEFAULT_LOCATOR_CONFIG.bannedAttributes, 'mine'] }`.
 *
 *   - `thresholds: { maxAmbiguous: 20 }` deep-merges with defaults — the
 *     other thresholds (maxLocatorsTotal / maxPerTier) keep their default
 *     values. Without deep-merge a partial threshold override would leave
 *     undefined fields, breaking sortAndCap (`kept.length >= undefined`
 *     is always false → infinite plans).
 *
 * The replace-on-arrays semantics are intentional: workspaces with unusual
 * stacks (e.g. internal framework that uses `aria-controls` as a real
 * anchor) need the ability to disable a default rule entirely.
 */
export function resolveLocatorConfig(
  workspaceConfig?: Partial<LocatorConfig>,
  testCaseConfig?: Partial<LocatorConfig>,
): LocatorConfig {
  return {
    ...DEFAULT_LOCATOR_CONFIG,
    ...workspaceConfig,
    ...testCaseConfig,
    // Deep-merge nested objects so partial overrides don't blank out
    // sibling fields. Order: defaults < workspace < testCase.
    thresholds: {
      ...DEFAULT_LOCATOR_CONFIG.thresholds,
      ...(workspaceConfig?.thresholds ?? {}),
      ...(testCaseConfig?.thresholds ?? {}),
    },
  };
}

/**
 * Returns true when `attrName` should be treated as authoritative for
 * locator strategies (whitelist). Uses prefix-match for entries ending
 * in `*`.
 */
export function isImportantAttribute(
  attrName: string,
  config: LocatorConfig,
): boolean {
  return matchesAnyPattern(attrName, config.importantAttributes);
}

/**
 * Returns true when `attrName` should be filtered out of locator
 * generation. Banned wins over important — if an attribute appears in
 * both lists (which shouldn't happen for a sensible config), banned
 * is honoured.
 */
export function isBannedAttribute(
  attrName: string,
  config: LocatorConfig,
): boolean {
  return matchesAnyPattern(attrName, config.bannedAttributes);
}

/**
 * Returns true when `className` matches any banned-class regex AND is not
 * explicitly listed in importantClasses. The exception list lets a
 * workspace force-keep a hash-shaped class that is actually stable in
 * their codebase.
 */
export function isClassBanned(
  className: string,
  config: LocatorConfig,
): boolean {
  if (matchesAnyPattern(className, config.importantClasses)) return false;
  return config.bannedClassPatterns.some((rx) => rx.test(className));
}

/**
 * Returns true when `id` matches any banned-id regex. Mirrors
 * `isDynamicId` from dynamic-id.util but reads patterns from the
 * resolved config — letting workspaces extend the blacklist without
 * editing the shared util.
 */
export function isIdBanned(
  id: string | null | undefined,
  config: LocatorConfig,
): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  if (trimmed.length === 0) return false;
  return config.bannedIdPatterns.some((rx) => rx.test(trimmed));
}

/**
 * Returns true when `attrName` is one of the workspace's recognized
 * test-hook attributes (default: `data-testid` / `data-cy` / `data-qa`
 * / ... — see DEFAULT_LOCATOR_CONFIG.testIdAttributes).
 *
 * The builder uses this to decide:
 *   1. whether to emit an IDENTITY-tier strategy on the value;
 *   2. whether `getByTestId` is appropriate (Playwright's testIdAttribute
 *      is configured at the project level — for non-default names we
 *      fall back to attribute-CSS).
 */
export function isTestIdAttribute(
  attrName: string,
  config: LocatorConfig,
): boolean {
  return matchesAnyPattern(attrName, config.testIdAttributes);
}

/**
 * Match a literal string against a list of patterns where each entry is
 * either an exact name (`'data-testid'`) or a prefix wildcard
 * (`'data-test-*'`). Case-sensitive — DOM attribute names are
 * canonically lowercased by the browser before reaching us.
 */
function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  for (const p of patterns) {
    if (p.endsWith('*')) {
      if (value.startsWith(p.slice(0, -1))) return true;
    } else if (value === p) {
      return true;
    }
  }
  return false;
}
