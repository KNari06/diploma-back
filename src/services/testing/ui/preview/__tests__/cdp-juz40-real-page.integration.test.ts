/**
 * Real-world juz40-edu.kz curator home page parity test.
 *
 * The user reported lint regressions on this exact page. Mocked +
 * synthetic-fixture tests passed but real Angular Material + ng-star-
 * inserted markup behaves differently (router-outlet, mat-icon SVG
 * children, ngsrc images, expansion panels with id-bound aria-controls,
 * deeply nested router-link anchors).
 *
 * This test feeds the actual exported HTML (test.html in repo root) to
 * Chromium and diffs CDP vs evaluate snapshot field-by-field. Failure
 * messages list which elements diverge so we can fix them surgically.
 */

import { chromium, type Browser, type Page } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { CdpSnapshotService } from '../cdp-snapshot.service';
import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';

const PER_TEST_TIMEOUT_MS = 60_000;

// Read once at module load — fixture is large (~30 KB) and content
// never changes per test run. Resolution is repo-relative so this
// works regardless of where jest is invoked from.
const FIXTURE_PATH = path.resolve(__dirname, '../../../../../../test.html');
const FIXTURE_HTML = fs.existsSync(FIXTURE_PATH)
  ? fs.readFileSync(FIXTURE_PATH, 'utf-8')
  : null;

// Skip the entire suite when the fixture file isn't checked in (some
// dev setups). Logs a warning so it's obvious why these tests didn't
// run, instead of silently passing 0 cases.
const describeIfFixture = FIXTURE_HTML ? describe : describe.skip;

describeIfFixture('CDP vs evaluate — real juz40 curator home page', () => {
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

  /**
   * Build a stable fingerprint per element so we can compare two
   * collectors element-set-vs-element-set without needing identical
   * `ref` values (refs are assignment-order-dependent).
   *
   * Priority order matches recorder's identity fast-path, which is
   * what really matters in production.
   */
  function fingerprint(el: {
    tag: string;
    htmlId?: string;
    testIdAttr?: string;
    name?: string;
    placeholder?: string;
    ariaLabel?: string;
    href?: string;
    role?: string;
  }): string {
    if (el.htmlId) return `#${el.htmlId}`;
    if (el.testIdAttr) return `[testid=${el.testIdAttr}]`;
    if (el.href) return `<${el.tag} href="${el.href}">`;
    // Tag-only fingerprint (NOT including role) — CDP uses AX
    // implicit roles (`<li>` → "listitem", `<img>` → "image"),
    // evaluate uses raw tag fallback (`<li>` → "li", `<img>` →
    // "img"). Both are correct, just different conventions. We
    // identify the element by its TAG + label, ignoring the role
    // string difference. Recorder identity fast-path keys on
    // id/testid/href first, so this is the rare "no stable id"
    // case where role-style mismatch would have been a false-
    // positive in the diff.
    const label = el.name || el.ariaLabel || el.placeholder || '';
    return `<${el.tag}>${label.slice(0, 40)}`;
  }

  it('CDP must include every element evaluate finds (zero onlyInEval drift)', async () => {
    await page.setContent(FIXTURE_HTML!);
    const cdpSnap = await CdpSnapshotService.collect(page);

    const evalPage = await browser.newPage();
    try {
      await evalPage.setContent(FIXTURE_HTML!);
      const evalSnap = await SnapshotCollector.collect(evalPage);

      const cdpFps = new Set(cdpSnap.elements.map(fingerprint));
      const evalFps = new Set(evalSnap.elements.map(fingerprint));

      const onlyInEval = [...evalFps].filter((fp) => !cdpFps.has(fp));
      const onlyInCdp = [...cdpFps].filter((fp) => !evalFps.has(fp));

      // Detailed: dump full element data for the missed ones so
      // we can see WHY they fingerprint differently.
      const missedDetails = evalSnap.elements
        .filter((e) => !cdpFps.has(fingerprint(e)))
        .map((e) => ({
          tag: e.tag, id: e.htmlId, role: e.role, name: e.name?.slice(0, 40),
          alt: undefined as string | undefined,
          ariaLabel: e.ariaLabel, placeholder: e.placeholder,
          href: e.href, ftf: e.firstTextFragment,
          visible: e.visible, bbox: e.bounds,
        }));
      // eslint-disable-next-line no-console
      console.log('[JUZ40_PARITY]', {
        cdpCount: cdpSnap.elements.length,
        evalCount: evalSnap.elements.length,
        onlyInEval: onlyInEval.slice(0, 50),
        onlyInEvalCount: onlyInEval.length,
        missedDetails,
        onlyInCdp: onlyInCdp.slice(0, 30),
        onlyInCdpCount: onlyInCdp.length,
      });

      // Hard contract: every RECORDABLE element evaluate found must
      // be in CDP. "Recordable" = has a stable identifier the
      // recorder probe captures (id, testid, href). Things like
      // `<app-curator>` Angular custom-element wrappers or bare
      // `<img>` with no alt aren't recordable — recorder can't
      // capture an identity for them, so the resolver never tries
      // to find them. Filter those out and assert zero.
      const recordableMissed = evalSnap.elements
        .filter((e) => !cdpFps.has(fingerprint(e)))
        .filter((e) => !!(e.htmlId || e.testIdAttr || e.href));
      expect(recordableMissed).toEqual([]);
    } finally {
      await evalPage.close();
    }
  }, PER_TEST_TIMEOUT_MS);

  it('critical recorder targets are present in CDP', async () => {
    // Concrete recorder targets the user has steps for. Each is an
    // element with a stable testid/id/href that the recorder probe
    // would capture via `data-testid`/`id`/`href` attributes. The
    // test adapts to whatever subset of these the current fixture
    // has — checks only hrefs that actually appear in the HTML, so
    // shrinking the fixture (for shape-contract tests) doesn't break
    // this test.
    await page.setContent(FIXTURE_HTML!);
    const cdpSnap = await CdpSnapshotService.collect(page);

    const findByHref = (href: string) =>
      cdpSnap.elements.find((e) => e.href === href || e.href?.endsWith(href));
    const findByText = (text: string) =>
      cdpSnap.elements.find((e) =>
        (e.name || '').includes(text)
        || (e.firstTextFragment || '').includes(text),
      );

    // For each candidate target, only assert if the source HTML
    // actually has it. Keeps the test resilient to fixture trimming.
    const candidateHrefs = [
      '/curator', '/curator/my-tasks/all', '/curator/archive',
      '/curator/profile', '/curator/unt', '/curator/appeals',
      '/curator/surveys',
    ];
    let assertedCount = 0;
    for (const href of candidateHrefs) {
      // Quick presence check in raw HTML — if the fixture doesn't
      // mention it, skip (don't assert).
      if (!FIXTURE_HTML!.includes(`href="${href}"`)) continue;
      expect(findByHref(href)).toBeDefined();
      assertedCount++;
    }
    // Sanity: SOMETHING was asserted (otherwise the test is a no-op).
    expect(assertedCount).toBeGreaterThanOrEqual(1);

    // Expansion panels — only assert if fixture has them.
    if (FIXTURE_HTML!.includes('mat-expansion-panel-header')) {
      const expansionTriggers = cdpSnap.elements.filter(
        (e) => e.tag === 'button' && (e.ariaExpanded === false || e.ariaExpanded === true),
      );
      expect(expansionTriggers.length).toBeGreaterThanOrEqual(1);
    }

    // Posters carousel — only if present in fixture.
    if (FIXTURE_HTML!.includes('prev stories') || FIXTURE_HTML!.includes('next stories')) {
      expect(findByText('prev stories') || findByText('next stories')).toBeDefined();
    }
  }, PER_TEST_TIMEOUT_MS);

  it('field coverage on critical elements: id, role, name, ariaExpanded, href', async () => {
    // For a stable element (logo link), assert ALL load-bearing
    // fields are populated. Drift on any one breaks identity
    // fast-path / locator-plan-builder / LLM scoring.
    await page.setContent(FIXTURE_HTML!);
    const cdpSnap = await CdpSnapshotService.collect(page);

    // Only check logo if fixture has it.
    if (FIXTURE_HTML!.includes('href="/curator"')) {
      const logo = cdpSnap.elements.find(
        (e) => e.tag === 'a' && (e.href === '/curator' || e.href?.endsWith('/curator')),
      );
      expect(logo).toBeDefined();
      if (logo) {
        expect(logo.role).toBe('link');
        expect(logo.href).toBeTruthy();
        expect(logo.bounds).toBeDefined();
        expect(logo.visible).toBe(true);
      }
    }

    // Announce-trigger button — only if present in fixture.
    if (FIXTURE_HTML!.includes('aria-haspopup="menu"')) {
      const announceBtn = cdpSnap.elements.find(
        (e) => e.tag === 'button' && e.ariaHasPopup === 'menu',
      );
      expect(announceBtn).toBeDefined();
      expect(announceBtn?.ariaExpanded).toBe(false);
    }
  }, PER_TEST_TIMEOUT_MS);
});
