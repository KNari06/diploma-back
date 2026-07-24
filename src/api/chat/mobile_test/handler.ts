/**
 * Mobile Test Handler
 * Chat intent handler for mobile (Android/iOS) test execution.
 *
 * Flow:
 *   1. Feature flag + health check
 *   2. Credit check
 *   3. Redis lock (1 test per chat session)
 *   4. Create test record (browsers: ['mobile-android'])
 *   5. Queue BullMQ job → mobile runner
 *   6. Return response with runnerSocketUrl for live preview
 *
 * Pattern mirrors: src/api/chat/ai_test/handler.ts
 */

import { redisConnection, QueueManager } from '@/config/infrastructure/queues';
import { env } from '@/config/environment/env';
import { dbAdminService, supabaseAdmin } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { getFlutterDefaultHost, getProjectMobileApp } from '@/services/mobile/project-mobile-app.helper';
import { resolveRunnerUrlForHost } from '@/services/mobile/mobile-runner-client';
import type { MobilePlatform, MobileIntentStep, MobileTestJobData } from '@/services/mobile/mobile-runner.types';
import { toMobilePlatformKey } from '@/services/mobile/mobile-runner.types';
import { AnalyticsQueryService } from '@/services/analytics/analytics-query.service';
import { IntelligentTestStorageService } from '@/services/testing/results/intelligent-test-storage.service';
import { TestChatMappingService } from '@/services/testing/shared/test-chat-mapping.service';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';

// ═══════════════════════════════════════════════════════════════════════════
// REDIS LOCK HELPER
// ═══════════════════════════════════════════════════════════════════════════

const MOBILE_TEST_LOCK_PREFIX = 'lock:mobile_test_start:';
const MOBILE_TEST_LOCK_TTL = 10;

async function acquireLock(chatSessionId: string): Promise<boolean> {
  try {
    const result = await redisConnection.set(
      `${MOBILE_TEST_LOCK_PREFIX}${chatSessionId}`,
      '1',
      'EX',
      MOBILE_TEST_LOCK_TTL,
      'NX',
    );
    return result === 'OK';
  } catch {
    return false;
  }
}

async function releaseLock(chatSessionId: string): Promise<void> {
  try {
    await redisConnection.del(`${MOBILE_TEST_LOCK_PREFIX}${chatSessionId}`);
  } catch {
    // best-effort
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ANALYTICS ANCHOR
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create the `regression_runs` + `test_executions` pair that anchors this
 * chat-triggered mobile test in the analytics stack. Sibling of the inline
 * block in `src/api/chat/ai_test/handler.ts` (web). Both handlers should
 * eventually share a single service; for now they mirror each other.
 *
 * Best-effort: returns blank ids on failure. Caller skips the cache
 * invalidation and lets the job finish without analytics visibility.
 */
async function createChatAnalyticsAnchor(params: {
  projectId: string;
  userId: string;
  testId: string;
  browser: string;
  platform: string;
}): Promise<{ analyticsRunId?: string; analyticsExecutionId?: string }> {
  try {
    const { data: run, error: runErr } = await supabaseAdmin
      .from('regression_runs')
      .insert({
        project_id: params.projectId,
        user_id: params.userId,
        trigger: 'chat',
        status: 'running',
        started_at: new Date().toISOString(),
        test_id: params.testId,
      })
      .select('id')
      .single();

    if (runErr || !run) {
      logger.warn('[MOBILE_TEST] Failed to create analytics regression_run', {
        error: runErr?.message,
        testId: params.testId,
      });
      return {};
    }

    const { data: exec, error: execErr } = await supabaseAdmin
      .from('test_executions')
      .insert({
        run_id: run.id,
        test_type: 'ui',
        test_case_id: null,
        status: 'running',
        started_at: new Date().toISOString(),
        browser: params.browser,
        platform: params.platform,
        result: { testId: params.testId, type: 'mobile', trigger: 'chat' },
      })
      .select('id')
      .single();

    if (execErr || !exec) {
      logger.warn('[MOBILE_TEST] Failed to create analytics test_execution', {
        error: execErr?.message,
        runId: run.id,
        testId: params.testId,
      });
      return { analyticsRunId: run.id };
    }

    return { analyticsRunId: run.id, analyticsExecutionId: exec.id };
  } catch (err) {
    logger.warn('[MOBILE_TEST] Analytics anchor creation threw (non-fatal)', {
      error: err instanceof Error ? err.message : String(err),
      testId: params.testId,
    });
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HANDLER
// ═══════════════════════════════════════════════════════════════════════════

export async function handleMobileTest(
  _req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    abortSignal?: AbortSignal;
    mode?: 'lite' | 'pro' | 'editor';
  },
): Promise<void> {
  const {
    message,
    parsedIntent,
    userId,
    workspace_id,
    chatSessionId,
  } = params;

  let lockAcquired = false;

  try {
    // ── Step 0: Feature flag ──────────────────────────────────────
    if (!env.MOBILE_RUNNER_ENABLED) {
      logger.info('[MOBILE_TEST] Mobile testing is disabled (feature flag)', { userId });
      res.json({
        success: false,
        reply: '📱 Mobile testing is not enabled yet. Please contact support to enable it for your workspace.',
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ── Step 1: Health check ──────────────────────────────────────
    const client = getMobileRunnerClient();
    const healthy = await client.isHealthy();

    if (!healthy) {
      logger.warn('[MOBILE_TEST] Runner is not healthy', { userId });
      res.json({
        success: false,
        reply: '📱 Mobile runner is currently unavailable. Please try again later or ensure the emulator is running.',
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ── Step 2: Credit check ──────────────────────────────────────
    // Gate on effectiveAvailable (balance + grace), not raw balance, so a
    // grace-funded user is not wrongly rejected (matches the per-step path).
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
    if (creditCheck.effectiveAvailable < 3) {
      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        code: 'INSUFFICIENT_CREDITS',
        message: `❌ Insufficient credits. Mobile tests cost 3 credits, but you have ${creditCheck.available}.`,
        creditsRequired: 3,
        creditsAvailable: creditCheck.available,
        details: { required: 3, available: creditCheck.available },
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ── Step 3: Redis lock ────────────────────────────────────────
    if (chatSessionId) {
      lockAcquired = await acquireLock(chatSessionId);
      if (!lockAcquired) {
        if (!res.headersSent) {
          res.status(409).json({
            success: false,
            error: 'CONCURRENT_REQUEST',
            message: 'Another mobile test request is already being processed. Please wait.',
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }
    }

    // ── Step 4: Extract test parameters ───────────────────────────
    const platform: MobilePlatform = parsedIntent?.mobilePlatform || 'android';
    const BROWSER_MAP: Record<MobilePlatform, 'mobile-android' | 'mobile-ios' | 'mobile-flutter'> = {
      android: 'mobile-android',
      ios: 'mobile-ios',
      flutter: 'mobile-flutter',
    };
    const browser = BROWSER_MAP[platform] ?? 'mobile-android';
    const intentSteps: MobileIntentStep[] = parsedIntent?.intentSteps || [];

    if (intentSteps.length === 0) {
      if (lockAcquired && chatSessionId) {
        await releaseLock(chatSessionId);
      }
      res.json({
        success: false,
        reply: '📱 No test steps provided. Please record steps in the editor first, then run the mobile test.',
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // ── Step 5: Resolve project + app metadata and create test ────
    const testId = uuidv4();
    const testGoal = parsedIntent?.target
      ? `Mobile test: ${parsedIntent.target} (${platform})`
      : `Mobile test on ${platform} (${intentSteps.length} steps)`;

    // Resolve project ID once so we can reuse it
    const projectId = parsedIntent?.projectId || workspace_id;

    // Project-level mobile app metadata (APK/IPA stored in Supabase)
    let appStoragePath: string | undefined;
    let appOriginalName: string | undefined;
    let projectAppPackage: string | undefined;
    // Host lane for an ad-hoc Flutter chat run: no test-case override exists
    // here, so the project default decides (android when unset).
    let hostPlatform: 'android' | 'ios' | undefined;

    try {
      const project = (await dbAdminService.getProject(projectId)) as any;
      if (platform === 'flutter') {
        hostPlatform = getFlutterDefaultHost(project?.settings);
      }
      // Read the platform-sharded slot so a dual-platform project doesn't
      // accidentally install the wrong-platform binary. `platform` is
      // resolved above (line ~228) from the parsed intent. An ios-host
      // Flutter run reads the `ios` slot (simulator .app) — prepApp's rule.
      const appSlotPlatform = platform === 'flutter' && hostPlatform === 'ios' ? 'ios' : platform;
      const mobileApp = getProjectMobileApp(project?.settings, appSlotPlatform);
      if (mobileApp?.storagePath) {
        appStoragePath = mobileApp.storagePath;
        appOriginalName = mobileApp.originalName;
        projectAppPackage = mobileApp.packageName;
        logger.info('[MOBILE_TEST] Found project mobile app', {
          testId,
          platform,
          appStoragePath,
          appOriginalName,
          projectAppPackage,
        });
      }
    } catch (err) {
      logger.warn('[MOBILE_TEST] Failed to lookup project app (will skip install)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Prefer explicit appPackage from intent, fall back to project-level packageName
    const appPackage: string | undefined = parsedIntent?.appPackage || projectAppPackage;

    try {
      await dbAdminService.createTest({
        id: testId,
        url: appPackage || `mobile://${platform}`,
        project_id: projectId,
        user_id: userId,
        status: 'pending',
        browsers: [browser as any],
        options: {
          mode: 'lite',
          platform,
          appPackage,
        },
        intelligent_mode: false,
        test_goal: testGoal,
        commands: [],
      });

      logger.info('[MOBILE_TEST] Test record created', {
        testId,
        browser,
        platform,
        stepsCount: intentSteps.length,
      });
    } catch (err) {
      logger.error('[MOBILE_TEST] Failed to create test record', {
        error: err instanceof Error ? err.message : String(err),
        userId,
      });
      throw new Error('Failed to create mobile test record');
    }

    // ── Step 6: Save test-chat mapping ────────────────────────────
    if (chatSessionId) {
      try {
        await TestChatMappingService.saveTestChatMapping({
          testId,
          chatSessionId,
          userId,
          metadata: { trigger: 'chat' },
        });
      } catch (err) {
        logger.warn('[MOBILE_TEST] Failed to save test-chat mapping', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // ── Step 6.5: Create analytics + bug-insights linkage ─────────
    // Chat-triggered mobile tests bypass regression-run.service, so they
    // need their own regression_runs + test_executions rows (analytics)
    // and an intelligent_test_sessions anchor (bug-insights). All three
    // are best-effort — a failure must not block the run from queueing.
    //
    // The analytics chain (run→execution, FK-dependent) runs in parallel
    // with the independent session-anchor insert to keep hot-path p50
    // under two sequential round-trips instead of three.
    const mobilePlatformKey = toMobilePlatformKey(platform);

    const [analyticsIds, intelligentSessionId] = await Promise.all([
      createChatAnalyticsAnchor({
        projectId,
        userId,
        testId,
        browser,
        platform: mobilePlatformKey,
      }),
      IntelligentTestStorageService.createSessionAnchor({
        testId,
        userId,
        projectId,
        goal: testGoal,
        startUrl: appPackage || `mobile://${platform}`,
        browser,
      }),
    ]);
    const { analyticsRunId, analyticsExecutionId } = analyticsIds;

    // Invalidate cached analytics so the new run is visible immediately
    // instead of waiting up to ANALYTICS_CACHE_TTL for the entry to expire.
    if (analyticsRunId) {
      AnalyticsQueryService.invalidateWorkspaceCaches(workspace_id);
    }

    // ── Step 7: Queue BullMQ job ──────────────────────────────────
    const jobData: MobileTestJobData = {
      testId,
      userId,
      workspaceId: workspace_id,
      projectId,
      chatSessionId,
      platform,
      ...(hostPlatform ? { hostPlatform } : {}),
      browser: browser as 'mobile-android' | 'mobile-ios' | 'mobile-flutter',
      appPackage,
      intentSteps,
      geminiApiKey: parsedIntent?.geminiApiKey,
      runnerUrl: resolveRunnerUrlForHost(hostPlatform),
      runnerApiKey: env.MOBILE_RUNNER_API_KEY,
      appStoragePath,
      appOriginalName,
      // Analytics parity: job finalizes the execution row + session on completion
      analyticsRunId,
      analyticsExecutionId,
      intelligentSessionId,
    };

    await QueueManager.addMobileTestRunJob(jobData);

    logger.info('[MOBILE_TEST] Job queued', { testId, browser });

    // ── Step 8: Emit WebSocket ────────────────────────────────────
    try {
      webSocketService.emitTestProgress(testId, {
        testId,
        browser,
        progress: 0,
        phase: 'queued',
        currentStep: `Mobile test queued (${platform})`,
        status: 'pending',
        timestamp: new Date().toISOString(),
        userId,
        sessionId: chatSessionId,
      });
    } catch { /* non-fatal */ }

    // ── Step 9: Release lock ──────────────────────────────────────
    if (lockAcquired && chatSessionId) {
      await releaseLock(chatSessionId);
      lockAcquired = false;
    }

    // ── Step 10: Respond ──────────────────────────────────────────
    const runnerSocketUrl = env.MOBILE_RUNNER_URL;

    const replyMessage =
      `📱 **Mobile Test Started!**\n\n` +
      `Platform: **${platform === 'android' ? 'Android' : 'iOS'}**\n` +
      `Steps: **${intentSteps.length}**\n` +
      (appPackage ? `App: **${appPackage}**\n` : '') +
      `\nWatch the progress below. The emulator preview is available in real-time.\n\n` +
      `📊 Test ID: \`${testId}\``;

    res.json({
      success: true,
      reply: replyMessage,
      testId,
      browser,
      platform,
      mode: 'lite',
      testStarted: true,
      runnerSocketUrl,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });

    logger.info('[MOBILE_TEST] Handler completed successfully', {
      testId,
      browser,
      platform,
      userId,
    });
  } catch (error) {
    // Release lock on error
    if (lockAcquired && chatSessionId) {
      await releaseLock(chatSessionId);
    }

    if (res.headersSent) {
      logger.warn('[MOBILE_TEST] Response already sent', {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    logger.error('[MOBILE_TEST] Handler error', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      userId,
    });

    res.status(500).json({
      success: false,
      error: 'Failed to start mobile test',
      message: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}
