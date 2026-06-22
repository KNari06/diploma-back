import { createServer, type Server } from 'http';
import { AddressInfo } from 'net';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { __test__captureClickAndVerify } from '../preview-step-apply.service';

/**
 * V28 integration test for the newtab click-effect signal.
 *
 * Rule under test: a click that opens a new tab is a STRONG signal ('url')
 * when the popup lands on the clicked anchor's OWN destination, and a WEAK
 * signal ('newtab') otherwise (unrelated ad/tracker popup, or a non-anchor
 * click). The strong path lets the editor persist the compiled plan (no stale
 * orange "Needs apply" dot); the weak path keeps the fake-success guard armed.
 *
 * We drive the REAL captureClickPreState → click → verifyClickHadEffect
 * pipeline on a live Chromium page. newTabMatchesHref compares http/https
 * origins, so we serve real pages from two loopback HTTP servers (same-site
 * and a "foreign" one) instead of data: URLs.
 */
describe('newtab click-effect signal (V28)', () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let siteA: Server;
  let siteB: Server; // "foreign" origin (ad/tracker)
  let baseA = '';
  let baseB = '';

  const start = (server: Server): Promise<string> =>
    new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const { port } = server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${port}`);
      });
    });

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
    siteA = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>siteA page</title><h1>siteA</h1>');
    });
    siteB = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<title>siteB page</title><h1>siteB ad</h1>');
    });
    baseA = await start(siteA);
    baseB = await start(siteB);
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => siteA.close(() => r()));
    await new Promise<void>((r) => siteB.close(() => r()));
  });

  beforeEach(async () => {
    context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    page = await context.newPage();
  });
  afterEach(async () => {
    await context?.close().catch(() => {});
  });

  // Render a page on siteA whose anchor is stamped with data-agent-ref="e0".
  // Render an anchor with a real href (drives targetHref resolution) whose
  // click opens a popup. We open it via an explicit window.open in a click
  // handler — that is exactly what a browser does internally for
  // target="_blank", but it deterministically surfaces the context 'page'
  // event in headless Playwright (a bare target="_blank" + synthetic click
  // does not reliably spawn a context page under setContent). `openUrl`
  // defaults to the href (matching destination) but can differ to model an
  // ad/tracker that hijacks the click to a foreign URL.
  const renderWithLink = async (
    href: string,
    opts?: { wrapIcon?: boolean; openUrl?: string },
  ) => {
    const inner = opts?.wrapIcon ? '<span data-agent-ref="e0">↗</span>' : 'Open';
    const refAttr = opts?.wrapIcon ? '' : 'data-agent-ref="e0"';
    const openUrl = opts?.openUrl ?? href;
    await page.goto(`${baseA}/`, { waitUntil: 'load' });
    await page.setContent(
      `<base href="${baseA}/">
       <a id="lnk" href="${href}" ${refAttr}>${inner}</a>
       <script>
         document.getElementById('lnk').addEventListener('click', (e) => {
           e.preventDefault();
           window.open(${JSON.stringify(openUrl)}, '_blank');
         });
       </script>`,
      { waitUntil: 'load' },
    );
  };

  // Click and wait for the popup to actually exist so the verifier (and our
  // assertions) race against a real second tab, not a not-yet-opened one.
  const clickRef = async () => {
    const popupPromise = context.waitForEvent('page').catch(() => null);
    await page.click('[data-agent-ref="e0"]');
    await popupPromise;
  };

  it('A1: STRONG (url) when the popup lands on the link\'s own destination', async () => {
    await renderWithLink(`${baseA}/dashboard`);
    const r = await __test__captureClickAndVerify(page, 'e0', clickRef);
    expect(r.effected).toBe(true);
    expect(r.signal).toBe('url'); // same-origin destination → real navigation
  }, 30000);

  it('A1b: STRONG even when the live tab carries extra query params', async () => {
    // server ignores the query, but the URL the tab reports keeps it → must
    // still match on the origin+path tier.
    await renderWithLink(`${baseA}/pricing?utm_source=mail&ref=x`);
    const r = await __test__captureClickAndVerify(page, 'e0', clickRef);
    expect(r.signal).toBe('url');
  }, 30000);

  it('A2: STRONG (url) for a genuine external link (href === foreign popup dest)', async () => {
    // The page is on siteA; the click opens a popup on siteB, but the recorded
    // anchor href ALSO points at siteB — i.e. a genuine "open this external
    // link in a new tab" link. href matches the popup destination → STRONG.
    // (A foreign DESTINATION is fine; what makes a newtab weak is href NOT
    // matching where we landed — see A2b.)
    await renderWithLink(`${baseB}/ad`);
    const r = await __test__captureClickAndVerify(page, 'e0', clickRef);
    expect(r.effected).toBe(true);
    expect(r.signal).toBe('url'); // href === popup destination (siteB) → strong
  }, 30000);

  it('A2b: WEAK when href and the actual popup destination disagree', async () => {
    // The visible href claims siteA, but the click actually opens siteB (a
    // hijacked/ad popup). The recorded "intent" (href) does not match where we
    // actually landed → weak. Canonical wrong-element / hijacked-popup case.
    await renderWithLink(`${baseA}/legit`, { openUrl: `${baseB}/popup` });
    const r = await __test__captureClickAndVerify(page, 'e0', clickRef);
    expect(r.signal).toBe('newtab'); // landed on siteB, href said siteA → weak
  }, 30000);

  it('A3: icon INSIDE the link still resolves href via closest(\'a\')', async () => {
    // click target is a <span> with the ref; href lives on the wrapping <a>.
    await renderWithLink(`${baseA}/report`, { wrapIcon: true });
    const r = await __test__captureClickAndVerify(page, 'e0', clickRef);
    expect(r.signal).toBe('url'); // closest('a[href]') found the destination
  }, 30000);

  it('A4: non-anchor click that opens a popup stays WEAK (no href to match)', async () => {
    // a plain button (no <a> ancestor) that JS-opens a same-origin tab. There
    // is no href to compare, so even a same-origin popup must NOT be promoted
    // to the strong 'url' signal — it stays in the weak set so the fake-success
    // guard can still reject it. (Exact weak tag may be 'newtab' or 'detach'
    // depending on how much the popup-open shook the opener page; either is
    // fine — both are weak. What matters is that it's NOT 'url'.)
    await page.goto(`${baseA}/`, { waitUntil: 'load' });
    await page.setContent(
      `<base href="${baseA}/">
       <button id="b" data-agent-ref="e0">click me</button>
       <script>
         document.getElementById('b').addEventListener('click', () => {
           window.open('${baseA}/whatever', '_blank');
         });
       </script>`,
      { waitUntil: 'load' },
    );
    const WEAK = ['newtab', 'detach', 'focus', 'none'];
    const r = await __test__captureClickAndVerify(page, 'e0', clickRef);
    expect(r.signal).not.toBe('url'); // no targetHref → never promoted to strong
    expect(WEAK).toContain(r.signal);
  }, 30000);
});
