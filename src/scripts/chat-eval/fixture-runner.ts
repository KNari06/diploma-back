/**
 * Tier-2b run primitive (impure) — replay authored IntentSteps against the web
 * fixture and control its broken-state flags.
 *
 * The run primitive converts IntentStep[] → Playwright commands and hands them to
 * `executePlaywrightTest`, which launches its OWN fresh headless browser (not a
 * preview session) and returns a real pass/fail. Flag control hits the fixture's
 * /config/flags endpoints (ported from qait-testbed). See the plan §5-6.
 *
 * Hygiene: real-format UUIDs (avoid the non-UUID `getTest` 22P02 at preflight);
 * NO userId (skips per-step credit deduction); the eval CLI sets
 * SCREENSHOT_EACH_STEP_ENABLED=false (no Supabase writes).
 */

import { randomUUID } from 'crypto';
import { executePlaywrightTest } from '@/agent/playwright/core/test-executor';
import { convertIntentStepsToCommands } from '@/services/testing/ui/preview/intent-step-converter.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { TestJobData } from '@/types';
import type { FixtureRunOutcome } from './fixture-types';

// Valid-format throwaway UUIDs (mirror replay.ts) — the run path scopes by UUID
// but writes no real rows (workspace resolves to 'unknown', no userId → no credits).
const EVAL_PROJECT_ID = '00000000-0000-4000-8000-000000000003';

/** Reset all fixture flags to the clean baseline. */
export async function resetFixtureFlags(fixtureBaseUrl: string): Promise<void> {
  const res = await fetch(`${fixtureBaseUrl}/config/flags/reset`, { method: 'POST' });
  if (!res.ok) throw new Error(`flag reset failed: HTTP ${res.status}`);
}

/** Enable/disable one fixture bug flag. */
export async function setFixtureFlag(fixtureBaseUrl: string, flagId: string, on: boolean): Promise<void> {
  const res = await fetch(`${fixtureBaseUrl}/config/flags`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [flagId]: on }),
  });
  if (!res.ok) throw new Error(`set flag ${flagId}=${on} failed: HTTP ${res.status}`);
}

/**
 * Replay one IntentStep[] against the fixture in a fresh headless browser.
 * `startUrl` is the exact page the flow begins on (converter prepends a goto).
 */
export async function runStepsOnFixture(
  steps: IntentStep[],
  startUrl: string,
): Promise<FixtureRunOutcome> {
  const commands = convertIntentStepsToCommands(steps, startUrl);

  const testData: TestJobData = {
    testId: randomUUID(),
    url: startUrl,
    browser: 'chrome', // → chromium (browser-pool.ts map); headless by default
    projectId: EVAL_PROJECT_ID,
    // NO userId → skips per-step credit deduction (test-executor.ts:856).
    commands,
    intelligentMode: false, // → replay path (isReplayMode, test-executor.ts:273)
    mode: 'lite',
  };

  try {
    const result = await executePlaywrightTest(testData);
    const firstError = Array.isArray(result.errors) && result.errors.length > 0
      ? summarizeError(result.errors[0])
      : result.error;
    return {
      passed: result.success === true,
      status: result.status ?? (result.success ? 'passed' : 'failed'),
      // commands includes the prepended goto — report authored step count.
      stepsRun: steps.length,
      errorSummary: result.success ? undefined : firstError,
    };
  } catch (err) {
    return {
      passed: false,
      status: 'error',
      stepsRun: 0, // the executor threw before/while running — nothing completed
      errorSummary: err instanceof Error ? err.message : String(err),
    };
  }
}

function summarizeError(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const anyE = e as Record<string, unknown>;
    const msg = anyE.message ?? anyE.error ?? anyE.reason;
    if (typeof msg === 'string') return msg;
    try { return JSON.stringify(e).slice(0, 200); } catch { return 'unknown error'; }
  }
  return String(e);
}
