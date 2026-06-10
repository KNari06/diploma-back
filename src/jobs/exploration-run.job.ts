/**
 * Exploration Run Job Handler
 * BullMQ job that runs autonomous site exploration in a worker process.
 */

import type { Job } from 'bullmq';
import type { ExplorationJobData } from '@/config/infrastructure/queues';
import { ExplorationEngine } from '@/agent/core/lite/exploration/exploration-engine';
import type { ExplorationConfig, ExplorationResult } from '@/agent/core/lite/exploration/types';
import { DEFAULT_EXPLORATION_BUDGET } from '@/agent/core/lite/exploration/types';
import { validateAuthFixture, isAuthFixtureNonEmpty } from '@/agent/core/lite/exploration/auth-fixture';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatService } from '@/services/utils/chat.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { EXPLORATION_DISCOVERY_CREDITS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';

// Rough USD cost recorded alongside the discovery credit deduction (~2-min
// browser + LLM survey). Credits are the single source of truth for billing;
// this is for cost analytics only. The credit amount itself lives in
// intelligent-test-limits.ts so the /start gate and this charge stay in sync.
const EXPLORATION_DISCOVERY_COST_USD = 0.01;

export class ExplorationRunJobHandler {
  static async process(job: Job<ExplorationJobData>): Promise<void> {
    const {
      explorationId,
      entryUrl,
      projectId,
      userId,
      chatSessionId,
      workspaceId,
      scopeHint,
      credentials,
      authFixture: rawAuthFixture,
      budget,
      maxConcurrency,
      rateLimiting,
    } = job.data;

    // Validate the optional auth fixture before handing it to Playwright.
    // An invalid fixture is downgraded (not fatal) — we log + emit a
    // progress warning and fall back to the credentials-based login flow.
    let validatedAuthFixture: ExplorationConfig['authFixture'];
    if (rawAuthFixture !== undefined && rawAuthFixture !== null) {
      const result = validateAuthFixture(rawAuthFixture);
      if (!result.valid) {
        logger.warn('[EXPLORATION_JOB] Invalid auth fixture — ignoring, will use credentials login path', {
          explorationId,
          errors: result.errors,
        });
      } else if (result.fixture && isAuthFixtureNonEmpty(result.fixture)) {
        validatedAuthFixture = result.fixture;
        logger.info('[EXPLORATION_JOB] Auth fixture accepted', {
          explorationId,
          cookies: result.fixture.cookies.length,
          origins: result.fixture.origins.length,
        });
      } else {
        logger.info('[EXPLORATION_JOB] Auth fixture was syntactically valid but empty — ignoring', {
          explorationId,
        });
      }
    }

    logger.info('[EXPLORATION_JOB] Starting exploration', {
      explorationId,
      entryUrl,
      projectId,
      userId,
    });

    // Check for existing checkpoint (resume after crash)
    const existingCheckpoint = await ExplorationStorageService.loadCheckpoint(explorationId);
    const isResume = !!existingCheckpoint;

    if (!isResume) {
      // Create DB record only for fresh runs
      const runRecord = await ExplorationStorageService.createRun({
        explorationId,
        projectId,
        userId,
        chatSessionId,
        entryUrl,
        config: { scopeHint, maxConcurrency, budget },
      });
      if (!runRecord) {
        throw new Error(`Failed to create exploration run record for ${explorationId}`);
      }
    }

    let browser;
    try {
      // If resuming, check resume count limit
      if (isResume) {
        const resumeCount = await ExplorationStorageService.incrementResumeCount(explorationId);
        if (resumeCount > 3) {
          logger.error('[EXPLORATION_JOB] Max resume attempts exceeded', { explorationId, resumeCount });
          await ExplorationStorageService.failRun(explorationId, 'Max resume attempts exceeded');
          webSocketService.emitExplorationCompleted({
            explorationId,
            testCasesCount: 0,
            summary: {},
            status: 'failed',
            errorMessage: 'Max resume attempts exceeded',
            timestamp: new Date().toISOString(),
            chatSessionId,
            userId,
          });
          return;
        }
        logger.info('[EXPLORATION_JOB] Resuming from checkpoint', { explorationId, resumeCount });
      }

      // Launch dedicated browser for exploration
      const { chromium } = await import('playwright');
      const { BROWSER_LAUNCH_ARGS, BROWSER_HEADLESS_MODE } = await import('@/config/testing/playwright-tuning');
      browser = await chromium.launch({
        headless: BROWSER_HEADLESS_MODE,
        args: [...BROWSER_LAUNCH_ARGS],
      });

      // Build exploration config
      const explorationConfig: ExplorationConfig = {
        entryUrl: entryUrl.trim(),
        explorationId,
        projectId,
        userId,
        chatSessionId,
        workspaceId,
        scopeHint,
        credentials: credentials || undefined,
        authFixture: validatedAuthFixture,
        budget: { ...DEFAULT_EXPLORATION_BUDGET, ...budget },
        maxConcurrency: maxConcurrency || 2, // Default 2 to avoid OpenAI TPM rate limits
        rateLimiting,
        onProgress: (event) => {
          webSocketService.emitExplorationProgress({
            explorationId,
            phase: event.phase,
            event: event.event,
            progressPercent: event.progressPercent,
            data: event.data,
            timestamp: new Date().toISOString(),
            chatSessionId,
            userId,
            budgetMs: explorationConfig.budget?.totalTimeoutMs,
          });
        },
      };

      // Run exploration (resume from checkpoint or fresh start)
      let result: ExplorationResult;
      if (isResume && existingCheckpoint) {
        result = await ExplorationEngine.resumeFromCheckpoint(browser, explorationConfig, existingCheckpoint);
      } else {
        const engine = new ExplorationEngine(browser, explorationConfig);
        result = await engine.run();
      }

      // Save test cases to DB
      const savedIds = await ExplorationStorageService.saveTestCases(
        result.testCases,
        projectId,
        userId,
      );

      // Mark run as completed
      await ExplorationStorageService.completeRun(explorationId, result);

      // Charge the fixed discovery cost once, on success. Best-effort: a
      // failed deduction must never fail the exploration the user already
      // received (mirrors the telemetry-write invariant).
      try {
        await CreditCostTrackerService.deductCreditsForTest({
          userId,
          testType: 'intelligent',
          credits: EXPLORATION_DISCOVERY_CREDITS,
          costUSD: EXPLORATION_DISCOVERY_COST_USD,
          testId: explorationId,
          description: `Exploration discovery — ${entryUrl}`,
        });
      } catch (creditError) {
        logger.warn('[EXPLORATION_JOB] Discovery credit deduction failed (non-critical)', {
          explorationId,
          userId,
          error: creditError instanceof Error ? creditError.message : String(creditError),
        });
      }

      // Save chat messages
      if (chatSessionId) {
        const summary = result.summary;
        const replyMessage =
          `**Exploration Complete**\n\n` +
          `Explored **${entryUrl}** autonomously.\n\n` +
          `**Results:**\n` +
          `- Pages surveyed: ${summary.pagesSurveyed}\n` +
          `- Entry points discovered: ${summary.entryPointsDiscovered}\n` +
          `- Flows explored: ${summary.flowsExplored}\n` +
          `- Passed: ${summary.flowsPassed} | Failed: ${summary.flowsFailed} | Blocked: ${summary.flowsBlocked}\n` +
          `- Test cases generated: ${result.testCases.length}\n` +
          `- Total steps discovered: ${summary.totalStepsDiscovered}\n` +
          `- Duration: ${Math.round(result.durationMs / 1000)}s\n\n` +
          `Exploration ID: \`${explorationId}\``;

        ChatService.saveChatMessages(chatSessionId, [
          {
            role: 'ai',
            content: replyMessage,
            metadata: {
              explorationId,
              mode: 'exploration',
              url: entryUrl,
              testCasesCount: result.testCases.length,
              savedTestCaseIds: savedIds,
            },
          },
        ]).catch(() => {});
      }

      // Emit completion
      webSocketService.emitExplorationCompleted({
        explorationId,
        testCasesCount: result.testCases.length,
        summary: result.summary as any,
        status: 'completed',
        timestamp: new Date().toISOString(),
        chatSessionId,
        userId,
      });

      logger.info('[EXPLORATION_JOB] Exploration completed', {
        explorationId,
        testCases: result.testCases.length,
        savedIds: savedIds.length,
        duration: result.durationMs,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error('[EXPLORATION_JOB] Exploration failed', {
        explorationId,
        error: errorMessage,
        stack: error instanceof Error ? error.stack : undefined,
      });

      // Mark run as failed
      await ExplorationStorageService.failRun(explorationId, errorMessage);

      // Emit failure
      webSocketService.emitExplorationCompleted({
        explorationId,
        testCasesCount: 0,
        summary: {},
        status: 'failed',
        errorMessage,
        timestamp: new Date().toISOString(),
        chatSessionId,
        userId,
      });

      throw error;
    } finally {
      if (browser) {
        await browser.close().catch((err) => {
          logger.warn('[EXPLORATION_JOB] Failed to close browser', {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    }
  }
}
