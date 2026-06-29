import * as regressionDb from './db/regression.db';
import { logger } from '@/utils/core/logger';
import { ValidationError } from '@/types';
import { applyParameters } from '@/utils/testing/parameter-substitution.utils';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * WEB TEST REQUEST BUILDER SERVICE
 *
 * Extracted from RegressionRunService (Phase 1-C refactor).
 * Responsible for building Playwright test request objects from intent test
 * cases — covering the three command-extraction strategies (pre-compiled
 * commands, graph extract, and steps_json conversion).
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class WebTestRequestBuilderService {
  /**
   * @throws {ValidationError} If intent case has no replayable data or URL
   */
  static async buildTestRequest(
    intentCase: any,
    userId: string,
    parameters: Record<string, any>,
    browserOverride?: string,
    trigger?: 'manual' | 'chat' | 'scheduled' | 'webhook',
    /** When set, the job routes progress/result WS events to chat:<sessionId>. */
    chatSessionId?: string,
  ): Promise<any> {
    // Validate URL exists first (with fallback to start_url)
    const targetUrl = intentCase.url || intentCase.start_url;
    if (!targetUrl) {
      throw new ValidationError(
        `Intent test case "${intentCase.name}" (${intentCase.id}) has no URL. ` +
        'Please set a URL on the test case before running.'
      );
    }

    // Get source test for base configuration (optional - only for browsers/options)
    // Step editor test cases have no source_test_id — query returns null, defaults apply
    const sourceTest = intentCase.source_test_id
      ? await regressionDb.getTestBrowsersAndOptions(intentCase.source_test_id)
      : null;

    let commands: any[] = [];

    // Extract commands based on strategy (3 paths):
    // 1. Pre-compiled commands (saved from completed test via /regression/save)
    // 2. Graph extract steps (saved from intelligent session)
    // 3. steps_json conversion (step editor test cases — converted at runtime)
    if (intentCase.replay_strategy === 'commands' && Array.isArray(intentCase.commands) && intentCase.commands.length > 0) {
      commands = intentCase.commands;
      // Phase B (May 2026) — stitchCommandsForTestCase is now a pass-through.
      // setup_steps / teardown_steps deprecated; scenario_setup bindings own
      // the prologue. Helper call retained so any future restoration is a
      // single-method change.
      commands = await WebTestRequestBuilderService.stitchCommandsForTestCase(commands, intentCase, targetUrl);
    } else if (intentCase.replay_strategy === 'graph_extract' && Array.isArray(intentCase.graph_ref?.steps) && intentCase.graph_ref.steps.length > 0) {
      commands = intentCase.graph_ref.steps;
      // Phase B (May 2026) — pass-through, see comment above.
      commands = await WebTestRequestBuilderService.stitchCommandsForTestCase(commands, intentCase, targetUrl);
    } else if (Array.isArray(intentCase.steps_json) && intentCase.steps_json.length > 0) {
      // Convert intent steps to executable Playwright commands (same path as preview runner).
      // Normalise main steps through the shared helper. Phase B (May 2026) —
      // stitchPhases removed: setup_steps/teardown_steps columns are
      // deprecated and always empty in production. The stitch was a no-op
      // when both extras were empty, so dropping it is byte-identical to
      // the prior behaviour for every existing test case. scenario_setup
      // bindings deliver the prologue via runScenarioSetups in test-executor.
      //
      // Original code (preserved for Phase C rollback context):
      //   const { stitchPhases, normaliseIntentStep } = await import('./intent-step-dispatch.service');
      //   const normalisedMain = intentCase.steps_json.map((raw: any, i: number) =>
      //     normaliseIntentStep(raw, i),
      //   );
      //   const { steps: stitchedSteps, counts, didStitch } = stitchPhases(normalisedMain, intentCase);
      const { normaliseIntentStep } = await import('./intent-step-dispatch.service');
      const stitchedSteps = intentCase.steps_json.map((raw: any, i: number) =>
        normaliseIntentStep(raw, i),
      );

      const { IntentStepConverterService } = await import('../ui/preview/intent-step-converter.service');
      commands = IntentStepConverterService.convertToCommands(stitchedSteps, targetUrl, intentCase.id);
      logger.info('[REGRESSION_RUN] Converted steps_json to commands', {
        intentTestCaseId: intentCase.id,
        stepsCount: intentCase.steps_json.length,
        commandsCount: commands.length,
        stepsWithCompiled: intentCase.steps_json.filter((s: any) => !!s.compiled).length,
      });
    } else {
      throw new ValidationError(
        `Intent test case "${intentCase.name}" (${intentCase.id}) has no replayable data. ` +
        `replay_strategy=${intentCase.replay_strategy}, commands=${intentCase.commands === null ? 'null' : typeof intentCase.commands}, ` +
        `steps_json=${intentCase.steps_json === null ? 'null' : (Array.isArray(intentCase.steps_json) ? `array(${intentCase.steps_json.length})` : typeof intentCase.steps_json)}, ` +
        `status=${intentCase.status}.`
      );
    }

    if (commands.length === 0) {
      throw new ValidationError(
        `Intent test case "${intentCase.name}" (${intentCase.id}) produced no executable commands.`
      );
    }

    // Phase B (May 2026) — shared_steps resolver is deactivated. The
    // PlaywrightCommand `action: 'shared_steps'` mechanism never had a
    // producer (UI, AI, importer) — see audit. scenario_setup resource
    // bindings are the canonical reuse path. The block below is the
    // historical call; rolled back here as a one-liner pass-through.
    // Original code preserved verbatim to ease Phase C rollback if
    // any unexpected DB row turns up with the dead action type.
    //
    //   const { SharedStepResolverService } = await import('../shared-steps/shared-step-resolver.service');
    //   const { commands: resolvedCommands, warnings } =
    //     await SharedStepResolverService.resolveCommands(commands, intentCase.project_id);
    //   if (warnings.length > 0) {
    //     logger.warn('[REGRESSION_RUN] Shared step resolution warnings', {
    //       intentTestCaseId: intentCase.id,
    //       warnings,
    //     });
    //   }
    //   commands = this.applyParameters(resolvedCommands, parameters);
    const resolvedCommands = commands;

    // Apply parameters AFTER resolution (so parent parameters apply to all expanded commands)
    commands = applyParameters(resolvedCommands, parameters);

    // Build request
    // Resource bindings (Login, Environment, Secret, ...) travel with the
    // test request so the runner can apply them before the first step.
    // select('*') above already pulled this column.
    const resourceBindings = Array.isArray(intentCase.resource_bindings)
      ? intentCase.resource_bindings
      : [];

    // Merge trigger into options so the unified tests list (FE Runs
    // table) can show how the test was launched (Manual / Schedule /
    // CI / API). Without this every web regression row falls through
    // to 'Manual' in `mapTestToResponse` — confirmed bug in the prior
    // re-review. The mobile dispatch path already injects this (see
    // dispatchMobileTest, May 2026).
    const mergedOptions = {
      ...(sourceTest?.options || {}),
      ...(trigger ? { trigger } : {}),
    };

    return {
      url: targetUrl,
      projectId: intentCase.project_id,
      userId,
      browsers: browserOverride ? [browserOverride] : (sourceTest?.browsers || ['chrome']),
      intelligentMode: false, // Background Replay: deterministic step-by-step execution with self-healing
      testGoal: intentCase.description || intentCase.name,
      commands, // Pre-generated commands
      options: mergedOptions,
      resourceBindings,
      // Routes WS progress/result to chat:<sessionId> when launched from chat.
      ...(chatSessionId ? { chatSessionId } : {}),
      metadata: {
        intentTestCaseId: intentCase.id,
        intentTestCaseName: intentCase.name,
        source: 'intent_test_case',
      },
    };
  }

  /**
   * Command-level phase stitching helper — DEPRECATED in Phase B (May 2026).
   *
   * Originally bracketed pre-compiled `commands` / `graph_ref.steps` test
   * cases with setup_steps / teardown_steps converted on the fly. The
   * extras were always empty in production (no UI writer existed) so this
   * was a no-op for every test in practice. scenario_setup bindings are
   * the canonical reuse mechanism now and they run via runScenarioSetups
   * in the executor, not via this helper.
   *
   * Now a pass-through. Original implementation preserved in commented
   * form for Phase C rollback context.
   */
  static async stitchCommandsForTestCase(
    mainCommands: any[],
    _intentCase: any,
    _targetUrl: string,
  ): Promise<any[]> {
    return mainCommands;
    //
    // === ORIGINAL IMPLEMENTATION (Phase B deactivation, May 2026) ===
    //
    // const { stitchPhases } = await import('./intent-step-dispatch.service');
    // const { steps: extras, counts, didStitch } = stitchPhases([], intentCase);
    // if (!didStitch) return mainCommands;
    //
    // const setupSteps = extras.filter((s) => s.phase === 'setup');
    // const teardownSteps = extras.filter((s) => s.phase === 'teardown');
    //
    // const { IntentStepConverterService } = await import('../ui/preview/intent-step-converter.service');
    // const setupCommands = setupSteps.length > 0
    //   ? IntentStepConverterService.convertToCommands(setupSteps, targetUrl, intentCase.id)
    //   : [];
    // const teardownCommands = teardownSteps.length > 0
    //   ? IntentStepConverterService.convertToCommands(teardownSteps, targetUrl, intentCase.id)
    //   : [];
    //
    // const taggedMain = mainCommands.map((cmd: any) => ({ ...cmd, phase: 'main' as const }));
    //
    // logger.info('[REGRESSION_RUN] Stitched command-level phases', {
    //   intentTestCaseId: intentCase.id,
    //   setup: setupCommands.length,
    //   main: taggedMain.length,
    //   teardown: teardownCommands.length,
    //   counts,
    // });
    // return [...setupCommands, ...taggedMain, ...teardownCommands];
  }
}
