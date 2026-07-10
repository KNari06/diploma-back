import { RegressionTestQueryService } from './db/regression-test-query.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { LinkResolutionService, namespacedMapSource, MAX_LINKED_TEST_CASE_DEPTH } from './link-resolution.service';
import { MobileTestDispatcherService } from './mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from './web-test-request-builder.service';
import { ManualTestService } from '@/services/testing/ui/manualTest.service';
import * as linkResolutionDb from './db/link-resolution.db';
import { resolvePlaceholders, VariableSource } from '@/utils/interpolation/resolve-placeholders';
import { ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';

const POLL_INTERVAL_MS = 3000;
// Matches the existing 10-minute convention used elsewhere for a single
// test's worst-case wait (execution-completion-emitter's DEFAULT_TIMEOUT_MS,
// the orchestrator's mobile-gate wait) — a cap for the slowest expected
// environment, not a target (see LESSONS.md L-0002).
const MAX_WAIT_MS = 10 * 60 * 1000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled', 'error']);
const FAILURE_STATUSES = new Set(['failed', 'cancelled', 'error', 'timeout']);

export interface LinkedRunOutcome {
  /** alias → resolved value. Feed into namespacedMapSource('link', outputs) for the parent's subsequent steps. */
  outputs: Map<string, string>;
}

/**
 * Runs ONE cross-platform `link_test_case` step to completion.
 *
 * Same-platform links never reach here — LinkResolutionService inlines
 * those directly. This handles only the case where the linked test case's
 * platform differs from the step's own test case, which means it must run
 * as its own independent dispatch (own session/browser context — the runner
 * has no nested-run capability, see the plan doc's ADR-adjacent research).
 *
 * Dispatch reuses the exact same per-platform services a normal top-level
 * run uses (MobileTestDispatcherService / WebTestRequestBuilderService +
 * ManualTestService) — a linked test case runs exactly like any other test,
 * just triggered internally instead of from an API request.
 */
export class LinkedTestCaseRunnerService {
  static async run(params: {
    step: IntentStep;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    chatSessionId?: string;
    /** Parent's current variable scope — inputBindings' valueExpr resolves against this. */
    parentVariableSources: VariableSource[];
    /**
     * Count of cross-platform link segments already dispatched within THIS
     * top-level test case's own segments array — incremented by the caller
     * (`RegressionRunService.runSegmentedTestCase` /
     * `dispatchFirstSegmentAndDetachRest`) once per `run()` call in its
     * segment loop, starting at 0. This is a SEPARATE counter from
     * `LinkResolutionService.resolveSameProlatformLinks`'s same-platform
     * recursion depth — it does not itself recurse (a linked test case may
     * not contain a further cross-platform link, see the check below) — but
     * it shares the same `MAX_LINKED_TEST_CASE_DEPTH` cap and seeds that
     * resolution's starting depth when resolving the linked case's OWN
     * same-platform steps (`depth + 1` below), so a long same-platform
     * sub-chain has proportionally less budget left the deeper into a
     * cross-platform chain it's reached from.
     */
    depth: number;
    /**
     * Chain-view: the outer `regression_runs.id` this link segment belongs
     * to — see `tests.regression_run_id` migration. Forwarded into whichever
     * platform dispatcher this link resolves to, so the linked test case's
     * own `tests` row tags back to the SAME outer run as its sibling
     * segments, not left untagged.
     */
    runId?: string;
  }): Promise<LinkedRunOutcome> {
    const { step, userId, trigger, chatSessionId, parentVariableSources, depth, runId } = params;
    const link = step.type === 'link_test_case' ? step.options?.linkTestCase : undefined;
    if (!link) {
      throw new ValidationError(`Step ${step.id} is not a valid link_test_case step`);
    }
    // Bounds how many cross-platform link segments this top-level test
    // case's own segments array may dispatch (see the `depth` param doc
    // above — a separate counter from resolveSameProlatformLinks's
    // same-platform recursion depth, sharing only the same cap constant).
    // Without this, a cycle that somehow evades the static save-time graph
    // check (utils/graph/link-graph.ts) could recurse indefinitely, each
    // hop spawning a brand-new real dispatched test polled for up to
    // MAX_WAIT_MS.
    if (depth > MAX_LINKED_TEST_CASE_DEPTH) {
      throw new ValidationError(
        `Linked test case chain exceeds max depth (${MAX_LINKED_TEST_CASE_DEPTH}) — check for an unintended long or cyclic chain`,
      );
    }

    // getSavedTestCase enforces the same project/owner access check a normal
    // run already relies on — a link can't reach a test case this user
    // doesn't own. Returns the raw (snake_case) row shape the dispatch
    // services below already expect (same shape regression-run.service.ts's
    // top-level intentCase has).
    const linkedCase = await RegressionTestQueryService.getSavedTestCase(link.linkedTestCaseId, userId);
    if ((linkedCase.platform || 'web') !== link.linkedPlatform) {
      // Not fatal — the step's own recorded platform may be stale if the
      // linked case was edited since. Proceed with the CURRENT platform;
      // dispatch below branches on linkedCase.platform, not the step's copy.
      logger.warn('[LINKED_TEST_CASE_RUNNER] Linked test case platform drifted since the step was authored', {
        stepId: step.id,
        stepRecordedPlatform: link.linkedPlatform,
        currentPlatform: linkedCase.platform,
      });
    }
    const targetPlatform: string = linkedCase.platform || link.linkedPlatform;

    // inputBindings: resolve each valueExpr against the PARENT's scope, then
    // expose to the LINKED test's own steps as {{link_input.<targetParam>}}.
    // Pre-resolved here (not passed through the `parameters` mechanism) so it
    // works uniformly for mobile too, where the backend never runs
    // resolvePlaceholders before dispatch (the runner owns interpolation) —
    // see plan doc §2.3.
    const inputValues = new Map<string, string>();
    for (const binding of link.inputBindings || []) {
      inputValues.set(binding.targetParam, resolvePlaceholders(binding.valueExpr, parentVariableSources));
    }

    let linkedSteps = ((linkedCase.steps_json as IntentStep[]) || []);
    if (inputValues.size > 0) {
      const inputSource = namespacedMapSource('link_input', inputValues);
      linkedSteps = linkedSteps.map((s) => ({
        ...s,
        value: typeof s.value === 'string' ? resolvePlaceholders(s.value, [inputSource]) : s.value,
        assertionText: typeof s.assertionText === 'string' ? resolvePlaceholders(s.assertionText, [inputSource]) : s.assertionText,
        description: typeof s.description === 'string' ? resolvePlaceholders(s.description, [inputSource]) : s.description,
      }));
    }

    // The linked test case may itself contain same-platform links.
    linkedSteps = await LinkResolutionService.resolveSameProlatformLinks(linkedSteps, targetPlatform, userId, depth + 1);

    // A cross-platform link ONE LEVEL DEEP is not supported — this runner
    // dispatches the linked case's steps directly (mobile batch RPC / web
    // Playwright request), neither of which has a `link_test_case` case.
    // Without this check a remaining marker would reach that dispatch
    // unresolved and either misfire or fail with an opaque runner/converter
    // error instead of this clean rejection. Mirrors the same segment-KIND
    // guard `test-execution-orchestrator.service.ts` uses at its own
    // boundary. See DECISIONS.md ADR-0011 for the documented gap — nested
    // cross-platform chains are a follow-up, not silently broken.
    if (LinkResolutionService.segmentByLinks(linkedSteps).some((s) => s.kind === 'link')) {
      throw new ValidationError(
        `Linked test case "${linkedCase.name}" itself contains a cross-platform Link Test Case step, which isn't supported — a linked test case may only contain same-platform links internally. Remove the nested cross-platform link, or link to it directly from the parent test case instead.`,
      );
    }

    logger.info('[LINKED_TEST_CASE_RUNNER] Dispatching nested linked test case', {
      parentStepId: step.id,
      linkedTestCaseId: link.linkedTestCaseId,
      targetPlatform,
      depth,
      inputBindings: link.inputBindings?.length || 0,
      outputBindings: link.outputBindings?.length || 0,
    });

    let nestedTestId: string;
    if (targetPlatform.startsWith('mobile_')) {
      const dispatch = await MobileTestDispatcherService.dispatchMobileTest(
        { ...linkedCase, steps_json: linkedSteps },
        userId,
        trigger,
        undefined,
        {},
        undefined,
        chatSessionId,
        undefined,
        runId,
      );
      nestedTestId = dispatch.testId;
    } else {
      const testRequest = await WebTestRequestBuilderService.buildTestRequest(
        { ...linkedCase, steps_json: linkedSteps },
        userId,
        {},
        undefined,
        trigger,
        chatSessionId,
        runId,
      );
      const result = await ManualTestService.runTest(testRequest);
      if (!result.success || !result.data?.id) {
        throw new Error(`Failed to start linked test case "${linkedCase.name}" (${link.linkedTestCaseId})`);
      }
      nestedTestId = result.data.id;
    }

    const finalStatus = await this.pollUntilTerminal(nestedTestId);
    if (FAILURE_STATUSES.has(finalStatus)) {
      throw new ValidationError(
        `Linked test case "${linkedCase.name}" did not complete successfully (status: ${finalStatus}) — parent run stopped at this step`,
      );
    }

    const { variables: finalVariables, redactedKeys } = await this.readFinalVariables(nestedTestId);
    const outputs = new Map<string, string>();
    for (const binding of link.outputBindings || []) {
      const value = finalVariables.get(binding.sourceVariable);
      if (value === undefined) {
        logger.warn('[LINKED_TEST_CASE_RUNNER] outputBinding source variable not found in linked run', {
          linkedTestCaseId: link.linkedTestCaseId,
          sourceVariable: binding.sourceVariable,
          alias: binding.alias,
        });
        continue;
      }
      // The persisted snapshot this value came from is redacted before it
      // ever reaches us (command-executor.ts / mobile-test-run.job.ts —
      // Hard invariant #10), so a secrets-derived value here is already
      // masked to the literal '***'. Silently handing that back as the
      // resolved output would corrupt the parent's {{link.<alias>}} without
      // any error — fail loudly instead. Secrets are not supported through
      // link_test_case output bindings: capture a non-secret derived value
      // in the linked test case if you need to pass data across the link.
      if (redactedKeys.has(binding.sourceVariable)) {
        throw new ValidationError(
          `Linked test case "${linkedCase.name}" output binding "${binding.alias}" reads source variable ` +
          `"${binding.sourceVariable}", which holds a {{secrets.*}}-derived value. Secrets cannot be passed ` +
          `through link_test_case output bindings — capture a non-secret value instead.`,
        );
      }
      outputs.set(binding.alias, value);
    }

    return { outputs };
  }

  /**
   * Bounded poll on `tests.status` — see plan doc §2.3 for why polling was
   * chosen over a BullMQ job-wait (no jobId is returned from the web
   * dispatch path without a riskier change to existing return shapes).
   * Public: also reused by regression-run.service.ts to await each
   * same-platform "steps" segment between links in a multi-segment run.
   */
  static async pollUntilTerminal(testId: string): Promise<string> {
    const startedAt = Date.now();
    while (Date.now() - startedAt < MAX_WAIT_MS) {
      const { data, error } = await linkResolutionDb.getTestStatusAndStepsById(testId);
      if (error) {
        logger.warn('[LINKED_TEST_CASE_RUNNER] Poll query failed, retrying', { testId, error: error.message });
      } else if (data && TERMINAL_STATUSES.has(data.status)) {
        return data.status;
      }
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    logger.warn('[LINKED_TEST_CASE_RUNNER] Timed out waiting for linked test case', { testId, waitedMs: MAX_WAIT_MS });
    return 'timeout';
  }

  /**
   * Reconstructs the linked run's final variable state from its persisted
   * per-step results. Both platforms' executors snapshot their FULL
   * scratchpad/extractedData on any step that mutates it (mobile:
   * `runtimeMeta.scratchpadSnapshot`; web: `runtimeMeta.extractedDataSnapshot`)
   * — folding every snapshot in step order (last write wins per key) yields
   * the same end state a "final snapshot" would, without needing the
   * dispatch paths to report one explicitly.
   *
   * `tests.status` flips to a terminal value BEFORE `executed_steps` is
   * populated (both job handlers drain their Redis step buffer to Postgres
   * in a `finally` block that runs after the status update) — so a read
   * immediately after `pollUntilTerminal` returns can race an empty/stale
   * `executed_steps`. Retry a few times rather than treating "no steps yet"
   * as "no output produced".
   */
  private static async readFinalVariables(testId: string): Promise<{
    variables: Map<string, string>;
    redactedKeys: Set<string>;
  }> {
    const MAX_READ_ATTEMPTS = 5;
    const READ_RETRY_DELAY_MS = 1000;

    let steps: ExecutedStepForVariableFold[] = [];

    for (let attempt = 0; attempt < MAX_READ_ATTEMPTS; attempt++) {
      const { data } = await linkResolutionDb.getTestStatusAndStepsById(testId);
      steps = (data?.executed_steps as typeof steps) || [];
      if (steps.length > 0) break;
      if (attempt < MAX_READ_ATTEMPTS - 1) {
        await new Promise((resolve) => setTimeout(resolve, READ_RETRY_DELAY_MS));
      }
    }
    if (steps.length === 0) {
      logger.warn('[LINKED_TEST_CASE_RUNNER] executed_steps still empty after retries — outputBindings will resolve to nothing', { testId });
    }

    return foldExecutedStepSnapshots(steps);
  }
}

/** Shape `readFinalVariables` needs from a `tests.executed_steps` entry. */
export interface ExecutedStepForVariableFold {
  runtimeMeta?: {
    scratchpadSnapshot?: Record<string, string>;
    extractedDataSnapshot?: Record<string, string>;
    /** Keys in this step's snapshot that were masked — see redactSnapshotValues. */
    redactedSnapshotKeys?: string[];
  };
}

/**
 * Pure folding logic for `readFinalVariables`, split out for direct unit
 * testing (no DB mocking needed). Both platforms' executors snapshot their
 * FULL scratchpad/extractedData on any step that mutates it — folding every
 * snapshot in step order (last write wins per key) yields the run's final
 * variable state.
 *
 * `redactedKeys` tracks, per key, whether the value CURRENTLY in `variables`
 * (i.e. from the last step that defined it) was masked — last-write-wins
 * applies to redacted status too, so a later non-secret write of the same
 * key correctly un-marks it.
 */
export function foldExecutedStepSnapshots(
  steps: ExecutedStepForVariableFold[],
): { variables: Map<string, string>; redactedKeys: Set<string> } {
  const variables = new Map<string, string>();
  const redactedKeys = new Set<string>();
  for (const step of steps) {
    const snapshot = step.runtimeMeta?.scratchpadSnapshot || step.runtimeMeta?.extractedDataSnapshot;
    if (!snapshot) continue;
    const stepRedactedKeys = new Set(step.runtimeMeta?.redactedSnapshotKeys || []);
    for (const [key, value] of Object.entries(snapshot)) {
      variables.set(key, value);
      if (stepRedactedKeys.has(key)) {
        redactedKeys.add(key);
      } else {
        redactedKeys.delete(key);
      }
    }
  }
  return { variables, redactedKeys };
}
