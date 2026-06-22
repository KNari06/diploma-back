import { chromium, type Browser, type Page } from 'playwright';
import {
  showLintHighlight,
  suppressLintHighlight,
  releaseLintHighlightSuppression,
  clearLintHighlightForSession,
} from '../preview-lint-highlight.service';

/**
 * Regression for the stuck lint border: a `preview:step:lint` emitted just
 * before Apply has its resolver round-trip land AFTER apply cleared the border.
 * That late `showLintHighlight` repainted a border that never went away
 * (observed: red dashed box stuck on the "Name" input after Run).
 *
 * Fix: Apply/Run call `suppressLintHighlight`, so a late showLintHighlight is a
 * no-op (drawn:false) that also clears any leftover border. Suppression lifts on
 * a graced release after the step/run finishes.
 */
describe('lint-highlight suppression (V28)', () => {
  let browser: Browser;
  let page: Page;
  const SID = 'sess-suppress-test';

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await (await browser.newContext({ viewport: { width: 800, height: 600 } })).newPage();
    await page.setContent(
      '<input data-agent-ref="e0" style="position:absolute;top:50px;left:50px" />',
      { waitUntil: 'load' },
    );
  });
  afterEach(async () => {
    await clearLintHighlightForSession(SID).catch(() => undefined);
    await page?.context().close().catch(() => undefined);
  });

  const borderPresent = (): Promise<boolean> =>
    page.evaluate(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      !!(globalThis as any).document.getElementById('__qai_lint_highlight_root'),
    );

  it('draws the border normally when not suppressed', async () => {
    const r = await showLintHighlight(SID, page, 'e0', 'success');
    expect(r.drawn).toBe(true);
    expect(await borderPresent()).toBe(true);
  }, 30000);

  it('suppresses a late lint highlight (no draw) and clears any leftover', async () => {
    // a border is up...
    await showLintHighlight(SID, page, 'e0', 'success');
    expect(await borderPresent()).toBe(true);

    // ...Apply starts → suppress (clears immediately)
    suppressLintHighlight(SID);
    await page.waitForTimeout(50);
    expect(await borderPresent()).toBe(false);

    // ...the late lint result lands AFTER apply → must NOT repaint
    const r = await showLintHighlight(SID, page, 'e0', 'success');
    expect(r.drawn).toBe(false);
    expect(await borderPresent()).toBe(false);
  }, 30000);

  it('draws again only after suppression is released (grace elapsed)', async () => {
    suppressLintHighlight(SID);
    releaseLintHighlightSuppression(SID); // starts the ~1.5s grace timer

    // still within the grace window → late lint still swallowed
    const during = await showLintHighlight(SID, page, 'e0', 'success');
    expect(during.drawn).toBe(false);

    // after the grace window → a fresh lint paints normally again
    await page.waitForTimeout(1700);
    const after = await showLintHighlight(SID, page, 'e0', 'success');
    expect(after.drawn).toBe(true);
    expect(await borderPresent()).toBe(true);
  }, 30000);

  it('re-suppressing cancels a pending graced release (rapid apply→apply)', async () => {
    suppressLintHighlight(SID);
    releaseLintHighlightSuppression(SID); // grace timer armed
    suppressLintHighlight(SID);           // second apply → cancels the release

    await page.waitForTimeout(1700);      // past the (cancelled) grace
    const r = await showLintHighlight(SID, page, 'e0', 'success');
    expect(r.drawn).toBe(false); // still suppressed — timer was cancelled
  }, 30000);
});
