import * as regressionDb from './db/regression.db';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { FlowService } from '@/services/testing/flows/flow.service';
import { logger } from '@/utils/core/logger';
import { dbAdminService } from '@/db/supabase';
import { IntelligentTestStorageService } from '../results/intelligent-test-storage.service';
import { QueueManager } from '@/config/infrastructure/queues';
import { buildMetadataFromTestCase } from '@/services/mobile/mobile-runner.types';
import type { FlutterHostPlatform, MobileTestJobData, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { normaliseHostOverride } from '@/services/mobile/project-mobile-app.helper';
import { resolveRunnerUrlForHost } from '@/services/mobile/mobile-runner-client';
import { sanitizeTriggers } from '@/services/mobile/trigger-validation.util';
import { env } from '@/config/environment/env';
import { isPaidUser } from '@/services/core/plan-access.service';
import { PAID_FEATURE_LABELS } from '@/config/features/feature-labels';
import { ValidationError } from '@/types';
import { v4 as uuidv4 } from 'uuid';
import { applyParameters } from '@/utils/testing/parameter-substitution.utils';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MOBILE TEST DISPATCHER SERVICE
 *
 * Extracted from RegressionRunService (Phase 1-B refactor).
 * Responsible for dispatching mobile test cases to the BullMQ mobile runner
 * queue — creating the `tests` DB record and queuing the `MobileTestJobData`.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export class MobileTestDispatcherService {
  /**
   * Dispatch a mobile test case to the mobile runner queue.
   * Mirrors the pattern from ci.controller.ts and preview.controller.ts.
   *
   * Creates a `tests` DB record + queues a `MobileTestJobData` job.
   * The existing test-completion-handler will track completion.
   */
  static async dispatchMobileTest(
    intentCase: any,
    userId: string,
    trigger: string,
    /**
     * Phase 5: optional git context from the caller (git-webhook → runPlan).
     * Undefined for manual / scheduled runs → resolver falls back to
     * legacy `projects.settings.mobileApp`.
     */
    triggerContext?: { branch?: string; commitSha?: string; buildId?: string; variantLabel?: string },
    /**
     * Phase 6: runtime parameters from the caller (e.g. `runPlan({ parameters })`).
     * Applied to `intentCase.steps_json` before stitching so placeholders in
     * step values, options, assertion text and binding hints resolve to
     * concrete values before the runner ever sees them. Missing / empty is
     * a no-op — byte-identical to pre-Phase-6 dispatch.
     */
    parameters?: Record<string, any>,
    /**
     * `test_executions.id` the caller pre-created via `createBatch`. The
     * mobile job flips it to passed/failed on completion. Undefined for
     * single-case manual dispatch (no batch) — the job skips the update.
     */
    analyticsExecutionId?: string,
    /**
     * When launched from chat, the chat session id so the mobile job streams
     * progress + result into the chat panel (room `chat:<sessionId>`).
     * Undefined for plan / scheduled / CI runs.
     */
    chatSessionId?: string,
    /**
     * V-cross-app continuation (see `MobileTestJobData` for the full
     * rationale): lets a segmented `link_test_case` regression run resume
     * an existing live session for the "steps" segment after a cross-
     * platform link, instead of acquiring + prepping a new one (which
     * force-stops/relaunches the app and loses any typed-but-unsubmitted
     * UI state from before the link). Only set by
     * `RegressionRunService.dispatchFirstSegmentAndDetachRest` — every
     * other caller omits it and gets the pre-existing fresh-dispatch
     * behaviour unchanged.
     */
    continuation?: {
      resumeSessionId?: string;
      resumeSessionSource?: MobileTestJobData['resumeSessionSource'];
      keepSessionAlive?: boolean;
    },
    /**
     * Chain-view: the outer `regression_runs.id` this segment belongs to, so
     * its `tests` row can be queried back alongside its sibling segments.
     * Only set by the single-test-case dispatch path (`RegressionRunService.
     * dispatchStepsSegment` and `LinkedTestCaseRunnerService.run`) — bulk
     * plan/module/flow/priority dispatches omit it and get `NULL`, matching
     * today's behaviour (those runs already group via `test_ids`).
     */
    runId?: string,
  ): Promise<{ testId: string; jobId: string; appBuildId: string | null }> {
    // 0. Plan gate — mobile testing is a Pro feature. This is the single choke
    // point for every mobile dispatch path (single-case run, plan/module
    // orchestrator, CI), so free users can't queue mobile jobs from any route.
    if (!(await isPaidUser(userId))) {
      throw new ValidationError(`${PAID_FEATURE_LABELS.MOBILE_TESTING} is available on paid plans. Upgrade to run mobile tests.`);
    }

    // 1. Resolve platform and browser
    const PLATFORM_MAP: Record<string, MobilePlatform> = {
      mobile_ios: 'ios',
      mobile_flutter: 'flutter',
    };
    let platform: MobilePlatform = PLATFORM_MAP[intentCase.platform] ?? 'android';

    // Self-correct stale platform: a test case saved before the
    // detectedFramework-aware save (or saved while the runner reported the
    // host platform) can be `mobile_android` for what is actually a Flutter
    // app. Running it as `android` skips attach-flutter and leaves element
    // resolution blind. If the project's app is detected as Flutter, upgrade
    // an android-typed case to flutter here. Never downgrade — an explicit
    // ios/flutter label wins. Read failure is non-fatal (keep stored value).
    if (platform === 'android') {
      const framework = await MobileAppStorageService.getDetectedFramework(
        intentCase.project_id,
      ).catch(() => undefined);
      if (framework === 'flutter') {
        logger.warn('[MOBILE-DISPATCH] Upgrading android→flutter from detectedFramework', {
          testCaseId: intentCase.id,
          projectId: intentCase.project_id,
          storedPlatform: intentCase.platform,
        });
        platform = 'flutter';
      }
    }

    const browser: 'mobile-android' | 'mobile-ios' | 'mobile-flutter' =
      platform === 'ios' ? 'mobile-ios'
      : platform === 'flutter' ? 'mobile-flutter'
      : 'mobile-android';

    // 1b. Host lane for a Flutter run (ADR-0019 deferred half): which OS the
    // worker acquires, which artifact shard resolves, which runner routes.
    // Precedence: test-case override > project default > 'android'.
    const hostPlatform: FlutterHostPlatform | undefined =
      platform === 'flutter'
        ? (normaliseHostOverride(intentCase.host_platform) ??
            (await MobileAppStorageService.getProjectDefaultFlutterHost(intentCase.project_id)))
        : undefined;
    // Mirror prepApp's resolve rule exactly: 'ios' ONLY for an ios-host
    // Flutter run; android-host Flutter keeps 'flutter' so the resolver's
    // legacy fallback chain is preserved byte-for-byte.
    const artifactResolvePlatform: MobilePlatform =
      platform === 'flutter' && hostPlatform === 'ios' ? 'ios' : platform;
    if (hostPlatform) {
      logger.debug('[MOBILE-DISPATCH] resolved flutter host lane', {
        testCaseId: intentCase.id,
        hostPlatform,
        source: normaliseHostOverride(intentCase.host_platform) ? 'test' : 'project-default',
      });
    }

    // 2. Fetch project workspace (needed for MobileTestJobData; the APK
    // itself comes from the resolver below, not from project settings).
    // workspaceId is REQUIRED for a mobile run — it keys billing, telemetry,
    // and dedicated-emulator routing. After the workspace backfill +
    // projects.workspace_id NOT NULL migration this can only be null for a
    // genuinely broken project, so fail loudly instead of persisting a '' key
    // (an empty workspaceId silently breaks workspace-scoped lookups
    // downstream).
    const workspaceId = await regressionDb.getProjectWorkspaceId(intentCase.project_id);
    if (!workspaceId) {
      throw new Error(
        `Cannot dispatch mobile test: project ${intentCase.project_id} has no workspace assigned`,
      );
    }

    // Effective variant lane, by precedence:
    //   test-case override > flow override > plan variant > project
    //   default-variant pointer > 'default'. Each lower tier is consulted only
    //   when the higher ones are unset (avoids extra reads on the common path).
    const testVariant = typeof intentCase.mobile_variant_label === 'string' && intentCase.mobile_variant_label.trim()
      ? intentCase.mobile_variant_label.trim()
      : undefined;
    let flowVariant: string | undefined;
    if (!testVariant && intentCase.flow_id) {
      flowVariant = (await FlowService.getMobileVariantLabel(intentCase.flow_id)) ?? undefined;
    }
    let variantLabel = testVariant ?? flowVariant ?? triggerContext?.variantLabel;
    let variantSource = testVariant ? 'test' : flowVariant ? 'flow' : (triggerContext?.variantLabel ? 'plan' : 'project-default');
    if (!variantLabel) {
      variantLabel = await MobileAppStorageService.getProjectDefaultVariant(intentCase.project_id, artifactResolvePlatform);
      variantSource = 'project-default';
    }
    if (variantLabel) {
      logger.debug('[MOBILE-DISPATCH] resolved variant lane', {
        testCaseId: intentCase.id,
        variantLabel,
        source: variantSource,
      });
    }

    // Phase 5: resolve which APK to install. Precedence inside the resolver:
    //   buildId pin > commitSha > branch > latest-in-variant > legacy.
    // Returns null only when the project has NEVER had an APK uploaded —
    // `appStoragePath` stays undefined and the mobile job handler runs
    // steps without installing anything (pre-Phase-5 behaviour for empty
    // projects). The resolver output shape is identical to the legacy
    // `MobileAppMetadata`, so downstream code is unchanged.
    const resolvedBuild = await MobileAppStorageService.resolveAppForRun({
      projectId: intentCase.project_id,
      // Host-aware for Flutter: an ios-host run reads the `ios` shard (the
      // simulator `.app`); android-host keeps the `flutter` platform intact.
      platform: artifactResolvePlatform,
      buildId: triggerContext?.buildId,
      branch: triggerContext?.branch,
      commitSha: triggerContext?.commitSha,
      variantLabel,
    });

    // 3. Extract intent steps from steps_json via the shared IntentStep
    // normaliser (single source of truth for which fields survive the
    // JSONB round-trip — see intent-step-dispatch.service.ts).
    //
    // Phase B (May 2026) — stitchPhases removed: setup_steps/teardown_steps
    // were a never-used column duplicate, always empty in production. No
    // work to do here beyond normalisation.
    //
    // Original code (preserved for Phase C rollback context):
    //   const { stitchPhases, normaliseIntentStep } = await import('./intent-step-dispatch.service');
    //   const rawMainSteps = (intentCase.steps_json || []).map((step: any, index: number) =>
    //     normaliseIntentStep(step, index),
    //   );
    //   const { steps: stitchedSteps, counts: phaseCounts, didStitch } =
    //     stitchPhases(rawMainSteps, intentCase);
    const { normaliseIntentStep } = await import('./intent-step-dispatch.service');
    const stitchedSteps = (intentCase.steps_json || []).map((step: any, index: number) =>
      normaliseIntentStep(step, index),
    );

    // Phase 6: apply plan-level parameters to the steps. Walks every string
    // leaf recursively so placeholders in options, bindingHints, etc.
    // resolve too — not just top-level `value`. No-op when `parameters`
    // is empty, preserving pre-Phase-6 behaviour bit-for-bit.
    const intentSteps = applyParameters(stitchedSteps, parameters ?? {});

    if (intentSteps.length === 0) {
      throw new ValidationError(
        `Mobile test case "${intentCase.name}" has no steps (steps_json is empty)`,
      );
    }

    // 3b. Shared resources (Login / Environment / Secret / ...) — Option A.
    //
    // SECURITY: Compilation + decryption happens in the WORKER
    // (mobile-test-run.job.ts), NOT here. The dispatcher puts only
    // `{kind, resource_id, required?}` into the BullMQ payload so
    // plaintext secrets never land in Redis (which is typically
    // unencrypted-at-rest and has long job history retention).
    //
    // What we DO run here: a lightweight DB-only preflight that loads
    // `id, name, status, scope` (no decrypt!) for every `required: true`
    // binding. If any required binding is missing or broken we throw
    // BEFORE `createTest`, keeping the abort clean (no DB detritus, no
    // UI "failed" row). Platform mismatch is intentionally not a fatal
    // preflight error — the compiler soft-skips with a loud warning.
    const rawBindings = Array.isArray(intentCase.resource_bindings)
      ? (intentCase.resource_bindings as Array<{
          kind: string;
          resource_id: string;
          required?: boolean;
        }>)
      : [];
    if (rawBindings.length > 0) {
      const { validateBindingsPreflight } = await import(
        '@/services/test-resource/test-resource.service'
      );
      const pre = await validateBindingsPreflight(
        rawBindings as Parameters<typeof validateBindingsPreflight>[0],
        userId,
        platform,
      );
      if (!pre.ok) {
        // Fail-fast BEFORE createTest. Every failure is a `required: true`
        // binding that can't possibly be applied — pretending to run the
        // test would just waste emulator time and produce a confusing
        // "tap login failed" error.
        const summary = pre.reasons
          .map((r) => `${r.resourceId}: ${r.reason}`)
          .slice(0, 5)
          .join('; ');
        throw new ValidationError(
          `Mobile test case "${intentCase.name}" has failed resource preflight: ${summary}`,
        );
      }
    }

    // 3c. User-defined triggers (event→action rules) — echoed from the test
    // case verbatim into the job. Sanitize (not throw): a stale/legacy row
    // shouldn't crash a run; only well-formed triggers are forwarded. The
    // worker hands them to the runner in the run-steps body.
    const triggers = sanitizeTriggers(intentCase.triggers);

    // 4. Create test record in DB (same pattern as ci.controller.ts)
    const testId = uuidv4();
    await dbAdminService.createTest({
      id: testId,
      url: `mobile://${platform}`,
      project_id: intentCase.project_id,
      user_id: userId,
      status: 'pending',
      regression_run_id: runId ?? null,
      browsers: [browser as any],
      options: {
        mode: 'lite',
        platform,
        // Flutter host lane (android|ios) the run actually targeted. Surfaced on
        // the run report ("FLUTTER · iOS" badge). Only for flutter — native
        // platforms already encode their host in `platform`.
        ...(hostPlatform ? { hostPlatform } : {}),
        trigger,
        // Chain view: mirrors the web dispatch path's `options.metadata`
        // shape (see WebTestRequestBuilderService.buildTestRequest / test-
        // creator.ts) so the report assembler can read a test case's name
        // the same way regardless of which platform ran it.
        metadata: { intentTestCaseId: intentCase.id, intentTestCaseName: intentCase.name },
        appPackage: resolvedBuild?.packageName,
        // Preserve which APK actually ran for this test — helps when
        // debugging "test failed on prod build vs. on PR branch", and
        // survives `pruneOldBuilds` because it lives on `tests.options`
        // (which is never pruned), not on `mobile_app_builds`.
        ...(resolvedBuild?.versionName ? { appVersionName: resolvedBuild.versionName } : {}),
        ...(typeof resolvedBuild?.versionCode === 'number'
          ? { appVersionCode: resolvedBuild.versionCode }
          : {}),
        ...(resolvedBuild?.branch ? { appBranch: resolvedBuild.branch } : {}),
        ...(resolvedBuild?.commitSha ? { appCommitSha: resolvedBuild.commitSha } : {}),
        ...(resolvedBuild?.buildNumber ? { appBuildNumber: resolvedBuild.buildNumber } : {}),
        ...(resolvedBuild?.id && resolvedBuild.id !== 'legacy-settings'
          ? { appBuildId: resolvedBuild.id }
          : {}),
      },
      intelligent_mode: false,
      test_goal: `Regression: ${intentCase.name} (${platform})`,
      commands: [],
    });

    // 4b. FK anchor for mobile bug findings (/bug-insights). Without this,
    // ai-analysis.extractBugPatterns early-returns on "no session" and
    // mobile runs never contribute to the Patterns tab.
    const intelligentSessionId = await IntelligentTestStorageService.createSessionAnchor({
      testId,
      userId,
      projectId: intentCase.project_id,
      goal: `Regression: ${intentCase.name} (${platform})`,
      startUrl: resolvedBuild?.packageName || `mobile://${platform}`,
      browser,
    });

    // 5. Build and queue mobile job.
    // NOTE on the cast: `stitchPhases` returns web-flavoured IntentStep[]
    // (its action types are a superset of MobileIntentActionType — e.g.
    // 'dblclick' exists on web but not mobile). The runner rejects unknown
    // action types at dispatch, so an unsupported type authored into a
    // mobile setup_steps/teardown_steps buffer surfaces as a runtime error
    // at the runner — which is the right place for that check. At the
    // TypeScript boundary we just unblock the assignment.
    const jobData: MobileTestJobData = {
      testId,
      userId,
      workspaceId,
      projectId: intentCase.project_id,
      // Routes WS progress/result to chat:<sessionId> when launched from chat.
      ...(chatSessionId ? { chatSessionId } : {}),
      platform,
      // Host lane rides the job so the worker acquires the right pool and
      // prepApp resolves the right shard. Absent for non-flutter platforms.
      ...(hostPlatform ? { hostPlatform } : {}),
      browser,
      intentSteps: intentSteps as unknown as MobileTestJobData['intentSteps'],
      runnerUrl: resolveRunnerUrlForHost(hostPlatform),
      runnerApiKey: env.MOBILE_RUNNER_API_KEY,
      appStoragePath: resolvedBuild?.storagePath,
      appOriginalName: resolvedBuild?.originalName,
      appPackage: resolvedBuild?.packageName,
      // Fast-auth: pass the real versionCode if the uploader supplied one;
      // fall back to CI buildNumber for projects that haven't migrated to
      // explicit version capture yet. The compiler's snapshot gate uses
      // this to invalidate captures taken against an older app build —
      // when both are absent the gate degrades to TTL + runtime-failure
      // invalidation, which is acceptable.
      ...(typeof resolvedBuild?.versionCode === 'number'
        ? { appVersionCode: resolvedBuild.versionCode }
        : typeof resolvedBuild?.buildNumber === 'number'
          ? { appVersionCode: resolvedBuild.buildNumber }
          : {}),
      // Human-readable version string for runner logs / display.
      // Not used in any gating decision — versionCode above is what
      // actually drives fast-auth invalidation.
      ...(resolvedBuild?.versionName
        ? { appVersionName: resolvedBuild.versionName }
        : {}),
      testCaseId: intentCase.id,
      testCaseName: intentCase.name,
      metadata: buildMetadataFromTestCase(intentCase),
      // Regression-plan runs own their own run-level status — pass only
      // the execution id, never analyticsRunId, to avoid double-finalizing.
      analyticsExecutionId,
      intelligentSessionId,
      // SECURITY: only the raw reference is threaded through Redis. The
      // worker calls ResourceStepCompilerService.compileForMobile on its
      // own — decrypts, prepends setup steps, builds the audit snapshot.
      // Secrets therefore never appear in BullMQ job data.
      ...(rawBindings.length > 0 ? { resourceBindings: rawBindings } : {}),
      // User-defined triggers (no secrets — pure event→action rules). Only
      // attached when non-empty so no-trigger jobs are byte-identical to
      // pre-trigger dispatch.
      ...(triggers.length > 0 ? { triggers } : {}),
      // V-cross-app continuation — see the param doc above. Omitted entirely
      // for every non-continuation caller, so this is byte-identical to
      // pre-continuation dispatch unless explicitly requested.
      ...(continuation?.resumeSessionId ? { resumeSessionId: continuation.resumeSessionId } : {}),
      ...(continuation?.resumeSessionSource ? { resumeSessionSource: continuation.resumeSessionSource } : {}),
      ...(continuation?.keepSessionAlive ? { keepSessionAlive: true } : {}),
    };

    await QueueManager.addMobileTestRunJob(jobData);

    // BullMQ job id format mirrors QueueManager.addMobileTestRunJob:
    //   `${testId}-${browser}`  (see queues.ts:717)
    // Caller uses this to wait for `queue.completed` in the regression
    // concurrency gate so Test N+1 doesn't dispatch before Test N's
    // session destroy is finished on the runner side.
    const jobId = `${testId}-${browser}`;

    logger.info('[REGRESSION_RUN] Mobile test dispatched', {
      testId,
      jobId,
      platform,
      testCaseId: intentCase.id,
      testCaseName: intentCase.name,
      stepsCount: intentSteps.length,
      resourceBindingsCount: rawBindings.length,
      triggersCount: triggers.length,
      // Phase 5: which build ran, for operator debugging.
      appBuildId: resolvedBuild?.id,
      appBranch: resolvedBuild?.branch,
      appCommitSha: resolvedBuild?.commitSha,
      appSource: resolvedBuild?.source,
    });

    // appBuildId is null when:
    //   - resolveAppForRun returned the legacy-settings shim (id === 'legacy-settings')
    //   - the project has never had a build (resolvedBuild === null)
    // Callers use this to populate `test_executions.mobile_app_build_id`
    // so historical runs keep their hard pointer to the binary even after
    // pruning removes the row from `mobile_app_builds`.
    const appBuildId = resolvedBuild?.id && resolvedBuild.id !== 'legacy-settings'
      ? resolvedBuild.id
      : null;

    return { testId, jobId, appBuildId };
  }
}
