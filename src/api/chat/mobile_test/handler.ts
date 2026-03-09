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
import { dbAdminService } from '@/db/supabase';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import type { MobilePlatform, MobileIntentStep, MobileTestJobData } from '@/services/mobile/mobile-runner.types';
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
    const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, 'intelligent');
    if (creditCheck.available < 3) {
      res.status(402).json({
        success: false,
        error: 'Insufficient credits',
        message: `❌ Insufficient credits. Mobile tests cost 3 credits, but you have ${creditCheck.available}.`,
        creditsRequired: 3,
        creditsAvailable: creditCheck.available,
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
    const browser = platform === 'ios' ? 'mobile-ios' : 'mobile-android';
    const appPackage: string | undefined = parsedIntent?.appPackage;
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

    // ── Step 5: Create test record ────────────────────────────────
    const testId = uuidv4();
    const testGoal = parsedIntent?.target
      ? `Mobile test: ${parsedIntent.target} (${platform})`
      : `Mobile test on ${platform} (${intentSteps.length} steps)`;

    try {
      await dbAdminService.createTest({
        id: testId,
        url: appPackage || `mobile://${platform}`,
        project_id: parsedIntent?.projectId || workspace_id,
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

    // ── Step 6b: Lookup project's mobile app (APK/IPA) ────────────
    let appStoragePath: string | undefined;
    let appOriginalName: string | undefined;
    const projectId = parsedIntent?.projectId || workspace_id;

    try {
      const project = (await dbAdminService.getProject(projectId)) as any;
      const mobileApp = project?.settings?.mobileApp;
      if (mobileApp?.storagePath) {
        appStoragePath = mobileApp.storagePath;
        appOriginalName = mobileApp.originalName;
        logger.info('[MOBILE_TEST] Found project APK', {
          testId,
          appStoragePath,
          appOriginalName,
        });
      }
    } catch (err) {
      logger.warn('[MOBILE_TEST] Failed to lookup project app (will skip install)', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Step 7: Queue BullMQ job ──────────────────────────────────
    const jobData: MobileTestJobData = {
      testId,
      userId,
      workspaceId: workspace_id,
      projectId,
      chatSessionId,
      platform,
      browser: browser as 'mobile-android' | 'mobile-ios',
      appPackage,
      intentSteps,
      geminiApiKey: parsedIntent?.geminiApiKey,
      runnerUrl: env.MOBILE_RUNNER_URL,
      runnerApiKey: env.MOBILE_RUNNER_API_KEY,
      appStoragePath,
      appOriginalName,
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
