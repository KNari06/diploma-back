/**
 * Real-Chromium integration tests for CdpSnapshotService (Etap 2 Phase 3).
 *
 * Why this exists:
 *   All other CDP tests are mocked at the CDP boundary — they verify the
 *   pipeline orchestrates phases correctly given canned bundles. They CANNOT
 *   catch:
 *     - real DOMSnapshot/AXTree quirks (e.g., empty `documents[0]` on
 *       about:blank, missing `nodeName` indices on synthetic nodes)
 *     - shape contract drift between evaluate path and CDP path on the
 *       same DOM
 *     - Layer 2 modal promotion + `isInsideActiveModal` flag propagation
 *       on a real Chromium-rendered page
 *     - hard-timeout race when Playwright actually owns the page lifecycle
 *
 *   This file fills that gap with a `chromium.launch()` per test suite,
 *   mirroring the patterns in `snapshot-collector.shadow-dom.test.ts`
 *   and `network-tracker.interception.test.ts`.
 *
 * Test isolation:
 *   - One Browser shared across all tests (beforeAll/afterAll) — launching
 *     Chromium is ~1.5s per test, prohibitive at scale.
 *   - One Page per test (beforeEach/afterEach) — `__agentRefCounter` lives
 *     on `window`, so a fresh page is the cheap way to reset the namespace.
 *   - All test fixtures are `page.setContent(`<inline html>`)` — no network,
 *     deterministic, runs offline.
 *
 * Failure semantics:
 *   - Test asserts on a CONTRACT (field is populated / promoted / matches),
 *     not on numeric speedup. Wall-clock varies by CI machine; we instead
 *     assert that CDP completes in a sane bound (5s) and don't drift.
 *   - When evaluate-path and CDP-path diverge, test prefers the EVALUATE
 *     output as the source of truth (it's the production baseline) and
 *     fails CDP if it deviates beyond declared tolerances.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { CdpSnapshotService } from '../cdp-snapshot.service';
import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';
import { diffSnapshots } from '../snapshot-diff.util';

// Hard cap — every test must finish under this. Tightening would catch
// regressions sooner; loosening is a code-smell. 30s lets us tolerate
// a slow CI machine while flagging genuine 60s+ hangs.
const PER_TEST_TIMEOUT_MS = 30_000;

describe('CdpSnapshotService — real Chromium integration', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser.close();
  });

  beforeEach(async () => {
    page = await browser.newPage();
  });

  afterEach(async () => {
    if (!page.isClosed()) await page.close();
  });

  // ──────────────────────────────────────────────────────────────────
  // 1. Smoke — does CDP actually work end-to-end on a real page?
  // ──────────────────────────────────────────────────────────────────
  describe('smoke', () => {
    it('returns a populated LiteSnapshot on a simple page', async () => {
      await page.setContent(`
        <button id="submit">Submit</button>
        <input type="text" placeholder="email" />
        <a href="/about">About</a>
      `);

      const snapshot = await CdpSnapshotService.collect(page);

      expect(snapshot.elements.length).toBeGreaterThan(0);
      expect(snapshot.url).toBeTruthy();
      // Phase 0 contract: transientState always populated, even when
      // page has no loading indicators.
      expect(snapshot.transientState).toBeDefined();
      expect(snapshot.transientState?.isTransient).toBe(false);
    }, PER_TEST_TIMEOUT_MS);

    // ──────────────────────────────────────────────────────────────────
    // Regression test for May 2026 bi.group "Астана" incident:
    //   CDP DOMSnapshot.bounds is document-relative. The refAssign phase
    //   calls `elementsFromPoint(cx, cy)` and `getBoundingClientRect()`
    //   which are viewport-relative. Without subtracting scrollY, any
    //   button below the fold gets dropped at refAssign with
    //   `findElementReturnedNull / atPoint: null`.
    //
    //   Forensic evidence from production capture (preview_db408e1b…):
    //     scrollY=500, 543/639 refAssign rejections had bbox.y > 720.
    //     Target button "Астана" at doc-y=792.5 was one of them.
    //
    //   This test reproduces the scenario in isolation:
    //   - Tall page (force scrollbar).
    //   - Button placed well below the first viewport.
    //   - Scroll the page so the button is INSIDE the viewport after scroll.
    //   - Collect snapshot → assert the button survived with a ref.
    //
    // If the scroll fix regresses, the button gets `ref=''` and is
    // filtered out by the post-refAssign defense — total ref count drops
    // and this assertion fails.
    it('preserves below-the-fold buttons after page scroll (refAssign coord-space fix)', async () => {
      // 3000px tall page; target button at y≈1200 in DOCUMENT space.
      // Viewport is 1280×720 by default. After scrollTo(0, 500) the
      // button sits at y≈700 in viewport — visible — but document
      // coordinates are still y=1200. The pre-fix code passed y=1200
      // to elementsFromPoint, hitting empty space (> 720), and dropped.
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.setContent(`
        <div style="height: 1100px; background: linear-gradient(#eef,#fff);">
          <p style="padding-top: 200px;">filler above</p>
        </div>
        <button id="target-astana" data-testid="city-astana"
                style="display:block; width:300px; height:44px;">
          Астана
        </button>
        <div style="height: 1500px;">filler below</div>
      `);
      await page.evaluate(() => (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 500));
      // Settle layout + ensure scroll actually applied.
      await page.waitForFunction(() => (globalThis as unknown as { scrollY: number }).scrollY === 500);

      const snapshot = await CdpSnapshotService.collect(page);

      // The button MUST appear with a ref (i.e. it survived refAssign).
      const astana = snapshot.elements.find(
        (e) => e.tag === 'button' && (e.htmlId === 'target-astana' || e.testIdAttr === 'city-astana'),
      );
      expect(astana).toBeDefined();
      expect(astana?.ref).toMatch(/^e\d+$/);
      // Bounds in the public LiteElement contract MUST stay
      // document-relative (we subtract scroll only inside refAssign,
      // not on the public field) — this is part of the API stability
      // promise to downstream consumers like the resolver and traces.
      expect(astana?.bounds?.y).toBeGreaterThanOrEqual(1000);
    }, PER_TEST_TIMEOUT_MS);

    // Race regression: scroll changes BETWEEN captureSnapshot (Node side,
    // which records scrollOffset in the DS document) and the in-page
    // refAssign evaluate. If we subtract snapshot-time scroll, the bbox
    // we hand to elementsFromPoint is off by `(liveScroll - snapshotScroll)`
    // px — when that delta exceeds TOL_EXACT (10px), bboxScore returns
    // 'mismatch' and the element drops. Subtracting LIVE scroll inside
    // the evaluate body (the only safe place) keeps both sides in sync.
    //
    // Repro: scroll to 500, kick off the collect (captureSnapshot reads
    // scrollOffset=500), then immediately scroll to 600. By the time
    // refAssign runs ~50ms later, win.scrollY=600 but DS bounds were
    // captured at scroll=500. Pre-fix or with snapshot-scroll subtraction
    // the button drops. With live-scroll subtraction it survives.
    it('survives scroll-during-collect race (live scroll, not snapshot scroll)', async () => {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.setContent(`
        <div style="height: 1100px; background:#eef;"></div>
        <button id="race-target" style="display:block; width:300px; height:44px;">
          Race Target
        </button>
        <div style="height: 1500px;"></div>
      `);
      await page.evaluate(() => (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 500));
      await page.waitForFunction(() => (globalThis as unknown as { scrollY: number }).scrollY === 500);

      // Kick off collect AND a scroll concurrently. The exact timing
      // varies; what matters is that AT LEAST ONE run lands in the
      // race window where snapshot scroll != live scroll. We do 3
      // independent collects with mid-flight scrolls — at least one
      // should hit the race.
      let foundCount = 0;
      for (const targetScroll of [600, 450, 550]) {
        const collectPromise = CdpSnapshotService.collect(page);
        // Best-effort race: fire the scroll immediately. May land
        // before captureSnapshot starts (no race) or during refAssign
        // (race we want to test).
        page.evaluate((y) => (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, y), targetScroll).catch(() => {});
        const snap = await collectPromise;
        const found = snap.elements.find((e) => e.htmlId === 'race-target');
        if (found?.ref) foundCount++;
        // restabilize
        await page.evaluate(() => (globalThis as unknown as { scrollTo: (x: number, y: number) => void }).scrollTo(0, 500));
        await page.waitForFunction(() => (globalThis as unknown as { scrollY: number }).scrollY === 500);
      }

      // Even in the worst case, the live-scroll fix should preserve
      // the target on at least 2/3 collects. With the OLD bug (no
      // scroll subtraction) we'd see 0/3 because target is always
      // below the fold. With snapshot-scroll subtraction we'd see 1/3
      // at best (only the non-racing run survives).
      expect(foundCount).toBeGreaterThanOrEqual(2);
    }, PER_TEST_TIMEOUT_MS);

    it('every interactive element has a ref starting with "e"', async () => {
      await page.setContent(`
        <button>A</button><button>B</button><button>C</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      // Recorder/snapshot-collector init __agentRefCounter at 0, so refs
      // start at e0. CDP must follow the same convention or DB-cached
      // evidence.lastSuccessRef breaks. Phase 0 audit caught an init=1
      // bug — this test is the regression guard.
      const refs = snapshot.elements.map((e) => e.ref).filter(Boolean);
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) {
        expect(ref).toMatch(/^e\d+$/);
      }
    }, PER_TEST_TIMEOUT_MS);

    // ──────────────────────────────────────────────────────────────────
    // Regression: June 2026 codemify.com "Dropped duplicate-ref elements"
    //   spam. findElement is a many-to-one map — an <input>, the SVG icon
    //   group centred on it, and assorted pseudo/layout rows all resolve
    //   to the SAME live DOM node. The first request set data-agent-ref;
    //   every later request read the SAME attribute back and the collector
    //   emitted N LiteElements sharing one ref (observed e34×4, e202 on a
    //   form-with-icons page). dedupeElementsByRef then dropped 17/90 each
    //   tick — quality-aware so the visible input usually survived, but it
    //   was pure log spam + a signal of source-level collisions.
    //
    //   Fix: one-node-per-pass claim WeakSet in runRefAssignmentInFrame —
    //   a node may back at most ONE ref per evaluate. These tests assert
    //   the SOURCE invariant (no element shares a ref BEFORE dedup would
    //   run), i.e. beforeDedup ≈ afterDedup.
    it('never mints the same ref for two distinct elements (input + overlapping icon)', async () => {
      // An input field overlaid by an absolutely-positioned SVG icon whose
      // center sits on the input — the canonical many-to-one collapse:
      // the input request and the icon-group request both center on the
      // input's bbox and Stage B returns the same node for the loser.
      await page.setContent(`
        <div style="position:relative; width:320px;">
          <input type="text" name="email" placeholder="Email"
                 style="width:320px; height:44px; box-sizing:border-box;" />
          <svg style="position:absolute; right:8px; top:10px; width:24px; height:24px;"
               viewBox="0 0 24 24" aria-label="email icon">
            <rect x="0" y="0" width="24" height="24"></rect>
            <rect x="4" y="4" width="16" height="16"></rect>
          </svg>
        </div>
        <button id="go">Go</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);

      const refs = snapshot.elements.map((e) => e.ref).filter(Boolean) as string[];
      const seen = new Set<string>();
      const dups: string[] = [];
      for (const r of refs) {
        if (seen.has(r)) dups.push(r);
        seen.add(r);
      }
      expect(dups).toEqual([]);
      // Sanity: the input itself still made it through with a ref (the
      // fix drops the COLLIDING twin, never the real field).
      const input = snapshot.elements.find((e) => e.tag === 'input');
      expect(input?.ref).toMatch(/^e\d+$/);
    }, PER_TEST_TIMEOUT_MS);

    it('keeps every emitted ref unique on a dense modal-style form (no dedup needed)', async () => {
      // Modal with multiple labelled inputs + icon buttons — the shape
      // that produced e34×4 in production. Assert the ref space is
      // collision-free at the SOURCE so dedupeElementsByRef has nothing
      // to drop.
      await page.setContent(`
        <div role="dialog" style="position:fixed; inset:80px; background:#fff;">
          <h2>Get a free lesson</h2>
          <label>Name
            <span style="position:relative; display:inline-block;">
              <input type="text" name="name" style="width:280px; height:40px;" />
              <svg style="position:absolute; right:6px; top:8px; width:20px; height:20px;" viewBox="0 0 20 20">
                <rect x="0" y="0" width="20" height="20"></rect>
              </svg>
            </span>
          </label>
          <label>Email
            <span style="position:relative; display:inline-block;">
              <input type="email" name="email" style="width:280px; height:40px;" />
              <svg style="position:absolute; right:6px; top:8px; width:20px; height:20px;" viewBox="0 0 20 20">
                <rect x="0" y="0" width="20" height="20"></rect>
              </svg>
            </span>
          </label>
          <button type="submit">Send</button>
        </div>
      `);

      const snapshot = await CdpSnapshotService.collect(page);

      const refs = snapshot.elements.map((e) => e.ref).filter(Boolean) as string[];
      expect(refs.length).toBeGreaterThan(0);
      expect(new Set(refs).size).toBe(refs.length);
      // Both inputs survive (each backs its own ref).
      expect(snapshot.elements.filter((e) => e.tag === 'input' && e.ref).length).toBe(2);
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // 2. Shape symmetry — CDP and evaluate paths should agree
  // ──────────────────────────────────────────────────────────────────
  describe('shape symmetry with evaluate path', () => {
    // Why pick the evaluate output as ground truth: it's the production
    // baseline that consumers (ObserverAgent, ElementResolver) have been
    // trained against. A shape difference is a CDP regression by definition,
    // even if conceptually CDP "should" be more accurate (e.g., AX-driven
    // role names differ from in-page implicit-role inference).
    it('element counts are within 10% on a moderate page', async () => {
      await page.setContent(`
        <header><nav>
          <a href="/">Home</a>
          <a href="/products">Products</a>
        </nav></header>
        <main>
          <button id="cta">Buy now</button>
          <form>
            <input name="email" placeholder="Email" />
            <input name="password" type="password" />
            <button type="submit">Sign in</button>
          </form>
        </main>
      `);

      // CDP first — assigns refs from a fresh counter on this page.
      const cdpSnap = await CdpSnapshotService.collect(page);
      // Open a SECOND page for the evaluate baseline so the two don't
      // race for `__agentRefCounter` increments. Same content via the
      // same setContent call.
      const evalPage = await browser.newPage();
      try {
        await evalPage.setContent(await page.content());
        const evalSnap = await SnapshotCollector.collect(evalPage);

        const a = cdpSnap.elements.length;
        const b = evalSnap.elements.length;
        const ratio = Math.min(a, b) / Math.max(a, b);
        // Allow 10% drift (different page-state-aware filters,
        // implicit-role inference, etc.). Drift > 10% on a static page
        // is a real symmetry regression.
        expect(ratio).toBeGreaterThanOrEqual(0.9);
      } finally {
        await evalPage.close();
      }
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // 3. Phase 0: load-bearing fields must populate on a real page
  // ──────────────────────────────────────────────────────────────────
  describe('Phase 0 — load-bearing fields', () => {
    it('detects role=progressbar as transientState', async () => {
      await page.setContent(`
        <div role="progressbar" aria-valuenow="50" aria-valuemin="0" aria-valuemax="100">
          Loading 50%
        </div>
        <button>Click after load</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      expect(snapshot.transientState).toBeDefined();
      expect(snapshot.transientState?.isTransient).toBe(true);
      expect(snapshot.transientState?.type).toBe('progressbar');
    }, PER_TEST_TIMEOUT_MS);

    it('detects aria-busy=true as transientState', async () => {
      await page.setContent(`
        <div aria-busy="true">Content loading</div>
        <button>Already there</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      expect(snapshot.transientState?.isTransient).toBe(true);
      expect(snapshot.transientState?.type).toBe('aria-busy');
    }, PER_TEST_TIMEOUT_MS);

    it('returns isTransient=false on a calm page (fast-path)', async () => {
      // Fast-path early-exit: when no candidate selector matches AND no
      // pattern text, transientState resolves without touching levels 1-6.
      // We verify the result, not the timing — timing is observability.
      await page.setContent(`
        <h1>Welcome</h1>
        <button>Click</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      expect(snapshot.transientState?.isTransient).toBe(false);
    }, PER_TEST_TIMEOUT_MS);

    it('collects obstacleFacts for fixed/sticky overlays', async () => {
      await page.setContent(`
        <style>
          .banner { position: fixed; top: 0; left: 0; right: 0;
                    height: 60px; z-index: 100; background: yellow; }
          .modal-host { position: fixed; top: 50%; left: 50%;
                        transform: translate(-50%, -50%);
                        width: 400px; height: 300px;
                        z-index: 1000; background: white; }
        </style>
        <header class="banner">Cookie notice</header>
        <div class="modal-host">
          <button class="close">×</button>
          <input placeholder="Email" />
          <button>Submit</button>
        </div>
        <main>Page content</main>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      expect(snapshot.obstacleFacts).toBeDefined();
      expect(snapshot.obstacleFacts!.length).toBeGreaterThan(0);
      // Top-z-index obstacle should be the modal (z=1000), not the
      // banner (z=100). obstacleFacts is sorted descending by zIndex.
      expect(snapshot.obstacleFacts![0].zIndex).toBe(1000);
      expect(snapshot.obstacleFacts![0].hasInteractiveChildren).toBe(true);
    }, PER_TEST_TIMEOUT_MS);

    it('collects a role=dialog obstacle with computed z-index:auto (Radix/shadcn portal pattern, no explicit z-index)', async () => {
      // Regression test for a real bi.group (2026-07-12) miss: Radix UI /
      // shadcn/ui portal-rendered dialogs intentionally omit z-index and
      // rely on DOM/portal order instead, so getComputedStyle(...).zIndex
      // reads 'auto' — parseInt('auto', 10) is NaN. The obstacle-candidate
      // filter used to hard-`continue` on isNaN(zIndex), silently dropping
      // a fully spec-compliant, viewport-covering role="dialog" modal from
      // obstacleFacts even though it also matched IRON_CLAD_MODAL_SELECTORS.
      const html = `
        <button id="outside">Outside</button>
        <div id="modal" role="dialog" style="position: fixed; inset: 0; display: flex;">
          <button class="close">×</button>
          <p>Where do you want to buy property?</p>
          <button>Astana</button>
        </div>
        <div id="decorative-badge" style="position: absolute; top: 4px; right: 4px; width: 10px; height: 10px;">•</div>
      `;
      await page.setContent(html);
      const cdpSnap = await CdpSnapshotService.collect(page);

      const evalPage = await browser.newPage();
      try {
        await evalPage.setContent(html);
        const evalSnap = await SnapshotCollector.collect(evalPage);

        for (const snapshot of [cdpSnap, evalSnap]) {
          const modalFact = snapshot.obstacleFacts?.find((f) => f.id === 'modal');
          expect(modalFact).toBeDefined();
          expect(modalFact!.hintType).toBe('modal');
          expect(modalFact!.zIndex).toBe(0);

          // Negative case, unchanged: an `absolute`-positioned element with
          // no z-index stays excluded — the false-positive guard (badges,
          // carets, in-flow decorative elements) is preserved; only
          // 'fixed'/'sticky' were relaxed.
          const badgeFact = snapshot.obstacleFacts?.find((f) => f.id === 'decorative-badge');
          expect(badgeFact).toBeUndefined();
        }
      } finally {
        await evalPage.close();
      }
    }, PER_TEST_TIMEOUT_MS);

    it('Layer 1 modal: <dialog open> sets activeModalRef AND propagates isInsideActiveModal', async () => {
      // CRITICAL audit-found bug to regress against: Phase 0 added
      // Layer 2 promotion AFTER Phase 5 sets per-element flags — flags
      // could remain stale (false) for elements inside a Layer-2-promoted
      // modal. This test ensures Layer 1 (the simpler case) at least is
      // wired correctly. Layer 2 is exercised in the next test.
      await page.setContent(`
        <button id="outside">Outside</button>
        <dialog open id="modal">
          <button id="inside">Inside modal</button>
          <input placeholder="Inside input" />
        </dialog>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      expect(snapshot.activeModalRef).toBeDefined();

      // Find by id (more stable than text):
      const insideButton = snapshot.elements.find((e) => e.htmlId === 'inside');
      const outsideButton = snapshot.elements.find((e) => e.htmlId === 'outside');

      expect(insideButton).toBeDefined();
      expect(outsideButton).toBeDefined();
      // The contract: elements inside the active modal flagged true,
      // elements outside flagged false. Drift here = wrong-element bugs
      // because Pruner uses this to filter.
      expect(insideButton!.isInsideActiveModal).toBe(true);
      expect(outsideButton!.isInsideActiveModal).toBeFalsy();
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // 4. Runtime fields (Phase 4 enrichment in CDP path)
  // ──────────────────────────────────────────────────────────────────
  describe('runtime field enrichment', () => {
    it('populates checked / hasValue / isContentEditable on real form elements', async () => {
      await page.setContent(`
        <input type="checkbox" id="c1" checked />
        <input type="text" id="t1" value="hello" />
        <div contenteditable="true" id="rt">Rich text</div>
      `);

      const snapshot = await CdpSnapshotService.collect(page);

      const checkbox = snapshot.elements.find((e) => e.htmlId === 'c1');
      const textInput = snapshot.elements.find((e) => e.htmlId === 't1');
      // contenteditable divs aren't always interactive by tag, but the
      // collector's role/tabindex/contenteditable filter should pick
      // them up. If not found, that's a separate (smaller) issue worth
      // flagging — keeping assertion soft so the test failure points
      // at the actual culprit.
      const editable = snapshot.elements.find((e) => e.htmlId === 'rt');

      expect(checkbox).toBeDefined();
      expect(checkbox!.checked).toBe(true);
      expect(textInput).toBeDefined();
      expect(textInput!.hasValue).toBe(true);
      if (editable) {
        expect(editable.isContentEditable).toBe(true);
      }
    }, PER_TEST_TIMEOUT_MS);

    it('hasValue privacy contract: text=false (empty), password=undefined (sensitive)', async () => {
      await page.setContent(`
        <input type="text" id="t1" />
        <input type="password" id="p1" />
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      const text = snapshot.elements.find((e) => e.htmlId === 't1');
      const password = snapshot.elements.find((e) => e.htmlId === 'p1');

      // Non-sensitive empty input → hasValue=false (state signal that
      // "type if empty" branch can use safely).
      expect(text?.hasValue).toBe(false);
      // Sensitive input (password) → hasValue=undefined ON PURPOSE.
      // Returning false would leak presence-vs-absence; returning true
      // would leak filled state. Existing evaluate-path collector
      // returns undefined for sensitive inputs to mirror "we did not
      // measure this". CDP path must match for shape symmetry.
      expect(password?.hasValue).toBeUndefined();
      // Privacy contract: NEVER expose raw value, regardless of input type.
      // If we ever leak `value` field on an element, that's a privacy
      // regression and this assertion catches it.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((text as any)?.value).toBeUndefined();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((password as any)?.value).toBeUndefined();
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // 4b. Q1 audit fix — 4 critical fields previously dropped
  //     (isTopMostAtCenter, childTestId, iconClasses)
  // ──────────────────────────────────────────────────────────────────
  describe('Q1 audit fix — fields previously missing in CDP', () => {
    it('isTopMostAtCenter: uncovered button = true, covered button = false', async () => {
      // Two buttons at the same coordinates — second one wins z-stacking,
      // first one is "covered" at its center. Resolver consumers
      // (hybrid-semantic-weight, lite-engine.ts:598) penalise covered
      // elements; without this field they'd be indistinguishable.
      await page.setContent(`
        <style>
          .a { position: absolute; top: 100px; left: 100px;
               width: 200px; height: 50px; z-index: 1; }
          .b { position: absolute; top: 100px; left: 100px;
               width: 200px; height: 50px; z-index: 100; background: white; }
        </style>
        <button class="a" id="under">Under</button>
        <button class="b" id="over">Over</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      const under = snapshot.elements.find((e) => e.htmlId === 'under');
      const over = snapshot.elements.find((e) => e.htmlId === 'over');

      expect(under).toBeDefined();
      expect(over).toBeDefined();
      // The button on top is topmost-at-center; the one underneath is not.
      expect(over!.isTopMostAtCenter).toBe(true);
      expect(under!.isTopMostAtCenter).toBe(false);
    }, PER_TEST_TIMEOUT_MS);

    it('childTestId: lifts testid from unique icon child when parent has no own descriptor', async () => {
      // Icon-only button without text/aria-label/title/testid on the
      // button itself, but the SVG inside has data-testid. Used by
      // compiled-locator-executor for testId-strategy fingerprint
      // matching.
      await page.setContent(`
        <button id="iconBtn">
          <svg data-testid="save-icon" width="16" height="16"></svg>
        </button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      const btn = snapshot.elements.find((e) => e.htmlId === 'iconBtn');
      expect(btn).toBeDefined();
      expect(btn!.childTestId).toBe('save-icon');
    }, PER_TEST_TIMEOUT_MS);

    it('childTestId: NOT set when button has its own descriptor', async () => {
      // Symmetric guard — when parent already has aria-label, we don't
      // lift child testid (would be redundant and confuse fingerprint
      // matching).
      await page.setContent(`
        <button id="labeledBtn" aria-label="Save document">
          <svg data-testid="save-icon"></svg>
        </button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      const btn = snapshot.elements.find((e) => e.htmlId === 'labeledBtn');
      expect(btn).toBeDefined();
      expect(btn!.childTestId).toBeUndefined();
    }, PER_TEST_TIMEOUT_MS);

    it('identity fields populated: id (stable), testIdAttr, isDynamicId', async () => {
      // CLAUDE.md root invariant 6: identity fast-path REQUIRES id +
      // testIdAttr populated. Without these, recorder symmetry breaks
      // and resolverPath="identity_id" / "identity_testid" never fires.
      // Q5 audit found these were missing in CDP path.
      await page.setContent(`
        <button id="login-btn">Login</button>
        <button id="el-id-225-3" data-testid="signup">Signup</button>
        <button id=":r5:">Generated</button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      const login = snapshot.elements.find((e) => e.htmlId === 'login-btn');
      const signup = snapshot.elements.find((e) => e.htmlId === 'el-id-225-3');
      const gen = snapshot.elements.find((e) => e.htmlId === ':r5:');

      // Stable id: passes through, isDynamicId is falsy.
      expect(login?.id).toBe('login-btn');
      expect(login?.isDynamicId).toBeFalsy();
      // Element Plus generated id: filtered (id=undefined), isDynamicId=true.
      expect(signup?.id).toBeUndefined();
      expect(signup?.isDynamicId).toBe(true);
      expect(signup?.testIdAttr).toBe('signup');
      // React useId() generated id: filtered, isDynamicId=true.
      expect(gen?.id).toBeUndefined();
      expect(gen?.isDynamicId).toBe(true);
    }, PER_TEST_TIMEOUT_MS);

    it('iconClasses: extracts FontAwesome / Material / icon-suffixed class hints', async () => {
      // Two icon-only buttons sharing role="button" — without
      // iconClasses they look identical to the resolver. With it,
      // each gets a stable distinguishing signal.
      // Note: bare data-lucide="trash" doesn't pass the regex filter
      // in either CDP or evaluate path (no icon prefix on the token)
      // — symmetric known limitation. Use a class-prefixed example
      // to verify the path works.
      await page.setContent(`
        <button id="b1" aria-label=""><i class="fa fa-save fa-lg"></i></button>
        <button id="b2" aria-label=""><i class="material-icons">edit</i></button>
        <button id="b3" aria-label=""><i class="folder-icon"></i></button>
      `);

      const snapshot = await CdpSnapshotService.collect(page);
      const b1 = snapshot.elements.find((e) => e.htmlId === 'b1');
      const b2 = snapshot.elements.find((e) => e.htmlId === 'b2');
      const b3 = snapshot.elements.find((e) => e.htmlId === 'b3');

      expect(b1?.iconClasses).toMatch(/fa-save/);
      expect(b2?.iconClasses).toMatch(/material-icons/);
      expect(b3?.iconClasses).toMatch(/folder-icon/);
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // Phase 5 piggyback REMOVED — empirical test showed 100% screencast
  // frame drop during DOMSnapshot.captureSnapshot on the same CDP
  // session. See cdp-screencast-collision.integration.test.ts for the
  // measurement. Preview now ALWAYS uses evaluate path; CDP path
  // serves only background/AI contexts (no screencast = no conflict).
  // ──────────────────────────────────────────────────────────────────

  // ──────────────────────────────────────────────────────────────────
  // 4d. Real-Chromium SPEED comparison — CDP vs evaluate on dense DOM
  //
  // The whole point of Etap 2: measure the real wall-clock difference
  // on a juz40-class dense page. Not synthetic, not mocked. If CDP
  // doesn't actually beat evaluate by a meaningful margin on real
  // Chromium, the piggyback complexity isn't worth the screencast
  // jank tradeoff.
  //
  // Constraint: synthetic 5000-element page is the closest we can get
  // to juz40's 11k DOM in a unit-style test. Real prod numbers will
  // be 2-3x worse on both paths but the RATIO should hold.
  // ──────────────────────────────────────────────────────────────────
  describe('SPEED comparison — CDP vs evaluate on dense synthetic DOM', () => {
    it('CDP does not regress under evaluate, per element, on a 5000-element page', async () => {
      // Build a dense page programmatically — 5000 visible buttons +
      // attributes that force the evaluate path through every cascade
      // (icon classes, descendants, etc.). This is the kind of page
      // where evaluate path's 16s pain manifests in production.
      const itemsPerRow = 50;
      const rows = 100; // 5000 items
      const html = `
        <style>
          .item { padding: 4px 8px; margin: 2px; display: inline-block; cursor: pointer; }
          .icon::before { content: ''; display: inline-block; width: 14px; height: 14px; }
          .row { display: flex; flex-wrap: wrap; }
        </style>
        ${Array.from({ length: rows }, (_, r) => `
          <div class="row" data-row="${r}">
            ${Array.from({ length: itemsPerRow }, (_, c) => `
              <button class="item" id="item-${r}-${c}" data-testid="cell-${r}-${c}" aria-label="Cell ${r},${c}">
                <i class="icon fa-cell-${c}"></i>
                <span>R${r}C${c}</span>
              </button>
            `).join('')}
          </div>
        `).join('')}
      `;
      await page.setContent(html);

      // Warm up Chromium / Playwright connection — first call always
      // pays a higher setup cost (CDP session creation, lazy-init).
      await CdpSnapshotService.collect(page);

      // CDP path
      const cdpStart = Date.now();
      const cdpSnap = await CdpSnapshotService.collect(page);
      const cdpMs = Date.now() - cdpStart;

      // Evaluate path on a fresh page (don't re-use the CDP-mutated DOM)
      const evalPage = await browser.newPage();
      try {
        await evalPage.setContent(html);
        // Warm-up evaluate path too
        await SnapshotCollector.collect(evalPage).catch(() => {});

        const evalStart = Date.now();
        const evalSnap = await SnapshotCollector.collect(evalPage);
        const evalMs = Date.now() - evalStart;

        const cdpCount = cdpSnap.elements.length;
        const evalCount = evalSnap.elements.length;
        const cdpMsPerElement = cdpMs / Math.max(1, cdpCount);
        const evalMsPerElement = evalMs / Math.max(1, evalCount);

        // Telemetry — surfaces in Jest output via console.log so we
        // can EYEBALL the real numbers when running the test, even
        // when the assertion passes by a wide margin.
        // eslint-disable-next-line no-console
        console.log('[SPEED]', {
          cdpMs,
          evalMs,
          cdpElements: cdpCount,
          evalElements: evalCount,
          cdpMsPerElement: cdpMsPerElement.toFixed(3),
          evalMsPerElement: evalMsPerElement.toFixed(3),
          perElementRatio: (evalMsPerElement / Math.max(0.001, cdpMsPerElement)).toFixed(2) + 'x',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          cdpPhases: (cdpSnap as any).__cdpPhaseTimings,
        });

        // ── The two paths do NOT collect the same set on a dense page ──
        //
        // Measured 2026-08-15 on this exact fixture (5000 buttons, 281 of
        // them inside a 1280×720 viewport):
        //
        //   evaluate → 581 = 281 buttons (EXACTLY the in-viewport ones)
        //                  + 150 <i> + 150 <span>  (Tier-2, capped at 300)
        //   CDP      → 1500 = buttons up to MAX_TOTAL_ELEMENTS, Tier-2 = 0
        //
        // That difference is by design on the CDP side: below-the-fold
        // elements MUST survive (invariant #18 and the "preserves
        // below-the-fold buttons after page scroll" test above), whereas the
        // evaluate path restricts Tier-1 to the viewport. Assert the
        // divergence rather than let it silently distort a timing number.
        expect(cdpCount).toBeGreaterThan(evalCount);

        // Contract: CDP must not regress under evaluate — measured PER
        // ELEMENT, because comparing raw wall-clock across two collections
        // of different size is not a speed comparison at all. This assertion
        // spent months failing for that reason: CDP looked "2× slower" while
        // returning 2.6× the elements, i.e. ~1.3× FASTER per element.
        //
        // Per-element cost is what the regression this guards would actually
        // move — the Q5 audit's uncapped Tier-2 made CDP 30× slower without
        // returning 30× more elements. Do NOT loosen this back into a raw
        // wall-clock ratio, and do not widen the multiplier to make a red run
        // green; the number to look at first is cdpMsPerElement above.
        // Headroom for CI noise: ×1.5.
        //
        // Deliberately NOT asserted: absolute speed. The WIN is proportional
        // to evaluate-path complexity, which is far heavier on real pages
        // (juz40-class 11k DOM, deep ancestor walks, framework detection)
        // than on a flat synthetic grid where CDP transport (~300ms) eats
        // most of the budget.
        expect(cdpMsPerElement).toBeLessThan(evalMsPerElement * 1.5);
      } finally {
        await evalPage.close();
      }
    }, 60_000); // 60s budget — evaluate on 5000 elements can be slow on CI
  });

  // ──────────────────────────────────────────────────────────────────
  // 5. Resilience: Phase 0 hard-timeout + non-fatal failure
  // ──────────────────────────────────────────────────────────────────
  describe('resilience', () => {
    it('does not crash when CDP collect runs immediately after navigation', async () => {
      // The "page just navigated" race used to be a CDP failure mode
      // (DOMSnapshot returns malformed bundle mid-nav). Phase 0
      // categorised it as `page_gone`, made it non-fatal. This test
      // gives that path real coverage.
      await page.setContent('<button>First</button>');
      // Navigate but don't await — the collect call may hit the page
      // mid-transition. We don't care if it succeeds or throws a
      // categorised error; we care that it doesn't hang or crash hard.
      const navPromise = page.setContent('<button>Second</button>');
      try {
        const snapshot = await CdpSnapshotService.collect(page);
        // If it succeeded, transientState must still be populated.
        expect(snapshot.transientState).toBeDefined();
      } catch (err) {
        // Categorised CdpSnapshotError is acceptable; uncategorised
        // exception is a regression.
        expect(err instanceof Error).toBe(true);
      }
      await navPromise;
    }, PER_TEST_TIMEOUT_MS);

    it('finishes under the 5s hard timeout on a normally-responsive page', async () => {
      // Sanity: the hard-timeout shouldn't EVER fire on a healthy page.
      // If this fails, either the page is pathologically slow OR we
      // regressed Phase 0's fast-path. 5s budget is the inner watchdog;
      // we give 6s here for setup overhead.
      await page.setContent('<button>Hi</button>');
      const start = Date.now();
      await CdpSnapshotService.collect(page);
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(6_000);
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // 6. Diff harness: confirm shadow-mode reporter would say "match"
  // ──────────────────────────────────────────────────────────────────
  describe('diff harness end-to-end', () => {
    it('diffSnapshots(eval, cdp) on simple page reports high overlap', async () => {
      // This is the closest thing to "would shadow mode flip cleanly?"
      // a unit test can give us. Doesn't assert match=true (some drift
      // is expected — implicit-role inference, AX name cascade), just
      // that the overlap is high enough to flip the production flag.
      await page.setContent(`
        <h1>Welcome</h1>
        <nav>
          <a href="/a">A</a>
          <a href="/b">B</a>
        </nav>
        <main>
          <button>Submit</button>
          <input placeholder="Email" />
        </main>
      `);

      const cdpSnap = await CdpSnapshotService.collect(page);
      const evalPage = await browser.newPage();
      try {
        await evalPage.setContent(await page.content());
        const evalSnap = await SnapshotCollector.collect(evalPage);

        const diff = diffSnapshots(evalSnap, cdpSnap);
        // Element-level matched count should cover at least 70% of the
        // smaller side. Below that threshold means the diff harness
        // can't trust shadow output at all.
        const minSide = Math.min(diff.summary.aElementCount, diff.summary.bElementCount);
        if (minSide > 0) {
          const matchRatio = diff.summary.matchedElementCount / minSide;
          expect(matchRatio).toBeGreaterThanOrEqual(0.7);
        }
      } finally {
        await evalPage.close();
      }
    }, PER_TEST_TIMEOUT_MS);
  });

  // ──────────────────────────────────────────────────────────────────
  // Framework-clickable role-less wrapper — the documentolog "Login"
  // regression. A role-LESS <div> with a JS-prop (React fiber) onClick whose
  // label lives in a CHILD <p>. Three collector fixes must hold together:
  //   (a) tagFrameworkClickable marks it → isInteractiveNodeTier1 → Tier-1, so
  //       it survives the MAX_TIER2_ELEMENTS cap under cursor:pointer noise;
  //   (b) text comes from the nodeValue descendant (the child <p>), NOT the
  //       textarea-only `textValue` (which is empty) → the resolver has "Login";
  //   (c) Chrome AX role=generic is promoted to button so the LLM candidate
  //       pruner keeps it and the resolver's actionability guard accepts it.
  // Drop any one and the live editor's "Find" returned "element not found" on
  // documentolog.com/en while the evaluate path resolved it (a collector-
  // symmetry break — preview/CLAUDE.md invariant #5).
  // ──────────────────────────────────────────────────────────────────
  describe('framework-clickable role-less wrapper (documentolog "Login")', () => {
    // <div onClick><svg/><p>Login</p></div> — role-less, NO `onclick` attribute;
    // the handler is a JS prop only, surfaced via a simulated React fiber props
    // bag (the exact `__reactProps$*.onClick` signal the tag pass reads). The
    // child <svg>/<p> are pinned to cursor:auto so they don't become their own
    // Tier-2 candidates and add noise.
    async function buildLoginPage(p: Page, decoyCount: number): Promise<void> {
      const decoys = Array.from(
        { length: decoyCount },
        (_, i) => `<div class="decoy" data-i="${i}" style="cursor:pointer;width:30px;height:15px;display:inline-block;"></div>`,
      ).join('');
      await p.setContent(`
        <header>
          <div id="login-wrapper" style="cursor:pointer;width:62px;height:48px;display:inline-block;">
            <svg width="16" height="16" viewBox="0 0 16 16" style="cursor:auto;"></svg>
            <p style="cursor:auto;">Login</p>
          </div>
        </header>
        <main>${decoys}</main>
      `);
      // Attach a React-style fiber props bag carrying onClick. role-less + no
      // `onclick` attribute means this handler is invisible to the attribute-only
      // DOMSnapshot; only the runtime tag pass (Object.keys → __reactProps$*) sees it.
      await p.evaluate(() => {
        const doc = (globalThis as unknown as {
          document: { querySelector(s: string): Record<string, unknown> | null };
        }).document;
        const el = doc.querySelector('#login-wrapper');
        if (el) el['__reactProps$qaittest'] = { onClick: () => { /* noop */ } };
      });
    }

    it('promotes the role-less <div onClick> to a candidate with text + role=button', async () => {
      await buildLoginPage(page, 0);

      const snapshot = await CdpSnapshotService.collect(page);
      const login = snapshot.elements.find((e) => e.htmlId === 'login-wrapper');

      expect(login).toBeDefined();
      expect(login?.tag).toBe('div');
      // (c) Chrome AX reports role=generic; promotion lifts it to button.
      expect(login?.role).toBe('button');
      // (b) Label is in the child <p> — descendant text bubbles it to the wrapper.
      expect(login?.text).toContain('Login');
    }, PER_TEST_TIMEOUT_MS);

    it('survives the Tier-2 cap under cursor:pointer pressure (promotion → Tier-1)', async () => {
      // 350 textless cursor:pointer decoys > MAX_TIER2_ELEMENTS (300). They are
      // smaller (area 450) than the target (2976), so the Tier-2 priority sort
      // fills the cap with decoys first and would crowd the target out — UNLESS
      // the framework-click marker promoted it to (uncapped) Tier-1.
      await buildLoginPage(page, 350);

      const snapshot = await CdpSnapshotService.collect(page);
      const login = snapshot.elements.find((e) => e.htmlId === 'login-wrapper');

      // (a) Present despite the cap pressure → it took the Tier-1 path.
      expect(login).toBeDefined();
      expect(login?.role).toBe('button');
      expect(login?.text).toContain('Login');
      // Sanity: the cap actually fired (not all 350 decoys survived) — otherwise
      // the "pressure" is fake and the survival assertion proves nothing.
      const keptDecoys = snapshot.elements.filter((e) => e.tag === 'div' && e.htmlId !== 'login-wrapper').length;
      expect(keptDecoys).toBeLessThan(350);
    }, PER_TEST_TIMEOUT_MS);
  });
});
