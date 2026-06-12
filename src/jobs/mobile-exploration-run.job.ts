/**
 * Mobile Exploration Run Job (Stage 3, Slice 3).
 *
 * Backend-brokered counterpart to exploration-run.job.ts. Instead of
 * launching Playwright in-process, it drives the mobile runner:
 *
 *   1. Record the run (status=running) — config carries the mobile fields
 *      (platform / appId / runner session) so it shows in the same history
 *      list as web runs, with no schema migration.
 *   2. Start the exploration on the already-warmed runner session (the
 *      runner API key is injected server-side by MobileRunnerClient).
 *   3. Hold a relay for the run's lifetime: it forwards the runner's
 *      exploration:progress/completed onto the backend's own Socket.IO so
 *      the browser never touches the runner. The job awaits the relay's
 *      terminal outcome.
 *   4. Persist completion / failure, post a chat summary.
 *
 * The job OWNS the relay (decision: job holds it until completion), so a
 * worker slot is occupied for the whole crawl — acceptable, and gives us
 * natural completion ordering for persistence.
 */

import type { Job } from 'bullmq';
import type { MobileExplorationJobData } from '@/config/infrastructure/queues';
import { getMobileRunnerClient } from '@/services/mobile/mobile-runner-client';
import { MobileExplorationRelay } from '@/services/mobile/mobile-exploration-relay';
import { ExplorationStorageService } from '@/services/testing/exploration/exploration-storage.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';

export class MobileExplorationRunJobHandler {
  static async process(job: Job<MobileExplorationJobData>): Promise<void> {
    const {
      explorationId,
      runnerSessionId,
      runnerSocketUrl,
      appId,
      platform,
      projectId,
      userId,
      chatSessionId,
      goal,
      budget,
    } = job.data;

    const startedAt = Date.now();

    // 1. Record the run. Mobile fields ride in `config` (no migration) and
    //    `entry_url` carries the app id so the history row has a label.
    const runRecord = await ExplorationStorageService.createRun({
      explorationId,
      projectId,
      userId,
      chatSessionId,
      entryUrl: appId,
      config: { surface: 'mobile', platform, appId, runnerSessionId, goal, budget },
    });
    if (!runRecord) {
      throw new Error(`Failed to create mobile exploration run record for ${explorationId}`);
    }

    const client = getMobileRunnerClient();
    let relay: MobileExplorationRelay | null = null;

    try {
      // 2. Start the run on the runner (key injected server-side).
      const started = await client.startExploration(
        runnerSessionId,
        { appId, goal, budget },
        { userId },
      );
      // The runner mints its own runId; the relay subscribes to THAT, but
      // the frontend keys off our explorationId. Bridge them: emit under
      // explorationId by overriding it in the relay's forwarded payloads.
      // (The relay stamps explorationId from params.runId, so we pass our
      // explorationId as the subscribe target only when they match; here
      // they differ, so we forward the runner runId for subscription but
      // re-label to explorationId.) See relay note below.
      const runnerRunId = started.runId;

      // 3. Hold the relay for the run's lifetime.
      relay = new MobileExplorationRelay({
        runnerSocketUrl,
        runId: runnerRunId,
        explorationId, // re-label forwarded events to our id (frontend keys off this)
        chatSessionId,
        userId,
        budgetMs: budget?.totalTimeoutMs,
      });
      relay.start();

      const outcome = await relay.waitUntilDone();

      // 4a. Persist + summarise.
      if (outcome.status === 'completed') {
        // The runner's completion envelope carries no test-case count and
        // no cases — fetch the final result snapshot and persist the
        // discovered cases ourselves (mirrors the web job's saveTestCases).
        let savedCount = 0;
        let summary: Record<string, unknown> = outcome.summary;
        try {
          const snapshot = await client.getExplorationResult(runnerRunId, { userId });
          const flows = Array.isArray((snapshot as { flows?: unknown[] }).flows)
            ? (snapshot as { flows: Parameters<typeof ExplorationStorageService.saveMobileTestCasesFromSnapshot>[0] }).flows
            : [];
          const savedIds = await ExplorationStorageService.saveMobileTestCasesFromSnapshot(
            flows, projectId, userId, platform,
          );
          savedCount = savedIds.length;
          // Prefer the snapshot's richer summary over the envelope's.
          summary = (snapshot as { summary?: Record<string, unknown> }).summary ?? snapshot ?? outcome.summary;
        } catch (err) {
          // Non-fatal: the run DID complete; we just couldn't fetch/persist
          // cases. Record the run as completed with 0 saved rather than
          // flipping a successful crawl to failed.
          logger.warn('[MOBILE_EXPLORATION_JOB] result fetch / case save failed', {
            explorationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }

        await ExplorationStorageService.completeMobileRun(explorationId, {
          summary,
          durationMs: Date.now() - startedAt,
          testCasesCount: savedCount,
        });

        if (chatSessionId) {
          ChatService.saveChatMessages(chatSessionId, [{
            role: 'ai',
            content:
              `**Mobile exploration complete**\n\n` +
              `Explored **${appId}** (${platform}).\n\n` +
              `- Test cases generated: ${savedCount}\n` +
              `Exploration ID: \`${explorationId}\``,
            metadata: { explorationId, mode: 'exploration', platform, appId, testCasesCount: savedCount },
          }]).catch(() => {});
        }

        logger.info('[MOBILE_EXPLORATION_JOB] completed', {
          explorationId, appId, platform, testCases: savedCount,
        });
      } else {
        // 4b. Failed / never reported done.
        const msg = outcome.errorMessage || 'Mobile exploration ended without completion';
        await ExplorationStorageService.failRun(explorationId, msg);
        webSocketService.emitExplorationCompleted({
          explorationId,
          testCasesCount: 0,
          summary: {},
          status: 'failed',
          errorMessage: msg,
          timestamp: new Date().toISOString(),
          chatSessionId,
          userId,
        });
        logger.warn('[MOBILE_EXPLORATION_JOB] failed', { explorationId, reason: outcome.reason, msg });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      logger.error('[MOBILE_EXPLORATION_JOB] error', { explorationId, error: errorMessage });
      await ExplorationStorageService.failRun(explorationId, errorMessage);
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
      // Always tear the relay down — idempotent, covers the throw path.
      relay?.stop('job-cleanup');
    }
  }
}
