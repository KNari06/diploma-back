import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { CommandExecutor } from '../command-executor';
import type { PlaywrightCommand } from '@/types';

/**
 * V28 integration test for URL-aware `switchTab` in the regression/background
 * CommandExecutor path.
 *
 * Old behaviour switched purely by raw tab index (`pages()[N]`). If the runtime
 * tab order diverged from record time (ad/tracker popup inserted a tab, or a
 * recorded tab failed to open) index N pointed at the WRONG page and EVERY
 * later step silently ran in it. The fix matches the recorded tab URL first
 * (`intentMeta.evidence.pageUrl`, tiers: full → origin+path → origin) and only
 * falls back to index for legacy steps / no-match.
 *
 * We assert on which page `executor.page` ends up pointing at — that's the
 * thing every subsequent step inherits, so it's the real contract. URLs must
 * be real http:// (norm() rejects data:/about:blank), so we serve each tab's
 * page from a loopback HTTP server keyed by path.
 */
describe('CommandExecutor — URL-aware switchTab (V28)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let server: Server;
  let base = '';

  const start = (s: Server): Promise<string> =>
    new Promise((resolve) => {
      s.listen(0, '127.0.0.1', () => {
        const { port } = s.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    // Any path returns a tiny page titled after the path — gives each tab a
    // distinct, real http URL.
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<title>${req.url}</title><h1>${req.url}</h1>`);
    });
    base = await start(server);
  });
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });
  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  });
  afterEach(async () => {
    await context?.close().catch(() => {});
  });

  const url = (path: string) => `${base}${path}`;

  // Open pages at the given paths, in order; return the Page handles.
  const openTabs = async (...paths: string[]): Promise<Page[]> => {
    const pages: Page[] = [];
    for (const p of paths) {
      const pg = await context.newPage();
      await pg.goto(url(p), { waitUntil: 'load' });
      pages.push(pg);
    }
    return pages;
  };

  const activePage = (ex: CommandExecutor): Page =>
    (ex as unknown as { page: Page }).page;

  const switchTab = (
    ex: CommandExecutor,
    value: string,
    pageUrl?: string,
  ): Promise<{ success: boolean; error?: string }> => {
    const command = {
      action: 'switchTab',
      value,
      ...(pageUrl ? { intentMeta: { stepId: 's1', evidence: { pageUrl } } } : {}),
    } as unknown as PlaywrightCommand;
    return ex.executeCommand(command);
  };

  it('B1: switches by URL when an ad popup shifted the tab index', async () => {
    // record: tab1 was the invoice. replay: an ad opened tab1, pushing the real
    // invoice to tab2. Index=1 would land on the ad — URL must win.
    const [home, ad, realInvoice] = await openTabs('/home', '/ad', '/invoice');
    const ex = new CommandExecutor(home, {});

    const res = await switchTab(ex, '1', url('/invoice')); // recorded idx=1, url=invoice
    expect(res.success).toBe(true);
    expect(activePage(ex)).toBe(realInvoice); // tab2 by URL, NOT tab1 (ad)
    expect(activePage(ex)).not.toBe(ad);
  }, 30000);

  it('B3: falls back to index for a legacy step with no recorded URL', async () => {
    const [home, , third] = await openTabs('/home', '/second', '/third');
    const ex = new CommandExecutor(home, {});

    const res = await switchTab(ex, '2'); // no pageUrl → pure index
    expect(res.success).toBe(true);
    expect(activePage(ex)).toBe(third);
  }, 30000);

  it('B4: happy path — order unchanged, exact URL match', async () => {
    const [home, realInvoice] = await openTabs('/home', '/invoice');
    const ex = new CommandExecutor(home, {});

    const res = await switchTab(ex, '1', url('/invoice'));
    expect(res.success).toBe(true);
    expect(activePage(ex)).toBe(realInvoice);
  }, 30000);

  it('matches on origin+path when the live tab carries extra query params', async () => {
    // recorded url is clean; the live tab URL keeps ?utm — origin+path tier.
    const [home] = await openTabs('/home');
    const liveTab = (await openTabs('/orders/42?utm_source=mail'))[0];
    const ex = new CommandExecutor(home, {});

    const res = await switchTab(ex, '1', url('/orders/42')); // clean recorded url
    expect(res.success).toBe(true);
    expect(activePage(ex)).toBe(liveTab);
  }, 30000);

  it('throws when the recorded tab is absent AND index is out of range', async () => {
    // record: switch to tab1=invoice. replay: invoice never opened, only home.
    const [home] = await openTabs('/home');
    const ex = new CommandExecutor(home, {});

    // index 1 is OOR (1 tab), and no open tab matches /invoice → must throw,
    // NOT silently stay/return success on the wrong page.
    await expect(switchTab(ex, '1', url('/invoice'))).rejects.toThrow(/Tab not available/i);
    expect(activePage(ex)).toBe(home); // active page unchanged
  }, 30000);

  it('prefers the URL match even when the index points at a valid-but-wrong tab', async () => {
    // index=0 is in range and valid, but it is NOT the recorded destination.
    const [home, realInvoice] = await openTabs('/home', '/invoice');
    const ex = new CommandExecutor(home, {});

    const res = await switchTab(ex, '0', url('/invoice')); // wrong index, right URL
    expect(res.success).toBe(true);
    expect(activePage(ex)).toBe(realInvoice); // url wins over index=0 (home)
    expect(activePage(ex)).not.toBe(home);
  }, 30000);
});
