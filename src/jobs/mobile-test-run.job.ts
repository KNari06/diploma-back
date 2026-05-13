/**
 * Mobile Test Run Job Handler
 * BullMQ job that orchestrates mobile test execution via qait-mobile-runner.
 *
 * Flow:
 *   1. Create session on runner
 *   2. Run IntentSteps
 *   3. Get artifacts (screenshots, video)
 *   4. Upload to Supabase Storage
 *   5. Create test_results record
 *   6. Queue AI analysis
 *   7. Destroy session (always in finally)
 *
 * Pattern mirrors: src/jobs/manual-test-run.job.ts
 */

import { QueueManager } from '@/config/infrastructure/queues';
import { dbAdminService, supabaseAdmin } from '@/db/supabase';
import { ExecutionService } from '@/services/testing/executions/execution.service';
import { logQueueEvent, logger } from '@/utils/core/logger';
import { shouldRetry, calculateRetryDelay } from '@/utils/core/error-handler';
import { webSocketService } from '@/websocket/core/websocket.service';
import { CiRunService } from '@/services/mobile/ci-run.service';
import { Job } from 'bullmq';
import type { MobileTestJobData, MobileRunStepsResponse, MobileIntentStep } from '@/services/mobile/mobile-runner.types';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { MobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import { claimWarmedSession } from '@/api/mobile/session.controller';
import { MobileAppPrepService } from '@/services/mobile/mobile-app-prep.service';

// ============================================================================
// JOB HANDLER
// ============================================================================

/**
 * Custom error raised when a mobile test is cancelled mid-job.
 *
 * Mirrors the web pattern at manual-test-run.job.ts:32-37
 * (`TestCancelledError`). The web job uses a typed exception so the
 * outer catch can distinguish "user cancelled" from "everything else
 * failed" — cancelled tests need a `webSocketService.emitTestCancelled`
 * event and a graceful return, NOT a `tests.status = failed` flip.
 *
 * Pre-fix, mobile's cancellation paths silently `return`-ed without
 * emitting any WS event. The frontend then had to infer the cancel
 * had taken effect from the next `regression:run:progress` poll
 * rather than receiving an explicit lifecycle signal.
 */
export class MobileTestCancelledError extends Error {
  constructor(testId: string, browser: string) {
    super(`Mobile test ${testId} (${browser}) was cancelled`);
    this.name = 'MobileTestCancelledError';
  }
}

export class MobileTestRunJobHandler {
  /**
   * Check if test is already finalized
   */
  private static async isTestFinalized(testId: string): Promise<boolean> {
    try {
      const test = (await dbAdminService.getTest(testId)) as any;
      if (!test) return false;
      return ['completed', 'failed', 'cancelled', 'timeout'].includes(test.status);
    } catch {
      return false;
    }
  }

  /**
   * Check if test was cancelled
   */
  private static async isTestCancelled(testId: string): Promise<boolean> {
    try {
      const test = (await dbAdminService.getTest(testId)) as any;
      return test?.status === 'cancelled';
    } catch {
      return false;
    }
  }

  /**
   * Process mobile test run job
   */
  static async process(job: Job<MobileTestJobData>): Promise<void> {
    const {
      testId,
      userId,
      workspaceId,
      projectId,
      chatSessionId,
      platform,
      browser,
      appPackage,
      geminiApiKey,
      runnerUrl,
      runnerApiKey,
      appStoragePath,
      appOriginalName,
      ciRunId,
      metadata,
      // `analyticsRunId` is intentionally not destructured: see the
      // comment inside `finalizeAnalyticsLinkage` for why we don't flip
      // regression_runs from the job. The field stays on the job data
      // type so future non-Phase-9 paths can consume it if needed.
      analyticsExecutionId,
      intelligentSessionId,
      // Track 5 (shared resources): raw bindings only — the worker
      // compiles them on its own so plaintext secrets never land in Redis.
      resourceBindings,
      // `intent_test_cases.id`. Required for `persistCompiledPlansFromRun`
      // to find the test case row and merge per-step compiled plans back
      // into `intent_test_cases.steps_json`. Pre-fix the worker passed
      // `testId` (which is `tests.id`) and the persist silently failed
      // for every regression run with `Cannot coerce the result to a
      // single JSON object` — meaning compiled plans were NEVER saved
      // and every run hit the LLM from scratch on every step.
      // Optional because the chat dispatch path doesn't set it yet.
      testCaseId: intentTestCaseId,
      // Retry counter — undefined on first attempt, incremented by the
      // worker before re-throwing on retry-able errors. See W5 below.
      retryCount = 0,
    } = job.data;

    // ── Job-level retry budget ───────────────────────────────────────
    // Mirrors the web job's MAX_RETRIES constant
    // (manual-test-run.job.ts:26). Default 1 retry — i.e. up to 2 total
    // attempts on retry-able errors (network blip to runner, transient
    // 503, Redis stall). Tunable via env without redeploy. Lower than
    // web's default because mobile cold-starts cost ~30s each, so a
    // permanently-broken pool would otherwise burn 2 minutes per
    // failed regression test before giving up.
    const MAX_MOBILE_RETRIES = parseInt(process.env.MOBILE_TEST_MAX_RETRIES ?? '1', 10);

    // `intentSteps` stays a `let` because Track 5 resource compilation
    // may prepend setup steps to it (see below). Without bindings this is
    // byte-identical to job.data.intentSteps.
    let intentSteps = job.data.intentSteps;
    // Snapshot of applied/skipped resources — written to
    // test_executions.executed_resources on job completion (success or
    // failure). Built after compile; starts undefined so the no-bindings
    // fast path skips writeback entirely.
    let executedResources: Array<Record<string, unknown>> | undefined;

    // Validate
    if (!testId || !intentSteps?.length) {
      throw new Error('Missing required parameters: testId or intentSteps');
    }

    // Guard: skip if already finalized.
    // Mirrors the web job's pattern at manual-test-run.job.ts:85-101.
    // A BullMQ retry of a stalled job that already finished its real work
    // (steps executed, status flipped) but stalled in post-processing
    // would otherwise re-claim a session and re-run all steps. Returning
    // a no-op here is safe AND idempotent — the test row already says
    // 'completed' / 'failed' / 'cancelled' / 'timeout'.
    //
    // The log line includes job.id and job.attemptsMade so a sudden
    // spike in "already finalized" log lines is observable and points
    // at queue health (jobs being retried that shouldn't be).
    if (await this.isTestFinalized(testId)) {
      logger.info('[MOBILE-TEST] Test already finalized, skipping job execution', {
        testId,
        browser,
        jobId: job.id,
        jobAttempts: job.attemptsMade,
      });
      return;
    }

    // Guard: skip if cancelled. Emit a WS lifecycle event so any
    // listener that subscribed AFTER the user's cancelRun call (e.g.
    // a late-mounting analytics consumer) still sees the lifecycle
    // close. Mirrors the cancellation event emission web does in its
    // catch block (manual-test-run.job.ts:280-284).
    if (await this.isTestCancelled(testId)) {
      logger.info('[MOBILE-TEST] Test was cancelled before execution', {
        testId,
        browser,
        jobId: job.id,
        jobAttempts: job.attemptsMade,
      });
      try {
        webSocketService.emitTestCancelled(testId, {
          testId,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal — the test_status flip already happened upstream */ }
      return;
    }

    logger.info('[MOBILE-TEST] Processing mobile test job', {
      testId,
      browser,
      platform,
      stepsCount: intentSteps.length,
      appPackage,
    });
    logQueueEvent('processing', job.id!, { testId, browser });

    // Create client for this job
    const client = new MobileRunnerClient({
      baseUrl: runnerUrl,
      apiKey: runnerApiKey,
    });
    if (geminiApiKey) {
      client.setGeminiApiKey(geminiApiKey);
    }

    let sessionId: string | null = null;
    let sessionSource: 'pool' | 'warmup' | 'cold' = 'cold';

    try {
      // ── Track 5: Compile shared resources into setup steps ──
      // MUST run inside the main try block — otherwise a compile throw
      // skips the unified error handler below, leaving `test_executions`
      // stuck in 'pending' and regression runs never finalizing.
      //
      // Runs BEFORE any session acquisition so a `required: true` failure
      // doesn't waste an emulator boot. Decrypt + compile live inside the
      // worker process — Redis only ever sees `{kind, resource_id}`.
      if (resourceBindings && resourceBindings.length > 0) {
        const { ResourceStepCompilerService } = await import(
          '@/services/test-resource/resource-step-compiler.service'
        );
        const compileResult = await ResourceStepCompilerService.compileForMobile({
          bindings: resourceBindings as Parameters<
            typeof ResourceStepCompilerService.compileForMobile
          >[0]['bindings'],
          userId,
          projectId: projectId ?? '',
          platform,
        });

        // Prepend compiled setup steps. Type cast mirrors the one in
        // dispatchMobileTest — compiled steps use mobile-only action
        // types (network / geolocation / upload) not in the web
        // IntentActionType.
        if (compileResult.steps.length > 0) {
          intentSteps = [
            ...(compileResult.steps as unknown as typeof intentSteps),
            ...intentSteps,
          ] as typeof intentSteps;
        }

        // Pre-build audit snapshot (identical shape to web's AppliedBinding).
        executedResources = [
          ...compileResult.applied.map((a) => ({
            binding: a.binding,
            name: a.name,
            kind: a.kind,
            status_at_start: a.status_at_start,
            captured_at: a.captured_at,
            healed_during_run: a.healed_during_run,
            ...(a.apply_error ? { apply_error: a.apply_error } : {}),
          })),
          ...compileResult.skipped.map((s) => ({
            binding: s.binding,
            skipped_reason: s.reason,
          })),
        ];

        logger.info('[MOBILE-TEST] Resources compiled into setup', {
          testId,
          bindingsIn: resourceBindings.length,
          stepsOut: compileResult.steps.length,
          applied: compileResult.applied.length,
          skipped: compileResult.skipped.length,
        });
      }

      // ── Phase 1: Emit progress ────────────────────────────────
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 5,
          phase: 'initializing',
          currentStep: `Preparing ${platform} emulator...`,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // ── Phase 2: Update test status ───────────────────────────
      await this.updateTestStatus(testId, 'running', browser);

      // ── Phase 3: Acquire session — Pool → Warmup → Cold Start ─
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 10,
          phase: 'initializing',
          currentStep: `Starting ${platform} session...`,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Phase 6: Session acquisition can take up to ~60s on a cold start.
      // Progressively tell the frontend which fallback we're on so "Starting
      // mobile session…" doesn't feel like a freeze. Progress stays in the
      // 10-15% band — we're still in the initializing phase, not executing.
      const emitSessionPhase = (step: string, pct: number) => {
        try {
          webSocketService.emitTestProgress(testId, {
            testId,
            browser,
            progress: pct,
            phase: 'initializing',
            currentStep: step,
            status: 'running',
            timestamp: new Date().toISOString(),
            userId,
            sessionId: chatSessionId,
          });
        } catch { /* non-fatal */ }
      };

      // Try 1: Pool claim (runner pre-booted sessions, fastest path ~0-15s).
      // Pass `ownerId: userId` so the runner switches to this user's
      // dedicated Android multi-user — apps from other owners are hidden.
      try {
        const claimed = await client.claimSession(platform, { ownerId: userId });
        sessionId = claimed.sessionId;
        sessionSource = 'pool';
        logger.info('[MOBILE-TEST] Pool session claimed', { testId, sessionId, platform, ownerId: userId });
      } catch (poolErr) {
        // Pool exhausted, disabled, or runner unreachable — try next
        logger.debug('[MOBILE-TEST] Pool claim failed, trying warmup', {
          testId,
          error: poolErr instanceof Error ? poolErr.message : String(poolErr),
        });
      }

      // Try 2: Warmed session (editor eager start)
      if (!sessionId && projectId) {
        emitSessionPhase(`Checking warmed ${platform} session…`, 11);
        const warmed = await claimWarmedSession(projectId, userId);
        if (warmed && warmed.platform === platform) {
          sessionId = warmed.sessionId;
          sessionSource = 'warmup';
          logger.info('[MOBILE-TEST] Warmed session claimed', { testId, sessionId, platform });
        } else if (warmed && warmed.platform !== platform) {
          // Pre-fix this branch was silent — a warmup existed but for a
          // different platform (e.g. user warmed mobile_android in the
          // editor, then ran a mobile_ios regression). The cold-start
          // tax then applies anyway. Warn so operators can spot wasted
          // warmups and tune the editor's eager-start heuristics.
          logger.warn('[MOBILE-TEST] Warmed session discarded — platform mismatch', {
            testId,
            warmedSessionId: warmed.sessionId,
            warmedPlatform: warmed.platform,
            requestedPlatform: platform,
          });
        }
      }

      // Try 3: Cold start (fallback — creates new emulator/simulator ~60s)
      if (!sessionId) {
        // Explicit heads-up: cold starts can take up to a minute, so users
        // see "Booting emulator…" instead of a long silent pause after 10%.
        emitSessionPhase(`Booting ${platform} emulator (cold start, up to 60s)…`, 12);
        const session = await client.createSession(platform, { ownerId: userId });
        sessionId = session.sessionId;
        sessionSource = 'cold';
        logger.info('[MOBILE-TEST] Session created (cold start)', {
          testId,
          sessionId,
          platform,
          ownerId: userId,
        });
      }

      // ── Phase 3a: Apply project-level runtime-permission policy ────
      // Editor warmup applies this during the warmup HTTP handler, but
      // regression/CI runs reach the runner through this worker WITHOUT
      // going through warmup. Without this call the user's project-level
      // setting (auto_allow / auto_deny / manual) silently has no effect
      // on regression runs — they always got the runner's hard-coded
      // `auto_allow` default. Applying it after EVERY acquisition path
      // covers all three cases:
      //
      //   - 'pool'    : session was pre-booted by the runner with
      //                 default `auto_allow`; PATCH overrides it.
      //   - 'warmup'  : session already received the same PATCH during
      //                 the editor warmup → PATCH is a no-op (same value).
      //   - 'cold'    : brand-new session, default `auto_allow`; PATCH
      //                 overrides if the project picked something else.
      //
      // The helper is non-fatal end-to-end: if the project has no policy
      // stored, or the runner PATCH fails, we leave the session on the
      // runner default and continue — same behaviour the warmup path has.
      if (sessionId && projectId) {
        const { applyProjectPolicyToSession } = await import('@/services/mobile/permission-policy.service');
        const appliedPolicy = await applyProjectPolicyToSession({
          client,
          sessionId,
          projectId,
          userId,
          context: { testId, sessionSource, platform },
        });
        if (appliedPolicy) {
          logger.debug('[MOBILE-TEST] Permission policy applied', {
            testId,
            sessionId,
            sessionSource,
            policy: appliedPolicy,
          });
        }
      }

      // ── Phase 3b: Prepare app via shared MobileAppPrepService ──────
      // Single primitive shared with the editor warmup
      // (session.controller.ts:warmupSession). Three branches inside the
      // service:
      //   1. Cached fast-path (Redis hit + same APK) → pm clear + relaunch
      //   2. Device-check fast-path (Redis expired but APK on device) → same
      //   3. Full install (download → upload → install → launch)
      // All three end on a freshly-data-wiped, cold-launched app — the
      // worker no longer paying the full APK download+install cost on every
      // test when the editor just installed the same APK on the same
      // emulator. Sharing the primitive also means future warmup
      // improvements automatically benefit regression.
      //
      // NB: the worker resolves storagePath/originalName/packageName at
      // dispatch time (regression-run.service:dispatchMobileTest) and
      // passes them via job.data. The service supports overrides so it
      // uses the dispatch-time-resolved values, not whatever the project's
      // settings say RIGHT NOW (which could differ if a new APK was
      // uploaded since this regression run started).
      if (appStoragePath && projectId) {
        const emitInstallStep = (step: string, pct: number) => {
          try {
            webSocketService.emitTestProgress(testId, {
              testId,
              browser,
              progress: pct,
              phase: 'initializing',
              currentStep: step,
              status: 'running',
              timestamp: new Date().toISOString(),
              userId,
              sessionId: chatSessionId,
            });
          } catch { /* non-fatal */ }
        };

        if (!appPackage) {
          logger.warn('[MOBILE-TEST] Project has mobile app binary but no appPackage (package/bundle ID). Skipping install.', {
            testId,
            appStoragePath,
          });
        } else {
          logger.info('[MOBILE-TEST] Preparing app via MobileAppPrepService', {
            testId,
            appStoragePath,
            appPackage,
          });
          // Map the service's editor-flavoured progress stages to the
          // worker's existing 13-15-17% step ramp. Stage names are stable
          // across editor/worker; only the numeric progress and the human
          // string differ.
          await MobileAppPrepService.prepApp({
            client,
            sessionId,
            projectId,
            userId,
            appPackage,
            appStoragePathOverride: appStoragePath,
            appOriginalNameOverride: appOriginalName,
            onProgress: (stage, _progress) => {
              switch (stage) {
                case 'launching_browser':
                  emitInstallStep(`Preparing app on ${platform} runner…`, 13);
                  break;
                case 'loading_page':
                  emitInstallStep(`Downloading + installing app binary…`, 15);
                  break;
                case 'extracting_elements':
                  emitInstallStep(`Launching ${appPackage}…`, 17);
                  break;
                default:
                  break;
              }
            },
          });

          logger.info('[MOBILE-TEST] App prepared (installed + hard-reset + launched)', {
            testId,
            appPackage,
          });
        }
      }

      // ── Phase 4: Run steps ────────────────────────────────────
      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 20,
          phase: 'executing',
          currentStep: `Executing ${intentSteps.length} steps on ${platform}...`,
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Check cancellation before long operation. Throws so the outer
      // catch can emit the cancellation WS event uniformly with other
      // mid-job cancel detection points. Pre-fix this was a silent
      // return that updated the test status to 'cancelled' but emitted
      // no lifecycle event — frontend / analytics had to infer the
      // cancel landed by watching the next progress poll.
      if (await this.isTestCancelled(testId)) {
        throw new MobileTestCancelledError(testId, browser);
      }

      // Mid-run cancellation: poll `tests.status === 'cancelled'` every 2s
      // and propagate via AbortSignal to the outgoing fetch. Without this
      // a cancelRun issued AFTER runSteps starts only takes effect once
      // the runner finishes naturally (steps could still run for minutes).
      // The signal aborts the fetch → runner's req.on('close') fires →
      // step loop exits at the next boundary → session mutex released.
      const runStepsAbort = new AbortController();
      const cancelPollMs = 2_000;
      let cancelDetected = false;
      const cancelPoller = setInterval(async () => {
        try {
          if (await this.isTestCancelled(testId)) {
            cancelDetected = true;
            runStepsAbort.abort();
          }
        } catch { /* polling errors are non-fatal */ }
      }, cancelPollMs);
      // Don't keep the worker process alive just for this timer.
      cancelPoller.unref?.();

      let runResult: MobileRunStepsResponse;
      try {
        runResult = await client.runSteps(sessionId, intentSteps, {
          screenshotEachStep: true,
          metadata,
          signal: runStepsAbort.signal,
        });
      } catch (err) {
        clearInterval(cancelPoller);
        // If the abort came from our cancel poller, surface it as a
        // typed cancellation so the outer catch emits the right WS event
        // and updates `tests.status` correctly. Any other AbortError or
        // network failure bubbles up unchanged.
        if (cancelDetected) {
          throw new MobileTestCancelledError(testId, browser);
        }
        throw err;
      }
      clearInterval(cancelPoller);

      logger.info('[MOBILE-TEST] Steps executed', {
        testId,
        sessionId,
        totalSteps: runResult.totalSteps,
        passedSteps: runResult.passedSteps,
        failedSteps: runResult.failedSteps,
        skippedSteps: runResult.skippedSteps,
        status: runResult.status,
        durationMs: runResult.durationMs,
      });

      // ── Diagnostic: aborted/timed-out steps ──────────────────────────
      // The runner pushes per-step results with `error: 'Client aborted'`
      // or `'Run timed out'` when its `req.on('close')` handler fires
      // before the response is sent (HTTP socket dropped) or the 30-min
      // overall budget elapses. Both are runner-internal — neither is
      // surfaced via a structured field other than the error string.
      // Logging the count here makes it discoverable in production
      // telemetry without needing access to runner stdout.
      const abortedSteps = runResult.steps.filter(
        (s) => !s.success && (s.error === 'Client aborted' || s.error === 'Run timed out'),
      );
      if (abortedSteps.length > 0) {
        logger.warn('[MOBILE-TEST] Some steps did not execute (aborted or timed out)', {
          testId,
          sessionId,
          abortedCount: abortedSteps.length,
          totalSteps: runResult.totalSteps,
          firstAbortReason: abortedSteps[0]?.error,
          // Position of first aborted step gives a cheap hint about where
          // the connection dropped. Step 1 aborting = pre-execute-loop;
          // step N aborting = mid-run.
          firstAbortIndex: runResult.steps.findIndex(
            (s) => !s.success && (s.error === 'Client aborted' || s.error === 'Run timed out'),
          ),
        });
      }

      // ── Cross-validate runner aggregate vs per-step truth ─────────────
      // Defense in depth — the runner's `status` field SHOULD already
      // agree with per-step results (after the 2026-05-08 fix to
      // run.routes.ts that flips skip-style aborts/timeouts into
      // `failed++`). But if the runner ever ships with a regression of
      // that fix, the worker should catch it here and downgrade the
      // verdict so the regression doesn't show a false-green. We log
      // loudly when we have to override the runner.
      //
      // Optional steps: a step authored with `options.continueOnError: true`
      // is contractually allowed to fail without failing the test. The
      // runner correctly continues past such steps (see run.routes.ts:553)
      // BUT its aggregate `status` does not special-case them — they count
      // toward `failed` and flip the run to 'partial' / 'failed'. The
      // worker therefore computes its own verdict from per-step results
      // crossed with the original `intentSteps[].options.continueOnError`,
      // and treats the runner's `status` as advisory.
      //
      // `isAutoInjected` (auto-wait, recovery, etc.) is also tolerable —
      // mirrors run.routes.ts:553's `shouldContinue` rule.
      const tolerableFailureStepIds = new Set<string>();
      const knownStepIds = new Set<string>();
      for (const s of intentSteps) {
        knownStepIds.add(s.id);
        if (s.options?.continueOnError === true || s.isAutoInjected === true) {
          tolerableFailureStepIds.add(s.id);
        }
      }
      const isTolerableFailure = (stepId: string): boolean => {
        // Auto-injected steps the runner adds itself (not in our intentSteps)
        // are also tolerable — they're infrastructure helpers, not user steps.
        if (!knownStepIds.has(stepId)) return true;
        return tolerableFailureStepIds.has(stepId);
      };
      const realFailures = runResult.steps.filter(
        (s) => !s.success && !isTolerableFailure(s.stepId),
      );
      const optionalFailures = runResult.steps.filter(
        (s) => !s.success && isTolerableFailure(s.stepId),
      );
      const allStepsActuallyPassed = realFailures.length === 0;
      const runnerSaidPassed = runResult.status === 'passed';
      const aggregateMismatch = runnerSaidPassed && runResult.steps.some((s) => !s.success);
      if (aggregateMismatch) {
        logger.error('[MOBILE-TEST] Runner aggregate disagrees with per-step truth — downgrading', {
          testId,
          sessionId,
          runnerStatus: runResult.status,
          runnerPassedSteps: runResult.passedSteps,
          runnerFailedSteps: runResult.failedSteps,
          runnerSkippedSteps: runResult.skippedSteps,
          actualFailedCount: runResult.steps.filter((s) => !s.success).length,
        });
      }
      if (optionalFailures.length > 0) {
        logger.info('[MOBILE-TEST] Optional/auto-injected steps failed — not failing the test', {
          testId,
          sessionId,
          optionalFailedCount: optionalFailures.length,
          optionalFailedStepIds: optionalFailures.map((s) => s.stepId),
        });
      }

      // Emit step-level progress
      for (let i = 0; i < runResult.steps.length; i++) {
        const stepResult = runResult.steps[i];
        try {
          // Distinguish "real failure" (dispatch ran, action did not produce
          // expected outcome) from "skip-style failure" (runner could not
          // even convert the step — unsupported type, missing required
          // field) from "soft failure" (step is `options.continueOnError`
          // OR `isAutoInjected`, so its failure does NOT fail the test).
          // All three are `success: false`, but the UI should render them
          // differently:
          //   * `executed`    — green check
          //   * `skipped`     — gray "skipped (unsupported step)" badge
          //   * `soft-failed` — yellow/orange "skipped (optional)" badge
          //   * `failed`      — red, actionable
          // The runner signals skip-style via `resolvedVia: 'skipped'`
          // (see qait-mobile-runner run.routes.ts unsupported-step branch).
          // Soft-fail is detected here against the same tolerable-set the
          // verdict computation built earlier (line ~575) so per-step UI
          // semantics match the run-level verdict.
          const isSkipped = stepResult.resolvedVia === 'skipped';
          const isSoftFailure =
            !stepResult.success
            && !isSkipped
            && isTolerableFailure(stepResult.stepId);
          const runtimeStatus = stepResult.success
            ? 'executed'
            : isSkipped
              ? 'skipped'
              : isSoftFailure
                ? 'soft-failed'
                : 'failed';
          webSocketService.emitTestStepCompleted(testId, {
            testId,
            browser,
            step: i + 1,
            stepDescription: `Step: ${stepResult.stepId}`,
            // For soft-fails the per-step result remains `success: false`
            // (the action did fail), but the UI should not flag it as a
            // failure — `softFailure: true` on runtimeMeta is the signal
            // the frontend uses to flip badge style without re-deriving
            // tolerability rules client-side.
            success: stepResult.success,
            timestamp: new Date().toISOString(),
            runtimeMeta: {
              stepId: stepResult.stepId,
              runtimeStatus,
              executionMs: stepResult.durationMs,
              failedReason: stepResult.error ? 'unknown' : undefined,
              failureExplanation: stepResult.error,
              resolvedVia: stepResult.resolvedVia,
              // Soft-fail signal for the frontend. Absent (not `false`) for
              // hard failures and successes — keeps the field truthy-only
              // so existing renderers don't accidentally render a "soft"
              // badge for a hard fail.
              ...(isSoftFailure ? { softFailure: true } : {}),
              // Advisory warnings from the runner (e.g. install_app's
              // WebView-debuggable probe). Absent when the step had none —
              // do not emit an empty array, so the frontend can do a
              // truthy-check instead of length-check.
              ...(stepResult.warnings && stepResult.warnings.length > 0
                ? { warnings: stepResult.warnings }
                : {}),
            },
          });
        } catch { /* non-fatal */ }
      }

      // ── Phase 4.5: Auto-persist compiled plans from successful steps ─────
      // Mirror of web's preview-run.service.ts batch persist (calls
      // IntentTestCaseService.batchUpdateStepsFromRun). On mobile, until
      // this was added, compiled plans were only persisted on apply/heal —
      // so the first regression run of a freshly-authored test case hit the
      // LLM for every step. Now every successful run writes freshly-built
      // compiled plans back to steps_json, and subsequent runs short-circuit
      // via the runner's compiled-fast-path (~10ms/step).
      //
      // Non-fatal: a persist failure must not fail the run.
      // Mutex-safe: batchUpdateStepsFromRun takes withTestCaseMutex, so it
      // serializes against updateStepFromPreviewApply / updateStepAfterHeal
      // that fire from apply and in-run heal paths.
      await MobileTestRunJobHandler.persistCompiledPlansFromRun(
        intentTestCaseId,
        intentSteps,
        runResult,
      );

      // ── Phase 5: Create test result ───────────────────────────
      // testPassed = no MANDATORY step failed. Optional steps
      // (`options.continueOnError: true`) and runner-injected helper
      // steps (`isAutoInjected: true`) are contractually allowed to
      // fail without failing the test — see `realFailures` /
      // `tolerableFailureStepIds` above. The runner's aggregate
      // `runResult.status` is treated as advisory because it does not
      // special-case optional steps and would flip the test to failed
      // on any optional failure.
      const testPassed = allStepsActuallyPassed;

      try {
        webSocketService.emitTestProgress(testId, {
          testId,
          browser,
          progress: 80,
          phase: 'analyzing',
          currentStep: 'Processing results...',
          status: 'running',
          timestamp: new Date().toISOString(),
          userId,
          sessionId: chatSessionId,
        });
      } catch { /* non-fatal */ }

      // Finalize test status
      const finalStatus = testPassed ? 'completed' : 'failed';
      await this.updateTestStatus(testId, finalStatus, browser);

      // Create test result record
      const testResultId = await this.createTestResult(testId, browser, runResult, userId, workspaceId, testPassed);

      // ── Phase 5.5: Finalize analytics linkage ────────────────
      await MobileTestRunJobHandler.finalizeAnalyticsLinkage({
        analyticsExecutionId,
        intelligentSessionId,
        passed: testPassed,
        durationMs: runResult.durationMs,
        totalSteps: runResult.totalSteps,
        firstError: runResult.steps.find((s) => !s.success)?.error,
      });

      // ── Phase 5.6: Persist test_resources snapshot ───────────
      // Mirrors manual-test-run.job.ts:509-520. Non-fatal — the test
      // result is the source of truth, audit data just enriches it.
      await MobileTestRunJobHandler.persistExecutedResourcesSnapshot(
        testId,
        executedResources,
      );

      // ── Phase 6: Queue AI analysis ────────────────────────────
      if (testResultId) {
        try {
          await QueueManager.addAIAnalysisJob(testResultId, testId);
          logger.debug('[MOBILE-TEST] AI analysis job queued', { testId, testResultId });
        } catch (err) {
          logger.warn('[MOBILE-TEST] Failed to queue AI analysis', {
            testId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── Phase 7: Emit completion events ───────────────────────
      try {
        webSocketService.emitTestBrowserCompleted(testId, {
          testId,
          browser,
          status: testPassed ? 'completed' : 'failed',
          timestamp: new Date().toISOString(),
        });

        webSocketService.emitTestCompleted(testId, {
          testId,
          status: 'completed',
          totalBrowsers: 1,
          completedBrowsers: testPassed ? 1 : 0,
          failedBrowsers: testPassed ? 0 : 1,
          timestamp: new Date().toISOString(),
        });

        if (testResultId) {
          webSocketService.emitResultReady(testId, {
            testId,
            resultId: testResultId,
            browser,
            status: testPassed ? 'completed' : 'failed',
            timestamp: new Date().toISOString(),
          });
        }
      } catch { /* non-fatal */ }

      // ── Phase 8: CI run tracking ──────────────────────────────
      if (ciRunId) {
        try {
          await CiRunService.markTestComplete(ciRunId, testId, finalStatus);
          logger.debug('[MOBILE-TEST] CI run updated', { testId, ciRunId, status: finalStatus });
        } catch (err) {
          logger.warn('[MOBILE-TEST] Failed to update CI run', {
            testId,
            ciRunId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── Phase 9: Post-completion handler (regression tracking) ──
      try {
        const { TestCompletionHandlerService } = await import(
          '@/services/testing/results/test-completion-handler.service'
        );
        await TestCompletionHandlerService.handleTestCompletion(testId);
      } catch (completionError) {
        logger.warn('[MOBILE-TEST] Post-completion handler failed (non-fatal)', {
          testId,
          error: completionError instanceof Error ? completionError.message : String(completionError),
        });
      }

      logger.info('[MOBILE-TEST] Job completed successfully', {
        testId,
        browser,
        status: finalStatus,
        passRate: runResult.passRate,
      });
    } catch (error) {
      // ── Cancellation: separate codepath from real failure ──────────
      // A cancelled test is NOT a failure — the user explicitly stopped
      // it. Marking the test 'failed' would corrupt the regression run
      // statistics (counted as failed instead of cancelled). Emit the
      // lifecycle event and return without flipping any status.
      // Mirrors web's pattern at manual-test-run.job.ts:273-299.
      if (error instanceof MobileTestCancelledError) {
        logger.info('[MOBILE-TEST] Test cancelled mid-job', {
          testId,
          browser,
          jobId: job.id,
        });
        try {
          webSocketService.emitTestCancelled(testId, {
            testId,
            timestamp: new Date().toISOString(),
          });
        } catch { /* non-fatal */ }
        // tests.status was already set to 'cancelled' by the cancelRun
        // controller in qai-backend BEFORE this catch fired. Do NOT
        // call updateTestStatus here — the routes-through-IfNotCancelled
        // helper would correctly skip the write, but staying explicit
        // is clearer.
        return;
      }

      // ── Error handling ──────────────────────────────────────────
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof MobileRunnerError ? error.code : 'UNKNOWN';

      logger.error('[MOBILE-TEST] Job failed', {
        testId,
        browser,
        errorCode,
        error: errorMessage,
        retryCount,
        maxRetries: MAX_MOBILE_RETRIES,
      });

      // ── Retry gate ────────────────────────────────────────────────
      // If the error is retry-able AND we have budget, increment the
      // retry counter and re-throw so BullMQ re-queues the job. The
      // shared `shouldRetry` matches on ECONNREFUSED, ETIMEDOUT, 5xx
      // status codes, and 429 — the exact transient classes the mobile
      // runner-client surfaces (MobileRunnerError with statusCode >= 500
      // for runner 503s, network errors with `code` set).
      //
      // Mirrors the web pattern at manual-test-run.job.ts:322-329. The
      // effect is two-layer protection: the runner already retries
      // individual steps on stabilization errors; the worker now also
      // retries the WHOLE job on transient runner-level failures.
      // On retry, the next attempt re-claims a session (cold-start
      // costs ~30s) so MAX_MOBILE_RETRIES defaults to 1 to bound the
      // worst-case cost.
      const retryableError = error instanceof MobileRunnerError
        ? error.statusCode === undefined || error.statusCode === 0 || error.statusCode >= 500 || error.statusCode === 429
        : true;
      if (retryableError && shouldRetry(error, retryCount, MAX_MOBILE_RETRIES)) {
        const delay = calculateRetryDelay(retryCount);
        logger.info('[MOBILE-TEST] Retrying job', {
          testId,
          browser,
          delay,
          attempt: retryCount + 1,
          maxRetries: MAX_MOBILE_RETRIES,
        });
        try {
          await job.updateData({ ...job.data, retryCount: retryCount + 1 });
        } catch { /* non-fatal — counter increment failed but BullMQ retry still runs */ }
        // Re-throw triggers BullMQ retry (the queue is configured with
        // exponential backoff and finite attempts elsewhere in
        // QueueManager). Doing the rethrow BEFORE the failure-state DB
        // writes is important — those writes are for the FINAL failure
        // path, not transient retries.
        throw new Error(`Mobile test retry ${retryCount + 1}/${MAX_MOBILE_RETRIES}: ${errorMessage}`);
      }

      // Update test status to failed
      try {
        await this.updateTestStatus(testId, 'failed', browser);
      } catch { /* ignore */ }

      // Persist a job-level failure test_results row so the regression UI
      // can render an artifact-less but informative failure card. Mirrors
      // web's handleFailedTest at manual-test-run.job.ts:575-598. Best-
      // effort: failure to write does not propagate (the helper logs and
      // returns null). The id, when present, also feeds the AI analysis
      // enqueue below.
      const failedTestResultId = await MobileTestRunJobHandler.createFailedJobTestResult(
        testId,
        browser,
        error,
        userId,
        workspaceId,
      );

      // Same finalizer as the success path, different outcome.
      await MobileTestRunJobHandler.finalizeAnalyticsLinkage({
        analyticsExecutionId,
        intelligentSessionId,
        passed: false,
        errorMessage,
      });

      // Persist snapshot even on job-level failure (session couldn't
      // start, runner unreachable, etc.). Operators need to know which
      // resources were meant to be live so they can triage quickly.
      await MobileTestRunJobHandler.persistExecutedResourcesSnapshot(
        testId,
        executedResources,
      );

      // Enqueue AI analysis for failure too. Web does this at
      // manual-test-run.job.ts:628 — failures are the highest-value
      // signal for bug-detection / pattern matching, exactly the cases
      // where AI analysis should run. Pre-fix mobile only enqueued AI
      // on success, so failures got zero post-mortem analysis. Best-
      // effort: a queue failure should not propagate.
      if (failedTestResultId) {
        try {
          await QueueManager.addAIAnalysisJob(failedTestResultId, testId);
          logger.debug('[MOBILE-TEST] AI analysis enqueued for failed run', {
            testId,
            testResultId: failedTestResultId,
          });
        } catch (queueErr) {
          logger.warn('[MOBILE-TEST] Failed to enqueue AI analysis for failed run', {
            testId,
            testResultId: failedTestResultId,
            error: queueErr instanceof Error ? queueErr.message : String(queueErr),
          });
        }
      }

      // Emit failure event
      try {
        webSocketService.emitTestFailed(testId, {
          testId,
          browser,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        });
      } catch { /* non-fatal */ }

      // Post-completion handler on failure (regression tracking)
      try {
        const { TestCompletionHandlerService } = await import(
          '@/services/testing/results/test-completion-handler.service'
        );
        await TestCompletionHandlerService.handleTestCompletion(testId);
      } catch { /* non-fatal */ }

      // CI run tracking on failure
      if (ciRunId) {
        try {
          await CiRunService.markTestComplete(ciRunId, testId, 'failed');
        } catch { /* non-fatal */ }
      }

      throw error;
    } finally {
      // ── Cleanup: release pooled session or destroy adhoc/warmed ──
      if (sessionId) {
        try {
          if (sessionSource === 'pool') {
            await client.releaseSession(sessionId);
            logger.debug('[MOBILE-TEST] Pool session released', { testId, sessionId });
          } else {
            await client.destroySession(sessionId);
            logger.debug('[MOBILE-TEST] Session destroyed', { testId, sessionId, sessionSource });
          }
        } catch (err) {
          logger.warn('[MOBILE-TEST] Session cleanup failed (runner TTL will handle)', {
            testId,
            sessionId,
            sessionSource,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Decrement fair-priority pending counter for this user
      try {
        await QueueManager.decrementMobilePendingCount(userId);
      } catch { /* non-fatal — counter has TTL expiry as safety net */ }
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────

  /**
   * Persist freshly-built compiled plans from a completed run onto the
   * IntentTestCase.steps_json. Idempotent, non-fatal, mutex-safe.
   *
   * Persistence rules (revised):
   *   1. Step succeeded AND has a compiledPlan → persist (canonical case).
   *   2. Step FAILED but the resolve went through compiled_fast_path or
   *      cache → persist. Reason: those resolves only succeed when an
   *      already-validated plan still matches the current tree. The plan
   *      itself is not the cause of the failure (some downstream step in
   *      dispatch / VTE / app crash failed instead). Throwing the plan
   *      away here forces the next regression run to re-pay full LLM cost
   *      even though the plan is fine.
   *   3. Step failed and resolveVia was a fresh LLM/vision/thinking pass →
   *      do NOT persist. We don't know whether the LLM picked the right
   *      element or not, so we won't lock in a possibly-wrong plan.
   *
   * Original step fields (description, value, options, user-set
   * bindingHints) are preserved via spread; runner-emitted evidence is
   * attached under a `runtime` namespace to match the shape
   * MobileStepApplyService already writes for apply.
   */
  private static async persistCompiledPlansFromRun(
    intentTestCaseId: string | undefined,
    intentSteps: MobileIntentStep[],
    runResult: MobileRunStepsResponse,
  ): Promise<void> {
    if (!runResult?.steps?.length) return;
    // intentTestCaseId is the `intent_test_cases.id` (NOT `tests.id`).
    // The chat dispatch path doesn't populate it yet, in which case we
    // skip the persist — without the test-case PK there's nothing to
    // merge into. Regression and editor paths always pass it.
    if (!intentTestCaseId) {
      logger.debug('[MOBILE-TEST] Skipping compiled-plan persist — no intent_test_cases.id provided', {
        runStepsCount: runResult.steps.length,
      });
      return;
    }

    try {
      const originalById = new Map<string, MobileIntentStep>();
      for (const s of intentSteps) originalById.set(s.id, s);

      const enrichedSteps = new Map<string, IntentStep>();

      // resolvedVia values that mean "this plan was already proven against
      // the current tree before the run started". Safe to persist on failure
      // because the plan is independently validated.
      const PROVEN_RESOLVED_VIA = new Set<string>(['compiled', 'compiled_fast_path', 'cache']);

      for (const result of runResult.steps) {
        if (!result.compiledPlan) continue;
        // Runner can flag a plan as stale post-dispatch (VTE caught text in
        // wrong field, or foreground mismatch with no relaunch). Skip
        // persistence — the plan is "successful at dispatch level" but
        // points at the wrong element. Saving it locks in the bug.
        if (result.planStaleReason) {
          logger.debug('[MOBILE-TEST] Skipping plan persist — runner flagged stale', {
            stepId: result.stepId,
            reason: result.planStaleReason,
          });
          continue;
        }
        const planIsProven =
          result.resolvedVia !== undefined && PROVEN_RESOLVED_VIA.has(result.resolvedVia);
        if (!result.success && !planIsProven) continue;
        const original = originalById.get(result.stepId);
        if (!original) continue;

        // Start from the original step to preserve user-supplied fields
        // (description, value, options, assertionText, bindingHints, etc.),
        // then overlay runner-emitted artifacts. Cast is safe because
        // IntentStep is the structural superset used across web and mobile.
        const enriched: IntentStep = {
          ...(original as unknown as IntentStep),
          compiled: result.compiledPlan as unknown as IntentStep['compiled'],
        };

        if (result.evidence) {
          enriched.evidence = {
            ...(original as unknown as IntentStep).evidence,
            resolvedVia: result.resolvedVia,
            appliedAt: new Date().toISOString(),
            // Keep runner-collected logs/console/network errors under a
            // dedicated key so they don't collide with web StepEvidence fields.
            runtime: result.evidence,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any;
        }

        enrichedSteps.set(result.stepId, enriched);
      }

      if (enrichedSteps.size === 0) {
        logger.debug('[MOBILE-TEST] No compiled plans to persist', { intentTestCaseId });
        return;
      }

      const ok = await IntentTestCaseService.batchUpdateStepsFromRun({
        intentTestCaseId,
        enrichedSteps,
      });

      if (ok) {
        logger.info('[MOBILE-TEST] Persisted compiled plans from run', {
          intentTestCaseId,
          persistedCount: enrichedSteps.size,
          totalSteps: runResult.steps.length,
        });
      }
    } catch (error) {
      // Non-fatal: run already succeeded, test_results will still be created.
      logger.warn('[MOBILE-TEST] Failed to persist compiled plans (non-fatal)', {
        intentTestCaseId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static async updateTestStatus(
    testId: string,
    status: string,
    browser: string,
    startedAt?: string,
    completedAt?: string,
  ): Promise<void> {
    try {
      const updateData: Record<string, unknown> = { status };
      if (startedAt) updateData.started_at = startedAt;
      if (completedAt) updateData.completed_at = completedAt;
      if (status === 'running') updateData.started_at = new Date().toISOString();
      if (['completed', 'failed'].includes(status)) updateData.completed_at = new Date().toISOString();

      // Routes through `updateTestIfNotCancelled` so a cancellation that
      // landed between the worker's last `isTestCancelled` check and this
      // write doesn't get clobbered. Returns null when the row was
      // cancelled in the meantime; we re-check and bail gracefully so
      // the job doesn't accidentally re-emit a 'completed' / 'failed'
      // status onto a test the user has already cancelled. Mirrors the
      // web pattern at manual-test-run.job.ts:358-369.
      const updated = await dbAdminService.updateTestIfNotCancelled(testId, updateData);
      if (!updated && status !== 'cancelled') {
        if (await this.isTestCancelled(testId)) {
          logger.info('[MOBILE-TEST] Test is cancelled — skipping status update', {
            testId,
            status,
            browser,
          });
          return;
        }
      }
    } catch (error) {
      logger.error('[MOBILE-TEST] Failed to update test status', {
        testId,
        status,
        browser,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private static async createTestResult(
    testId: string,
    browser: string,
    runResult: MobileRunStepsResponse,
    userId: string,
    workspaceId: string,
    testPassed: boolean,
  ): Promise<string | null> {
    try {
      // Find last screenshot for the test result (prefer failed step, fallback to last step)
      const failedStepWithScreenshot = runResult.steps.find((s) => !s.success && s.screenshot);
      const lastStepWithScreenshot = [...runResult.steps].reverse().find((s) => s.screenshot);
      const resultScreenshot = failedStepWithScreenshot?.screenshot || lastStepWithScreenshot?.screenshot;

      // Map runner errors to the TestError[] format expected by AI analysis
      const errors = (runResult.errors || []).map((e) => ({
        type: e.type === 'app_crash' || e.type === 'anr' ? 'crash'
          : e.type === 'network_error' ? 'network'
          : e.type === 'js_exception' ? 'javascript'
          : e.type === 'assertion_failure' ? 'assertion'
          : 'other',
        message: e.message,
        timestamp: new Date(e.timestamp).toISOString(),
      }));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await dbAdminService.createMobileTestResult({
        test_id: testId,
        browser,
        // FIX: 'completed' not 'passed' — consistent with web tests and TestStatus type.
        // `testPassed` reflects the worker's verdict (real-failure aware:
        // optional / continueOnError / auto-injected steps are tolerable).
        // Was: `runResult.status === 'passed'`, which flipped to 'failed' on
        // any optional-step failure even though the test should pass.
        status: testPassed ? 'completed' : 'failed',
        screenshot: resultScreenshot,
        // Populate columns that were previously empty for mobile:
        errors: errors.length > 0 ? errors : [],
        logs: runResult.logs || [],
        network_logs: runResult.networkLogs || [],
        completed_at: new Date().toISOString(),
        duration: Math.round(runResult.durationMs / 1000),
        steps_total: runResult.totalSteps,
        steps_passed: runResult.passedSteps,
        steps_failed: runResult.failedSteps,
        pass_rate: runResult.passRate,
        user_id: userId,
        workspace_id: workspaceId,
        metadata: {
          platform: 'mobile',
          steps: runResult.steps.map((s) => ({
            stepId: s.stepId,
            success: s.success,
            error: s.error,
            screenshot: s.screenshot,
            durationMs: s.durationMs,
            resolvedVia: s.resolvedVia,
            evidence: s.evidence,
            errorClassification: s.errorClassification,
            bugReport: s.bugReport,
          })),
          bugReports: runResult.bugReports,
        },
      });

      return result?.id ?? null;
    } catch (error) {
      logger.error('[MOBILE-TEST] Failed to create test result', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create a minimal `test_results` row for the JOB-LEVEL failure path —
   * the runner was unreachable, the session creation failed, the APK
   * download threw, etc., so there's no `runResult` to persist from.
   *
   * Why this exists: pre-fix, mobile only called `createTestResult` on
   * the success path. A regression that failed before any steps ran
   * left `test_results` empty for that test, and the frontend's
   * regression-run drill-down had nothing to render — the user saw a
   * red "Failed" badge but couldn't click in to learn why. The web job
   * has solved this for years via `handleFailedTest`
   * (manual-test-run.job.ts:575-598).
   *
   * Best-effort: never throws. Returns the new row id (or null).
   */
  private static async createFailedJobTestResult(
    testId: string,
    browser: string,
    error: unknown,
    userId: string,
    workspaceId: string,
  ): Promise<string | null> {
    try {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof MobileRunnerError ? error.code : 'UNKNOWN';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: any = await dbAdminService.createMobileTestResult({
        test_id: testId,
        browser,
        status: 'failed',
        // No screenshot / dom / logs at this stage — the job didn't get
        // far enough to capture them. Provide a structured `errors` entry
        // so the regression-run-detail UI can show the failure reason.
        errors: [{
          type: 'job_failure',
          message: errorMessage,
          code: errorCode,
          timestamp: new Date().toISOString(),
        }],
        logs: [],
        network_logs: [],
        completed_at: new Date().toISOString(),
        duration: 0,
        steps_total: 0,
        steps_passed: 0,
        steps_failed: 0,
        pass_rate: 0,
        user_id: userId,
        workspace_id: workspaceId,
        metadata: {
          platform: 'mobile',
          // Marker so analytics / dashboards can distinguish job-level
          // failures (runner unreachable, install failed) from per-step
          // execution failures (tap missed, assertion mismatch).
          failureLayer: 'job',
          errorCode,
          errorMessage,
        },
      });
      return result?.id ?? null;
    } catch (createErr) {
      logger.error('[MOBILE-TEST] Failed to create failed-job test_result row', {
        testId,
        originalError: error instanceof Error ? error.message : String(error),
        createError: createErr instanceof Error ? createErr.message : String(createErr),
      });
      return null;
    }
  }

  /**
   * Finalize the pre-created analytics rows for this mobile run.
   *
   * Rows are created up front (chat handler, regression-run dispatch) in
   * 'running' state so the frontend sees a live row immediately. This
   * helper transitions them to terminal state when the run finishes.
   *
   * All three updates are best-effort: a failure here must not fail the
   * overall job — `test_results` is the authoritative record. Missing
   * ids are silently skipped so jobs without analytics wiring still work.
   *
   * Kept local to the mobile job because web's `TestCompletionHandler`
   * looks up executions via joins tuned for web and wouldn't match a
   * mobile row cleanly. An eventual shared finalizer can replace this.
   */
  private static async finalizeAnalyticsLinkage(params: {
    analyticsExecutionId?: string;
    intelligentSessionId?: string;
    passed: boolean;
    durationMs?: number;
    totalSteps?: number;
    firstError?: string;
    errorMessage?: string;
  }): Promise<void> {
    const {
      analyticsExecutionId,
      intelligentSessionId,
      passed,
      durationMs,
      totalSteps,
      firstError,
      errorMessage,
    } = params;

    // All three targets are independent — parallelize. allSettled so one
    // failure doesn't skip the others; per-branch try/catch logs locally.
    const tasks: Promise<unknown>[] = [];

    if (analyticsExecutionId) {
      tasks.push((async () => {
        try {
          await ExecutionService.updateStatus({
            id: analyticsExecutionId,
            status: passed ? 'passed' : 'failed',
            ...(durationMs !== undefined ? { durationMs } : {}),
            ...((firstError || errorMessage) ? { errorMessage: firstError || errorMessage } : {}),
          });
        } catch (err) {
          logger.warn('[MOBILE-TEST] Failed to finalize test_executions', {
            analyticsExecutionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })());
    }

    // Note: `regression_runs.status` is intentionally NOT finalized here.
    // Phase 9's `TestCompletionHandlerService.handleTestCompletion` reads
    // aggregated `test_executions` and updates the run with a correct
    // summary + emits the run-level WebSocket event + creates a user
    // notification. If we flipped `regression_runs.status` here first, the
    // optimistic-lock `.in('status', ['running','pending'])` in that
    // handler would no-op and the WS/notification would be lost.
    //
    // `analyticsRunId` is kept on MobileTestJobData so future code that
    // needs a pre-known run id (e.g. retry-backed failures that skip
    // Phase 9) can use it without re-querying.

    if (intelligentSessionId) {
      tasks.push((async () => {
        try {
          await supabaseAdmin
            .from('intelligent_test_sessions')
            .update({
              status: passed ? 'completed' : 'failed',
              success: passed,
              completed_at: new Date().toISOString(),
              ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
              // A mobile step is an "action"; there's no page-visit analogue,
              // so pages_visited stays at its default 0.
              ...(totalSteps !== undefined ? { actions_taken: totalSteps } : {}),
            })
            .eq('id', intelligentSessionId);
        } catch (err) {
          logger.warn('[MOBILE-TEST] Failed to finalize intelligent_test_sessions', {
            intelligentSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })());
    }

    await Promise.allSettled(tasks);
  }

  /**
   * Persist the compiled-at-dispatch resources snapshot onto every
   * matching `test_executions` row. Uses the same service method web
   * uses (`ExecutionService.persistExecutedResourcesByTestId`) so the
   * `executed_resources` column shape is platform-uniform and downstream
   * readers (UI, /bug-insights) don't branch on platform.
   *
   * Non-fatal — the test result is the source of truth, audit data just
   * enriches it. Missing / empty snapshot is a legitimate no-op (the case
   * had no resource_bindings). Wrapped in its own try so a failure here
   * can't mask a real test failure upstream.
   */
  private static async persistExecutedResourcesSnapshot(
    testId: string,
    snapshot?: Array<Record<string, unknown>>,
  ): Promise<void> {
    if (!snapshot || snapshot.length === 0) return;
    try {
      await ExecutionService.persistExecutedResourcesByTestId(testId, snapshot);
    } catch (err) {
      logger.warn('[MOBILE-TEST] Failed to persist executed_resources snapshot', {
        testId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
