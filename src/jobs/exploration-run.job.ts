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
import { classifyExplorationFailure } from '@/services/testing/exploration/classify-failure';
import { buildExplorationChatActions } from '@/services/testing/exploration/exploration-chat-actions';
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
      preset,
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
        config: { scopeHint, maxConcurrency, budget, preset },
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
        // Undefined for the chat producers, which pass no budget and therefore run
        // on the full defaults — `isQuickPreset(undefined)` is false, which is the
        // correct reading.
        preset,
        maxConcurrency: maxConcurrency || 2, // Default 2 to avoid OpenAI TPM rate limits
        rateLimiting,
        // Cross-process cancel signal. The endpoint runs on the API process and
        // flips the DB row; the engine runs here, so a DB read is the only way
        // it can see the request. Polled at phase boundaries, not per step —
        // this is one indexed lookup on a run that lasts minutes.
        onCancelCheck: () => ExplorationStorageService.isRunCancelled(explorationId),
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

      // Persist hook: save test cases to DB. Passed INTO engine.run() so the
      // save runs before the trace is finalized — the trace then records the
      // real save outcome and a failed save shows status 'failed' (not the old
      // bug where the trace closed first and always said 'completed').
      let savedIds: string[] = [];
      const onResultReady = async (result: ExplorationResult) => {
        try {
          savedIds = await ExplorationStorageService.saveTestCases(result.testCases, projectId, userId, explorationId);
          return { savedCount: savedIds.length };
        } catch (err) {
          return { savedCount: 0, error: err instanceof Error ? err.message : String(err) };
        }
      };

      // Run exploration (resume from checkpoint or fresh start)
      let result: ExplorationResult;
      if (isResume && existingCheckpoint) {
        // Resume path persists the legacy way (its trace lifecycle is separate).
        result = await ExplorationEngine.resumeFromCheckpoint(browser, explorationConfig, existingCheckpoint);

        // Save ONLY flows explored in this attempt. `resumeFromCheckpoint` merges
        // `previousTasks` into the result so the summary reflects the whole run,
        // but those pre-crash flows were already persisted by the attempt that
        // ran them — re-saving produced duplicate `intent_test_cases` rows (the
        // insert has no dedup), once per resume attempt. `DiscoveredTestCase.id`
        // is the entry-point id, which is stable across the crash, so the
        // checkpoint's completed tasks identify exactly what to skip.
        const alreadySaved = new Set(
          (existingCheckpoint.flowRunner?.completedTasks ?? [])
            .map((t) => t.entryPoint?.id)
            .filter((id): id is string => typeof id === 'string'),
        );
        const freshCases = result.testCases.filter((tc) => !alreadySaved.has(tc.id));
        if (freshCases.length < result.testCases.length) {
          logger.info('[EXPLORATION_JOB] Resume — skipping already-persisted test cases', {
            explorationId,
            skipped: result.testCases.length - freshCases.length,
            saving: freshCases.length,
          });
        }
        savedIds = await ExplorationStorageService.saveTestCases(freshCases, projectId, userId, explorationId);
      } else {
        const engine = new ExplorationEngine(browser, explorationConfig);
        result = await engine.run(onResultReady);
      }

      // Did the user stop this run? Re-read rather than infer from the result:
      // the cancel lands on the API process at an arbitrary moment, and only the
      // row knows. Checked BEFORE completeRun so a cancelled run is never
      // relabelled 'completed'.
      const wasCancelled = await ExplorationStorageService.isRunCancelled(explorationId);

      if (wasCancelled) {
        // Keep the 'cancelled' status (completeRun would overwrite it) but
        // record what the partial run actually produced, so the history card
        // and the results panel still show the saved test cases.
        await ExplorationStorageService.recordCancelledRunOutput(explorationId, result);
      } else {
        await ExplorationStorageService.completeRun(explorationId, result);
      }

      // Charge the fixed discovery cost once, on success — but ONLY when the run
      // actually produced something. A zero-test-case run means the user got no
      // deliverable (site was empty, everything was blocked, or the budget ran out
      // before a flow finished), and billing 10 credits for it reads as broken.
      // Unreachable entry URLs no longer reach this line at all: the survey throws
      // EntryUnreachableError, which the catch below turns into a failed run.
      // Best-effort deduction: a failed charge must never fail an exploration the
      // user already received (mirrors the telemetry-write invariant).
      // `result.testCases.length` is NOT the billable quantity: TestCaseBuilder
      // appends one zero-step `not_explored` placeholder per UNEXPLORED entry
      // point, so a run that surveyed pages and then explored nothing (budget
      // exhausted, every flow blocked) would still bill — the exact case this
      // gate exists to catch. Count only cases with at least one replayable step.
      //
      // Billing tracks EXPLORED FLOWS (`runnableTestCases`), never the persisted
      // row count. Generated negatives carry 3 steps and do persist, but nothing
      // ever executed them — they are a template derived from a flow the user is
      // already being charged for. Billing on them would charge 10 credits for a
      // run where every real flow failed, which is the contradiction invariant #9
      // exists to prevent. So: `persistedTestCases` answers "what did my project
      // receive", `runnableTestCases` answers "what did we actually explore", and
      // only the latter is billable. The no-charge chat copy below is gated on
      // this same variable, so "you were not charged" can never contradict it.
      const billableTestCases = result.summary.runnableTestCases;

      // A RESUME must never charge again. `deductCreditsForTest` is not idempotent
      // on `testId`, and the resume path rebuilds `previousTasks` into the result,
      // so each of up to 3 resume attempts billed another 10 credits for the SAME
      // exploration — up to 40cr for one logical run. The fresh attempt is the one
      // that creates the run record, so it is the one that pays.
      // A cancelled run is never charged, even if it explored flows before the
      // stop. The user did not receive the run they asked for, and they keep
      // whatever was discovered — that asymmetry is deliberate: it makes
      // cancelling safe, so nobody lets a bad run burn its full budget just to
      // avoid an ambiguous charge.
      if (billableTestCases > 0 && !isResume && !wasCancelled) {
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
      } else {
        logger.info('[EXPLORATION_JOB] No runnable test cases — skipping discovery charge', {
          explorationId,
          userId,
          entryUrl,
          placeholderCount: result.testCases.length,
        });
      }

      // Save chat messages
      if (chatSessionId) {
        const summary = result.summary;
        // A run with nothing RUNNABLE must not claim success. It previously read
        // "**Exploration Complete** — Explored <url> autonomously" with zeros
        // underneath, which is what made a dead URL look like the user's fault.
        // Uses the same billable count as the charge above, so "you were not
        // charged" is always true when we say it — `result.testCases.length`
        // would be non-zero for a placeholder-only run and contradict the charge.
        const producedNothing = billableTestCases === 0;
        // Cancellation gets its own header: neither "Complete" (it wasn't) nor
        // the no-test-cases diagnostic above (which blames the site for
        // something the user chose to do), and it must say the work so far was
        // kept, or the user assumes cancelling threw everything away.
        const header = wasCancelled
          ? `**Exploration cancelled**\n\n` +
            `Stopped **${entryUrl}** at your request. ` +
            `${producedNothing ? 'Nothing runnable had been discovered yet.' : 'Everything discovered before the stop was saved below.'} ` +
            `You were not charged.\n\n`
          : producedNothing
          ? `**Exploration finished — no test cases**\n\n` +
            `I reached **${entryUrl}** but couldn't derive any runnable tests. ` +
            `Common causes: the pages need a login (provide credentials), the content is ` +
            `static, or the flows were blocked. You were not charged.\n\n`
          : `**Exploration Complete**\n\n` + `Explored **${entryUrl}** autonomously.\n\n`;
        // "Test cases generated" must equal what the run actually WROTE to the
        // project — `summary.persistedTestCases`. NOT `result.testCases.length`,
        // which counts zero-step not_explored placeholders that are dropped on
        // save (that made the chat claim "34 generated" against a panel listing
        // 22), and NOT `runnableTestCases`, which omits the generated negatives
        // that do persist (that under-reported by one row per form flow, so the
        // user was told 3 while `/test-cases` returned 5). The negatives get
        // their own line rather than being folded in silently: they are real
        // saved rows, but they were never executed, so presenting them as part
        // of the explored total would overstate what we verified.
        const notExploredLine =
          summary.flowsNotExplored > 0
            ? `- Not explored (skipped/timed out): ${summary.flowsNotExplored}\n`
            : '';
        const negativeLine =
          summary.negativeTestCases > 0
            ? `- Validation cases generated (not executed): ${summary.negativeTestCases}\n`
            : '';
        const replyMessage =
          header +
          `**Results:**\n` +
          `- Pages surveyed: ${summary.pagesSurveyed}\n` +
          // Split, because "181 entry points" beside "2 pages surveyed" reads as
          // a broken survey. Most of that total is Scout branch points found
          // during flows, not candidates sitting on the surveyed pages.
          `- Entry points discovered: ${summary.entryPointsDiscovered}` +
          (summary.branchEntryPoints > 0
            ? ` (${summary.surveyEntryPoints} from survey, ${summary.branchEntryPoints} found during flows)`
            : '') +
          `\n` +
          `- Flows explored: ${summary.flowsExplored}\n` +
          `- Passed: ${summary.flowsPassed} | Failed: ${summary.flowsFailed} | Blocked: ${summary.flowsBlocked}\n` +
          `- Test cases generated: ${summary.persistedTestCases}\n` +
          negativeLine +
          notExploredLine +
          `- Total steps discovered: ${summary.totalStepsDiscovered}\n` +
          `- Duration: ${Math.round(result.durationMs / 1000)}s\n\n` +
          // Say the cases are ALREADY saved. Users read "Test cases generated: N"
          // as "N things I still have to save somewhere", go looking for a save
          // button, find none (the results panel — and its "Run all tests" — is
          // gone once closed), and conclude the run was lost. They are drafts in
          // the project the moment the run ends; nothing is pending.
          (savedIds.length > 0
            ? `${savedIds.length} test case(s) were **saved to your project as drafts** — open them below.\n\n`
            : '') +
          `Exploration ID: \`${explorationId}\``;

        ChatService.saveChatMessages(chatSessionId, [
          {
            role: 'ai',
            content: replyMessage,
            metadata: {
              explorationId,
              mode: 'exploration',
              url: entryUrl,
              // Persisted-row count — matches the history card, the "Test cases
              // generated" line above, and what `/explorations/:id/test-cases`
              // returns. `savedTestCaseIds` remains the authoritative persisted
              // set (shorter still on a resume — invariant #19).
              testCasesCount: result.summary.persistedTestCases,
              savedTestCaseIds: savedIds,
              // The only durable route back to this run — see
              // buildExplorationChatActions for why the panel isn't one.
              actions: buildExplorationChatActions(explorationId, savedIds.length),
            },
          },
        ]).catch(() => {});
      }

      // Emit completion
      webSocketService.emitExplorationCompleted({
        explorationId,
        // Persisted-row count — the frontend renders this as "N test cases
        // discovered", and the user can open every one of them, so it must be
        // the number of rows written (flows + generated negatives), matching the
        // history card the same run produces.
        testCasesCount: result.summary.persistedTestCases,
        summary: result.summary as any,
        // Report the real outcome — a cancelled run rendered as 'completed'
        // would show a success card for a run the user stopped.
        status: wasCancelled ? 'cancelled' : 'completed',
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

      // Narrow WHY the run ended, so "the site blocked us" is queryable instead
      // of buried in free-text `error_message`. Classified off the TYPED error,
      // never the message string: the reason is already structured on
      // EntryUnreachableError, and prose gets reworded.
      const failureStatus = classifyExplorationFailure(error);

      logger.error('[EXPLORATION_JOB] Exploration failed', {
        explorationId,
        error: errorMessage,
        failureStatus,
        stack: error instanceof Error ? error.stack : undefined,
      });

      await ExplorationStorageService.failRun(explorationId, errorMessage, failureStatus);

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
