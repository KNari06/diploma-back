/**
 * Editor iterative test authoring (build-by-executing).
 *
 * Replaces "LLM guesses the whole step array from a text snapshot, then runs it
 * blind" with a grounded loop: snapshot → LLM picks a REAL element by ref →
 * execute on the LIVE preview → fresh snapshot → next step → until the goal is
 * met. Every step is therefore proven against the live DOM as it is authored,
 * and the resulting plan has ALREADY passed — the final user "save" persists it
 * without a re-run.
 *
 * This drives the EXISTING `TestPipeline` (Planner→Executor→Reviewer loop) —
 * the same engine exploration uses — directly against the preview session's live
 * Page. It deliberately does NOT pull in FlowRunner / BudgetTracker / FlowQueue
 * / Strategist: those are background-exploration concerns. Step extraction
 * (rounds → grounded steps + compiled locator plans) is the shared
 * `extractDiscoveredSteps` so authored cases hit replay's fast path identically
 * to exploration-discovered ones.
 *
 * Concurrency: holds the SAME per-session run lock as Run-All
 * (`PreviewRunService.acquireRunLock`), so recording / apply / Run-All correctly
 * reject while authoring is in flight (preview invariant #1).
 */

import { ActionExecutor } from '@/agent/core/lite/execution/action-executor';
import { NetworkTracker } from '@/agent/core/lite/collectors/network-tracker';
import { GoalDetector } from '@/agent/core/lite/analysis/goal-detector';
import { TestPipeline, type PipelineIntegrations } from '@/agent/core/lite/pipeline/test-pipeline';
import type { PipelineConfig, ExecutionRound } from '@/agent/core/lite/pipeline/types';
import { extractDiscoveredSteps, commandToStep } from '@/agent/core/lite/exploration/pipeline-step-extractor';
import type { DiscoveredStep } from '@/agent/core/lite/exploration/types';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { getPreviewSessionService } from './preview-session.service';
import { PreviewRunService } from './preview-run.service';

/** Upper bound on author rounds — keeps an open-ended goal from looping forever. */
const DEFAULT_MAX_ROUNDS = 12;
/** Hard wall-clock cap for an authoring session. */
const DEFAULT_TIMEOUT_MS = 4 * 60 * 1000;

export interface AuthorTestParams {
  previewSessionId: string;
  userId: string;
  /** Natural-language goal, e.g. "test the login flow with valid credentials". */
  goal: string;
  /** Optional credentials surfaced to the Planner (never frozen into plans). */
  credentials?: PipelineConfig['credentials'];
  maxRounds?: number;
  timeoutMs?: number;
}

export interface AuthorTestResult {
  success: boolean;
  /** Grounded, already-executed steps (with compiled locator plans). */
  steps: DiscoveredStep[];
  /** Page URL the authoring started from (where the user was looking). */
  startUrl: string;
  /** Final URL after the authored flow ran. */
  endUrl: string;
  roundsExecuted: number;
  durationMs: number;
  /** Human-readable reason the loop stopped (goal met / blocked / timeout). */
  reason: string;
  /** Set when authoring could not start at all (no session / busy). */
  error?: string;
}

export class EditorIterativeAuthorService {
  /**
   * Author a test by building-and-executing on the live preview. Returns the
   * grounded steps; the caller decides whether to persist them.
   */
  static async authorTest(params: AuthorTestParams): Promise<AuthorTestResult> {
    const { previewSessionId, userId, goal } = params;
    const empty = (error: string): AuthorTestResult => ({
      success: false, steps: [], startUrl: '', endUrl: '', roundsExecuted: 0, durationMs: 0,
      reason: error, error,
    });

    const sessionService = getPreviewSessionService();
    if (!sessionService.isSessionOwned(previewSessionId, userId)) {
      return empty('No active editor preview session for this user.');
    }
    const page = sessionService.getPage(previewSessionId, userId);
    if (!page) {
      return empty('Preview session has no live page. Start a device/page in the editor first.');
    }

    // Reuse the Run-All mutex — authoring is a run as far as the session cares.
    const lock = PreviewRunService.acquireRunLock(previewSessionId);
    if (!lock) {
      return empty('A run is already in progress on this preview session. Wait for it to finish or cancel it first.');
    }

    const startUrl = page.url();
    const startedAt = Date.now();
    let networkTracker: NetworkTracker | undefined;
    // Hoisted so the catch can finalize the progress bubble it started.
    let startedEmitted = false;
    let emittedStepIndex = 0;
    try {
      const actionExecutor = new ActionExecutor(page);
      networkTracker = new NetworkTracker(page);
      const goalDetector = new GoalDetector(goal, previewSessionId);

      // Seed the editor's draft-run progress bubble. totalSteps:0 — build-by-
      // executing has an UNKNOWN total; the FE grows the list as steps stream in.
      webSocketService.emitToUser(userId, 'preview:run:started', {
        previewSessionId,
        totalSteps: 0,
        startUrl,
        ephemeral: true,
      });
      startedEmitted = true;

      // Per-round → per-step WS bridge. Each successful command becomes one
      // `preview:run:step` so the user watches the test being built live, with
      // the SAME tap-to-expand bubble as Run-All. Secret values are masked
      // (commandToStep already drops is_sensitive values; we never emit raw
      // `value` for sensitive steps — invariant #12).
      const onRoundComplete = (round: ExecutionRound): void => {
        for (const executed of round.commands) {
          if (!executed.result.success) continue;
          const ds = commandToStep(executed, emittedStepIndex + 1, '');
          if (!ds) continue; // infra command (observe/wait/blocked) — not user-facing
          webSocketService.emitToUser(userId, 'preview:run:step', {
            previewSessionId,
            stepIndex: emittedStepIndex,
            stepId: ds.ref ?? null,
            status: 'pass',
            action: ds.action,
            description: ds.description,
            // value carried only for non-sensitive value-bearing steps.
            ...(ds.value && !ds.isSensitive ? { value: ds.value } : {}),
            timestamp: new Date().toISOString(),
          });
          emittedStepIndex++;
        }
      };

      // NOTE: intentionally NOT passing `browserContext`. The preview session
      // already owns a popup/new-tab handler on this context
      // (attachPopupHandler → preview:tab:opened); giving TestPipeline a second
      // `context.on('page')` via its PageWatcher would double-handle popups and
      // could race the preview's own tab adoption. Popup detection is the
      // preview's job here.
      const integrations: PipelineIntegrations = {
        page,
        actionExecutor,
        networkTracker,
        goalDetector,
        onRoundComplete,
      };

      const config: PipelineConfig = {
        url: startUrl,
        credentials: params.credentials,
        hasCredentials: !!params.credentials,
        testId: previewSessionId,
        maxRounds: Math.max(1, params.maxRounds ?? DEFAULT_MAX_ROUNDS),
        timeoutMs: Math.max(5_000, params.timeoutMs ?? DEFAULT_TIMEOUT_MS),
        // A preview session has NO `tests` row — its id is `preview_<uuid>`, not
        // a UUID, so the DB cancellation check would error every round (22P02).
        // We cancel via externalAbortSignal instead.
        skipDbCancellationCheck: true,
        externalAbortSignal: lock.signal,
      };

      const pipeline = new TestPipeline(integrations);
      logger.info('[EDITOR_AUTHOR] Starting iterative authoring', {
        previewSessionId, startUrl, maxRounds: config.maxRounds, goalPreview: goal.slice(0, 80),
      });

      const result = await pipeline.run(goal, config);

      // Rounds → grounded steps + compiled plans (shared with exploration).
      const { steps } = await extractDiscoveredSteps(result, page);

      // Finalize the progress bubble (mirrors runStepsOnPreview's completed emit).
      webSocketService.emitToUser(userId, 'preview:run:completed', {
        previewSessionId,
        success: result.success,
        totalSteps: emittedStepIndex,
        passedSteps: emittedStepIndex, // only successful commands are emitted
        failedSteps: 0,
        skippedSteps: 0,
        duration: Date.now() - startedAt,
        ephemeral: true,
      });

      const endUrl = (() => { try { return page.url(); } catch { return startUrl; } })();
      logger.info('[EDITOR_AUTHOR] Authoring finished', {
        previewSessionId,
        success: result.success,
        roundsExecuted: result.roundsExecuted,
        stepCount: steps.length,
        reason: result.reason,
      });

      return {
        success: result.success,
        steps,
        startUrl,
        endUrl,
        roundsExecuted: result.roundsExecuted,
        durationMs: Date.now() - startedAt,
        reason: result.reason,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[EDITOR_AUTHOR] Authoring failed', { previewSessionId, error: message });
      // If we already seeded the progress bubble, finalize it so the FE spinner
      // doesn't hang (FE clears on completed).
      if (startedEmitted) {
        webSocketService.emitToUser(userId, 'preview:run:completed', {
          previewSessionId,
          success: false,
          totalSteps: emittedStepIndex,
          passedSteps: emittedStepIndex,
          failedSteps: 0,
          skippedSteps: 0,
          duration: Date.now() - startedAt,
          ephemeral: true,
        });
      }
      return {
        success: false, steps: [], startUrl, endUrl: startUrl,
        roundsExecuted: 0, durationMs: Date.now() - startedAt,
        reason: `Authoring failed: ${message}`, error: message,
      };
    } finally {
      // Detach network listeners from the long-lived preview page — otherwise
      // each authoring run leaks 5 listeners on a page that outlives the run.
      try { networkTracker?.stopTracking(); } catch { /* best-effort */ }
      lock.release();
    }
  }
}
