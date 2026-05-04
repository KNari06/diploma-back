/**
 * Shape contract test: every LiteElement field must agree between
 * CDP and evaluate paths on the same DOM, on the same element.
 *
 * Why this matters: prompts, resolver, locator-plan-builder, scoring,
 * pruner — none of them know which collector produced the snapshot.
 * They read fields. If field X is "true" via evaluate but undefined
 * via CDP, downstream behaviour silently diverges. Shadow-mode
 * divergence log is one signal but it's noisy and only fires in prod.
 *
 * This test loads a representative real-world HTML (juz40 home), runs
 * BOTH collectors, joins matched elements by stable identifier, and
 * asserts every LiteElement field is identical (with documented
 * tolerance for known-divergent fields like `role` AX vs raw tag).
 *
 * Failure output: per-field histogram of divergences so we can fix
 * one symmetry break at a time.
 */

import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { CdpSnapshotService } from '../cdp-snapshot.service';
import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';
import type { LiteElement } from '@/agent/core/lite/lite-types';

const PER_TEST_TIMEOUT_MS = 60_000;

const FIXTURE_PATH = path.resolve(__dirname, '../../../../../../test.html');
const FIXTURE_HTML = fs.existsSync(FIXTURE_PATH)
  ? fs.readFileSync(FIXTURE_PATH, 'utf-8')
  : null;

const describeIfFixture = FIXTURE_HTML ? describe : describe.skip;

/**
 * Fields where we KNOWINGLY tolerate CDP-vs-evaluate differences.
 * Each entry must have a comment explaining WHY drift is acceptable —
 * if you can't explain it, fix the contract instead of adding a
 * tolerance.
 */
const TOLERATED_FIELDS = new Set<keyof LiteElement>([
  // AX-derived implicit role: CDP returns "listitem" via AXTree, evaluate
  // returns "li" (raw tag fallback). CDP's value is closer to ARIA spec;
  // consumers tolerate either. Recorder identity fast-path keys on
  // id/testid/href before role, so this is cosmetic.
  'role',
  // AX-derived accessible name: CDP applies the full WAI-ARIA name
  // cascade via AXTree.name; evaluate uses simpler fallback chain.
  // Slight word-choice differences are acceptable — both are "what a
  // screen reader would say".
  'name',
  // ref is assignment-order-dependent (see __agentRefCounter). We
  // join elements by stable identifier first, so ref values can
  // legitimately differ between two parallel snapshots.
  'ref',
  // Bounds: float pixel rounding can differ by sub-pixel between
  // getBoundingClientRect (evaluate) and DOMSnapshot.layout (CDP).
  // We compare width/height with 1px tolerance below; full bounds
  // object skipped here.
  'bounds',
  // Visual properties read via getComputedStyle: minor format
  // differences (rgb() vs rgba(0,0,0,1) for default colors). Used
  // by V8 visual matching as fuzzy hints, not exact-match keys.
  'backgroundColor',
  'textColor',
  'borderRadius',
  // computedZIndex: 'auto' becomes null in both paths, but numeric
  // representation can differ (0 vs null for "no stacking context").
  // Resolver tolerates either.
  'computedZIndex',
  // isPositioned: derived from `position !== 'static'`. Both paths
  // implement it; minor differences for `position: relative` with no
  // offset are tolerated.
  'isPositioned',
  // firstTextFragment: relies on text-node walking which can differ
  // between in-page innerText (eval) and post-process textContent (cdp).
  // Whitespace normalisation differs by browser version.
  'firstTextFragment',
  // labelText: composed from label[for=]/aria-labelledby/wrapping label.
  // Eval reads element.labels live; CDP walks DS attrs. Subtle
  // differences when label has nested formatting (whitespace, <strong>).
  'labelText',
  // nearestRowText: sibling-cell concatenation; row detection can
  // differ for non-standard table markup.
  'nearestRowText',
  // childTestId: requires "descriptor-poor parent" check. Minor false
  // positives possible when evaluate sees CSS pseudo-content text but
  // CDP doesn't.
  'childTestId',
  // iconLabel: walks <svg><title> / data-lucide / etc. If evaluate
  // sees runtime-injected icon via JS but CDP sees only static HTML,
  // values can differ.
  'iconLabel',
  // iconClasses: filter regex same in both paths but iconChild
  // querySelector ordering may differ.
  'iconClasses',
  // isIconButton: derived from cloneNode + remove icons + check text.
  // Whitespace edge cases.
  'isIconButton',
  // isTopMostAtCenter: both paths use elementFromPoint, but evaluate
  // runs DURING the snapshot (live coords) while CDP path runs
  // post-collect (coords from DS layout, possibly stale by milliseconds).
  // For static pages identical; for animating pages can differ.
  'isTopMostAtCenter',
  // visible: derived from display/visibility/opacity. Floating-point
  // opacity comparison can flip true/false for `opacity: 0.001`.
  // We assert HARD on visible at sample-page level via critical-target
  // tests; aggregate field histogram can show drift.
  'visible',
  // parentRefChain: ref values are assignment-order-dependent (see
  // `ref` above). Same elements get different ref strings in two
  // parallel snapshots, so the array contents differ even when the
  // semantic chain is identical.
  'parentRefChain',
  // containerRef: same reason as parentRefChain — ref-value sensitive.
  'containerRef',
  // containerTitles: heading text walks can differ by 1-2 chars on
  // whitespace normalisation; consumers compare with substring match.
  'containerTitles',
  // V22 Pkg5: arrowDir and siblingIndex are derived in the in-page
  // collector via SVG path geometry inspection (arrowDir) and
  // nth-of-type queries among same-class siblings (siblingIndex).
  // Both require live DOM/SVG state. Not yet ported to CDP path —
  // tolerated until V22 Pkg5 CDP parity is in scope. Consumers
  // (hybrid-semantic-weight, locator-plan-builder) treat them as
  // optional hints, not strong selectors.
  'arrowDir',
  'siblingIndex',
  // `type`: the input/button `type` attribute. Eval-path reads it via
  // `el.type` (HTMLInputElement.type which has implicit defaults like
  // "text" / "submit"); CDP path reads the raw HTML attribute (absent
  // when implicit). Functional equivalence — consumers use it as a
  // hint, not an exact match. Could be unified by adding implicit
  // defaults on the CDP side, deferred.
  'type',
  // `customElementTag`: walk-up cap differs by edge case. Eval walks
  // via `closest()` selector which can cross a shadow boundary; CDP
  // walks via parentIndex which doesn't. For ordinary Angular pages
  // they match; for shadow-DOM Web Components the value can drop.
  // Resolver treats it as a hint, not a selector key.
  'customElementTag',
  // context: parentType derivation is byte-identical now (Container/
  // Section/Form/Modal/...); the trailing `"title"` part can differ
  // because evaluate uses `parent.querySelector(headings...)` (deep
  // subquery into the parent's children), while CDP walks the
  // ancestor chain UP and reads heading text seen in passing.
  // Different scopes yield different titles for nested layouts.
  // Both are correct hints; consumer (hybrid-semantic-weight)
  // tokenises via fuzzy match, doesn't rely on exact equality.
  'context',
]);

interface DivergenceCounts {
  [field: string]: number;
}

interface Divergence {
  identifier: string;
  field: string;
  cdpVal: unknown;
  evalVal: unknown;
}

/** Stable identifier for joining matched elements. */
function identify(el: LiteElement): string | null {
  if (el.htmlId) return `id:${el.htmlId}`;
  if (el.testIdAttr) return `testid:${el.testIdAttr}`;
  if (el.href) return `href:${el.href}`;
  // Fall back to tag + first 40 chars of name. Less stable but
  // covers nameless elements like <h2>Heading</h2>.
  if (el.name && el.name.length > 0) {
    return `tag:${el.tag}|name:${el.name.slice(0, 40)}`;
  }
  return null;
}

function compareElement(
  cdp: LiteElement,
  ev: LiteElement,
  identifier: string,
): Divergence[] {
  const divergences: Divergence[] = [];
  // Take the union of keys from both objects so we catch fields
  // populated on one side but undefined on the other.
  const allKeys = new Set<string>([
    ...Object.keys(cdp),
    ...Object.keys(ev),
  ]);
  for (const key of allKeys) {
    if (TOLERATED_FIELDS.has(key as keyof LiteElement)) continue;
    // Internal stash fields stripped before return — but defensive.
    if (key.startsWith('__')) continue;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cdpVal = (cdp as any)[key];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evalVal = (ev as any)[key];

    // Normalise: undefined ↔ false / 0 / '' for nullable fields.
    // This is symmetric — if either side is "absent" and the other
    // is "default", treat as agreement.
    const normalise = (v: unknown): unknown => {
      if (v === undefined) return undefined;
      if (v === null) return undefined;
      if (v === false) return undefined;
      if (v === 0) return undefined;
      if (v === '') return undefined;
      if (Array.isArray(v) && v.length === 0) return undefined;
      return v;
    };
    const cdpN = normalise(cdpVal);
    const evN = normalise(evalVal);

    // Deep-equal for arrays (parentRefChain etc are tolerated, but
    // for any other array field we compare by JSON).
    if (Array.isArray(cdpN) || Array.isArray(evN)) {
      if (JSON.stringify(cdpN) !== JSON.stringify(evN)) {
        divergences.push({ identifier, field: key, cdpVal, evalVal });
      }
      continue;
    }

    if (cdpN !== evN) {
      divergences.push({ identifier, field: key, cdpVal, evalVal });
    }
  }
  return divergences;
}

describeIfFixture('Shape contract: CDP and evaluate produce identical LiteElement', () => {
  let browser: Browser;
  let cdpPage: Page;
  let evalPage: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    cdpPage = await browser.newPage();
    evalPage = await browser.newPage();
  });

  afterEach(async () => {
    if (!cdpPage.isClosed()) await cdpPage.close();
    if (!evalPage.isClosed()) await evalPage.close();
  });

  it('every matched element on real juz40 home has identical shape (with documented tolerances)', async () => {
    await cdpPage.setContent(FIXTURE_HTML!);
    await evalPage.setContent(FIXTURE_HTML!);

    const cdpSnap = await CdpSnapshotService.collect(cdpPage);
    const evalSnap = await SnapshotCollector.collect(evalPage);

    // Index by identifier — only consider elements we can pair up
    // (skip nameless decorative children we couldn't match anyway).
    const cdpById = new Map<string, LiteElement>();
    for (const el of cdpSnap.elements) {
      const id = identify(el);
      if (id) cdpById.set(id, el);
    }
    const evalById = new Map<string, LiteElement>();
    for (const el of evalSnap.elements) {
      const id = identify(el);
      if (id) evalById.set(id, el);
    }

    // Join — only check elements present in BOTH (other test
    // already asserts onlyInEval is empty for useful elements).
    const allDivergences: Divergence[] = [];
    for (const [id, cdpEl] of cdpById) {
      const evEl = evalById.get(id);
      if (!evEl) continue;
      allDivergences.push(...compareElement(cdpEl, evEl, id));
    }

    // Per-field histogram so we know WHICH fields drift, not just
    // a list of mismatched cells.
    const histogram: DivergenceCounts = {};
    for (const d of allDivergences) {
      histogram[d.field] = (histogram[d.field] || 0) + 1;
    }

    const matchedCount = [...cdpById.keys()].filter((id) => evalById.has(id)).length;

    // Print summary so failure output is actionable.
    // eslint-disable-next-line no-console
    console.log('[SHAPE_CONTRACT]', {
      cdpTotal: cdpSnap.elements.length,
      evalTotal: evalSnap.elements.length,
      matchedPairs: matchedCount,
      totalDivergences: allDivergences.length,
      perFieldDivergences: histogram,
      // First 10 actual divergences so we can see exact values.
      examples: allDivergences.slice(0, 10).map((d) => ({
        id: d.identifier,
        field: d.field,
        cdp: typeof d.cdpVal === 'string' ? d.cdpVal.slice(0, 50) : d.cdpVal,
        eval: typeof d.evalVal === 'string' ? d.evalVal.slice(0, 50) : d.evalVal,
      })),
    });

    // Per-field budget: some fields require live DOM/SVG inspection
    // and have rare edge-case mismatches that don't affect resolver
    // behaviour (consumers use them as fuzzy hints). Cap divergences
    // for those fields to a small absolute count rather than zero.
    const PER_FIELD_BUDGET: Partial<Record<string, number>> = {
      // Row-container detection differs in <5% of buttons on dense
      // pages where the button itself wraps row-equivalent content
      // (custom-element row triggers without semantic li/tr ancestor).
      // Eval finds a row via closest()-like heuristic, CDP's parent
      // walk doesn't reach a row tag in 4 levels. Both behaviours are
      // defensible; consumer (candidate-pruner-llm) treats nearText
      // as optional disambiguation.
      nearText: 3,
    };

    const overBudget = allDivergences.filter((d) => {
      const budget = PER_FIELD_BUDGET[d.field] ?? 0;
      const fieldCount = histogram[d.field] ?? 0;
      return fieldCount > budget;
    });

    // Assertion: zero divergences except for budgeted fields above
    // their per-field cap. Every field that actually differs MUST
    // either be in TOLERATED_FIELDS, in PER_FIELD_BUDGET (with a
    // documented cap), or fixed in the collector.
    expect(overBudget).toEqual([]);
  }, PER_TEST_TIMEOUT_MS);

  it('field presence parity on auth-form: every populated field on one side is on the other', async () => {
    // Stricter check on a smaller, well-controlled fixture — every
    // field that one path sets to a non-default value, the OTHER
    // path must also set (possibly to a different value, but
    // populated). Catches "CDP forgets to fill X" silently.
    const html = `
      <input id="email" type="email" placeholder="Email" required />
      <input id="password" type="password" placeholder="Password" />
      <button id="login" aria-label="Sign in" data-testid="login-btn">
        Sign in
      </button>
      <a id="forgot" href="/forgot" aria-haspopup="menu">Forgot</a>
      <div id="editable" contenteditable="true" tabindex="0">edit me</div>
    `;
    await cdpPage.setContent(html);
    await evalPage.setContent(html);

    const cdpSnap = await CdpSnapshotService.collect(cdpPage);
    const evalSnap = await SnapshotCollector.collect(evalPage);

    const checkIds = ['email', 'password', 'login', 'forgot', 'editable'];
    const presenceMismatches: Array<{ id: string; field: string; cdp: boolean; eval: boolean }> = [];

    for (const id of checkIds) {
      const cdpEl = cdpSnap.elements.find((e) => e.htmlId === id);
      const evEl = evalSnap.elements.find((e) => e.htmlId === id);
      if (!cdpEl || !evEl) continue; // covered by other test

      // Important "filled" fields. If one side has a value and the
      // other doesn't (undefined), that's a contract break — even
      // if the values themselves would have differed.
      const importantFields: (keyof LiteElement)[] = [
        'id', 'testIdAttr', 'isDynamicId',
        'tag', 'type', 'placeholder', 'href',
        'ariaLabel', 'ariaHasPopup', 'isContentEditable',
        'tabIndex', 'required', 'hasValue',
        'isInsideShadowDOM', 'shadowDepth',
      ];
      for (const f of importantFields) {
        // "Has" = field has a meaningful value. We treat undefined,
        // null, false, 0, '' as "absent" because both paths legally
        // omit-vs-explicit-default for boolean fields. Asymmetry on
        // truthy values is what we want to catch.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const isMeaningful = (v: any): boolean =>
          v !== undefined && v !== null && v !== false && v !== 0 && v !== '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const cdpHas = isMeaningful((cdpEl as any)[f]);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const evHas = isMeaningful((evEl as any)[f]);
        if (cdpHas !== evHas) {
          presenceMismatches.push({ id, field: f, cdp: cdpHas, eval: evHas });
        }
      }
    }

    // eslint-disable-next-line no-console
    if (presenceMismatches.length > 0) {
      console.log('[PRESENCE_MISMATCHES]', presenceMismatches);
    }
    expect(presenceMismatches).toEqual([]);
  }, PER_TEST_TIMEOUT_MS);
});
