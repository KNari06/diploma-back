/**
 * ═══════════════════════════════════════════════════════════════════════════
 * scenario-setup-runner — web-path execution of scenario_setup steps.
 *
 * Mirror of `recipe-executor.ts` (which is auth-heal-only). This module
 * is general-purpose: takes any scenario_setup resource, recursively
 * expands its `use_setup` references, converts the resulting IntentStep[]
 * into PlaywrightCommands, and runs them through a fresh CommandExecutor
 * in the SAME browser context as the test body.
 *
 * Called from `executePlaywrightTest` AFTER `applyBindingsToContext`
 * (so auth.storageState is already injected and runVariables contains
 * secrets/env/fixture values) but BEFORE `navigateToUrl` (so the setup
 * recipe owns the initial navigation if it includes one).
 *
 * Failure modes:
 *   - Empty / missing config.steps → soft no-op + warn (legitimate
 *     transition state when user just created an empty setup).
 *   - Cycle detected / nesting too deep / unknown ref / kind drift
 *     → throw. Caller decides whether to fail the run (required:true)
 *       or carry on (required:false). Setup is normally required:false
 *       on web today; the user can still tag it required:true in their
 *       bindings JSONB.
 *   - Command execution failure → throw, identical handling to
 *     `recipe-executor`.
 *
 * Phase tagging on web: not implemented in this slice. CommandExecutor
 * doesn't read `phase:'setup'`. We DO push a marker into the replay
 * trace via metadata so the report layer can group by setup later
 * (Slice 3 — DAG visualisation).
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BrowserContext, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { CommandExecutor } from '@/agent/execution/command-executor';
import { IntentStepConverterService } from '@/services/testing/ui/preview/intent-step-converter.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { loadDecrypted } from '../test-resource.service';
import { expandScenarioSetupRecursively } from './scenario-setup-expander';

/**
 * Loose binding shape — accepts both the strongly-typed `ResourceBinding`
 * from `test-resource.service` and the runner's wider `{ kind: string }`
 * variant used in `TestJobData`. We narrow by string-equality below
 * (`kind === 'scenario_setup'`) so the wider type is safe at runtime.
 */
export interface LooseBinding {
  kind: string;
  resource_id: string;
  required?: boolean;
}

export interface RunScenarioSetupsParams {
  page: Page;
  context: BrowserContext;
  userId: string;
  projectId: string;
  /** Test's intended start URL — passed as `startUrl` to the step converter. */
  testUrl: string;
  /** Bindings to scan for `kind === 'scenario_setup'`. */
  bindings: LooseBinding[];
  /**
   * Aggregate of all `runVariables` produced by prior `apply()` calls
   * (secrets/env/fixture). Passed to the inner executor so `{{...}}`
   * interpolation works in setup step values.
   */
  runVariables: Map<string, unknown>;
}

export interface RunScenarioSetupsResult {
  /** Setup resources whose steps were executed (in order). */
  executed: Array<{ resourceId: string; name: string; stepCount: number }>;
  /** Setup bindings that were skipped (empty steps, missing, etc.). */
  skipped: Array<{ resourceId: string; reason: string }>;
}

/**
 * Run every scenario_setup binding in `bindings`. The applier ranks
 * scenario_setup last (after auth/env/secret) so by the time we land
 * here the page is logged-in and runVariables is populated.
 *
 * Multiple scenario_setup bindings on a single test are allowed in
 * principle (Slice 2+); today the editor enforces one. We iterate in
 * binding order so user intent (drag-drop order in the dropdown) is
 * preserved.
 */
export async function runScenarioSetups(
  params: RunScenarioSetupsParams,
): Promise<RunScenarioSetupsResult> {
  const { page, userId, projectId, testUrl, bindings, runVariables } = params;
  const executed: RunScenarioSetupsResult['executed'] = [];
  const skipped: RunScenarioSetupsResult['skipped'] = [];

  const setupBindings = bindings.filter((b) => b?.kind === 'scenario_setup');
  if (setupBindings.length === 0) {
    return { executed, skipped };
  }

  for (const binding of setupBindings) {
    const resourceId = binding.resource_id;
    if (!resourceId) {
      skipped.push({ resourceId: '', reason: 'missing resource_id' });
      continue;
    }

    const resource = await loadDecrypted(resourceId, userId).catch((err) => {
      logger.warn('[SCENARIO_SETUP_RUNNER] loadDecrypted threw — treating as missing', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    });
    if (!resource) {
      skipped.push({ resourceId, reason: 'resource not found' });
      if (binding.required) {
        throw new Error(`Required scenario_setup binding ${resourceId} not found`);
      }
      continue;
    }
    if (resource.kind !== 'scenario_setup') {
      // Kind drift — binding points at a non-setup resource. Treat as
      // hard error even for non-required because the user explicitly
      // pinned this binding kind=scenario_setup.
      throw new Error(
        `Binding resource_id=${resourceId} has kind "${resource.kind}", expected scenario_setup`,
      );
    }
    if (resource.status === 'broken') {
      skipped.push({ resourceId, reason: 'resource marked broken' });
      if (binding.required) {
        throw new Error(`Required scenario_setup "${resource.name}" is marked broken`);
      }
      continue;
    }

    // Recursive expansion — shared helper, identical contract to mobile.
    let flatSteps: unknown[];
    try {
      flatSteps = await expandScenarioSetupRecursively(
        resource,
        userId,
        new Set<string>(),
        0,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error('[SCENARIO_SETUP_RUNNER] expansion failed', {
        resourceId,
        name: resource.name,
        error: msg,
      });
      if (binding.required) throw err;
      skipped.push({ resourceId, reason: `expansion failed: ${msg}` });
      continue;
    }

    if (!flatSteps.length) {
      logger.warn('[SCENARIO_SETUP_RUNNER] setup has no steps after expansion — skipping', {
        resourceId,
        name: resource.name,
      });
      skipped.push({ resourceId, reason: 'no steps after expansion' });
      continue;
    }

    // Convert IntentStep[] → PlaywrightCommand[]. We pass the test's
    // intended start URL so converter-relative navigations resolve to
    // the right origin even though the page is still at about:blank
    // when setup runs.
    const intentSteps = flatSteps as IntentStep[];
    const commands = IntentStepConverterService.convertToCommands(intentSteps, testUrl);
    if (commands.length === 0) {
      skipped.push({ resourceId, reason: 'converter produced zero commands' });
      continue;
    }

    logger.info('[SCENARIO_SETUP_RUNNER] Running setup', {
      resourceId,
      name: resource.name,
      stepCount: intentSteps.length,
      commandCount: commands.length,
    });

    // Fresh executor per setup so trace / metadata is namespaced.
    // selfHealingEnabled stays on — a setup is structurally a "best
    // effort prologue" and a moved selector should heal rather than
    // hard-fail the entire test before the body even runs.
    // CommandExecutor metadata is strictly typed; the setup-id/name tags
    // are diagnostic and live in our logs above, not in executor metadata.
    // Slice 3 reporter will need a wider metadata contract — out of scope.
    const executor = new CommandExecutor(page, {
      selfHealingEnabled: true,
      metadata: {
        url: testUrl,
        projectId,
        userId,
      },
    });

    // Propagate runVariables so {{secrets.X}} / {{env.X}} / {{fixtures.X}}
    // inside setup step values interpolate. Mirrors the main background-
    // replay path at test-executor.ts:553.
    executor.setRunVariables(runVariables);

    const result = await executor.executeCommands(commands);
    if (!result.success || result.errors.length > 0) {
      const first = result.errors[0];
      const action = (first?.command as { action?: string })?.action ?? 'unknown';
      const errMsg = `Setup "${resource.name}" failed at action "${action}": ${first?.error ?? 'no error'}`;
      logger.error('[SCENARIO_SETUP_RUNNER] Setup failed', {
        resourceId,
        action,
        error: first?.error,
      });
      if (binding.required) throw new Error(errMsg);
      // Non-required setup that fails: warn but continue. The test body
      // will likely fail at the first step it expects setup-state for,
      // but that's the user's contract — they marked it not required.
      skipped.push({ resourceId, reason: errMsg });
      continue;
    }

    executed.push({
      resourceId,
      name: resource.name,
      stepCount: intentSteps.length,
    });
    logger.info('[SCENARIO_SETUP_RUNNER] Setup completed', {
      resourceId,
      name: resource.name,
      commandsRun: result.results.length,
    });
  }

  return { executed, skipped };
}
