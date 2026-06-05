import { chromium, type Browser, type Page } from 'playwright';
import { CommandExecutor } from '../command-executor';

/**
 * Integration test for the deterministic blocking-overlay clearer added to the
 * regression/background CommandExecutor path.
 *
 * The clearer is LANGUAGE-AGNOSTIC by design (no hardcoded close-word lists):
 *   Tier 1 — OverlayDismisser flow-mode (geometry + ARIA classification,
 *            type-specific recovery: Escape / click-away / wait).
 *   Tier 2 — LLM last resort (not exercised here; needs model + capped).
 *
 * These tests drive the private `tryClearBlockingOverlay` and assert it clears
 * a genuinely-blocking modal that Escape CAN dismiss, while leaving normal page
 * flow untouched. We avoid asserting on word-matched close buttons precisely
 * because that brittle text tier was removed.
 */
describe('CommandExecutor — deterministic obstacle clear (tier-1, language-agnostic)', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await (await browser.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  });
  afterEach(async () => {
    await page?.close().catch(() => {});
  });

  const covered = (id: string, x: number, y: number) =>
    page.evaluate(
      ({ id, x, y }) =>
        (globalThis as unknown as { document: { elementFromPoint(x: number, y: number): { id?: string } | null } }).document
          .elementFromPoint(x, y)?.id !== id,
      { id, x, y },
    );

  const clearOverlay = (ex: CommandExecutor): Promise<void> =>
    (ex as unknown as { tryClearBlockingOverlay(): Promise<void> }).tryClearBlockingOverlay();

  it('clears an Escape-dismissible modal covering the target (tier-1)', async () => {
    // role=dialog modal that closes on Escape — OverlayDismisser tries Escape
    // for modal type. Geometry/ARIA classified, no word matching.
    await page.setContent(`
      <button id="target" style="position:absolute;top:400px;left:400px">Save</button>
      <div id="m" role="dialog" aria-modal="true" style="position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:9999"></div>
      <script>
        document.addEventListener('keydown', (e) => {
          if (e.key === 'Escape') document.getElementById('m')?.remove();
        });
      </script>`, { waitUntil: 'load' });

    expect(await covered('target', 440, 410)).toBe(true); // blocked before
    const ex = new CommandExecutor(page, {});
    await clearOverlay(ex);
    await page.waitForTimeout(200);
    expect(await covered('target', 440, 410)).toBe(false); // unblocked after
  }, 30000);

  it('is a no-op (does not throw, changes nothing) on a clean page with no overlay', async () => {
    await page.setContent(`
      <main style="padding:40px">
        <button id="target">Save document</button>
        <button id="cancel">Отмена</button>
      </main>`, { waitUntil: 'load' });
    const ex = new CommandExecutor(page, {});
    await expect(clearOverlay(ex)).resolves.toBeUndefined();
    // Both buttons still present — nothing was clicked/removed.
    const ids = await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = (globalThis as any).document;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return Array.prototype.slice.call(d.querySelectorAll('button')).map((b: any) => b.id);
    });
    expect(ids).toEqual(expect.arrayContaining(['target', 'cancel']));
  }, 30000);

  it('does not dismiss a non-blocking sticky footer (flow-mode leaves chrome alone)', async () => {
    // sticky footer is permanent chrome — flow-mode must never remove it.
    await page.setContent(`
      <main style="padding:40px"><button id="target">Save</button></main>
      <footer id="sticky" style="position:sticky;bottom:0;height:40px;background:#eee">cookie bar</footer>`,
      { waitUntil: 'load' });
    const ex = new CommandExecutor(page, {});
    await clearOverlay(ex);
    const stickyStillThere = await page.evaluate(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      () => !!(globalThis as any).document.getElementById('sticky'),
    );
    expect(stickyStillThere).toBe(true);
  }, 30000);
});
