import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { computeUiStepCredits } from './credit-estimate.util';
import { BUG_REPORT_CREDITS } from '@/jobs/ai-analysis.job';
import { WorkspaceAccessService } from '@/services/core/workspace-access.service';
import { NotFoundError, ValidationError, InsufficientCreditsError } from '@/types';
import type {
  Priority,
  RunResult,
  RunReport,
  ExecutableTestCase,
} from '@/types/testing.types';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { logger, formatError } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ExecutionService } from '../executions/execution.service';
import { RegressionPlanService } from '../plans/regression-plan.service';
import { ManualTestService } from '../ui/manualTest.service';
import { IntentTestCaseService } from '../ui/preview/intent-test-case.service';
import { deriveRunStatus } from '@/utils/testing/run-status.utils';
import {
  RegressionReportAssemblerService,
  getProjectWorkspaceMemberIds,
} from './regression-report-assembler.service';
import { MobileTestDispatcherService } from './mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from './web-test-request-builder.service';
import { LinkResolutionService, namespacedMapSource, ExecutionSegment } from './link-resolution.service';
import { LinkedTestCaseRunnerService } from './linked-test-case-runner.service';
import { resolvePlaceholders, VariableSource } from '@/utils/interpolation/resolve-placeholders';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { RegressionTestQueryService } from './db/regression-test-query.db';
import {
  insertRun,
  updateRunById,
  updateRunByIdIfActive,
  listRunsByProject,
  getRunExecutionStatsRows,
} from './db/regression-run.db';
import { getProjectForAccess, getTestBrowsersAndOptions } from './db/regression.db';
import { priorityRank } from './resolve-test-case-priority.util';
import { TestExecutionOrchestratorService } from './test-execution-orchestrator.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION RUN SERVICE - Execute saved test cases and suites
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages regression test execution:
 * - Runs individual saved test cases with parameter substitution
 * - Runs regression suites (ordered execution of multiple test cases)
 * - Tracks execution via regression_runs table
 * - Lists saved test cases, suites, and runs for a project
 *
 * Key Features:
 * - Parameter substitution for runtime values (e.g., passwords)
 * - Access control verification
 * - Links regression runs to underlying tests for status tracking
 */

// Limits for pagination
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

/**
 * Service for running saved test cases and regression suites
 * Creates and dispatches underlying test executions
 */
export class RegressionRunService {
  /**
   * Run an intent test case (unified table for UI test cases)
   * Method name kept as runSavedTestCase for API compatibility.
   *
   * @param params.savedTestCaseId - ID of intent_test_cases to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type ('manual' via API or 'chat' via AI command)
   * @param params.parameters - Runtime parameters for parameterized values
   * @returns Regression run ID and underlying test ID
   * @throws {NotFoundError} If intent test case not found
   * @throws {ValidationError} If validation fails or access denied
   */
  static async runSavedTestCase(params: {
    savedTestCaseId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
    /** Optional Playwright browser override (chromium | firefox | webkit). */
    browserOverride?: string;
    /**
     * When launched from chat ("run my login test"), the chat session id so the
     * web/mobile job streams progress + result into the chat panel (room
     * `chat:<sessionId>`) — same surface as a Lite run. Undefined for the
     * Runs-screen / API / scheduled paths (no chat to stream to).
     */
    chatSessionId?: string;
  }): Promise<{
    runId: string;
    testId: string;
  }> {
    const { savedTestCaseId: intentTestCaseId, userId, trigger, parameters = {}, browserOverride, chatSessionId } = params;

    try {
      logger.info('[REGRESSION_RUN] Running intent test case', {
        intentTestCaseId,
        userId,
        trigger,
      });

      // 1. Get intent test case
      const intentCase = await RegressionTestQueryService.getSavedTestCase(intentTestCaseId, userId);

      // 1a. Inline transitive dependency (precondition) steps so they run
      // in-session BEFORE this test's own steps (shared browser → shared
      // login/cookies/data). Borrowed steps carry `_preconditionSource` and
      // are excluded from this case's persisted steps_json at writeback time.
      const preconditionSteps = await IntentTestCaseService.collectPreconditionSteps(intentTestCaseId);
      if (preconditionSteps.length > 0) {
        intentCase.steps_json = [...preconditionSteps, ...(intentCase.steps_json || [])];
        logger.info('[REGRESSION_RUN] Inlined precondition steps', {
          intentTestCaseId,
          preconditionSteps: preconditionSteps.length,
          totalSteps: intentCase.steps_json.length,
        });
      }

      // 1c. V-cross-app: resolve link_test_case steps. Same-platform links
      // are inlined in place (recursively); a remaining cross-platform link
      // is a segment boundary — see link-resolution.service.ts. A test case
      // with no links (or only same-platform ones) always segments to
      // exactly one "steps" segment, so this is a no-op for every existing
      // test case.
      const { resolvedSteps, segments } = await LinkResolutionService.resolveAndCheckForCrossPlatform(
        (intentCase.steps_json as IntentStep[]) || [],
        intentCase.platform || 'web',
        userId,
      );
      intentCase.steps_json = resolvedSteps;
      // Segments remaining AFTER the first one dispatches — only set for a
      // segmented (cross-platform link) chain; every other run leaves this
      // NULL/undefined so recomputeRunStatus's pending-segments check is a
      // no-op for the overwhelming majority of runs. See the write-up in
      // dispatchFirstSegmentAndDetachRest for why this exists.
      const isSegmentedChain = segments.some((s) => s.kind === 'link');
      const pendingSegments = isSegmentedChain ? segments.length - 1 : undefined;

      // 1b. Credit check + deduction for single test case
      await this.checkCreditBalance(
        userId,
        [{ testCaseId: intentTestCaseId, testType: 'ui', dependsOn: [] }],
        'regression_single'
      );

      // 2. Create regression run record (now uses intent_test_case_id)
      const dispatchStartedAt = new Date().toISOString();
      const { data: run, error: runError } = await insertRun({
        intent_test_case_id: intentTestCaseId,
        project_id: intentCase.project_id,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: dispatchStartedAt,
        // `last_segment_dispatched_at` starts equal to `started_at` — the
        // first segment IS the run starting. See the migration file for why
        // this anchors staleness per-segment instead of chain-wide.
        ...(pendingSegments !== undefined ? { pending_segments: pendingSegments, last_segment_dispatched_at: dispatchStartedAt } : {}),
      });

      if (runError || !run) {
        throw new Error(`Failed to create regression run: ${(runError as any)?.message}`);
      }

      // 3. Route mobile vs web test
      let testId: string;

      try {
        // Checking segment KIND, not just count: a test case whose entire
        // steps_json is a single cross-platform link (no steps before or
        // after it) segments to exactly one — but it's a "link" segment,
        // not "steps". `segments.length <= 1` alone would misclassify that
        // as the common case and dispatch the still-unresolved marker.
        if (!segments.some((s) => s.kind === 'link')) {
          // Common case — no cross-platform link_test_case steps (same-
          // platform ones are already inlined into intentCase.steps_json
          // above). Dispatch exactly as before this feature existed.
          testId = await this.dispatchStepsSegment(
            intentCase,
            (intentCase.steps_json as IntentStep[]) || [],
            userId,
            trigger,
            parameters,
            browserOverride,
            chatSessionId,
            undefined,
            run.id,
          );
        } else {
          // Dispatches the first segment synchronously and detaches the
          // rest (see dispatchFirstSegmentAndDetachRest) — a multi-segment
          // chain's total poll time can legitimately exceed the server's
          // own request timeout, and this request must return quickly like
          // every other dispatch path already does.
          testId = await this.dispatchFirstSegmentAndDetachRest(
            intentCase,
            segments,
            userId,
            trigger,
            parameters,
            run.id,
            browserOverride,
            chatSessionId,
          );
        }
      } catch (execError) {
        // Mark run as failed — it was already created with 'running' status
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
        throw execError;
      }

      // 5. Update regression run with test_id for status tracking
      const { error: updateError } = await updateRunById(run.id, { test_id: testId });

      if (updateError) {
        logger.warn('[REGRESSION_RUN] Failed to update run with test_id', {
          error: updateError,
          runId: run.id,
          testId,
        });
      }

      // 6. When launched from chat, link this test to the chat session so the
      // completion handler streams the final pass/fail back into the chat panel
      // (same surface as a Lite run). Without this row `getChatSessionsForTest`
      // returns [] and `handleTestCompletion` falls through to a bell
      // notification — the chat's "I'll report the result" promise is never
      // kept. `test:progress` already reaches chat:<sessionId>, but the
      // terminal events do not, so this mapping is what closes the loop.
      // Fire-and-forget + best-effort: never fail the run over a mapping write.
      if (chatSessionId) {
        TestChatMappingService.saveTestChatMapping({
          testId,
          chatSessionId,
          userId,
          metadata: { trigger: 'chat' },
        }).catch((mappingError) => {
          logger.warn('[REGRESSION_RUN] Failed to save test-chat mapping', {
            error: formatError(mappingError),
            testId,
            chatSessionId,
          });
        });
      }

      logger.info('[REGRESSION_RUN] Test execution started', {
        runId: run.id,
        testId,
        intentTestCaseId,
      });

      return {
        runId: run.id,
        testId,
      };
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to run intent test case', {
        error,
        intentTestCaseId,
      });
      throw error;
    }
  }

  /**
   * Dispatches one platform's steps via the existing per-platform mechanism
   * — the same code `runSavedTestCase` always ran, now also reused for each
   * "steps" segment of a test case that contains cross-platform
   * `link_test_case` links (see `runSegmentedTestCase`).
   */
  private static async dispatchStepsSegment(
    intentCase: any,
    steps: IntentStep[],
    userId: string,
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook',
    parameters: Record<string, any>,
    browserOverride?: string,
    chatSessionId?: string,
    /**
     * V-cross-app continuation (mobile only — see `MobileTestJobData`).
     * Ignored for web segments; there is no equivalent "resume the same
     * browser session" concept on that path today.
     */
    continuation?: {
      resumeSessionId?: string;
      resumeSessionSource?: 'pool' | 'warmup' | 'cold' | 'dedicated';
      keepSessionAlive?: boolean;
    },
    /**
     * Chain-view: the outer `regression_runs.id` this segment belongs to —
     * see `tests.regression_run_id` migration. Threaded into whichever
     * platform dispatcher below so every segment's `tests` row can be
     * queried back together.
     */
    runId?: string,
  ): Promise<string> {
    const segmentCase = { ...intentCase, steps_json: steps };
    if (intentCase.platform?.startsWith('mobile_')) {
      // Parameters are applied inside dispatchMobileTest before the job is
      // queued so placeholders in steps resolve to concrete values on the
      // runner (Phase 6 — same substitution pass as the web path below).
      const mobileResult = await MobileTestDispatcherService.dispatchMobileTest(
        segmentCase,
        userId,
        trigger,
        undefined, // no triggerContext for single-case manual run
        parameters,
        undefined, // no pre-created analyticsExecutionId for single-case run
        chatSessionId, // stream progress to chat when launched from chat
        continuation,
        runId,
      );
      return mobileResult.testId;
    }

    const testRequest = await WebTestRequestBuilderService.buildTestRequest(
      segmentCase, userId, parameters, browserOverride, trigger, chatSessionId, runId,
    );
    const testResult = await ManualTestService.runTest(testRequest);
    if (!testResult.success || !testResult.data?.id) {
      throw new Error('Failed to start test execution');
    }
    return testResult.data.id;
  }

  /**
   * V-cross-app: a test case containing one or more cross-platform
   * `link_test_case` steps. Each segment dispatches AND is awaited in order
   * — a "steps" segment via the normal per-platform mechanism
   * (`dispatchStepsSegment`), a "link" segment via
   * `LinkedTestCaseRunnerService`, which itself dispatches the linked test
   * case as its own independent run and polls it to completion. Output
   * bindings from a link accumulate into `linkOutputs` and are pre-resolved
   * into every subsequent segment's steps as `{{link.<alias>}}` before that
   * segment dispatches — no downstream dispatch path otherwise knows this
   * namespace exists.
   *
   * Returns the LAST segment's testId — the same "one trackable id"
   * contract `runSavedTestCase` already had; a multi-segment run just means
   * that id now represents the final leg of a chain instead of the whole
   * (single) dispatch.
   *
   * `parameters` (the caller's {{param_*}} substitution values, e.g. from a
   * scheduled/parameterized run) applies ONLY to the FIRST "steps" segment —
   * matching what a single-segment dispatch already did before this feature
   * existed. Segments after a link have no equivalent concept; they get
   * `{{link.*}}` from accumulated output bindings instead.
   */
  private static async runSegmentedTestCase(
    intentCase: any,
    segments: ExecutionSegment[],
    userId: string,
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook',
    parameters: Record<string, any>,
    browserOverride?: string,
    chatSessionId?: string,
    /**
     * Chain-view: the outer `regression_runs.id` this whole chain belongs
     * to — see `tests.regression_run_id` migration. Forwarded into every
     * segment's dispatch below.
     */
    runId?: string,
  ): Promise<string> {
    const linkOutputs = new Map<string, string>();
    let lastTestId: string | undefined;
    let depth = 0;
    let isFirstStepsSegment = true;
    // V-cross-app continuation (mobile only) — see dispatchFirstSegmentAndDetachRest's
    // comment for the full rationale. This method only runs the rare edge
    // case where the very first segment is itself a link, but every
    // "steps" segment after that first link still deserves the same fix.
    const isMobileChain = !!intentCase.platform?.startsWith('mobile_');
    let resumeSessionId: string | undefined;
    let resumeSessionSource: 'pool' | 'warmup' | 'cold' | 'dedicated' | undefined;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const isLastSegment = i === segments.length - 1;
      if (segment.kind === 'steps') {
        const sources: VariableSource[] = linkOutputs.size > 0 ? [namespacedMapSource('link', linkOutputs)] : [];
        const steps = sources.length === 0 ? segment.steps : segment.steps.map((s) => ({
          ...s,
          value: typeof s.value === 'string' ? resolvePlaceholders(s.value, sources) : s.value,
          assertionText: typeof s.assertionText === 'string' ? resolvePlaceholders(s.assertionText, sources) : s.assertionText,
          description: typeof s.description === 'string' ? resolvePlaceholders(s.description, sources) : s.description,
        }));

        const segmentParameters = isFirstStepsSegment ? parameters : {};
        const isFirstDispatch = isFirstStepsSegment;
        isFirstStepsSegment = false;
        lastTestId = await this.dispatchStepsSegment(
          intentCase, steps, userId, trigger, segmentParameters, browserOverride, chatSessionId,
          isMobileChain
            ? (isFirstDispatch
              ? { keepSessionAlive: !isLastSegment }
              : { resumeSessionId, resumeSessionSource, keepSessionAlive: !isLastSegment })
            : undefined,
          runId,
        );

        const status = await LinkedTestCaseRunnerService.pollUntilTerminal(lastTestId);
        if (status === 'failed' || status === 'cancelled' || status === 'error' || status === 'timeout') {
          throw new ValidationError(`Segment stopped at status "${status}" — linked run halted`);
        }
        if (isMobileChain && !isLastSegment) {
          ({ resumeSessionId, resumeSessionSource } = await this.readRunnerSessionForResume(lastTestId));
        }
      } else {
        const sources: VariableSource[] = linkOutputs.size > 0 ? [namespacedMapSource('link', linkOutputs)] : [];
        const outcome = await LinkedTestCaseRunnerService.run({
          step: segment.step,
          userId,
          trigger,
          chatSessionId,
          parentVariableSources: sources,
          depth,
          runId,
        });
        for (const [alias, value] of outcome.outputs) linkOutputs.set(alias, value);
        depth += 1;
      }
    }

    if (!lastTestId) {
      throw new Error('Segmented run produced no dispatched test — this indicates a segmentation bug');
    }
    return lastTestId;
  }

  /**
   * Dispatches ONLY the first "steps" segment synchronously (fast — matches
   * the single-segment contract every existing caller of `runSavedTestCase`
   * already relies on), then continues the rest of the chain (poll segment
   * 1, then any links/subsequent segments) DETACHED from the caller.
   *
   * This exists because `pollUntilTerminal` can legitimately take minutes
   * per segment (a real mobile cold start, a slow nested run) — awaiting
   * that end-to-end inside an HTTP request handler risks exceeding the
   * server's own socket timeout (`server.timeout` in src/index.ts, 3
   * minutes) while the backend keeps polling with no one listening. The
   * ORIGINAL single-dispatch path never had this problem (dispatch just
   * enqueues a job and returns); this keeps that same fast-return contract
   * for the segmented case by only awaiting the first dispatch, not the
   * whole chain.
   *
   * Errors in the detached continuation are caught and reflected onto the
   * `regression_runs` row (status: 'failed') rather than thrown into a
   * request that has already returned.
   */
  private static async dispatchFirstSegmentAndDetachRest(
    intentCase: any,
    segments: ExecutionSegment[],
    userId: string,
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook',
    parameters: Record<string, any>,
    runId: string,
    browserOverride?: string,
    chatSessionId?: string,
  ): Promise<string> {
    const firstSegment = segments[0];

    if (firstSegment.kind !== 'steps') {
      // Rare edge case: the test's very first step is itself a
      // cross-platform link (no steps of its own before it) — there is no
      // fast dispatch to return early with. Fall back to the fully
      // synchronous path; residual risk of exceeding the server timeout is
      // smaller here (typically one link's own dispatch+poll, not a whole
      // multi-segment chain) and accepted given remaining time (documented
      // in the plan doc / final report as a smaller, known gap).
      //
      // `runSegmentedTestCase` only returns once every segment in the chain
      // has succeeded (a failed/cancelled segment throws instead) — so
      // reaching this line means the run is genuinely done. `test_id` is
      // never written to `regression_runs` while this fully-synchronous path
      // runs (only at the very end, here), so this branch never hits the
      // premature-finalization race the main path below guards against —
      // `recomputeRunStatus` has no `test_id` to match an intermediate
      // segment's completion against. `pending_segments: 0` still clears the
      // initial "chain has N segments" count set at run creation, and the
      // guarded write (`...IfActive`, not raw `updateRunById`) protects
      // against clobbering a status the user cancelled (or the stale-run
      // reaper force-failed) while this was still finishing.
      const finalTestId = await this.runSegmentedTestCase(intentCase, segments, userId, trigger, parameters, browserOverride, chatSessionId, runId);
      await updateRunByIdIfActive(runId, { status: 'completed', pending_segments: 0, completed_at: new Date().toISOString() });
      return finalTestId;
    }

    // V-cross-app continuation (mobile only): a "steps" segment after a
    // cross-platform link resumes the SAME live mobile session the previous
    // "steps" segment used, instead of acquiring + prepping (force-stop +
    // relaunch) a fresh one — which would discard any typed-but-not-yet-
    // submitted UI state from before the link. See MobileTestJobData for
    // the full incident writeup (2026-07-06). Web has no equivalent
    // concept today, so this is a no-op for web test cases.
    const isMobileChain = !!intentCase.platform?.startsWith('mobile_');
    const remaining = segments.slice(1);

    const firstTestId = await this.dispatchStepsSegment(
      intentCase, firstSegment.steps, userId, trigger, parameters, browserOverride, chatSessionId,
      isMobileChain && remaining.length > 0 ? { keepSessionAlive: true } : undefined,
      runId,
    );

    void (async () => {
      try {
        const status = await LinkedTestCaseRunnerService.pollUntilTerminal(firstTestId);
        if (status === 'failed' || status === 'cancelled' || status === 'error' || status === 'timeout') {
          throw new ValidationError(`Segment stopped at status "${status}" — linked run halted`);
        }

        let lastTestId = firstTestId;
        const linkOutputs = new Map<string, string>();
        let depth = 0;
        let resumeSessionId: string | undefined;
        let resumeSessionSource: 'pool' | 'warmup' | 'cold' | 'dedicated' | undefined;
        if (isMobileChain) {
          ({ resumeSessionId, resumeSessionSource } = await this.readRunnerSessionForResume(firstTestId));
        }

        for (let i = 0; i < remaining.length; i++) {
          const segment = remaining[i];
          const isLastInChain = i === remaining.length - 1;
          if (segment.kind === 'steps') {
            const sources: VariableSource[] = linkOutputs.size > 0 ? [namespacedMapSource('link', linkOutputs)] : [];
            const steps = sources.length === 0 ? segment.steps : segment.steps.map((s) => ({
              ...s,
              value: typeof s.value === 'string' ? resolvePlaceholders(s.value, sources) : s.value,
              assertionText: typeof s.assertionText === 'string' ? resolvePlaceholders(s.assertionText, sources) : s.assertionText,
              description: typeof s.description === 'string' ? resolvePlaceholders(s.description, sources) : s.description,
            }));

            lastTestId = await this.dispatchStepsSegment(
              intentCase, steps, userId, trigger, {}, browserOverride, chatSessionId,
              isMobileChain
                ? { resumeSessionId, resumeSessionSource, keepSessionAlive: !isLastInChain }
                : undefined,
              runId,
            );
            // Reflect progress so a client re-fetching the run row sees the
            // CURRENT segment, not just the first — and update the pending-
            // segments count so `recomputeRunStatus` knows how many segments
            // are still left to dispatch (0 once this was the last one).
            // Guarded (`...IfActive`, not raw `updateRunById`): a run the
            // user cancelled (or the stale-run reaper force-failed) mid-chain
            // must not have its test_id silently reset to a later segment
            // after the row already went terminal.
            await this.recordSegmentProgress(runId, remaining.length - 1 - i, { test_id: lastTestId });

            const status = await LinkedTestCaseRunnerService.pollUntilTerminal(lastTestId);
            if (status === 'failed' || status === 'cancelled' || status === 'error' || status === 'timeout') {
              throw new ValidationError(`Segment stopped at status "${status}" — linked run halted`);
            }
            if (isMobileChain && !isLastInChain) {
              ({ resumeSessionId, resumeSessionSource } = await this.readRunnerSessionForResume(lastTestId));
            }
          } else {
            const sources: VariableSource[] = linkOutputs.size > 0 ? [namespacedMapSource('link', linkOutputs)] : [];
            const outcome = await LinkedTestCaseRunnerService.run({
              step: segment.step, userId, trigger, chatSessionId, parentVariableSources: sources, depth, runId,
            });
            for (const [alias, value] of outcome.outputs) linkOutputs.set(alias, value);
            depth += 1;
            // A "link" segment doesn't update the outer run's own test_id,
            // but it still consumes one slot of the pending-segments count —
            // a chain whose last segment is a link must still reach 0, or
            // `recomputeRunStatus` would defer finalization forever after
            // the final steps segment (if any) already went terminal.
            await this.recordSegmentProgress(runId, remaining.length - 1 - i);
          }
        }

        // Reaching here means every segment succeeded (a failed/cancelled/
        // errored/timed-out poll throws above instead). Explicitly finalize
        // the outer row's status — it otherwise never leaves 'running':
        // `handleTestCompletion` → `recomputeRunStatus` fires off segment 1's
        // OWN completion (matches this row by `test_id`, which pointed at
        // segment 1 the moment it was dispatched) and finalizes it based on
        // segment 1 alone, before segments 2+ have even run; the row then no
        // longer matches 'running'/'pending' so later segments' real
        // completions never rematch it. Writing the true terminal status
        // last, after the whole chain, overwrites that premature value.
        // Guarded write: if the run was cancelled (or force-failed by the
        // stale-run reaper) while this last segment was still finishing, the
        // row is no longer 'running'/'pending' — don't clobber that outcome
        // back to 'completed'.
        await updateRunByIdIfActive(runId, {
          test_id: lastTestId,
          status: 'completed',
          completed_at: new Date().toISOString(),
        });
        logger.info('[REGRESSION_RUN] Detached segmented continuation completed', { runId, finalTestId: lastTestId });
      } catch (err) {
        logger.error('[REGRESSION_RUN] Detached segmented continuation failed', {
          runId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Guarded (`...IfActive`, not raw `updateRunById`): significant time
        // has passed by the time this catch runs (a whole chain's worth of
        // dispatch+poll), so a concurrent cancel or stale-run reaper force-
        // fail is a live possibility here, unlike the top-level synchronous
        // dispatch failure path elsewhere in this file.
        await updateRunByIdIfActive(runId, { status: 'failed', completed_at: new Date().toISOString() }).catch(() => { /* best effort */ });
      }
    })();

    return firstTestId;
  }

  /**
   * Guarded write recording that a segment in a chain just dispatched or
   * completed — updates `pending_segments` and resets the per-segment
   * staleness clock (`last_segment_dispatched_at`) together, so a future edit
   * to this bookkeeping can't update one without the other (that drift would
   * silently reintroduce the premature-finalization bug this pairing exists
   * to prevent — see the migration file / ADR-0011 update 6). Was previously
   * duplicated verbatim at both per-segment call sites in the loop below,
   * differing only in whether `test_id` was also set — `extraFields` covers
   * that difference.
   */
  private static async recordSegmentProgress(
    runId: string,
    pendingSegments: number,
    extraFields: Record<string, unknown> = {},
  ): Promise<void> {
    await updateRunByIdIfActive(runId, {
      ...extraFields,
      pending_segments: pendingSegments,
      last_segment_dispatched_at: new Date().toISOString(),
    });
  }

  /**
   * V-cross-app continuation: read back the runner sessionId (+ its
   * original acquisition source) a just-completed mobile segment's job
   * persisted to `tests.options` (see `MobileTestRunJobHandler.
   * persistRunnerSessionId`), so the NEXT "steps" segment in the chain can
   * resume it instead of acquiring a fresh one. Best-effort: a missing/
   * unreadable value just means the next segment falls back to its normal
   * fresh-acquisition path (logged, not thrown — a continuation regression
   * shouldn't fail runs that would have passed under the old behaviour).
   */
  private static async readRunnerSessionForResume(testId: string): Promise<{
    resumeSessionId: string | undefined;
    resumeSessionSource: 'pool' | 'warmup' | 'cold' | 'dedicated' | undefined;
  }> {
    try {
      const row = await getTestBrowsersAndOptions(testId);
      const options = row?.options as { runnerSessionId?: string; runnerSessionSource?: string } | undefined;
      if (!options?.runnerSessionId) {
        logger.warn('[REGRESSION_RUN] No runner sessionId recorded for segment — next segment will acquire fresh', { testId });
        return { resumeSessionId: undefined, resumeSessionSource: undefined };
      }
      return {
        resumeSessionId: options.runnerSessionId,
        resumeSessionSource: options.runnerSessionSource as 'pool' | 'warmup' | 'cold' | 'dedicated' | undefined,
      };
    } catch (err) {
      logger.warn('[REGRESSION_RUN] Failed to read back runner sessionId — next segment will acquire fresh', {
        testId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { resumeSessionId: undefined, resumeSessionSource: undefined };
    }
  }

  /**
   * Soft balance check before starting a regression run.
   * Verifies user can afford estimated steps but does NOT deduct credits.
   * Actual credits are deducted per-step during execution.
   *
   * Pricing: 1 credit per step for UI tests, API tests × API credit cost.
   * Fetches actual step counts from intent_test_cases so the estimate is
   * proportional to test complexity (20-step test = 20 estimated credits).
   *
   * Throws ValidationError with "Insufficient credits" so the scheduler
   * can detect and notify the user.
   */
  private static async checkCreditBalance(
    userId: string,
    testCases: ExecutableTestCase[],
    source: string
  ): Promise<void> {
    const uiCases = testCases.filter((tc) => tc.testType === 'ui');
    const apiCount = testCases.filter((tc) => tc.testType === 'api').length;
    const apiCreditCost = TokenCalculatorService.getTestCreditCost('api');

    // Fetch step counts for UI test cases. Web = 1 credit/step; MOBILE steps
    // cost MOBILE_STEP_CREDIT_MULTIPLIER× (emulator COGS) and are charged at
    // that rate after the run in mobile-test-run.job. The pre-flight must apply
    // the SAME multiplier or a mobile run passes the gate on a 1× estimate and
    // then gets charged 4× — the user hits "insufficient credits" (or an
    // unexpected balance drop) despite a green pre-flight. Mobile cases are
    // `testType:'ui'` distinguished by `platform` (mobile_*), so read platform
    // off the case, not the row.
    let uiStepCredits = 0;
    let hasCrossPlatformLinks = false;
    if (uiCases.length > 0) {
      const uiIds = uiCases.map((tc) => tc.testCaseId);
      const rows = await RegressionTestQueryService.getUiStepCountRows(uiIds);
      // A link_test_case step is exactly ONE entry in steps_json regardless
      // of whether the linked test case has 1 or 100 steps. Expand
      // same-platform links (which inline into THIS execution, same rate,
      // fully recursively as of ADR-0011 update 6) before costing — see
      // expandLinkedStepCounts's docs for why cross-platform links are
      // flagged instead of expanded.
      const { expandedLengthById, hasCrossPlatformLinks: crossPlatform } =
        await LinkResolutionService.expandLinkedStepCounts(uiCases, rows);
      hasCrossPlatformLinks = crossPlatform;
      if (hasCrossPlatformLinks) {
        logger.warn('[REGRESSION_RUN] Credit estimate may be understated: unexpanded cross-platform link_test_case step(s)', {
          userId,
          source,
          uiTestCount: uiCases.length,
        });
      }
      // Pure arithmetic lives in computeUiStepCredits (unit-tested) — web 1×,
      // mobile MOBILE_STEP_CREDIT_MULTIPLIER×, matching the post-run charge.
      uiStepCredits = computeUiStepCredits(uiCases, rows, expandedLengthById);
    }

    // ai-analysis.job charges BUG_REPORT_CREDITS per UI test_result where bugs
    // are found. A regression run with N UI tests can incur up to N × 5 extra
    // credits after execution. Before this line was added, the estimate only
    // counted steps and users hit "insufficient credits" mid-run when the
    // post-analysis charge landed. We use the worst case (all UI tests find
    // bugs) to prevent that failure mode — users with tight balances see a
    // slightly conservative upfront estimate, which is the safer trade.
    const bugReportBudget = uiCases.length * BUG_REPORT_CREDITS;
    const totalRequired = uiStepCredits + apiCount * apiCreditCost + bugReportBudget;

    if (totalRequired <= 0) return;

    // Soft balance check — verify user can afford estimated steps, but don't deduct
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
    // Log the REAL totalRequired up-front so triage doesn't get fooled by
    // CreditCostTrackerService's own "required: 1" log (that logs the single
    // test-type cost, not the aggregated plan cost computed here).
    logger.info('[REGRESSION_RUN] Credit balance pre-flight', {
      userId,
      source,
      totalRequired,
      uiStepCredits,
      apiCount,
      apiCreditCost,
      bugReportBudget,
      available: creditCheck.available,
      graceLimit: creditCheck.graceLimit,
      effectiveAvailable: creditCheck.effectiveAvailable,
      uiTestCount: uiCases.length,
      hasCrossPlatformLinks,
    });
    // Gate on effectiveAvailable (balance + grace_limit), matching the runtime
    // per-step gate in CreditCostTrackerService. Using raw `available` here made
    // the pre-flight reject grace-eligible users (e.g. Pro/Ultra) that the
    // runtime would have allowed — surfacing "insufficient credits" despite a
    // positive balance + grace headroom.
    if (creditCheck.effectiveAvailable < totalRequired) {
      // Use the dedicated error class so the controller can surface a stable
      // `code: 'INSUFFICIENT_CREDITS'` to the frontend (which then flips the
      // global "credits exhausted" banner instead of a generic toast).
      throw new InsufficientCreditsError(
        `Insufficient credits. Required: ${totalRequired} (${uiStepCredits} UI step credits + ${apiCount} API × ${apiCreditCost} + ${bugReportBudget} bug-report budget)${hasCrossPlatformLinks ? ' [estimate may be understated: links to a test case on another platform]' : ''}, Available: ${creditCheck.effectiveAvailable}`,
        {
          required: totalRequired,
          available: creditCheck.effectiveAvailable,
          breakdown: {
            uiStepCredits,
            apiCount,
            apiCreditCost,
            bugReportBudget,
            hasCrossPlatformLinks,
          },
        },
      );
    }

    logger.info('[REGRESSION_RUN] Credit balance check passed (no deduction)', {
      userId,
      source,
      uiTestCount: uiCases.length,
      uiStepCredits,
      apiCount,
      bugReportBudget,
      totalEstimated: totalRequired,
      available: creditCheck.available,
    });
  }

  /**
   * Update run status (called after test completion)
   * Note: This is now primarily handled by test-completion-handler.service.ts
   * but kept for manual status updates if needed
   *
   * @deprecated Use test completion hook instead
   */
  static async updateRunStatus(params: {
    runId: string;
    status: 'passed' | 'completed' | 'failed' | 'cancelled';
    summary?: any;
  }): Promise<void> {
    const { runId, status, summary } = params;

    try {
      const { error } = await updateRunById(runId, {
        status,
        summary: summary || null,
        completed_at: new Date().toISOString(),
      });

      if (error) {
        throw new Error(`Failed to update run status: ${(error as any)?.message}`);
      }

      logger.info('[REGRESSION_RUN] Run status updated', { runId, status });
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to update run status', { error, runId });
      throw error;
    }
  }

  /**
   * List saved test cases for project
   *
   * @param projectId - Project ID to list cases for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @returns List of saved test cases
   */
  static async listSavedTestCases(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    platform?: string,
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    // Now fetches from intent_test_cases (unified table)
    const { data: cases, error } = await RegressionTestQueryService.listByProject(
      projectId,
      safeLimit,
      platform,
    );

    if (error) {
      throw new Error(`Failed to list intent test cases: ${(error as any)?.message}`);
    }

    return cases || [];
  }

  /**
   * List runs for project
   *
   * @param projectId - Project ID to list runs for
   * @param userId - User ID for ownership verification
   * @param limit - Maximum number of results (default: 50, max: 500)
   * @param planId - Optional: scope to a single plan's run history. A run
   *   counts as "the plan's" if `regression_runs.plan_id` matches OR the run
   *   is an ad-hoc single-test-case dispatch (`runIntentTestCase`, which never
   *   sets `plan_id`) of a test case that is currently a member of this plan.
   *   Without the second clause, running a test case directly (its own "Run"
   *   button, chat, a git webhook) instead of via "run this plan" makes that
   *   run permanently invisible on the plan's own Regressions detail page,
   *   even though the same run shows up in the global Test Runs list.
   * @returns List of regression runs with status and summary
   */
  static async listRuns(
    projectId: string,
    userId: string,
    limit: number = DEFAULT_LIST_LIMIT,
    planId?: string,
  ): Promise<any[]> {
    // Verify access
    await this.verifyProjectAccess(projectId, userId);

    // Apply limit bounds
    const safeLimit = Math.min(Math.max(limit, 1), MAX_LIST_LIMIT);

    // When scoping to a plan, fetch the full MAX_LIST_LIMIT candidate set
    // (not just safeLimit) BEFORE filtering — the project can have far more
    // recent unrelated runs than this plan has, so truncating first can push
    // this plan's own runs out of the fetched page entirely, then the filter
    // has nothing left to find. Only the FILTERED result is sliced to
    // safeLimit, matching the caller's requested page size.
    const fetchLimit = planId ? MAX_LIST_LIMIT : safeLimit;
    const { data: allRuns, error } = await listRunsByProject(projectId, fetchLimit);

    if (error) {
      throw new Error(`Failed to list runs: ${(error as any)?.message}`);
    }

    if (!allRuns || allRuns.length === 0) return [];

    let runs = allRuns;
    if (planId) {
      const plan = await RegressionPlanService.getById(planId, userId);
      const memberTestCaseIds = plan && plan.projectId === projectId
        ? new Set((await RegressionPlanService.expandPlan(planId)).map((tc) => tc.testCaseId))
        : new Set<string>();
      runs = allRuns
        .filter((r: any) => r.plan_id === planId || memberTestCaseIds.has(r.intent_test_case_id))
        .slice(0, safeLimit);
    }

    if (runs.length === 0) return [];

    // Batch fetch stats for all runs.
    // Phase 7: also pull `platform` + `test_type` so each run row can
    // carry a per-platform composition (web / mobile / api counts).
    // Same single-query pattern as the existing stats fetch — no new
    // round-trip, just two extra columns.
    const runIds = runs.map((r: any) => r.id);
    const allExecs = await getRunExecutionStatsRows(runIds);

    // Bucket a raw `test_executions` row into web/mobile/api. Matches
    // PlanHealthReport's bucketing exactly (see healthBucketForPlatform
    // in regression-plan.service); duplicated as a local closure because
    // the two services don't currently share a util layer and importing
    // across would create a minor circular risk. When we extract a
    // shared analytics-util module these should merge.
    const bucketFor = (exec: any): 'web' | 'mobile' | 'api' => {
      if (exec.test_type === 'api') return 'api';
      const p = exec.platform as string | null | undefined;
      if (p && p.startsWith('mobile_')) return 'mobile';
      return 'web';
    };
    const emptyBreakdown = () => ({
      web:    { total: 0, passed: 0, failed: 0 },
      mobile: { total: 0, passed: 0, failed: 0 },
      api:    { total: 0, passed: 0, failed: 0 },
    });

    // Group by run_id and compute stats + platform breakdown in one pass.
    const statsMap = new Map<string, any>();
    const breakdownMap = new Map<string, ReturnType<typeof emptyBreakdown>>();
    const grouped = new Map<string, any[]>();
    for (const exec of allExecs || []) {
      const arr = grouped.get(exec.run_id) || [];
      arr.push(exec);
      grouped.set(exec.run_id, arr);
    }
    for (const [rid, execs] of grouped) {
      const total = execs.length;
      const passed = execs.filter((e: any) => e.status === 'passed').length;
      const failed = execs.filter((e: any) => e.status === 'failed').length;
      const skipped = execs.filter((e: any) => e.status === 'skipped').length;
      const pending = execs.filter((e: any) => e.status === 'pending').length;
      const running = execs.filter((e: any) => e.status === 'running').length;
      const cancelled = execs.filter((e: any) => e.status === 'cancelled').length;
      const completed = passed + failed;
      statsMap.set(rid, {
        total, passed, failed, skipped, pending, running, cancelled,
        passRate: completed > 0 ? Math.round((passed / completed) * 100) : 0,
      });

      // Platform breakdown for this run — zero-filled slices for platforms
      // that don't appear in this run, so the frontend can render a
      // consistent three-slot strip without null checks.
      const bd = emptyBreakdown();
      for (const exec of execs) {
        const bucket = bucketFor(exec);
        bd[bucket].total++;
        if (exec.status === 'passed') bd[bucket].passed++;
        else if (exec.status === 'failed') bd[bucket].failed++;
      }
      breakdownMap.set(rid, bd);
    }

    return runs.map((run: any) => {
      const runStats = statsMap.get(run.id) || { total: 0, passed: 0, failed: 0, skipped: 0, pending: 0, running: 0, cancelled: 0, passRate: 0 };
      const durationMs = run.started_at && run.completed_at
        ? Math.max(new Date(run.completed_at).getTime() - new Date(run.started_at).getTime(), 0)
        : null;
      const bugsFound = run.summary?.bugs_count ?? run.summary?.bugsFound ?? 0;

      // Derive status from live execution data to avoid stale regression_runs cache
      const normalizedStatus = deriveRunStatus({ cachedStatus: run.status, execStats: runStats });

      return {
        id: run.id,
        planId: run.plan_id || null,
        planName: (run.regression_plans as any)?.name || null,
        projectId: run.project_id,
        status: normalizedStatus,
        trigger: run.trigger,
        startedAt: run.started_at,
        completedAt: run.completed_at || null,
        durationMs,
        passRate: runStats.passRate,
        stats: runStats,
        bugsFound,
        /**
         * Phase 7 — runs-list platform composition. Same shape as
         * `RunReportSummary.platformBreakdown` on the report endpoint;
         * frontend renders a compact "4 web / 1 mobile" chip.
         */
        platformBreakdown: breakdownMap.get(run.id) || emptyBreakdown(),
      };
    });
  }

  /**
   * Verify user has access to project (owner or any workspace member with read access).
   * So webhook-triggered runs are visible to all workspace members, not only project owner.
   *
   * @throws {NotFoundError} If project not found
   * @throws {ValidationError} If access denied
   */
  private static async verifyProjectAccess(
    projectId: string,
    userId: string
  ): Promise<void> {
    const project = await getProjectForAccess(projectId);

    if (!project) {
      throw new NotFoundError('Project', projectId);
    }

    if (project.user_id === userId) return;

    const workspaceId = project.workspace_id ?? undefined;
    if (workspaceId) {
      const role = await WorkspaceAccessService.getRole(userId, workspaceId);
      if (role != null) return;
    }

    throw new ValidationError('Access denied to this project');
  }

  // =========================================================================
  // NEW HIERARCHY METHODS
  // =========================================================================

  /**
   * Run a regression plan
   * Expands plan to individual test cases and executes them
   *
   * @param params.planId - ID of regression plan to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @param params.parameters - Runtime parameters
   * @returns Run result with run ID and test case count
   */
  static async runPlan(params: {
    planId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
    /**
     * Phase 5: optional trigger context — threaded from the git webhook
     * handler so mobile cases can install the APK built from that branch /
     * commit. Ignored by the web dispatch path (Playwright agent pulls the
     * site by URL regardless of git context).
     *
     * Precedence inside the mobile resolver:
     *   commitSha > branch > legacy project.settings.mobileApp
     *
     * When this context is absent (manual runs, scheduled runs without a
     * pinned build, pre-Phase-5 callers), the resolver falls back to the
     * legacy slot — byte-identical to pre-Phase-5 behaviour.
     */
    triggerContext?: {
      branch?: string;
      commitSha?: string;
      /** Explicit mobile build pin from plan/run settings (wins over branch/commit). */
      buildId?: string;
      /** Variant lane to resolve within (default lane when absent). */
      variantLabel?: string;
    };
  }): Promise<RunResult> {
    const { planId, userId, trigger, parameters = {}, triggerContext: rawTriggerContext } = params;

    try {
      logger.info('[REGRESSION_RUN] Running plan', { planId, userId, trigger });

      // 1. Verify plan access and expand to test cases
      const plan = await RegressionPlanService.getById(planId, userId);
      if (!plan) {
        throw new NotFoundError('Regression plan', planId);
      }

      // Merge the plan-level mobile build pin into triggerContext so the
      // resolver picks the pinned APK by default. Explicit triggerContext
      // from the caller (e.g. a git webhook with branch + commitSha)
      // still wins — webhook context is always more specific than a
      // generic "use this version" plan default.
      //
      // Detect a stale pin (build was pruned out by `pruneOldBuilds` after
      // the plan was created) so we can surface it loudly. The resolver
      // falls through to latest-on-project either way, but a silent
      // downgrade is exactly the kind of "why did my regression run
      // against v1.3 instead of v1.2?" incident we want to make visible.
      if (plan.mobileBuildMode === 'pinned' && plan.pinnedMobileAppBuildId) {
        const pinnedRow = await MobileAppStorageService.getBuildById(
          plan.pinnedMobileAppBuildId,
          plan.projectId,
        );
        if (!pinnedRow) {
          logger.warn('[REGRESSION_RUN] plan pin missing — pruned or deleted, falling back to latest', {
            planId,
            projectId: plan.projectId,
            pinnedBuildId: plan.pinnedMobileAppBuildId,
            trigger,
          });
        }
      }
      // Merge plan-level mobile selection (pin + variant) into the trigger
      // context. Explicit caller context (webhook branch/commit/buildId) still
      // wins — it's more specific than a plan default — so plan values only
      // fill fields the caller left unset. `variantLabel` scopes the resolver
      // to a named lane; pin still wins WITHIN that lane.
      const triggerContext = (() => {
        const base: { branch?: string; commitSha?: string; buildId?: string; variantLabel?: string } = {
          ...(rawTriggerContext ?? {}),
        };
        if (plan.mobileBuildMode === 'pinned' && plan.pinnedMobileAppBuildId && base.buildId === undefined) {
          base.buildId = plan.pinnedMobileAppBuildId;
        }
        if (plan.mobileVariantLabel && base.variantLabel === undefined) {
          base.variantLabel = plan.mobileVariantLabel;
        }
        return Object.keys(base).length > 0 ? base : undefined;
      })();
      if (triggerContext?.buildId || triggerContext?.variantLabel) {
        logger.info('[REGRESSION_RUN] mobile trigger context active', {
          planId,
          buildId: triggerContext.buildId,
          variantLabel: triggerContext.variantLabel,
          fromPlanPin: plan.mobileBuildMode === 'pinned' && plan.pinnedMobileAppBuildId === triggerContext.buildId,
        });
      }

      const expandedCases = await RegressionPlanService.expandPlan(planId);
      if (expandedCases.length === 0) {
        const items = await RegressionPlanService.getItems(planId);
        const flowItems = items.filter((i) => i.itemType === 'flow');
        const moduleItems = items.filter((i) => i.itemType === 'module');
        logger.error('[REGRESSION_RUN] Plan expanded to 0 test cases', {
          planId,
          totalItems: items.length,
          flowItems: flowItems.map((i) => i.flowId),
          moduleItems: moduleItems.map((i) => i.moduleId),
        });
        throw new ValidationError(
          items.length === 0
            ? 'Plan has no items. Add modules, flows, or test cases to the plan before running.'
            : `Plan has ${items.length} item(s) but none contain test cases. The referenced flows/modules may be empty.`
        );
      }

      // 1b. Batch-fetch depends_on + priority for UI test cases.
      // Dependencies are passed RAW (not filtered to in-run ids): the
      // orchestrator detects out-of-run references, surfaces them in the
      // run summary as `missingDependencies`, and the topological sort
      // ignores them for ordering — so the user sees the gap instead of
      // it being silently swallowed here.
      const uiCaseIds = expandedCases.filter((tc) => tc.testType === 'ui').map((tc) => tc.testCaseId);
      const depMap = new Map<string, string[]>();
      const priorityMap = new Map<string, string | null>();
      const hostMap = new Map<string, string | null>();
      if (uiCaseIds.length > 0) {
        const depRows = await RegressionTestQueryService.getDependsOnRows(uiCaseIds);
        for (const row of depRows) {
          depMap.set(row.id, row.depends_on || []);
          priorityMap.set(row.id, row.priority ?? null);
          hostMap.set(row.id, row.host_platform ?? null);
        }
      }

      const executableCases: ExecutableTestCase[] = expandedCases.map((tc) => ({
        testCaseId: tc.testCaseId,
        testType: tc.testType,
        moduleId: tc.moduleId,
        flowId: tc.flowId,
        dependsOn: depMap.get(tc.testCaseId) || [],
        priority: priorityMap.get(tc.testCaseId) ?? null,
        host_platform: hostMap.get(tc.testCaseId) ?? null,
        ...(tc.isNegative && { isNegative: true }),
        ...(tc.platform && { platform: tc.platform }),
      }));

      // 1c. Credit check — verify user has enough credits for all test cases
      await this.checkCreditBalance(userId, executableCases, 'regression_plan');

      // 2. Create regression run record with plan_id (initially 'pending' until executions are created)
      const { data: run, error: runError } = await insertRun({
        plan_id: planId,
        project_id: plan.projectId,
        user_id: userId,
        trigger,
        status: 'pending',
      });

      if (runError || !run) {
        throw new Error(`Failed to create plan run: ${(runError as any)?.message}`);
      }

      // Invalidate plans list cache (new run affects lastRun display)
      await cache.delByPattern(`qait:cache:plans:proj:${plan.projectId}:*`);

      // 3. Create execution records for all test cases
      let executions;
      try {
        executions = await ExecutionService.createBatch(
          run.id,
          executableCases.map((tc) => ({
            testCaseId: tc.testCaseId,
            testType: tc.testType,
            moduleId: tc.moduleId,
            flowId: tc.flowId,
            ...(tc.isNegative && { isNegative: true }),
            // Denormalise platform so reports / WS events can render the
            // right mobile/web artifacts without joining back to
            // intent_test_cases on every query.
            ...(tc.platform ? { platform: tc.platform } : {}),
          }))
        );
      } catch (batchError) {
        // Rollback: mark run as failed since executions couldn't be created
        logger.error('[REGRESSION_RUN] Failed to create executions, marking run as failed', {
          runId: run.id,
          error: batchError,
        });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
        throw batchError;
      }

      // Transition from 'pending' to 'running' now that executions exist
      await updateRunById(run.id, { status: 'running', started_at: new Date().toISOString() });

      // Notify all workspace members immediately — closes the gap between run creation
      // and the first progress event from executeTestCasesAsync (which fires only
      // after the BullMQ job picks up, potentially seconds later).
      // Non-fatal: a WS emit failure must never block run startup — the run row
      // already exists with status='running' and BullMQ will execute it regardless.
      try {
        const creationRecipients = await getProjectWorkspaceMemberIds(plan.projectId, userId);
        const creationPayload = {
          runId: run.id,
          userId,
          planId,
          projectId: plan.projectId,
          trigger,
          status: 'started' as const,
          progress: 0,
          message: 'Regression run started',
          details: { totalTests: executableCases.length, completedTests: 0 },
          timestamp: new Date().toISOString(),
        };
        for (const recipientId of creationRecipients) {
          webSocketService.emitRegressionRunProgress(recipientId, creationPayload);
        }
        logger.info('[REGRESSION_RUN] Creation WS event emitted', {
          runId: run.id,
          planId,
          recipients: creationRecipients.length,
        });
      } catch (wsError) {
        logger.warn('[REGRESSION_RUN] Failed to emit creation WS event — run will proceed normally', {
          runId: run.id, planId, error: wsError,
        });
      }

      // 4. Read runtime config from plan's automation_config
      const browserOverride = plan.automationConfig?.runtime?.browser;
      // Opt-in fail-fast: stop dispatching new tests after the first
      // failure / skipped-prereq. Default (undefined / false) preserves
      // the current "run every test" behaviour.
      const failOnFirstFailure = plan.automationConfig?.runtime?.failOnFirstFailure === true;

      // 5. Start executing tests (async, don't wait)
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        executableCases,
        userId,
        trigger,
        parameters,
        browserOverride,
        triggerContext,
        failOnFirstFailure,
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      logger.info('[REGRESSION_RUN] Plan execution started', {
        runId: run.id,
        planId,
        totalCases: executableCases.length,
        browserOverride,
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: executableCases.length,
      };
    } catch (error) {
      logger.error('[REGRESSION_RUN] Failed to run plan', { error, planId });
      throw error;
    }
  }

  /**
   * Run all tests in a module
   * Platform determines whether this runs UI or API tests (enforced by DB triggers)
   *
   * @param params.moduleId - ID of module to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @param params.parameters - Runtime parameters
   * @returns Run result
   */
  static async runModule(params: {
    moduleId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
  }): Promise<RunResult> {
    const { moduleId, userId, trigger, parameters = {} } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running module', { moduleId, userId, trigger });

      // 1. Get module with platform info and verify access
      const { data: mod, error: modError } = await RegressionTestQueryService.getModuleWithAccess(moduleId);

      if (modError || !mod) {
        throw new NotFoundError('Module', moduleId);
      }

      if ((mod.projects as any)?.user_id !== userId) {
        throw new ValidationError('Access denied to this module');
      }

      const platformKey = (mod.test_platforms as any)?.platform_key;
      logger.info('[REGRESSION_RUN] Module platform resolved', {
        moduleId,
        moduleName: mod.name,
        platformKey,
      });

      // 2. Get all flows in module
      const flowIds = await RegressionTestQueryService.getFlowIdsByModule(moduleId);

      // 3. Get all test cases in flows
      const testCases = await RegressionTestQueryService.getTestCasesInFlows(flowIds);

      if (testCases.length === 0) {
        throw new ValidationError('Module has no test cases');
      }

      // 4. Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_module');

      // 5. Create regression run record
      const { data: run, error: runError } = await insertRun({
        module_id: moduleId,
        project_id: mod.project_id,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create module run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // 6. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 7. Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        parameters
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      // Mark run as failed if it was already created
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run module', { error, moduleId });
      throw error;
    }
  }

  /**
   * Run all tests in a flow
   *
   * @param params.flowId - ID of flow to run
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @param params.parameters - Runtime parameters
   * @returns Run result
   */
  static async runFlow(params: {
    flowId: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
    parameters?: Record<string, any>;
  }): Promise<RunResult> {
    const { flowId, userId, trigger, parameters = {} } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running flow', { flowId, userId, trigger });

      // 1. Get flow and verify access
      const { data: flow, error: flowError } = await RegressionTestQueryService.getFlowWithAccess(flowId);

      if (flowError || !flow) {
        throw new NotFoundError('Flow', flowId);
      }

      const module = flow.test_modules as any;
      if (module?.projects?.user_id !== userId) {
        throw new ValidationError('Access denied to this flow');
      }

      // 2. Get test cases in flow
      const testCases = await RegressionTestQueryService.getTestCasesInFlows([flowId]);

      if (testCases.length === 0) {
        throw new ValidationError('Flow has no test cases');
      }

      // 2b. Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_flow');

      // 3. Create regression run record
      const { data: run, error: runError } = await insertRun({
        flow_id: flowId,
        module_id: flow.module_id,
        project_id: module.project_id,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create flow run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // 4. Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // 5. Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        parameters
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run flow', { error, flowId });
      throw error;
    }
  }

  /**
   * Run all tests with a specific tag
   *
   * @param params.projectId - Project ID
   * @param params.tag - Tag to filter by
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @returns Run result
   */
  static async runByTag(params: {
    projectId: string;
    tag: string;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
  }): Promise<RunResult> {
    const { projectId, tag, userId, trigger } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running by tag', { projectId, tag, userId });

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Get UI test cases with tag from intent_test_cases (unified table).
      // We pull `priority` so we can run higher-priority tests first
      // within a tag bucket — a tag is an unordered collection (unlike
      // a plan which has explicit `position`, or a module/flow which
      // has `order_index`), so reordering here doesn't violate any
      // curator-set sequence. Sort is below.
      const uiCases = await RegressionTestQueryService.getUiTestCasesByTag(projectId, tag);

      // Get API test cases with tag (scoped to project via environments/endpoints)
      const apiCases = await RegressionTestQueryService.getApiTestConfigsByProjectAndTag(projectId, userId, tag);

      // Sort UI cases by curator-set priority — critical first.
      // Stable within the same priority bucket (we lean on Array.sort's
      // stability guarantee, ES2019+). API cases stay in their original
      // relative order at the end because `api_test_configs` has no
      // priority column repo-wide (see analytics-query.service:838) — no
      // signal to sort on, so we don't pretend to.
      //
      // NULL / wrongly-cased handling lives in the shared priorityRank()
      // (resolve-test-case-priority.util.ts): legacy NULL rows and schema
      // drift like 'Critical' collapse into the medium bucket.
      const orderedUiCases = [...(uiCases || [])].sort(
        (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
      );

      const testCases: ExecutableTestCase[] = [
        ...orderedUiCases.map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: tc.depends_on || [],
          platform: tc.platform || undefined,
          priority: tc.priority ?? null,
        })),
        ...(apiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'api' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: [] as string[],
        })),
      ];

      if (testCases.length === 0) {
        throw new ValidationError(`No test cases found with tag: ${tag}`);
      }

      // Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_tag');

      // Create regression run
      const { data: run, error: runError } = await insertRun({
        project_id: projectId,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create tag run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        {}
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run by tag', { error, projectId, tag });
      throw error;
    }
  }

  /**
   * Run all tests with a specific priority
   *
   * @param params.projectId - Project ID
   * @param params.priority - Priority to filter by
   * @param params.userId - User ID for ownership verification
   * @param params.trigger - Trigger type
   * @returns Run result
   */
  static async runByPriority(params: {
    projectId: string;
    priority: Priority;
    userId: string;
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook';
  }): Promise<RunResult> {
    const { projectId, priority, userId, trigger } = params;
    let createdRunId: string | null = null;

    try {
      logger.info('[REGRESSION_RUN] Running by priority', { projectId, priority, userId });

      // Verify project access
      await this.verifyProjectAccess(projectId, userId);

      // Get UI test cases with priority from intent_test_cases (unified table)
      const uiCases = await RegressionTestQueryService.getUiTestCasesByPriority(projectId, priority);

      // Get API test cases with priority (scoped to project via environments/endpoints)
      const apiCases = await RegressionTestQueryService.getApiTestConfigsByProjectAndPriority(projectId, userId, priority);

      const testCases: ExecutableTestCase[] = [
        ...(uiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'ui' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: tc.depends_on || [],
          platform: tc.platform || undefined,
          priority: tc.priority ?? null,
        })),
        ...(apiCases || []).map((tc: any) => ({
          testCaseId: tc.id,
          testType: 'api' as const,
          flowId: tc.flow_id || undefined,
          dependsOn: [] as string[],
        })),
      ];

      if (testCases.length === 0) {
        throw new ValidationError(`No test cases found with priority: ${priority}`);
      }

      // Credit check + deduction
      await this.checkCreditBalance(userId, testCases, 'regression_priority');

      // Create regression run
      const { data: run, error: runError } = await insertRun({
        project_id: projectId,
        user_id: userId,
        trigger,
        status: 'running',
        started_at: new Date().toISOString(),
      });

      if (runError || !run) {
        throw new Error(`Failed to create priority run: ${(runError as any)?.message}`);
      }
      createdRunId = run.id;

      // Create execution records
      const executions = await ExecutionService.createBatch(run.id, testCases);

      // Start async execution
      TestExecutionOrchestratorService.executeTestCasesAsync(
        run.id,
        testCases,
        userId,
        trigger,
        {}
      ).catch(async (error) => {
        logger.error('[REGRESSION_RUN] Async execution failed', { error, runId: run.id });
        await updateRunById(run.id, { status: 'failed', completed_at: new Date().toISOString() });
      });

      return {
        runId: run.id,
        executionIds: executions.map((e) => e.id),
        totalTests: testCases.length,
      };
    } catch (error) {
      if (createdRunId) {
        try {
          await updateRunById(createdRunId, { status: 'failed', completed_at: new Date().toISOString() });
        } catch { /* non-fatal */ }
      }
      logger.error('[REGRESSION_RUN] Failed to run by priority', { error, projectId, priority });
      throw error;
    }
  }

  // =========================================================================
  // RUN REPORT — delegates to RegressionReportAssemblerService
  // =========================================================================

  static async buildFullReport(runId: string, userId: string): Promise<RunReport | null> {
    return RegressionReportAssemblerService.buildFullReport(runId, userId);
  }

  static async buildPublicReport(shareToken: string): Promise<RunReport | null> {
    return RegressionReportAssemblerService.buildPublicReport(shareToken);
  }

  static async batchGetTestResults(testIds: string[]) {
    return RegressionReportAssemblerService.batchGetTestResults(testIds);
  }
}
