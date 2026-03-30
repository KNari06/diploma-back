/**
 * Exploration Run Job Handler
 * BullMQ job that runs autonomous site exploration in a worker process.
 */

import type { Job } from 'bullmq';
import type { ExplorationJobData } from '@/config/infrastructure/queues';
import { ExplorationEngine } from '@/agent/core/lite/exploration/exploration-engine';
import type { ExplorationConfig, ExplorationResult } from '@/agent/core/lite/exploration/types';
import { DEFAULT_EXPLORATION_BUDGET } from '@/agent/core/lite/exploration/types';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';

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
      budget,
      maxConcurrency,
      rateLimiting,
    } = job.data;

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

      // Launch dedicated browser for exploration (with anti-detection args matching browser-pool)
      const { chromium } = await import('playwright');
      browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-blink-features=AutomationControlled',
          '--disable-features=IsolateOrigins,site-per-process',
          '--disable-site-isolation-trials',
          '--window-size=1920,1080',
        ],
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
