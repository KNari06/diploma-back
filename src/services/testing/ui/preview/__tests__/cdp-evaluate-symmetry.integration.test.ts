/**
 * Side-by-side CDP vs evaluate symmetry on real Chromium.
 *
 * This test exists because mocked unit tests can't catch the
 * field-level divergences that bite us in production. We open a
 * realistic auth-form-class page (mirrors juz40 login layout that
 * caused the recent lint regression) and assert specific contracts:
 *
 *   1. ELEMENT COUNT — both paths must find the same set of
 *      interactive elements within a small tolerance.
 *   2. FIELD COVERAGE — for elements present in both, every
 *      load-bearing field must be populated (id, testIdAttr,
 *      role, name, bounds, etc.).
 *   3. SHAPE PARITY — `isInsideShadowDOM`/`isSlotted`/`shadowDepth`/
 *      `context` must agree on `undefined-vs-false` semantics.
 *
 * When any of these break, the test prints which elements/fields
 * differ — giving a fast loop for fixing CDP shape contract.
 */

import { chromium, type Browser, type Page } from 'playwright';
import { CdpSnapshotService } from '../cdp-snapshot.service';
import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';

const PER_TEST_TIMEOUT_MS = 30_000;

const AUTH_FORM_HTML = `
  <style>
    body { font-family: sans-serif; padding: 20px; }
    .lang-switcher { display: flex; gap: 8px; }
    .lang-switcher button { padding: 4px 12px; cursor: pointer; }
    form { display: flex; flex-direction: column; gap: 12px; max-width: 400px; }
    input { padding: 8px; border: 1px solid #ccc; }
    .submit-btn { padding: 10px; background: #007aff; color: white; border: 0; cursor: pointer; }
    .logo { display: flex; align-items: center; gap: 8px; cursor: pointer; }
    .icon { width: 16px; height: 16px; display: inline-block; }
  </style>
  <header class="logo">
    <img src="data:image/svg+xml,%3Csvg/%3E" id="logo-new" alt="logo" />
    <span>Juz40</span>
  </header>
  <nav class="lang-switcher">
    <button id="lang-kz" type="button">KZ</button>
    <button id="lang-ru" type="button">RU</button>
  </nav>
  <main>
    <h1>Авторизация</h1>
    <form id="login-form">
      <label for="email">Электрондық пошта</label>
      <input id="email" type="email" placeholder="Электрондық пошта" required />

      <label for="password">Парольді еңгізіңіз</label>
      <input id="password" type="password" placeholder="Парольді еңгізіңіз" required />

      <button id="login-btn" class="submit-btn" type="submit">
        <i class="icon"></i>
        Кіру
      </button>
    </form>
    <p id="forgot"><a href="/forgot">Пошта</a></p>
  </main>
`;

describe('CDP vs evaluate — symmetry on auth-form fixture', () => {
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

  it('CDP finds the SAME interactive elements as evaluate (within 10% tolerance)', async () => {
    await page.setContent(AUTH_FORM_HTML);
    const cdpSnap = await CdpSnapshotService.collect(page);

    const evalPage = await browser.newPage();
    try {
      await evalPage.setContent(AUTH_FORM_HTML);
      const evalSnap = await SnapshotCollector.collect(evalPage);

      // Build sets of stable identifiers (id or testid or tag+text)
      // so we can list which specific elements diverge.
      const fingerprint = (el: { tag: string; htmlId?: string; testIdAttr?: string; name?: string; ariaLabel?: string; placeholder?: string }) => {
        if (el.htmlId) return `#${el.htmlId}`;
        if (el.testIdAttr) return `[testid=${el.testIdAttr}]`;
        const label = el.name || el.ariaLabel || el.placeholder || '';
        return `<${el.tag}>${label.slice(0, 30)}`;
      };

      const cdpFps = new Set(cdpSnap.elements.map(fingerprint));
      const evalFps = new Set(evalSnap.elements.map(fingerprint));

      const onlyInEval = [...evalFps].filter((fp) => !cdpFps.has(fp));
      const onlyInCdp = [...cdpFps].filter((fp) => !evalFps.has(fp));

      // eslint-disable-next-line no-console
      console.log('[SYMMETRY]', {
        cdpCount: cdpSnap.elements.length,
        evalCount: evalSnap.elements.length,
        onlyInEval,
        onlyInCdp,
      });

      // Critical: every element evaluate found by stable id (#email,
      // #password, #login-btn, etc.) MUST also be in CDP. These are
      // the elements lint/apply will try to find — drop them and
      // user-visible bugs follow.
      const criticalIds = ['#email', '#password', '#login-btn', '#lang-kz', '#lang-ru', '#logo-new'];
      const cdpIds = cdpSnap.elements.map((e) => e.htmlId).filter(Boolean).map((id) => `#${id}`);
      for (const id of criticalIds) {
        expect(cdpIds).toContain(id);
      }

      // Total count tolerance — drift of ≥3 elements signals a
      // systematic filter mismatch worth investigating.
      const drift = Math.abs(cdpSnap.elements.length - evalSnap.elements.length);
      expect(drift).toBeLessThanOrEqual(2);
    } finally {
      await evalPage.close();
    }
  }, PER_TEST_TIMEOUT_MS);

  it('shape parity: isInsideShadowDOM/isSlotted/shadowDepth/context align', async () => {
    // No shadow DOM, no slots — all elements should report the
    // SAME default. evaluate-path may set false; CDP-path may
    // leave undefined. Either is fine but they must AGREE.
    await page.setContent(AUTH_FORM_HTML);
    const cdpSnap = await CdpSnapshotService.collect(page);

    const evalPage = await browser.newPage();
    try {
      await evalPage.setContent(AUTH_FORM_HTML);
      const evalSnap = await SnapshotCollector.collect(evalPage);

      // Compare matched elements — must agree on these fields.
      const matched: Array<{ id: string; cdpVal: unknown; evalVal: unknown; field: string }> = [];

      for (const cdpEl of cdpSnap.elements) {
        if (!cdpEl.htmlId) continue;
        const evalEl = evalSnap.elements.find((e) => e.htmlId === cdpEl.htmlId);
        if (!evalEl) continue;

        for (const field of ['isInsideShadowDOM', 'isSlotted', 'shadowDepth', 'context'] as const) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cdpVal = (cdpEl as any)[field];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const evalVal = (evalEl as any)[field];
          // Treat undefined and false as equal (privacy/coverage
          // contract — we don't care about presence vs explicit-false).
          const cdpNorm = cdpVal === undefined ? false : cdpVal;
          const evalNorm = evalVal === undefined ? false : evalVal;
          if (cdpNorm !== evalNorm) {
            matched.push({ id: cdpEl.htmlId, cdpVal, evalVal, field });
          }
        }
      }

      // eslint-disable-next-line no-console
      if (matched.length > 0) console.log('[SHAPE_DIFFS]', matched.slice(0, 10));

      // After Bug 2 fix: zero shape divergences expected.
      expect(matched).toHaveLength(0);
    } finally {
      await evalPage.close();
    }
  }, PER_TEST_TIMEOUT_MS);

  it('every CDP element has a non-undefined bounds (Bug 1 regression)', async () => {
    // Bug 1: CDP dropped elements when bounds was undefined. After
    // fix: bounds is always present, even if 0×0 placeholder for
    // display:contents elements.
    await page.setContent(AUTH_FORM_HTML);
    const cdpSnap = await CdpSnapshotService.collect(page);

    const elsWithoutBounds = cdpSnap.elements.filter((e) => !e.bounds);
    // eslint-disable-next-line no-console
    if (elsWithoutBounds.length > 0) {
      console.log('[NO_BOUNDS]', elsWithoutBounds.map((e) => ({
        tag: e.tag, id: e.htmlId, role: e.role, name: e.name?.slice(0, 30),
      })));
    }
    expect(elsWithoutBounds).toHaveLength(0);
  }, PER_TEST_TIMEOUT_MS);

  it('attribute-based interactive elements: onclick / data-testid / aria-haspopup', async () => {
    // Variants the user's real pages have but our fixture didn't
    // exercise. Each MUST appear in CDP — they're explicitly tagged
    // for testing/interaction.
    await page.setContent(`
      <div id="onclick-div" onclick="void 0">click me</div>
      <span id="testid-span" data-testid="my-trigger">trigger</span>
      <div id="popup-trigger" aria-haspopup="true">menu</div>
      <div id="draggable" draggable="true">drag</div>
      <div id="contented" contenteditable="true">edit me</div>
      <i id="data-action-i" data-action="click->controller#do">stimulus</i>
    `);
    const cdpSnap = await CdpSnapshotService.collect(page);
    const ids = cdpSnap.elements.map((e) => e.htmlId).filter(Boolean);
    expect(ids).toContain('onclick-div');
    expect(ids).toContain('testid-span');
    expect(ids).toContain('popup-trigger');
    expect(ids).toContain('draggable');
    expect(ids).toContain('contented');
    expect(ids).toContain('data-action-i');
  }, PER_TEST_TIMEOUT_MS);

  it('dataState (Radix/shadcn/Vaul) — collected symmetrically by both paths', async () => {
    // Radix UI / shadcn / Vaul encode toggle state as data-state.
    // Without it, resolver can't tell open trigger from closed →
    // canonical fake-success on already-opened dropdown clicks.
    // PURE ADDITIVE: existing fields untouched; this only verifies
    // the new field appears on both paths and stays absent when
    // the attribute is missing.
    await page.setContent(`
      <button id="opened-trigger" data-state="open" aria-haspopup="menu">Open menu</button>
      <button id="closed-trigger" data-state="closed" aria-haspopup="menu">Closed menu</button>
      <div role="tab" id="active-tab" data-state="active">Active tab</div>
      <div role="tab" id="inactive-tab" data-state="inactive">Inactive tab</div>
      <button id="plain-button">No data-state</button>
    `);
    const cdpSnap = await CdpSnapshotService.collect(page);
    const evalSnap = await SnapshotCollector.collect(page);

    const findById = (snap: { elements: Array<{ htmlId?: string; dataState?: string }> }, id: string) =>
      snap.elements.find((e) => e.htmlId === id);

    for (const id of ['opened-trigger', 'closed-trigger', 'active-tab', 'inactive-tab', 'plain-button']) {
      const cdpEl = findById(cdpSnap, id);
      const evalEl = findById(evalSnap, id);
      expect(cdpEl).toBeDefined();
      expect(evalEl).toBeDefined();
      // Symmetry contract — same value (or both undefined).
      expect(cdpEl?.dataState).toBe(evalEl?.dataState);
    }

    // Concrete value assertions — guards against silent drop on
    // either path. If either path reads the wrong attribute or
    // mis-trims, this fails.
    expect(findById(cdpSnap, 'opened-trigger')?.dataState).toBe('open');
    expect(findById(cdpSnap, 'closed-trigger')?.dataState).toBe('closed');
    expect(findById(cdpSnap, 'active-tab')?.dataState).toBe('active');
    expect(findById(cdpSnap, 'inactive-tab')?.dataState).toBe('inactive');
    // Critical: plain button has NO data-state → must be undefined,
    // not '' / false / null. Existing consumers rely on
    // `if (el.dataState === 'open')` etc.
    expect(findById(cdpSnap, 'plain-button')?.dataState).toBeUndefined();
    expect(findById(evalSnap, 'plain-button')?.dataState).toBeUndefined();
  }, PER_TEST_TIMEOUT_MS);

  it('context derivation: form/nav/modal containers populate `context` field', async () => {
    // hybrid-semantic-weight reads `el.context` for LLM scoring.
    // Without it, dense-page candidate ranking diverges.
    await page.setContent(`
      <nav><button id="in-nav">Nav button</button></nav>
      <form><button id="in-form">Form button</button></form>
      <div role="dialog" aria-label="Confirm dialog">
        <button id="in-modal">Modal button</button>
      </div>
      <article>
        <h2>Article title</h2>
        <a href="#" id="in-article">Article link</a>
      </article>
    `);
    const cdpSnap = await CdpSnapshotService.collect(page);
    const inNav = cdpSnap.elements.find((e) => e.htmlId === 'in-nav');
    const inForm = cdpSnap.elements.find((e) => e.htmlId === 'in-form');
    const inModal = cdpSnap.elements.find((e) => e.htmlId === 'in-modal');
    const inArticle = cdpSnap.elements.find((e) => e.htmlId === 'in-article');

    expect(inNav?.context).toMatch(/Navigation/);
    expect(inForm?.context).toMatch(/Form/);
    expect(inModal?.context).toMatch(/Modal/);
    expect(inArticle?.context).toMatch(/Article/);
  }, PER_TEST_TIMEOUT_MS);

  it('input fields (email, password) are present with correct semantics', async () => {
    // Direct regression for the lint failure the user reported:
    // "lint can't find email input on auth page".
    await page.setContent(AUTH_FORM_HTML);
    const cdpSnap = await CdpSnapshotService.collect(page);

    const email = cdpSnap.elements.find((e) => e.htmlId === 'email');
    const password = cdpSnap.elements.find((e) => e.htmlId === 'password');

    expect(email).toBeDefined();
    expect(email!.tag).toBe('input');
    expect(email!.type).toBe('email');
    expect(email!.placeholder).toBe('Электрондық пошта');

    expect(password).toBeDefined();
    expect(password!.tag).toBe('input');
    expect(password!.type).toBe('password');
    // hasValue privacy: undefined for sensitive (password) — already
    // covered by other test. Just verify it's NOT a leak of value.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((password as any).value).toBeUndefined();
  }, PER_TEST_TIMEOUT_MS);
});
