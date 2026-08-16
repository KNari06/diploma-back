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
import { buildExplorationChatActions } from '@/services/testing/exploration/exploration-chat-actions';
import { AppSkeletonService } from '@/services/testing/exploration/app-skeleton.service';
import { webSocketService } from '@/websocket/core/websocket.service';
import { ChatService } from '@/services/utils/chat.service';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { MOBILE_STEP_CREDIT_MULTIPLIER } from '@/services/core/token-calculator.service';
import { EXPLORATION_DISCOVERY_CREDITS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';

/**
 * How often the job re-reads the run row to see whether the user cancelled.
 *
 * 5s: a mobile crawl runs for minutes and holds an emulator, so the cost of
 * one indexed lookup is nothing next to leaving a device pinned after the user
 * asked to stop. Not faster, because the runner still needs a moment to wind
 * the agent down and a tighter poll would not shorten that.
 */
const CANCEL_POLL_INTERVAL_MS = 5_000;

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
      briefing,
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
        { appId, goal, briefing, budget },
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

      // Cross-process cancel. `POST /explorations/:id/cancel` flips the DB row
      // on the API process; the crawl runs on the RUNNER, so neither an
      // in-memory flag nor the web engine's BudgetTracker can reach it. Poll
      // the row and forward the stop to the runner, which is the only actor
      // that can actually halt the agent and free the emulator.
      //
      // Without this a mobile run could not be stopped at all: the endpoint
      // marked it cancelled while the crawl kept going to its full budget,
      // holding a device the whole time.
      const cancelPoll = setInterval(() => {
        void (async () => {
          try {
            if (!(await ExplorationStorageService.isRunCancelled(explorationId))) return;
            clearInterval(cancelPoll);
            logger.info('[MOBILE_EXPLORATION_JOB] Cancellation requested — stopping runner', {
              explorationId, runnerRunId,
            });
            // Runner first (it owns the device); the relay teardown follows so
            // we stop forwarding events for a run that is going away. Both are
            // idempotent, and a failure here must not mask the user's intent.
            await client.cancelExploration(runnerRunId, { userId }).catch((err) => {
              logger.warn('[MOBILE_EXPLORATION_JOB] Runner cancel failed', {
                explorationId,
                error: err instanceof Error ? err.message : String(err),
              });
            });
            relay?.stop();
          } catch {
            // A failed poll is not a cancellation — try again next tick.
          }
        })();
      }, CANCEL_POLL_INTERVAL_MS);

      let outcome;
      try {
        outcome = await relay.waitUntilDone();
      } finally {
        clearInterval(cancelPoll);
      }

      // 4a. Persist + summarise.
      if (outcome.status === 'completed') {
        // The runner's completion envelope carries no test-case count and
        // no cases — fetch the final result snapshot and persist the
        // discovered cases ourselves (mirrors the web job's saveTestCases).
        let savedCount = 0;
        // Hoisted out of the try below so the chat metadata can carry the
        // persisted ids — they are the authoritative set of what landed.
        let savedIds: string[] = [];
        let summary: Record<string, unknown> = outcome.summary;
        try {
          const snapshot = await client.getExplorationResult(runnerRunId, { userId });
          const flows = Array.isArray((snapshot as { flows?: unknown[] }).flows)
            ? (snapshot as { flows: Parameters<typeof ExplorationStorageService.saveMobileTestCasesFromSnapshot>[0] }).flows
            : [];
          savedIds = await ExplorationStorageService.saveMobileTestCasesFromSnapshot(
            flows, projectId, userId, platform, explorationId,
          );
          savedCount = savedIds.length;

          // Persist the screen graph into the per-app skeleton — the map a later
          // "test X in this app" / chat request consults instead of re-crawling.
          // The graph already rides in this same snapshot under `mobile`; we used
          // to discard it. Best-effort inside the service (never throws).
          const mobile = (snapshot as { mobile?: {
            graph?: { nodes?: unknown[]; edges?: unknown[] };
            rootFingerprint?: string; fingerprintVersion?: number;
            domainGuess?: string; coverageScore?: number;
          } }).mobile;
          if (mobile?.graph) {
            await AppSkeletonService.mergeRunIntoSkeleton({
              projectId,
              platform: toSkeletonPlatform(platform),
              packageName: appId,
              // Pass through as-is (may be undefined on an older runner). The
              // service treats undefined as "same version" so it MERGES rather
              // than rebuilding — a `?? 0` here would make every run look like a
              // version change and never accumulate.
              fingerprintVersion: mobile.fingerprintVersion,
              graph: mobile.graph,
              rootFingerprint: mobile.rootFingerprint,
              domainGuess: mobile.domainGuess,
              // coverageScore rides on the mobile header (the snapshot has no
              // top-level `summary`), so read it there — reading summary.* here
              // was always undefined → bestCoverageScore stuck at 0.
              coverageScore: mobile.coverageScore,
              runId: runnerRunId,
            });
          }

          // Prefer the snapshot's richer summary over the envelope's.
          const rawSummary = (snapshot as { summary?: Record<string, unknown> }).summary ?? snapshot ?? outcome.summary;
          // Hoist coverageScore to the TOP level: the runner puts it at
          // summary.mobile.coverageScore, but the frontend history view reads
          // summary.coverageScore → it was always null for mobile. Prefer the
          // authoritative mobile value; fall back to any existing top-level one.
          const mobileHdr = (snapshot as { mobile?: { coverageScore?: number } }).mobile;
          summary = {
            ...rawSummary,
            coverageScore: mobileHdr?.coverageScore
              ?? (rawSummary as { coverageScore?: number }).coverageScore
              ?? null,
          };
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

        // Billing: mobile discovery charges the web discovery cost × the mobile
        // multiplier (emulator COGS is higher). Charged once on success, best-
        // effort — a failed deduction must never fail the run the user got.
        // Mirrors mobile-test-run.job and the web exploration discovery charge.
        // Only charge when the run actually produced test cases — a completed
        // crawl that saved nothing (or whose result fetch failed above, leaving
        // savedCount = 0) is not a billable discovery.
        if (userId && savedCount > 0) {
          const mobileExplorationCredits =
            EXPLORATION_DISCOVERY_CREDITS * MOBILE_STEP_CREDIT_MULTIPLIER;
          try {
            await CreditCostTrackerService.deductCreditsForTest({
              userId,
              testType: 'intelligent',
              credits: mobileExplorationCredits,
              costUSD: 0,
              testId: explorationId,
              description: `Mobile exploration discovery — ${appId} (${platform})`,
            });
          } catch (creditError) {
            logger.warn('[MOBILE_EXPLORATION_JOB] credit deduction failed (non-critical)', {
              explorationId,
              userId,
              error: creditError instanceof Error ? creditError.message : String(creditError),
            });
          }
        }

        if (chatSessionId) {
          ChatService.saveChatMessages(chatSessionId, [{
            role: 'ai',
            content:
              `**Mobile exploration complete**\n\n` +
              `Explored **${appId}** (${platform}).\n\n` +
              `- Test cases generated: ${savedCount}\n` +
              // Same honesty fix as the web path: users read "N generated" as
              // "N things I still have to save", go looking for a save button,
              // and conclude the run was lost. They are drafts already.
              (savedCount > 0
                ? `\n${savedCount} test case(s) were **saved to your project as drafts** — open them below.\n\n`
                : '\n') +
              `Exploration ID: \`${explorationId}\``,
            metadata: {
              explorationId,
              mode: 'exploration',
              platform,
              appId,
              testCasesCount: savedCount,
              savedTestCaseIds: savedIds,
              // Without these the finished message is a dead end: the mobile
              // live panel is component state, so closing it removes every
              // route back to the run. Same framework, same reasoning as web.
              actions: buildExplorationChatActions(explorationId, savedCount),
            },
          }]).catch(() => {});
        }

        logger.info('[MOBILE_EXPLORATION_JOB] completed', {
          explorationId, appId, platform, testCases: savedCount,
        });
      } else if (await ExplorationStorageService.isRunCancelled(explorationId)) {
        // 4b. Stopped on the user's request. The relay ends as `stopped`, which
        // is indistinguishable here from a crash — so ASK the row, which the
        // cancel endpoint already flipped. Writing `failRun` would relabel a
        // deliberate stop as a failure and bury it in the failure metrics.
        // The status stays 'cancelled'; nothing is charged (the charge only
        // runs on the completed branch above).
        logger.info('[MOBILE_EXPLORATION_JOB] cancelled by user', { explorationId, appId });
        webSocketService.emitExplorationCompleted({
          explorationId,
          testCasesCount: 0,
          summary: {},
          status: 'cancelled',
          timestamp: new Date().toISOString(),
          chatSessionId,
          userId,
        });
      } else {
        // 4c. Failed / never reported done.
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

/** Normalize the job's bare platform ('android'|'ios'|'flutter') to the
 *  intent_test_cases enum form the skeleton table keys on. */
function toSkeletonPlatform(
  platform: 'android' | 'ios' | 'flutter',
): 'mobile_android' | 'mobile_ios' | 'mobile_flutter' {
  return platform === 'ios' ? 'mobile_ios' : platform === 'flutter' ? 'mobile_flutter' : 'mobile_android';
}
