/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Recipe Executor — the glue between a stored `recipe` (IntentStep[]) and
 * the runtime CommandExecutor.
 *
 * Why live in test-resource/runtime (not in agent/execution):
 *   - It IS a TestResource concern (only used to heal a resource).
 *   - It's isolated in a subdirectory so the "pure" test-resource root
 *     (service, adapters) stays free of Playwright imports for unit tests.
 *   - Import direction: test-executor.ts → recipe-executor → CommandExecutor
 *     is the same chain that already exists for Background Replay; no
 *     cycle with TestResourceService (which the supervisor imports).
 *
 * Responsibilities:
 *   1. Convert the stored IntentStep[] recipe into PlaywrightCommand[].
 *   2. Execute them in the SAME browser context as the test.
 *   3. Throw on any step failure — the supervisor catches that and
 *      routes to markBroken().
 *
 * This is called EXCLUSIVELY by ResourceSupervisor.healAuth. Do not
 * import it elsewhere; there is no legitimate reason to replay a login
 * recipe outside a heal.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { BrowserContext, Page } from 'playwright';
import { logger } from '@/utils/core/logger';
import { CommandExecutor } from '@/agent/execution/command-executor';
import { IntentStepConverterService } from '@/services/testing/ui/preview/intent-step-converter.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { RecipeExecutor } from '@/services/test-resource/resource-supervisor';
import { interpolateRecipeSecrets } from './recipe-redaction';

/**
 * Build a RecipeExecutor implementation backed by CommandExecutor.
 *
 * The closure captures nothing — it builds a fresh executor per heal so
 * stepRuntimeMeta / extractedData from a previous run don't leak into
 * the heal. The page is passed in explicitly by the supervisor (might
 * differ from the one the outer CommandExecutor was built with — e.g.
 * popup tabs).
 */
export function createCommandExecutorRecipeRunner(): RecipeExecutor {
  return {
    async run(params: {
      page: Page;
      context: BrowserContext;
      recipe: unknown[];
      userId: string;
      projectId: string;
      secrets?: Record<string, string>;
    }): Promise<void> {
      const rawSteps = params.recipe as IntentStep[];
      if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
        throw new Error('Recipe is empty or not an array');
      }

      // Resolve secrets BEFORE conversion to commands — the converter
      // reads `step.value` to populate Playwright fill/type actions and
      // wouldn't know about `{{_secret_*}}` semantics.
      const steps = interpolateRecipeSecrets(rawSteps, params.secrets);

      // startUrl for the converter is the page's current URL — we're
      // healing IN PLACE, not opening a new tab. The converter uses
      // startUrl only to resolve relative navigations; for a login
      // recipe the first step is usually a .goto(/login) so the value
      // matters little, but we pass a sane default.
      let startUrl: string;
      try {
        startUrl = params.page.url() || 'about:blank';
      } catch {
        startUrl = 'about:blank';
      }

      const commands = IntentStepConverterService.convertToCommands(steps, startUrl);
      if (commands.length === 0) {
        throw new Error('Recipe converted to zero commands');
      }

      logger.info('[RECIPE_EXECUTOR] Replaying heal recipe', {
        userId: params.userId,
        steps: steps.length,
        commands: commands.length,
      });

      // Fresh executor — don't reuse outer caller's (different metadata,
      // different step-trace namespace). Heal runs are short (login recipe
      // is 3-5 steps typically) so the cost is negligible.
      // selfHealing stays ON so a moved login selector doesn't kill the
      // heal — the recipe IS our last line of defence.
      const executor = new CommandExecutor(params.page, {
        selfHealingEnabled: true,
        metadata: {
          url: startUrl,
          projectId: params.projectId,
          userId: params.userId,
        },
      });

      // executeCommands short-circuits on the first non-continueOnError
      // failure (throws), so if we get here the whole recipe ran. Any
      // accumulated `errors` array is typed as a "reported but continued"
      // list — treat non-empty as failure for heal purposes: we want a
      // fully green login before declaring success.
      const result = await executor.executeCommands(commands);
      if (!result.success || result.errors.length > 0) {
        const first = result.errors[0];
        const action = (first?.command as any)?.action ?? 'unknown';
        throw new Error(
          `Recipe failed at action "${action}": ${first?.error ?? 'no error'}`,
        );
      }

      logger.info('[RECIPE_EXECUTOR] Heal recipe completed', {
        userId: params.userId,
        commandsRun: result.results.length,
      });
    },
  };
}
