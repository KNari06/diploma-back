/**
 * Empirical test: does DOMSnapshot.captureSnapshot block screencast
 * frame delivery on the SAME CDP session?
 *
 * Background: invariant in root CLAUDE.md says "never create raw CDP
 * sessions because they conflict with screencast". Phase 5 piggyback
 * goes the OPPOSITE way — reuses the existing screencast session for
 * snapshot commands. Web research (Chromium source) couldn't conclude
 * whether `Page.screencastFrame` events keep flowing while
 * `DOMSnapshot.captureSnapshot` is in flight on the same session.
 *
 * This test answers it empirically. Steps:
 *   1. Open page with continuous DOM mutations (drives screencast frames)
 *   2. Start screencast on a CDP session
 *   3. Count frames received over a 2-second baseline (X frames)
 *   4. Run `DOMSnapshot.captureSnapshot` on the SAME session
 *   5. Count frames received DURING the captureSnapshot call (Y frames)
 *   6. Calculate frames-per-second drop: if Y/duration < 50% of baseline,
 *      we have a real conflict; if not, piggyback is safe.
 *
 * Why this matters for Etap 2:
 *   If piggyback fully blocks frames → editor video freezes for ~1.5s
 *   per snapshot → user-visible jank → revert piggyback
 *   If frames keep flowing → piggyback is the right design → keep it
 */

import { chromium, type Browser, type Page, type CDPSession } from 'playwright';

const TEST_TIMEOUT = 30_000;

describe('CDP screencast + snapshot collision (empirical)', () => {
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

  it('measures whether DOMSnapshot.captureSnapshot blocks Page.screencastFrame on same session', async () => {
    // Build a continuously mutating page — every 16ms we toggle a
    // class so the compositor has reason to send a fresh frame.
    await page.setContent(`
      <style>
        body { margin: 0; }
        .a { background: red; width: 100%; height: 100%; position: absolute; }
        .b { background: blue; width: 100%; height: 100%; position: absolute; }
        ${Array.from({ length: 1000 }, (_, i) => `.x${i}{padding:2px;}`).join('')}
      </style>
      <div id="root"></div>
      <script>
        const root = document.getElementById('root');
        let toggle = false;
        // Build dense DOM so DOMSnapshot has real work to do.
        for (let i = 0; i < 1000; i++) {
          const d = document.createElement('div');
          d.className = 'x' + i;
          d.textContent = 'item-' + i;
          root.appendChild(d);
        }
        // Toggle background every animation frame — drives screencast frames.
        function tick() {
          document.body.className = toggle ? 'a' : 'b';
          toggle = !toggle;
          requestAnimationFrame(tick);
        }
        tick();
      </script>
    `);

    const cdp: CDPSession = await page.context().newCDPSession(page);
    try {
      const frameTimes: number[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cdp.on('Page.screencastFrame', async (params: any) => {
        frameTimes.push(Date.now());
        // Must ack or screencast stops after ~3 frames.
        try {
          await cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch { /* page closed */ }
      });

      await cdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 30,
        everyNthFrame: 1,
      });

      // ── Phase 1: baseline (2 seconds, no snapshot interference) ──
      const baselineStart = Date.now();
      await page.waitForTimeout(2000);
      const baselineEnd = Date.now();
      const baselineFrames = frameTimes.filter(
        (t) => t >= baselineStart && t <= baselineEnd,
      );
      const baselineFps = baselineFrames.length / ((baselineEnd - baselineStart) / 1000);

      // ── Phase 2: during DOMSnapshot.captureSnapshot ──
      const snapshotStart = Date.now();
      // Trigger captureSnapshot — this is the command we're testing.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshotPromise: Promise<any> = cdp.send('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity', 'cursor'],
        includeDOMRects: true,
        includePaintOrder: true,
      });
      // Wait for snapshot completion AND collect frames during it.
      await snapshotPromise;
      const snapshotEnd = Date.now();
      const snapshotMs = snapshotEnd - snapshotStart;

      const duringFrames = frameTimes.filter(
        (t) => t >= snapshotStart && t <= snapshotEnd,
      );
      const duringFps = duringFrames.length / Math.max(0.01, (snapshotEnd - snapshotStart) / 1000);

      // ── Phase 3: post-snapshot recovery (1 second) ──
      const recoveryStart = Date.now();
      await page.waitForTimeout(1000);
      const recoveryEnd = Date.now();
      const recoveryFrames = frameTimes.filter(
        (t) => t >= recoveryStart && t <= recoveryEnd,
      );
      const recoveryFps = recoveryFrames.length / ((recoveryEnd - recoveryStart) / 1000);

      await cdp.send('Page.stopScreencast').catch(() => {});

      const dropPct = baselineFps > 0
        ? Math.round((1 - duringFps / baselineFps) * 100)
        : 0;

      // eslint-disable-next-line no-console
      console.log('[SCREENCAST_COLLISION]', {
        snapshotMs,
        baselineFps: baselineFps.toFixed(1),
        duringSnapshotFps: duringFps.toFixed(1),
        recoveryFps: recoveryFps.toFixed(1),
        dropPct: dropPct + '%',
        verdict:
          dropPct < 30 ? 'PIGGYBACK SAFE — frames flow normally during snapshot'
          : dropPct < 70 ? 'PIGGYBACK DEGRADED — moderate frame drop, but functional'
          : 'PIGGYBACK BLOCKS VIDEO — frames freeze, must revert',
      });

      // We're not asserting a specific drop rate — this test is
      // diagnostic. The real value is the printed verdict telling us
      // whether to keep or revert the Phase 5 piggyback wiring.
      expect(snapshotMs).toBeGreaterThan(0);
    } finally {
      await cdp.detach().catch(() => {});
    }
  }, TEST_TIMEOUT);

  it('SEPARATE CDP sessions: does parallel snapshot still block screencast?', async () => {
    // Same scenario as above, but the snapshot runs on a SECOND
    // CDP session. If frames keep flowing → we have a workaround:
    // open a dedicated CDP session for snapshot, leave screencast
    // alone on its own. If frames still drop → the bottleneck is
    // the renderer process itself (Blink main thread or DevTools
    // dispatcher), not the CDP channel — no workaround possible.
    await page.setContent(`
      <style>
        body { margin: 0; }
        .a { background: red; width: 100%; height: 100%; position: absolute; }
        .b { background: blue; width: 100%; height: 100%; position: absolute; }
        ${Array.from({ length: 1000 }, (_, i) => `.x${i}{padding:2px;}`).join('')}
      </style>
      <div id="root"></div>
      <script>
        const root = document.getElementById('root');
        let toggle = false;
        for (let i = 0; i < 1000; i++) {
          const d = document.createElement('div');
          d.className = 'x' + i;
          d.textContent = 'item-' + i;
          root.appendChild(d);
        }
        function tick() {
          document.body.className = toggle ? 'a' : 'b';
          toggle = !toggle;
          requestAnimationFrame(tick);
        }
        tick();
      </script>
    `);

    // Two SEPARATE CDP sessions on the same page.
    const screencastCdp: CDPSession = await page.context().newCDPSession(page);
    const snapshotCdp: CDPSession = await page.context().newCDPSession(page);
    try {
      const frameTimes: number[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      screencastCdp.on('Page.screencastFrame', async (params: any) => {
        frameTimes.push(Date.now());
        try {
          await screencastCdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch { /* page closed */ }
      });

      await screencastCdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 30,
        everyNthFrame: 1,
      });

      // Phase 1: baseline (2s).
      const baselineStart = Date.now();
      await page.waitForTimeout(2000);
      const baselineEnd = Date.now();
      const baselineFrames = frameTimes.filter(
        (t) => t >= baselineStart && t <= baselineEnd,
      );
      const baselineFps = baselineFrames.length / ((baselineEnd - baselineStart) / 1000);

      // Phase 2: trigger captureSnapshot on the SECOND session.
      const snapshotStart = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshotPromise: Promise<any> = snapshotCdp.send('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity', 'cursor'],
        includeDOMRects: true,
        includePaintOrder: true,
      });
      await snapshotPromise;
      const snapshotEnd = Date.now();
      const snapshotMs = snapshotEnd - snapshotStart;
      const duringFrames = frameTimes.filter(
        (t) => t >= snapshotStart && t <= snapshotEnd,
      );
      const duringFps = duringFrames.length / Math.max(0.01, (snapshotEnd - snapshotStart) / 1000);

      // Phase 3: recovery (1s).
      const recoveryStart = Date.now();
      await page.waitForTimeout(1000);
      const recoveryEnd = Date.now();
      const recoveryFrames = frameTimes.filter(
        (t) => t >= recoveryStart && t <= recoveryEnd,
      );
      const recoveryFps = recoveryFrames.length / ((recoveryEnd - recoveryStart) / 1000);

      await screencastCdp.send('Page.stopScreencast').catch(() => {});

      const dropPct = baselineFps > 0
        ? Math.round((1 - duringFps / baselineFps) * 100)
        : 0;

      // eslint-disable-next-line no-console
      console.log('[SEPARATE_SESSIONS]', {
        snapshotMs,
        baselineFps: baselineFps.toFixed(1),
        duringSnapshotFps: duringFps.toFixed(1),
        recoveryFps: recoveryFps.toFixed(1),
        dropPct: dropPct + '%',
        verdict:
          dropPct < 30 ? 'WORKAROUND VIABLE — separate CDP session keeps frames flowing'
          : dropPct < 70 ? 'PARTIAL — moderate degradation but better than piggyback'
          : 'NO WORKAROUND — bottleneck is renderer-internal, not CDP channel',
      });

      expect(snapshotMs).toBeGreaterThan(0);
    } finally {
      await screencastCdp.detach().catch(() => {});
      await snapshotCdp.detach().catch(() => {});
    }
  }, TEST_TIMEOUT);

  it('SEPARATE CDP sessions on DENSE page (5000+ nodes): real-world test', async () => {
    // The previous test ran on ~1000 nodes — captureSnapshot finished
    // in 7ms, well within a single frame. This test runs on a juz40-
    // class dense page where snapshot takes 200-1000ms — long enough
    // for any conflict to actually manifest. If frames keep flowing
    // here too → workaround is genuinely viable for production preview.
    const itemsPerRow = 50;
    const rows = 100; // 5000 buttons
    const html = `
      <style>
        body { margin: 0; }
        .a { background: red; } .b { background: blue; }
        .item { padding: 4px 8px; margin: 2px; display: inline-block; cursor: pointer; }
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
      <script>
        let toggle = false;
        function tick() {
          document.body.className = toggle ? 'a' : 'b';
          toggle = !toggle;
          requestAnimationFrame(tick);
        }
        tick();
      </script>
    `;
    await page.setContent(html);

    const screencastCdp: CDPSession = await page.context().newCDPSession(page);
    const snapshotCdp: CDPSession = await page.context().newCDPSession(page);
    try {
      const frameTimes: number[] = [];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      screencastCdp.on('Page.screencastFrame', async (params: any) => {
        frameTimes.push(Date.now());
        try {
          await screencastCdp.send('Page.screencastFrameAck', { sessionId: params.sessionId });
        } catch { /* page closed */ }
      });

      await screencastCdp.send('Page.startScreencast', {
        format: 'jpeg',
        quality: 30,
        everyNthFrame: 1,
      });

      // Baseline 1.5s
      const baselineStart = Date.now();
      await page.waitForTimeout(1500);
      const baselineEnd = Date.now();
      const baselineFrames = frameTimes.filter(
        (t) => t >= baselineStart && t <= baselineEnd,
      );
      const baselineFps = baselineFrames.length / ((baselineEnd - baselineStart) / 1000);

      // Heavy snapshot on second session
      const snapshotStart = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const snapshotPromise: Promise<any> = snapshotCdp.send('DOMSnapshot.captureSnapshot', {
        computedStyles: ['display', 'visibility', 'opacity', 'cursor', 'pointer-events',
                         'position', 'z-index', 'background-color', 'color', 'border-radius'],
        includeDOMRects: true,
        includePaintOrder: true,
      });
      await snapshotPromise;
      const snapshotEnd = Date.now();
      const snapshotMs = snapshotEnd - snapshotStart;
      const duringFrames = frameTimes.filter(
        (t) => t >= snapshotStart && t <= snapshotEnd,
      );
      const duringFps = duringFrames.length / Math.max(0.01, (snapshotEnd - snapshotStart) / 1000);

      // Recovery
      const recoveryStart = Date.now();
      await page.waitForTimeout(1000);
      const recoveryEnd = Date.now();
      const recoveryFrames = frameTimes.filter(
        (t) => t >= recoveryStart && t <= recoveryEnd,
      );
      const recoveryFps = recoveryFrames.length / ((recoveryEnd - recoveryStart) / 1000);

      await screencastCdp.send('Page.stopScreencast').catch(() => {});

      const dropPct = baselineFps > 0
        ? Math.round((1 - duringFps / baselineFps) * 100)
        : 0;

      // eslint-disable-next-line no-console
      console.log('[SEPARATE_SESSIONS_DENSE]', {
        snapshotMs,
        baselineFps: baselineFps.toFixed(1),
        duringSnapshotFps: duringFps.toFixed(1),
        recoveryFps: recoveryFps.toFixed(1),
        dropPct: dropPct + '%',
        verdict:
          snapshotMs < 50 ? 'snapshot too fast to measure conflict — try denser page'
          : dropPct < 30 ? 'DENSE WORKAROUND VIABLE — production preview can use CDP via 2nd session'
          : dropPct < 70 ? 'DENSE PARTIAL — degraded but functional'
          : 'DENSE BLOCKED — even with separate session, video freezes',
      });

      expect(snapshotMs).toBeGreaterThan(0);
    } finally {
      await screencastCdp.detach().catch(() => {});
      await snapshotCdp.detach().catch(() => {});
    }
  }, TEST_TIMEOUT);
});
