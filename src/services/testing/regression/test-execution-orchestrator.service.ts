import { ApiConfigService } from '@/services/api/api-config.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { TokenCalculatorService } from '@/services/core/token-calculator.service';
import { UserCreditsService } from '@/services/core/user-credits.service';
import { logger } from '@/utils/core/logger';
import { topologicalSort } from '@/utils/graph/topological-sort';
import { collapseLevelsIfBarrierDisabled } from './level-dispatch.util';
import { isRegressionLevelBarrierDisabled } from '@/config/features/regression-scheduling';
import { webSocketService } from '@/websocket/core/websocket.service';
import { executionCompletionEmitter } from '../executions/execution-completion-emitter';
import { ExecutionService } from '../executions/execution.service';
import { ManualTestService } from '../ui/manualTest.service';
import { IntentTestCaseService } from '../ui/preview/intent-test-case.service';
import { mobileTestRunQueue, mobileTestRunQueueEvents } from '@/config/infrastructure/queues';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import type { ExecutableTestCase } from '@/types/testing.types';
import type { RegressionRunProgressPayload } from '@/websocket/types/types';
import { getProjectWorkspaceMemberIds } from './regression-report-assembler.service';
import { priorityRank } from './resolve-test-case-priority.util';
import { MobileTestDispatcherService } from './mobile-test-dispatcher.service';
import { WebTestRequestBuilderService } from './web-test-request-builder.service';
import { RegressionTestQueryService } from './db/regression-test-query.db';
import {
  getRunRoutingInfo,
  getExecutionRefsForRun,
  getFastAuthByExecIds,
  updateRunById,
  updateRunByIdIfActive,
} from './db/regression-run.db';
import {
  decideMaxMobileInFlight,
  countMobileTests,
  dominantMobilePlatform,
  envCapMobile,
} from './concurrency-decision';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST EXECUTION ORCHESTRATOR SERVICE
 *
 * Extracted from RegressionRunService (Phase 1-E refactor).
 * Owns the core `executeTestCasesAsync` loop: topological dispatch,
 * mobile/web routing, credit tracking, progress emission, and run
 * status finalization.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class TestExecutionOrchestratorService {
  /**
   * Execute test cases asynchronously
   * Updates execution records as tests complete
   */
  static async executeTestCasesAsync(
    runId: string,
    testCases: ExecutableTestCase[],
    userId: string,
    trigger: 'manual' | 'chat' | 'scheduled' | 'webhook',
    parameters: Record<string, any>,
    browserOverride?: string,
    /**
     * Phase 5: optional git context propagated from runPlan. Only consumed
     * by the mobile branch of the per-case dispatch (see line where
     * `dispatchMobileTest` is called); web Playwright runs ignore it.
     */
    triggerContext?: { branch?: string; commitSha?: string; buildId?: string },
    /**
     * When true, the loop sets a `failFastTriggered` flag on the first
     * failure and stops dispatching further tests. Mirrors the existing
     * `creditExhausted` early-exit pattern. Defaults to false (continue
     * running every test) to preserve historic nightly-run semantics.
     */
    failOnFirstFailure: boolean = false,
  ): Promise<void> {
    const startedAt = new Date().toISOString();

    // Resolve recipients + plan/project for progress payload once (so git-trigger progress is visible to workspace members, not only owner)
    let planIdForWs: string | null = null;
    let projectIdForWs: string | null = null;
    let progressRecipients: string[] = [userId];
    try {
      const runRow = await getRunRoutingInfo(runId);
      planIdForWs = runRow?.plan_id ?? null;
      projectIdForWs = runRow?.project_id ?? null;

      if (projectIdForWs) {
        progressRecipients = await getProjectWorkspaceMemberIds(projectIdForWs, userId);
      }
    } catch {
      // non-fatal: fall back to owner-only
    }

    // Preload executions to avoid per-test lookups
    const { rows: executions, error: execError } = await getExecutionRefsForRun(runId);

    if (execError) {
      // Pre-fix this was a silent `return` — left the run row orphan in
      // 'running' state because nothing thrown reached runPlan's
      // `.catch()` finalizer at line 1310. Now we explicitly finalize the
      // run row before bailing out so the regression list / detail view
      // doesn't show a forever-running run.
      logger.error('[REGRESSION_RUN] Failed to preload executions', { error: execError, runId });
      try {
        await updateRunByIdIfActive(runId, {
          status: 'failed',
          completed_at: new Date().toISOString(),
          summary: {
            total: testCases.length,
            error: `Failed to preload executions: ${(execError as any)?.message ?? 'unknown'}`,
            completed_at: new Date().toISOString(),
          },
        });
      } catch (finalizeErr) {
        logger.error('[REGRESSION_RUN] Failed to finalize run after preload failure', {
          runId,
          error: finalizeErr,
        });
      }
      return;
    }

    const execByKey = new Map<string, string>();
    for (const e of executions) {
      execByKey.set(`${e.test_type}:${e.test_case_id}`, e.id);
    }

    // Topological sort by depends_on
    const { levels: topoLevels, hasCycle, cycleNodes, blockedByCycleNodes } = topologicalSort(testCases);

    // Level barrier (default ON): dependency levels run in order — a dependent
    // waits for its dependency's standalone run. When REGRESSION_DISABLE_LEVEL_BARRIER
    // is ON, collapse to a single level so every non-cyclic test dispatches together
    // (bounded only by worker concurrency). Inlining of dependency steps and cycle
    // detection are unaffected; cycle nodes are already excluded from `levels`.
    const levels = collapseLevelsIfBarrierDisabled(topoLevels, isRegressionLevelBarrierDisabled());

    // Dependencies pointing OUTSIDE this run (test case in depends_on but
    // not in the plan/selection) are ignored for ordering — the dependent
    // runs without waiting. That's the only sane default, but it must be
    // VISIBLE: a server-side log alone leaves QA wondering why B ran
    // without A. Collected here and persisted into every summary write
    // below so the run report can render a warning.
    const inRunIds = new Set(testCases.map((t) => t.testCaseId));
    const missingDependencies = testCases
      .map((tc) => ({
        testCaseId: tc.testCaseId,
        missingDependencyIds: (tc.dependsOn || []).filter((d) => !inRunIds.has(d)),
      }))
      .filter((e) => e.missingDependencyIds.length > 0);
    const missingDepsSummary =
      missingDependencies.length > 0 ? { missingDependencies } : {};
    if (missingDependencies.length > 0) {
      logger.warn('[REGRESSION_RUN] Test cases reference dependencies outside this run', {
        runId,
        missingDependencies,
      });
    }

    // Level-based execution with dependency tracking
    const failedOrSkippedIds = new Set<string>();
    const uiTestIds: string[] = [];
    let apiPassed = 0;
    let apiFailed = 0;
    let skippedCount = 0;
    let completedCount = 0;
    const totalTests = testCases.length;
    const totalLevels = levels.length;

    // Helper to emit regression progress (non-fatal)
    const emitProgress = (
      status: 'started' | 'level_started' | 'test_started' | 'test_completed' | 'level_completed' | 'completed' | 'failed',
      message: string,
      extra?: {
        currentLevel?: number;
        currentTestName?: string;
        errorCode?: string;
        /**
         * Optional per-test lifecycle update. Populated only when the
         * event describes a specific test case (queued / dispatching /
         * running / completed). Let the frontend maintain a live
         * per-test card list without REST polling.
         */
        testExecution?: RegressionRunProgressPayload['details'] extends infer D
          ? D extends { testExecution?: infer T } ? T : never
          : never;
      }
    ) => {
      try {
        const progress = totalTests > 0 ? Math.round((completedCount / totalTests) * 100) : 0;
        const payload: RegressionRunProgressPayload = {
          runId,
          userId,
          planId: planIdForWs,
          projectId: projectIdForWs,
          trigger,
          status,
          progress,
          message,
          errorCode: extra?.errorCode,
          details: {
            totalTests,
            completedTests: completedCount,
            currentLevel: extra?.currentLevel,
            totalLevels,
            currentTestName: extra?.currentTestName,
            passed: apiPassed,
            failed: apiFailed,
            skipped: skippedCount,
            // Only include when the emitter explicitly passed one — keeps
            // aggregate-level events (level_started etc) clean.
            ...(extra?.testExecution ? { testExecution: extra.testExecution } : {}),
          },
          timestamp: new Date().toISOString(),
        };

        for (const recipientId of progressRecipients) {
          webSocketService.emitRegressionRunProgress(recipientId, payload);
        }
      } catch { /* non-fatal */ }
    };

    emitProgress('started', `Regression run started: ${totalTests} tests in ${totalLevels} levels`);

    if (missingDependencies.length > 0) {
      emitProgress(
        'started',
        `${missingDependencies.length} test(s) reference dependencies outside this run and will run without waiting for them`,
      );
    }

    if (hasCycle) {
      logger.error('[REGRESSION_RUN] Dependency cycle detected in run', {
        runId,
        cycleNodes,
        blockedByCycleNodes,
      });
      // True cycle members can never be ordered — fail them outright.
      for (const nodeId of cycleNodes || []) {
        const tc = testCases.find((t) => t.testCaseId === nodeId);
        if (!tc) continue;
        const execId = execByKey.get(`${tc.testType}:${tc.testCaseId}`);
        if (execId) {
          await ExecutionService.updateStatus({
            id: execId,
            status: 'failed',
            errorMessage: 'Circular dependency detected. Cannot execute.',
          });
          emitProgress('test_completed', `Failed (circular dependency): ${tc.testCaseId}`, {
            testExecution: {
              testCaseId: tc.testCaseId,
              testExecutionId: execId,
              testType: tc.testType,
              event: 'completed',
              status: 'failed',
              errorMessage: 'Circular dependency detected. Cannot execute.',
            },
          });
        }
      }
      // Nodes that merely depend on the cycle are not broken themselves —
      // skip them with an honest reason instead of the misleading
      // "circular dependency" label. Mirrors the failed-prerequisite skip.
      for (const nodeId of blockedByCycleNodes || []) {
        const tc = testCases.find((t) => t.testCaseId === nodeId);
        if (!tc) continue;
        skippedCount++;
        const execId = execByKey.get(`${tc.testType}:${tc.testCaseId}`);
        if (execId) {
          const blockedReason = 'Skipped: depends on test(s) inside a circular dependency chain';
          await ExecutionService.updateStatus({
            id: execId,
            status: 'skipped',
            errorMessage: blockedReason,
          });
          emitProgress('test_completed', `Skipped (blocked by circular dependency): ${tc.testCaseId}`, {
            testExecution: {
              testCaseId: tc.testCaseId,
              testExecutionId: execId,
              testType: tc.testType,
              event: 'completed',
              status: 'skipped',
              errorMessage: blockedReason,
            },
          });
        }
      }
    }

    // Mobile regression concurrency cap.
    //
    // WHY: BullMQ's mobile worker has its own concurrency (default 2 after
    // the 2026-04-23 tuning), but that's a GLOBAL cap across ALL runs and
    // editor sessions on the instance. A single regression plan that
    // dispatches 15 test-cases as UI queue jobs would try to fan out to the
    // worker immediately; whoever is first in the queue claims the pool.
    // This cap keeps one plan from monopolizing the pool: we only dispatch
    // up to N mobile UI tests in-flight at once, awaiting the first to
    // complete before dispatching the next.
    //
    // The cap is advisory for non-mobile UI tests (web) — they don't
    // consume the mobile pool, but keeping the same ceiling keeps progress
    // events ordered and the regression view less chaotic.
    //
    // Override via REGRESSION_MOBILE_MAX_CONCURRENCY. Should be ≤ runner's
    // POOL_ANDROID_SIZE + POOL_IOS_SIZE — otherwise each extra slot forces
    // a ~60s cold-start that ends up slower than serial execution.
    //
    // Default is 1 (serial). The previous default of 2 caused regression
    // runs to dispatch two mobile tests in parallel, both racing the same
    // emulator. When the runner pool claim fails (e.g.
    // `pm create-user failed: (no output)` on a redroid that hasn't fully
    // booted multi-user), both tests fall back to cold-start on the same
    // device, contend on the ADB shell, and the second `runSteps` HTTP
    // request gets its socket dropped — surfacing as `Client aborted`
    // after step 0 in the runner. Editor runs never hit this because
    // they're always single-test. Operators with a healthy warm pool can
    // raise this to match `POOL_ANDROID_SIZE + POOL_IOS_SIZE`.
    // Phase 4 (May 2026): dynamic concurrency cap.
    //
    // Pre-Phase-4 this was a static parse of REGRESSION_MOBILE_MAX_CONCURRENCY
    // with a Math.max(1, ...) floor. That ignored real-time pool capacity
    // and test count — operators had to manually retune the env var.
    //
    // Now: we ask the runner for live pool capacity (cheap REST call,
    // 5s timeout) and decide a cap that respects:
    //   - envCap (operator's hard ceiling — never violated)
    //   - poolIdle (don't dispatch more parallel tests than the runner can claim)
    //   - testCount + platform (skip parallelism overhead when not useful)
    //
    // Falls back to cap=1 on any failure path (runner down, classic mode,
    // iOS-only, ...), preserving the pre-Phase-4 default behaviour. NEVER
    // throws — the regression always proceeds, just maybe serially.
    //
    // Snapshot-and-go: decision is computed once here and re-used for the
    // entire run. We deliberately don't recompute mid-run; multiple
    // regressions sharing the pool would race each other otherwise.
    //
    // See docs/mobile-test-orchestration-plan.md Phase 4.
    let MAX_MOBILE_IN_FLIGHT = 1;
    try {
      const decision = await decideMaxMobileInFlight({
        testCount: countMobileTests(levels),
        platform: dominantMobilePlatform(levels),
        runnerClient: getMobileRunnerClient(),
      });
      MAX_MOBILE_IN_FLIGHT = decision.cap;
      logger.info('[REGRESSION_RUN] Mobile concurrency decided', {
        runId,
        cap: decision.cap,
        reason: decision.reason,
        ...decision.inputs,
      });
    } catch (err) {
      // decideMaxMobileInFlight is documented not-to-throw; if it does,
      // fall back to the env cap (or 1) so the regression still runs.
      // Surface so we notice in logs and fix.
      //
      // Phase 4 audit (May 2026): use `envCapMobile()` rather than an
      // inline `Math.max(1, parseInt(...))`. parseInt('abc', 10) → NaN
      // and Math.max(1, NaN) → NaN, which would silently disable the
      // `inFlight.size >= cap` gate (NaN >= n is always false) and
      // dispatch every test in parallel. envCapMobile() validates
      // Number.isFinite + >=1 and falls back to 1 on garbage env.
      logger.error('[REGRESSION_RUN] decideMaxMobileInFlight threw — falling back to envCap', {
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
      MAX_MOBILE_IN_FLIGHT = envCapMobile();
    }

    // Defensive guard: log loudly if any testCaseId is dispatched twice
    // within a single run. Topological levels + dedup at expansion time
    // (regression-plan.service.ts:941-947) should make this impossible,
    // but the user has reported a "tests run again" symptom we couldn't
    // reproduce from logs. If the backend ever emits a duplicate, this
    // log + early-return surfaces it without putting an extra job on the
    // queue. Cheap, defensive, removable once the symptom is understood.
    const dispatchedTestCaseIds = new Set<string>();

    let creditExhausted = false;
    // Fail-fast flag — mirrors `creditExhausted`. Flipped to true the first
    // time any test case fails or is skipped due to a failed prerequisite
    // while `failOnFirstFailure` is enabled on the plan. Remaining tests
    // (both in the current level's dispatch loop and in future levels)
    // are marked 'skipped' with a clear reason instead of being dispatched.
    let failFastTriggered = false;
    // Track the testCaseId that triggered fail-fast so the UI can explain
    // which test caused the early stop.
    let failFastTriggerTestCaseId: string | null = null;

    for (let levelIdx = 0; levelIdx < levels.length && !creditExhausted && !failFastTriggered; levelIdx++) {
      // Dispatch critical tests first within the level. Order between
      // levels is owned by the topological sort; within a level it used
      // to be arbitrary (input order), so a critical smoke test could
      // queue behind twenty low-priority ones. Stable sort keeps the
      // curator's relative order inside each priority bucket.
      const level = [...levels[levelIdx]].sort(
        (a, b) => priorityRank(a.priority) - priorityRank(b.priority),
      );
      // `platform` captured at dispatch so we can forward it with the
      // per-test completion event below (post-level), which is how the
      // UI discriminates mobile vs web cards.
      const uiWaiters: Array<{
        testCaseId: string;
        execId: string;
        platform: string | null;
        promise: Promise<string>;
      }> = [];

      // ── Concurrency gate ────────────────────────────────────────────────
      // Tracks UI waiters that haven't settled yet. We don't want more than
      // MAX_MOBILE_IN_FLIGHT live mobile tests at a time — each one consumes
      // a device from the runner's pool, and exceeding pool size forces
      // expensive cold-starts. The gate also helps fairness across users on
      // shared infrastructure (one plan can't hog every device).
      //
      // We use a set of "in-flight" wrapper promises rather than counting
      // uiWaiters.length because `executionCompletionEmitter.waitForCompletion`
      // can resolve at any time while we're still dispatching; a set that
      // self-removes on resolve gives us an accurate current live count.
      const inFlight = new Set<Promise<void>>();
      const trackInFlight = (p: Promise<string>) => {
        const tracker: Promise<void> = p.then(() => {
          inFlight.delete(tracker);
        }, () => {
          // waitForCompletion only rejects on a timeout / emitter error.
          // Either way we must free the slot so dispatch can proceed.
          inFlight.delete(tracker);
        });
        inFlight.add(tracker);
      };

      emitProgress('level_started', `Starting level ${levelIdx + 1}/${totalLevels} (${level.length} tests)`, {
        currentLevel: levelIdx + 1,
      });

      for (const testCase of level) {
        // Fail-fast: once a prior test in this level (or earlier) has
        // failed, stop *dispatching* new ones. The uiWaiters block below
        // still awaits tests that were dispatched before the trigger, so
        // we don't lose verdicts from in-flight tests.
        if (failFastTriggered) break;

        // Defensive duplicate-dispatch guard. If the topological sort or
        // plan expansion ever lets the same testCaseId through twice in
        // one run, log loudly and skip the second dispatch — better to
        // have a missing run-card than to charge the user twice and
        // confuse the regression UI with phantom executions.
        const dispatchKey = `${testCase.testType}:${testCase.testCaseId}`;
        if (dispatchedTestCaseIds.has(dispatchKey)) {
          logger.error('[REGRESSION_RUN] DUPLICATE DISPATCH detected — skipping second invocation', {
            runId,
            testCaseId: testCase.testCaseId,
            testType: testCase.testType,
            level: levelIdx,
          });
          continue;
        }
        dispatchedTestCaseIds.add(dispatchKey);

        const execId = execByKey.get(`${testCase.testType}:${testCase.testCaseId}`);

        // Check if any prerequisite failed or was skipped
        const failedPrereqs = (testCase.dependsOn || []).filter((d) => failedOrSkippedIds.has(d));
        if (failedPrereqs.length > 0) {
          failedOrSkippedIds.add(testCase.testCaseId);
          skippedCount++;
          if (execId) {
            await ExecutionService.updateStatus({
              id: execId,
              status: 'skipped',
              errorMessage: `Skipped: prerequisite test(s) failed or were skipped [${failedPrereqs.join(', ')}]`,
            });
          }
          logger.info('[REGRESSION_RUN] Skipped test due to dependency failure', {
            runId,
            testCaseId: testCase.testCaseId,
            failedPrereqs,
          });
          // Surface the skip to the per-test dashboard. Same emission
          // shape as a completed-failed verdict so the FE card renders
          // consistently.
          if (execId) {
            emitProgress(
              'test_completed',
              `Skipped (prerequisite failed): ${testCase.testCaseId}`,
              {
                currentLevel: levelIdx + 1,
                testExecution: {
                  testCaseId: testCase.testCaseId,
                  testExecutionId: execId,
                  testType: testCase.testType,
                  event: 'completed',
                  status: 'skipped',
                  errorMessage: `Prerequisite(s) failed: ${failedPrereqs.join(', ')}`.slice(0, 200),
                },
              },
            );
          }
          continue;
        }

        // Execute test (existing logic preserved)
        // Track upfront-deducted credits we must refund if the dispatch code
        // throws catastrophically (service crash, network partition, DB
        // unreachable) — distinct from a normal API-reported failure where
        // the request was still sent.
        let refundOnCrash: { amount: number; testCaseId: string } | undefined;
        try {
          // For non-UI tests, mark execution as running before dispatch.
          // For UI tests, we defer this to after runTest() so we can write
          // result.testId atomically — prevents a race where the BullMQ job
          // completes before result.testId is persisted.
          if (execId && testCase.testType !== 'ui') {
            await ExecutionService.updateStatus({ id: execId, status: 'running' });
          }

          emitProgress('test_started', `Running ${testCase.testType.toUpperCase()} test (${completedCount + 1}/${totalTests})`, {
            currentLevel: levelIdx + 1,
            currentTestName: testCase.testCaseId,
            // Per-test lifecycle marker: we're about to dispatch the job
            // (UI tests → runner / Playwright queue; API tests → inline).
            // Platform is filled in after we've fetched the saved case
            // for UI tests, so we leave it undefined here and let the
            // `test_completed` event carry the authoritative value.
            ...(execId
              ? {
                  testExecution: {
                    testCaseId: testCase.testCaseId,
                    testExecutionId: execId,
                    testType: testCase.testType,
                    event: 'dispatching',
                  },
                }
              : {}),
          });

          if (testCase.testType === 'ui') {
            // Run UI test without creating nested regression_runs
            const savedCase = await RegressionTestQueryService.getSavedTestCase(testCase.testCaseId, userId);

            // Inline transitive dependency (precondition) steps so they run
            // in-session BEFORE this case's own steps (shared browser → shared
            // login/cookies/data) — same behavior as the editor / single run.
            // Borrowed steps carry namespaced ids + `_preconditionSource`, so
            // compiled-plan writeback never pollutes this case's steps_json.
            if (savedCase.depends_on?.length) {
              const preconditionSteps = await IntentTestCaseService.collectPreconditionSteps(testCase.testCaseId);
              if (preconditionSteps.length > 0) {
                savedCase.steps_json = [...preconditionSteps, ...(savedCase.steps_json || [])];
                logger.info('[REGRESSION_RUN] Inlined precondition steps', {
                  runId,
                  testCaseId: testCase.testCaseId,
                  preconditionSteps: preconditionSteps.length,
                  totalSteps: savedCase.steps_json.length,
                });
              }
            }

            // Route: mobile tests → mobile runner queue, web tests → Playwright queue
            const isMobile = savedCase.platform?.startsWith('mobile_');
            let testId: string;
            // Captured from dispatchMobileTest so the concurrency gate below
            // can also wait on the BullMQ `queue.completed` event, not just
            // the execution-completion emitter (which fires several seconds
            // before the worker's `finally` block finishes destroying the
            // runner session).
            let mobileJobId: string | null = null;
            // `mobile_app_builds.id` of the APK that was installed for this
            // execution — captured here so the audit-trail update below can
            // persist it on `test_executions`. Null when the resolver fell
            // back to the legacy slot (id === 'legacy-settings') or when no
            // build exists for the project.
            let mobileAppBuildIdForExec: string | null = null;

            if (isMobile) {
              // Phase 5: forward git triggerContext so the APK resolver can
              // pick the build matching the branch / commit that kicked off
              // this run. `triggerContext` is undefined for manual /
              // scheduled runs → resolver falls back to the legacy slot.
              // Phase 6: forward plan parameters too — the mobile dispatch
              // applies them to steps before queueing so placeholders
              // resolve (same semantics as buildTestRequest for web below).
              // `execId` lets the mobile job finalize test_executions.status
              // directly (web relies on TestCompletionHandler which doesn't
              // match mobile executions cleanly).
              const mobileResult = await MobileTestDispatcherService.dispatchMobileTest(
                savedCase,
                userId,
                trigger,
                triggerContext,
                parameters,
                execId,
              );
              testId = mobileResult.testId;
              mobileJobId = mobileResult.jobId;
              mobileAppBuildIdForExec = mobileResult.appBuildId;
            } else {
              const testRequest = await WebTestRequestBuilderService.buildTestRequest(savedCase, userId, parameters, browserOverride, trigger);
              const testResult = await ManualTestService.runTest(testRequest);

              if (!testResult.success || !testResult.data?.id) {
                throw new Error('Failed to start UI test execution');
              }
              testId = testResult.data.id;
            }

            uiTestIds.push(testId);

            if (execId) {
              await ExecutionService.updateStatus({
                id: execId,
                status: 'running',
                result: {
                  type: 'ui',
                  testId,
                  trigger,
                  startedAt,
                },
                // Mobile only — pin the execution row to the resolved
                // build so the audit trail survives storage pruning.
                // ON DELETE SET NULL keeps the row when the build row
                // itself is later evicted by `pruneOldBuilds`.
                ...(isMobile ? { mobileAppBuildId: mobileAppBuildIdForExec } : {}),
              });

              // Register waiter for dependency-aware ordering
              const waitPromise = executionCompletionEmitter.waitForCompletion(execId);
              uiWaiters.push({
                testCaseId: testCase.testCaseId,
                execId,
                platform: savedCase.platform || null,
                promise: waitPromise,
              });

              // Only mobile tests consume the runner's emulator pool — gate
              // those. Web tests go through Playwright's own pool and share
              // no resources with mobile, so there's no device shortage to
              // worry about. (When web tests end up slowing mobile due to
              // shared CPU/memory, cap them via WEB_WORKER_CONCURRENCY, not
              // here.)
              if (isMobile) {
                // The execution-completion emitter fires when the worker
                // updates `test_executions.status` — but the worker keeps
                // running for several more seconds inside its `finally`
                // block (destroySession, persistCompiledPlans, etc.). If we
                // released the gate here, Test N+1 would dispatch onto the
                // runner while Test N's session destroy is still in flight,
                // racing the runner's emulator teardown.
                //
                // Compose with `queue.completed` from the BullMQ worker so
                // the gate stays closed until the mobile worker's `finally`
                // also finishes. Failure of either side (job not found,
                // wait timeout) is non-fatal — the gate releases anyway so
                // a stuck runner doesn't deadlock the whole regression run.
                const mobileGatePromise = (async (): Promise<string> => {
                  const status = await waitPromise;
                  if (mobileJobId) {
                    try {
                      const job = await mobileTestRunQueue.getJob(mobileJobId);
                      if (job) {
                        // 10-minute cap mirrors executionCompletionEmitter's
                        // own DEFAULT_TIMEOUT_MS so a frozen runner doesn't
                        // wedge the gate for longer than the upstream.
                        await job.waitUntilFinished(mobileTestRunQueueEvents, 600_000);
                      }
                    } catch (err) {
                      logger.warn('[REGRESSION_RUN] BullMQ wait for mobile job failed; releasing gate anyway', {
                        jobId: mobileJobId,
                        error: err instanceof Error ? err.message : String(err),
                      });
                    }
                  }
                  return status;
                })();
                trackInFlight(mobileGatePromise);
                if (inFlight.size >= MAX_MOBILE_IN_FLIGHT) {
                  emitProgress(
                    'test_started',
                    `Queued ${totalTests - completedCount - inFlight.size} more — ${inFlight.size} mobile test(s) in flight`,
                    { currentLevel: levelIdx + 1 },
                  );
                  // Wait for any in-flight mobile test to settle. We don't
                  // care which one — we just need a free slot. Errors are
                  // absorbed by trackInFlight's .then, so Promise.race won't
                  // bubble a rejection here.
                  await Promise.race(inFlight);
                }
              }
            }
          } else {
            // Deduct API test credits upfront (flat cost per API test)
            const apiCreditCost = TokenCalculatorService.getTestCreditCost('api');
            const apiDeduction = await CreditCostTrackerService.deductCreditsForTest({
              userId,
              testType: 'api',
              credits: apiCreditCost,
              costUSD: 0,
              testId: `api_${testCase.testCaseId}_${Date.now()}`,
              description: `API test: ${testCase.testCaseId}`,
            });

            if (!apiDeduction.success) {
              throw new Error('Insufficient credits for API test');
            }

            // Track for refund on catastrophic failure — see catch block below.
            refundOnCrash = { amount: apiCreditCost, testCaseId: testCase.testCaseId };

            // Run API test via existing configuration-based executor
            const apiExecution = await ApiConfigService.executeWithConfig(userId, {
              test_config_id: testCase.testCaseId,
            } as any);

            // Normal completion (success OR API-reported failure) — keep the charge;
            // the request was dispatched and the user got a verdict back.
            refundOnCrash = undefined;

            const passed = !!apiExecution?.success;
            if (passed) {
              apiPassed++;
            } else {
              apiFailed++;
              failedOrSkippedIds.add(testCase.testCaseId);
              // Opt-in fail-fast: first failure trips the flag. The outer
              // level loop checks this after the current level's uiWaiters
              // finish; we still let already-dispatched tests in this level
              // complete so their verdicts are recorded.
              if (failOnFirstFailure && !failFastTriggered) {
                failFastTriggered = true;
                failFastTriggerTestCaseId = testCase.testCaseId;
              }
            }

            if (execId) {
              await ExecutionService.updateStatus({
                id: execId,
                status: passed ? 'passed' : 'failed',
                result: {
                  type: 'api',
                  apiExecutionId: apiExecution?.id,
                  statusCode: apiExecution?.status_code,
                  durationMs: apiExecution?.duration_ms,
                },
                errorMessage: passed ? undefined : apiExecution?.error_message || 'API test failed',
              });
            }

            completedCount++;
            emitProgress('test_completed', `API test ${passed ? 'passed' : 'failed'} (${completedCount}/${totalTests})`, {
              currentLevel: levelIdx + 1,
              ...(execId
                ? {
                    testExecution: {
                      testCaseId: testCase.testCaseId,
                      testExecutionId: execId,
                      testType: 'api',
                      // API tests have no device platform.
                      platform: null,
                      event: 'completed',
                      status: passed ? 'passed' : 'failed',
                      errorMessage: passed
                        ? undefined
                        : (apiExecution?.error_message || 'API test failed').slice(0, 200),
                    },
                  }
                : {}),
            });
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const isCreditError = errMsg.toLowerCase().includes('insufficient credits');

          logger.error('[REGRESSION_RUN] Failed to execute test case', {
            runId,
            testCaseId: testCase.testCaseId,
            testType: testCase.testType,
            errorMessage: errMsg,
            errorCode: (error as any)?.code,
            isCreditError,
            error,
          });

          failedOrSkippedIds.add(testCase.testCaseId);
          // Same fail-fast trip as the normal-failure branch above.
          if (failOnFirstFailure && !failFastTriggered && !isCreditError) {
            failFastTriggered = true;
            failFastTriggerTestCaseId = testCase.testCaseId;
          }

          // Refund upfront-deducted credits on catastrophic dispatch failure.
          // `refundOnCrash` is cleared after normal completion (pass OR fail),
          // so we only refund when the code never reached a verdict — e.g. the
          // executor threw before sending the request. We do NOT refund on
          // credit errors (nothing to refund: the deduction itself failed).
          if (refundOnCrash && !isCreditError) {
            try {
              await UserCreditsService.addCredits(
                userId,
                refundOnCrash.amount,
                'refund',
                `Refund: regression ${refundOnCrash.testCaseId} failed to dispatch`,
                { runId, testCaseId: refundOnCrash.testCaseId, reason: errMsg.slice(0, 200) },
              );
              logger.info('[REGRESSION_RUN] Refunded upfront credits after crash', {
                runId,
                testCaseId: refundOnCrash.testCaseId,
                amount: refundOnCrash.amount,
              });
            } catch (refundErr) {
              logger.error('[REGRESSION_RUN] Credit refund failed', {
                runId,
                testCaseId: refundOnCrash.testCaseId,
                amount: refundOnCrash.amount,
                error: refundErr instanceof Error ? refundErr.message : String(refundErr),
              });
            }
          }

          if (execId) {
            try {
              await ExecutionService.updateStatus({
                id: execId,
                status: 'failed',
                errorMessage: errMsg,
              });
            } catch (statusError) {
              logger.error('[REGRESSION_RUN] Failed to update execution status', {
                execId,
                statusError: statusError instanceof Error ? statusError.message : String(statusError),
              });
            }

            // Surface the catastrophic failure on the per-test card. This
            // path happens when the dispatch code itself threw (service
            // crash, network partition, etc.) — the test never entered
            // the uiWaiters post-level path, so we emit the completed
            // event here. Credit errors get a dedicated event below.
            if (!isCreditError) {
              emitProgress(
                'test_completed',
                `${testCase.testType.toUpperCase()} test failed to dispatch: ${errMsg.slice(0, 80)}`,
                {
                  currentLevel: levelIdx + 1,
                  testExecution: {
                    testCaseId: testCase.testCaseId,
                    testExecutionId: execId,
                    testType: testCase.testType,
                    event: 'completed',
                    status: 'failed',
                    errorMessage: errMsg.slice(0, 200),
                  },
                },
              );
            }
          }

          // Emit credit-specific progress event so frontend can show top-up prompt
          if (isCreditError) {
            creditExhausted = true;
            emitProgress('failed', 'Regression run stopped: insufficient credits. Please top up to continue.', {
              currentLevel: levelIdx + 1,
              errorCode: 'INSUFFICIENT_CREDITS',
            });
            break;
          }
        }
      }

      // Wait for all UI tests in this level to complete before moving to next level
      if (uiWaiters.length > 0) {
        logger.info('[REGRESSION_RUN] Waiting for UI tests in level to complete', {
          runId,
          level: levelIdx,
          uiTestCount: uiWaiters.length,
        });

        const results = await Promise.all(
          uiWaiters.map(async (w) => {
            const status = await w.promise;
            return {
              testCaseId: w.testCaseId,
              execId: w.execId,
              platform: w.platform,
              status,
            };
          })
        );

        // Batch-fetch fast-auth telemetry for every execId in this level
        // so the per-test `test_completed` WS payload can surface the
        // "Restored session 200ms" pill the FE renders. One SELECT for
        // the whole level (NOT N+1). Null/missing values are normal:
        //   - non-mobile tests have fast_auth_used IS NULL
        //   - mobile tests with no snapshot have fast_auth_used IS NULL
        // The map only populates entries that actually attempted fast-auth.
        // Best-effort: a query failure here leaves the pills off but the
        // run finalization continues unaffected.
        const fastAuthByExecId = new Map<
          string,
          { used: boolean; restoreMs?: number }
        >();
        try {
          const execIdsForFastAuth = results
            .map((r) => r.execId)
            .filter((id): id is string => typeof id === 'string' && id.length > 0);
          const faRows = await getFastAuthByExecIds(execIdsForFastAuth);
          for (const row of faRows) {
            if (row.fast_auth_used === null) continue;
            fastAuthByExecId.set(row.id, {
              used: row.fast_auth_used,
              ...(typeof row.fast_auth_restore_ms === 'number'
                ? { restoreMs: row.fast_auth_restore_ms }
                : {}),
            });
          }
        } catch (err) {
          logger.warn(
            '[REGRESSION_RUN] Failed to fetch fast-auth telemetry for live payload — pills will be off this level',
            {
              runId,
              level: levelIdx,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }

        for (const result of results) {
          completedCount++;
          if (result.status !== 'passed') {
            failedOrSkippedIds.add(result.testCaseId);
            // UI test verdicts arrive here (async via executionCompletionEmitter)
            // rather than in the inline API branch — so fail-fast needs to
            // trip here too, otherwise a UI-only plan would never early-exit.
            if (failOnFirstFailure && !failFastTriggered) {
              failFastTriggered = true;
              failFastTriggerTestCaseId = result.testCaseId;
            }
          }
          // Narrow the emitter status to the FE's union. `executionCompletionEmitter`
          // returns strings that may include 'cancelled' / 'pending' / 'timeout' —
          // collapse everything non-pass to 'failed' or 'skipped' so the FE state
          // machine stays three-valued. 'timeout' counts as a failure.
          const mappedStatus: 'passed' | 'failed' | 'skipped' =
            result.status === 'passed' ? 'passed'
            : result.status === 'failed' || result.status === 'timeout' ? 'failed'
            : 'skipped';
          const fa = result.execId ? fastAuthByExecId.get(result.execId) : undefined;
          emitProgress('test_completed', `UI test ${result.status} (${completedCount}/${totalTests})`, {
            currentLevel: levelIdx + 1,
            testExecution: {
              testCaseId: result.testCaseId,
              testExecutionId: result.execId,
              testType: 'ui',
              platform: result.platform,
              event: 'completed',
              status: mappedStatus,
              ...(fa ? { fastAuth: fa } : {}),
            },
          });
        }

        // Stamp timed-out executions in the DB so they are never left as 'running'.
        // The emitter resolved with 'timeout' (not a real signal) — the DB row was
        // never updated by the worker. Best-effort: a failure here is logged and
        // swallowed; the 30-minute force-fail in recomputeRunStatus is the backstop.
        // Persist as 'failed' (with a timeout error_message): the
        // `test_executions.status` CHECK constraint has no 'timeout' value, and
        // nothing downstream distinguishes timeout from failure. Writing 'timeout'
        // here raised a 23514 constraint violation, leaving the row stuck 'running'.
        const timedOutExecIds = results
          .filter((r) => r.status === 'timeout' && r.execId)
          .map((r) => r.execId as string);

        await Promise.all(
          timedOutExecIds.map((execId) =>
            ExecutionService.updateStatus({
              id: execId,
              status: 'failed',
              errorMessage: 'Mobile job not processed within 10 minutes (timeout)',
            }).catch((err) =>
              logger.warn('[REGRESSION_RUN] Failed to stamp timed-out execution in DB', {
                runId,
                execId,
                error: err instanceof Error ? err.message : String(err),
              }),
            ),
          ),
        );

        // A timed-out execution means the worker never signalled it, so no
        // completion event will ever recompute the run — without this trigger
        // the run stays 'running' until the 30-minute stale reaper. Recompute
        // now that the rows are stamped; if later levels are still pending the
        // recompute is a safe early-return, and its optimistic lock makes a
        // redundant call a no-op. Dynamic import mirrors mobile-test-run.job.ts
        // (avoids a static import cycle with the completion handler).
        if (timedOutExecIds.length > 0) {
          try {
            const { TestCompletionHandlerService } = await import(
              '../results/test-completion-handler.service'
            );
            await TestCompletionHandlerService.recomputeRunStatusById(runId);
          } catch (err) {
            logger.warn('[REGRESSION_RUN] Post-timeout run recompute failed', {
              runId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      emitProgress('level_completed', `Level ${levelIdx + 1}/${totalLevels} completed`, {
        currentLevel: levelIdx + 1,
      });

      // If fail-fast fired during this level, emit a dedicated progress
      // event so the UI can show the reason immediately — before the
      // remaining-skipped sweep below. We do this AFTER the level
      // completes (in-flight uiWaiters have returned) so the triggering
      // test's verdict is already written.
      if (failFastTriggered && !creditExhausted) {
        emitProgress(
          'failed',
          failFastTriggerTestCaseId
            ? `Regression stopped early: test "${failFastTriggerTestCaseId}" failed and fail-fast is enabled`
            : 'Regression stopped early: fail-fast policy',
          {
            currentLevel: levelIdx + 1,
            errorCode: 'FAIL_FAST_TRIGGERED',
          },
        );
      }
    }

    // If fail-fast stopped the run, mark remaining tests as skipped and
    // finalize. Mirrors the creditExhausted block below, but with a
    // distinct status (`completed` not `failed`) and summary flag — the
    // run finished cleanly per the user's own policy, it wasn't an
    // infrastructure problem.
    if (failFastTriggered && !creditExhausted) {
      for (const tc of testCases) {
        if (!failedOrSkippedIds.has(tc.testCaseId)) {
          const execId = execByKey.get(`${tc.testType}:${tc.testCaseId}`);
          const skipReason = failFastTriggerTestCaseId
            ? `Skipped: regression stopped early after "${failFastTriggerTestCaseId}" failed (fail-fast policy)`
            : 'Skipped: regression stopped early (fail-fast policy)';
          if (execId) {
            await ExecutionService.updateStatus({
              id: execId,
              status: 'skipped',
              errorMessage: skipReason,
            }).catch(() => {});

            // Surface each skipped test on the per-test dashboard so the
            // UI cards transition from "queued" → "skipped" with a reason.
            emitProgress(
              'test_completed',
              `Skipped (fail-fast): ${tc.testCaseId}`,
              {
                testExecution: {
                  testCaseId: tc.testCaseId,
                  testExecutionId: execId,
                  testType: tc.testType,
                  event: 'completed',
                  status: 'skipped',
                  errorMessage: skipReason.slice(0, 200),
                },
              },
            );
          }
          skippedCount++;
        }
      }

      await updateRunById(runId, {
        status: 'failed',
        test_ids: uiTestIds.length > 0 ? uiTestIds : undefined,
        summary: {
          total: testCases.length,
          api_passed: apiPassed,
          api_failed: apiFailed,
          skipped: skippedCount,
          failFastTriggered: true,
          failFastTriggerTestCaseId,
          ...missingDepsSummary,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        },
        completed_at: new Date().toISOString(),
      });

      return;
    }

    // If credit exhaustion stopped the run, mark remaining tests as skipped and finalize
    if (creditExhausted) {
      // Mark all non-started executions as skipped
      for (const tc of testCases) {
        if (!failedOrSkippedIds.has(tc.testCaseId)) {
          const execId = execByKey.get(`${tc.testType}:${tc.testCaseId}`);
          if (execId) {
            await ExecutionService.updateStatus({
              id: execId,
              status: 'skipped',
              errorMessage: 'Skipped: regression run stopped due to insufficient credits',
            }).catch(() => {});
          }
          skippedCount++;
        }
      }

      await updateRunById(runId, {
        status: 'failed',
        test_ids: uiTestIds.length > 0 ? uiTestIds : undefined,
        summary: {
          total: testCases.length,
          api_passed: apiPassed,
          api_failed: apiFailed,
          skipped: skippedCount,
          creditExhausted: true,
          ...missingDepsSummary,
          started_at: startedAt,
          completed_at: new Date().toISOString(),
        },
        completed_at: new Date().toISOString(),
      });

      return;
    }

    // Link UI test IDs to regression_runs so existing completion pipeline can update the run
    if (uiTestIds.length > 0) {
      const { error: updateError } = await updateRunById(runId, {
        test_ids: uiTestIds,
        summary: {
          total: testCases.length,
          ui_started: uiTestIds.length,
          api_passed: apiPassed,
          api_failed: apiFailed,
          skipped: skippedCount,
          ...missingDepsSummary,
          started_at: startedAt,
        },
      });

      if (updateError) {
        logger.warn('[REGRESSION_RUN] Failed to update run with UI test_ids', {
          error: updateError,
          runId,
        });
      }

      // Do not finalize run here — it will be recomputed on UI test completion
      // Emit progress so frontend knows all tests have been dispatched (UI tests still running)
      emitProgress('started', `All ${uiTestIds.length} UI tests dispatched, waiting for completion...`);
      return;
    }

    // If only API tests exist, finalize run immediately.
    // NOTE: regression_runs.status uses 'completed' (not 'passed') for success — match DB convention.
    const hasFails = apiFailed > 0;
    const persistedStatus = hasFails ? 'failed' : 'completed';
    await updateRunById(runId, {
      status: persistedStatus,
      summary: {
        total: testCases.length,
        passed: apiPassed,
        failed: apiFailed,
        api_passed: apiPassed,
        api_failed: apiFailed,
        skipped: skippedCount,
        ...missingDepsSummary,
        completed_at: new Date().toISOString(),
      },
      completed_at: new Date().toISOString(),
    });

    emitProgress(
      persistedStatus === 'completed' ? 'completed' : 'failed',
      `Regression run ${persistedStatus}: ${apiPassed} passed, ${apiFailed} failed, ${skippedCount} skipped`
    );
  }
}
