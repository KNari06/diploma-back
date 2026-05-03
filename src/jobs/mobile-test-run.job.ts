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
import { webSocketService } from '@/websocket/core/websocket.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { CiRunService } from '@/services/mobile/ci-run.service';
import { Job } from 'bullmq';
import type { MobileTestJobData, MobileRunStepsResponse, MobileIntentStep } from '@/services/mobile/mobile-runner.types';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { IntentTestCaseService } from '@/services/testing/ui/preview/intent-test-case.service';
import { MobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { MobileRunnerError } from '@/services/mobile/mobile-runner.types';
import { claimWarmedSession } from '@/api/mobile/session.controller';

// ============================================================================
// JOB HANDLER
// ============================================================================

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
    } = job.data;

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

    // Guard: skip if already finalized
    if (await this.isTestFinalized(testId)) {
      logger.info('[MOBILE-TEST] Test already finalized, skipping', { testId, browser });
      return;
    }

    // Guard: skip if cancelled
    if (await this.isTestCancelled(testId)) {
      logger.info('[MOBILE-TEST] Test was cancelled before execution', { testId, browser });
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

      // Try 1: Pool claim (runner pre-booted sessions, fastest path ~0-15s)
      try {
        const claimed = await client.claimSession(platform);
        sessionId = claimed.sessionId;
        sessionSource = 'pool';
        logger.info('[MOBILE-TEST] Pool session claimed', { testId, sessionId, platform });
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
        }
      }

      // Try 3: Cold start (fallback — creates new emulator/simulator ~60s)
      if (!sessionId) {
        // Explicit heads-up: cold starts can take up to a minute, so users
        // see "Booting emulator…" instead of a long silent pause after 10%.
        emitSessionPhase(`Booting ${platform} emulator (cold start, up to 60s)…`, 12);
        const session = await client.createSession(platform);
        sessionId = session.sessionId;
        sessionSource = 'cold';
        logger.info('[MOBILE-TEST] Session created (cold start)', {
          testId,
          sessionId,
          platform,
        });
      }

      // ── Phase 3b: Install app (if project has APK/IPA) ───────
      if (appStoragePath) {
        // Phase 6: APK install has three distinct sub-steps that each
        // can take several seconds on a large binary. We surface all three
        // so the progress bar moves through 13 → 15 → 17% while the job
        // works — the pre-Phase-6 single 15% emit made a ~30s operation
        // look like a freeze.
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

        logger.info('[MOBILE-TEST] Downloading app from storage', {
          testId,
          appStoragePath,
          appOriginalName,
        });
        if (!appPackage) {
          logger.warn('[MOBILE-TEST] Project has mobile app binary but no appPackage (package/bundle ID). Skipping install.', {
            testId,
            appStoragePath,
          });
        } else {
          // (1) Download APK from Supabase Storage
          emitInstallStep(`Downloading app binary…`, 13);
          const appBuffer = await MobileAppStorageService.downloadApp(appStoragePath);

          // (2) Upload APK to runner
          emitInstallStep(`Uploading app to ${platform} runner…`, 15);
          const uploadResult = await client.uploadApp(
            appBuffer,
            appOriginalName || 'app.apk',
          );

          logger.info('[MOBILE-TEST] App uploaded to runner, installing', {
            testId,
            runnerPath: uploadResult.path,
            size: uploadResult.size,
          });

          // (3) Install + launch on the emulator/simulator
          emitInstallStep(`Installing ${appPackage}…`, 17);

          // Install + launch the app on the emulator/simulator via low-level commands
          await client.executeBatchCommands(sessionId, [
            {
              type: 'install_app',
              params: {
                apkPath: uploadResult.path,
                reinstall: true,
              },
            },
            {
              type: 'launch_app',
              params: {
                packageName: appPackage,
                clearData: true,
              },
            },
          ]);

          logger.info('[MOBILE-TEST] App installed and launched', {
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

      // Check cancellation before long operation
      if (await this.isTestCancelled(testId)) {
        logger.info('[MOBILE-TEST] Test cancelled before step execution', { testId });
        await this.updateTestStatus(testId, 'cancelled', browser);
        return;
      }

      const runResult = await client.runSteps(sessionId, intentSteps, {
        screenshotEachStep: true,
        metadata,
      });

      logger.info('[MOBILE-TEST] Steps executed', {
        testId,
        sessionId,
        totalSteps: runResult.totalSteps,
        passedSteps: runResult.passedSteps,
        failedSteps: runResult.failedSteps,
        status: runResult.status,
        durationMs: runResult.durationMs,
      });

      // Emit step-level progress
      for (let i = 0; i < runResult.steps.length; i++) {
        const stepResult = runResult.steps[i];
        try {
          webSocketService.emitTestStepCompleted(testId, {
            testId,
            browser,
            step: i + 1,
            stepDescription: `Step: ${stepResult.stepId}`,
            success: stepResult.success,
            timestamp: new Date().toISOString(),
            runtimeMeta: {
              stepId: stepResult.stepId,
              runtimeStatus: stepResult.success ? 'executed' : 'failed',
              executionMs: stepResult.durationMs,
              failedReason: stepResult.error ? 'unknown' : undefined,
              failureExplanation: stepResult.error,
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
        testId,
        intentSteps,
        runResult,
      );

      // ── Phase 5: Create test result ───────────────────────────
      const testPassed = runResult.status === 'passed';

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
      const testResultId = await this.createTestResult(testId, browser, runResult, userId, workspaceId);

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
      // ── Error handling ──────────────────────────────────────────
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorCode = error instanceof MobileRunnerError ? error.code : 'UNKNOWN';

      logger.error('[MOBILE-TEST] Job failed', {
        testId,
        browser,
        errorCode,
        error: errorMessage,
      });

      // Update test status to failed
      try {
        await this.updateTestStatus(testId, 'failed', browser);
      } catch { /* ignore */ }

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
    testId: string,
    intentSteps: MobileIntentStep[],
    runResult: MobileRunStepsResponse,
  ): Promise<void> {
    if (!testId || !runResult?.steps?.length) return;

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
        logger.debug('[MOBILE-TEST] No compiled plans to persist', { testId });
        return;
      }

      const ok = await IntentTestCaseService.batchUpdateStepsFromRun({
        intentTestCaseId: testId,
        enrichedSteps,
      });

      if (ok) {
        logger.info('[MOBILE-TEST] Persisted compiled plans from run', {
          testId,
          persistedCount: enrichedSteps.size,
          totalSteps: runResult.steps.length,
        });
      }
    } catch (error) {
      // Non-fatal: run already succeeded, test_results will still be created.
      logger.warn('[MOBILE-TEST] Failed to persist compiled plans (non-fatal)', {
        testId,
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

      await dbAdminService.updateTest(testId, updateData);
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
      const result: any = await dbAdminService.createTestResult({
        test_id: testId,
        browser,
        // FIX: 'completed' not 'passed' — consistent with web tests and TestStatus type
        status: runResult.status === 'passed' ? 'completed' : 'failed',
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
