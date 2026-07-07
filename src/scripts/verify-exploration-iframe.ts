/**
 * Manual verification harness (dev-only — run directly via `npx tsx`, not part
 * of the production build or CI). Committed so the iframe-replay work is
 * reproducible, but it is NOT wired into any runtime path.
 *
 * Runs ExplorationEngine directly against a real browser — NO API / queue /
 * Supabase writes — and dumps each discovered test case's steps, flagging:
 *   - compiled?        → does the step carry a compiled locator plan
 *                        (closes the exploration-web-no-compiled-plans gap)
 *   - iframe selector? → for iframe elements, did we persist a frame-scoped
 *                        replay selector (step 4 of iframe support)
 *   - iframeSource     → was the element collected from inside an iframe at all
 *
 * Run (from the worktree root):
 *   npx tsx src/scripts/verify-exploration-iframe.ts [entryUrl]
 *
 * Default target: the-internet.herokuapp.com/iframe — a TinyMCE editor inside a
 * SAME-ORIGIN iframe (the case our change exercises). Pass another URL to try
 * elsewhere. Requires the LLM key the agents use to already be in the env.
 */

import { chromium } from 'playwright';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { ExplorationEngine } from '@/agent/core/lite/exploration/exploration-engine';
import { EXPLORATION_PRESETS, DEFAULT_EXPLORATION_BUDGET } from '@/agent/core/lite/exploration/types';
import type { ExplorationConfig } from '@/agent/core/lite/exploration/types';

/**
 * Serve the local iframe fixture (outer.html embeds a SAME-ORIGIN inner.html
 * with a real login form) so the run exercises iframe element collection +
 * frame-scoped action. Returns the base URL + a close fn.
 */
function startFixtureServer(): Promise<{ baseUrl: string; close: () => void }> {
  const dir = path.join(__dirname, 'iframe-fixture');
  const server = http.createServer((req, res) => {
    const file = req.url === '/' || req.url === '' ? '/outer.html' : (req.url || '').split('?')[0];
    const full = path.join(dir, path.basename(file));
    fs.readFile(full, (err, data) => {
      if (err) { res.statusCode = 404; res.end('not found'); return; }
      res.setHeader('content-type', 'text/html');
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ baseUrl: `http://127.0.0.1:${port}/outer.html`, close: () => server.close() });
    });
  });
}

async function main() {
  // CLI arg overrides; otherwise spin up the local same-origin iframe fixture.
  const argUrl = process.argv[2];
  const fixture = argUrl ? null : await startFixtureServer();
  const ENTRY_URL = argUrl || fixture!.baseUrl;

  console.log(`\n=== Exploration iframe verification ===\nentryUrl: ${ENTRY_URL}\n`);
  console.log('[verify] launching chromium…');

  const browser = await chromium.launch({ headless: true });
  console.log('[verify] chromium up, starting engine (this makes real LLM calls, ~2 min)…');
  try {
    const config: ExplorationConfig = {
      entryUrl: ENTRY_URL,
      explorationId: `verify-${Date.now()}`,
      projectId: 'verify-project',
      userId: 'verify-user',
      // 'quick' preset keeps it short + cheap for a smoke check (merged over
      // defaults, same as the controller does).
      budget: { ...DEFAULT_EXPLORATION_BUDGET, ...EXPLORATION_PRESETS.quick },
      maxConcurrency: 2,
      onProgress: (e) => {
        if (e.event === 'survey_complete' || e.phase === 'complete') {
          console.log(`[progress] ${e.phase}/${e.event} ${e.progressPercent ?? ''}%`);
        }
      },
    };

    const engine = new ExplorationEngine(browser, config);
    const result = await engine.run();

    console.log(`\n=== RESULT: ${result.testCases.length} test case(s) ===\n`);

    let totalSteps = 0;
    let stepsWithCompiled = 0;
    let iframeSteps = 0;
    let iframeStepsWithSelector = 0;

    for (const tc of result.testCases) {
      console.log(`\n• ${tc.name}  [${tc.status}]  (${tc.steps.length} steps)`);
      for (const s of tc.steps) {
        totalSteps++;
        const compiled = (s as any).compiled;
        const hasCompiled = !!compiled?.locatorPlan?.length;
        const iframeSel = compiled?.action?.options?.iframe?.selector;
        const fromIframe = !!(s as any).iframeSource || !!iframeSel;
        if (hasCompiled) stepsWithCompiled++;
        if (fromIframe) {
          iframeSteps++;
          if (iframeSel) iframeStepsWithSelector++;
        }
        console.log(
          `   - ${String(s.action).padEnd(8)} compiled=${hasCompiled ? 'YES' : 'no '}` +
            `${iframeSel ? `  iframe="${iframeSel}"` : ''}` +
            `  :: ${s.description?.slice(0, 70)}`,
        );
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log(`steps total:                 ${totalSteps}`);
    console.log(`steps with compiled plan:    ${stepsWithCompiled}  (gap closed if > 0)`);
    console.log(`iframe steps discovered:     ${iframeSteps}`);
    console.log(`iframe steps w/ frame sel:   ${iframeStepsWithSelector}  (step-4 working if > 0)`);
    console.log('');
  } finally {
    await browser.close().catch(() => {});
    fixture?.close();
  }
}

main()
  .then(() => {
    // Hard-exit: the engine opens a lingering ioredis client (checkpointing)
    // that keeps a reconnect loop alive with no local Redis. The SUMMARY is
    // already printed, so just exit cleanly instead of hanging.
    process.exit(0);
  })
  .catch((err) => {
    console.error('[verify] failed:', err);
    process.exit(1);
  });
