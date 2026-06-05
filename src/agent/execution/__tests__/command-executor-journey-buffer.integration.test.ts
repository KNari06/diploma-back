import { chromium, type Browser, type Page } from 'playwright';
import { CommandExecutor } from '../command-executor';
import type { IntentPlaywrightCommand } from '@/services/testing/ui/preview/intent-step-converter.service';

/**
 * Journey-context buffer (2026-06 heal-context fix): CommandExecutor keeps a
 * sliding window of the last N SUCCESSFUL step descriptions (descriptions only,
 * never input values) and feeds them — plus the test goal — to the heal
 * resolver so it has the "user's narrative". These tests verify the buffer:
 *   - records successful step descriptions,
 *   - caps at RECENT_STEPS_WINDOW (3),
 *   - clears on resetRunState.
 */
describe('CommandExecutor — journey-context step buffer', () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch({ headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    page = await (await browser.newContext({ viewport: { width: 1024, height: 768 } })).newPage();
    // Five distinct clickable buttons to drive five successful steps.
    await page.setContent(
      `<main>${[1, 2, 3, 4, 5].map((n) => `<button id="b${n}">Button ${n}</button>`).join('')}</main>`,
      { waitUntil: 'load' },
    );
  });
  afterEach(async () => {
    await page?.close().catch(() => {});
  });

  const buffer = (ex: CommandExecutor): string[] =>
    (ex as unknown as { recentStepDescriptions: string[] }).recentStepDescriptions;

  const clickCmd = (id: string, desc: string): IntentPlaywrightCommand => ({
    action: 'click',
    selector: `#${id}`,
    intentMeta: {
      stepId: `step-${id}`,
      intentDescription: desc,
      stepIndex: 0,
      actionType: 'click',
    },
  } as unknown as IntentPlaywrightCommand);

  it('records descriptions of successful steps and caps at 3 (most recent kept)', async () => {
    const ex = new CommandExecutor(page, { testGoal: 'Verify buttons', totalSteps: 5 });
    for (let n = 1; n <= 5; n++) {
      const r = await ex.executeCommand(clickCmd(`b${n}`, `click button ${n}`));
      expect(r.success).toBe(true);
    }
    const buf = buffer(ex);
    expect(buf).toHaveLength(3); // capped at RECENT_STEPS_WINDOW
    expect(buf).toEqual(['click button 3', 'click button 4', 'click button 5']); // most recent 3
  }, 30000);

  it('clears the buffer on resetRunState', async () => {
    const ex = new CommandExecutor(page, {});
    await ex.executeCommand(clickCmd('b1', 'click button 1'));
    expect(buffer(ex).length).toBeGreaterThan(0);
    ex.resetRunState();
    expect(buffer(ex)).toHaveLength(0);
  }, 30000);

  it('does NOT charge a heal credit for steps that resolve cleanly (no heal)', async () => {
    // Per-step heal-billing flag must be false after a clean step (the element
    // resolved without self-heal). Proves we only bill when heal actually fires.
    const ex = new CommandExecutor(page, {});
    const charged = (e: CommandExecutor): boolean =>
      (e as unknown as { currentStepHealCharged: boolean }).currentStepHealCharged;
    await ex.executeCommand(clickCmd('b1', 'click button 1'));
    expect(charged(ex)).toBe(false);
    // And the flag resets per command (not sticky across steps).
    await ex.executeCommand(clickCmd('b2', 'click button 2'));
    expect(charged(ex)).toBe(false);
  }, 30000);
});
