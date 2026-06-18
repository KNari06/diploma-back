/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FLOW RUNNER — Phase 2: Parallel test flow exploration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs discovered flows using the existing TestPipeline:
 *   1. Creates isolated BrowserContext per flow
 *   2. Injects auth state if needed
 *   3. Navigates to source page
 *   4. Runs TestPipeline.run(goal, config)
 *   5. Extracts DiscoveredStep[] from pipeline rounds
 *   6. Detects branch points (new flows on final page)
 *
 * Concurrency: semaphore-bounded (default 5 sub-agents).
 * Error isolation: Promise.allSettled, each flow in try/catch.
 */

import type { Browser, Page, BrowserContext } from 'playwright';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS } from '@/config/ai/ai-models.config';

import { TestPipeline, type PipelineIntegrations } from '../pipeline/test-pipeline';
import type { PipelineConfig, TestPipelineResult, ExecutedCommand } from '../pipeline/types';
import { ActionExecutor } from '../execution/action-executor';
import { NetworkTracker } from '../collectors/network-tracker';
import { GoalDetector } from '../analysis/goal-detector';
import { SnapshotCollector } from '../collectors/snapshot-collector';
import { SnapshotRouter } from '@/services/testing/ui/preview/snapshot-router.service';
import { OverlayDismisser } from './overlay-dismisser';
import { VisualStability } from '../collectors/visual-stability';

import {
  ACTION_TO_INTENT_TYPE,
  type ExplorationConfig,
  type EntryPoint,
  type FlowExplorationTask,
  type FlowExplorationStatus,
  type FlowRunnerCheckpoint,
  type DiscoveredStep,
  type CapturedApiCall,
  type FlowError,
  type ErrorClassification,
  type BlockerType,
  type ExplorationProgressCallback,
} from './types';
import type { NetworkSuccess } from '../lite-types';
import { attributeCallsToSteps } from './network-assertions';
import { LocatorPlanBuilder } from '@/services/testing/ui/preview/locator-plan-builder.service';
import { adaptLiteElementsToInteractiveNodes } from '@/agent/execution/background-dom-collector';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { TestAction } from '../test-case/types';
import { FlowQueue } from './flow-queue';
import { BudgetTracker } from './budget-tracker';
import { StateManager } from './state-manager';
import { RateLimiter } from './rate-limiter';
import {
  buildBranchDetectionPrompt,
  parseBranchDetectionResponse,
} from './prompts';
import { ClarificationService } from '@/agent/utils/context/clarification.service';
import type { ExplorationTraceService } from './exploration-trace.service';
import { Scout } from './agents/scout';
import type { ScoutInput, ScoutOutput, ExplorationBlackboard, CartographerInsight } from './agents/agent-types';
import { normalizeUrlWithPattern } from './url-pattern';

/**
 * Navigation timeout for flow execution (entry-point + login navigations).
 * Single source of truth so the value can't drift across the four goto sites.
 */
const FLOW_NAV_TIMEOUT_MS = 15_000;

/**
 * Wait strategy for every navigation on the flow-execution (replay) path.
 * MUST be 'load', never 'domcontentloaded' — see CLAUDE.md Hard Invariant #4.
 * domcontentloaded fires before JS hydrates, so actions/login forms can fire
 * against a non-interactive page and flake.
 */
const FLOW_NAV_WAIT_UNTIL = 'load' as const;

/**
 * Element-targeting actions that earn a compiled locator plan (frozen from the
 * element the executor resolved at action time). Excludes non-targeting steps
 * (navigate/press/scroll/scrollToElement) and synthetic verify steps — those
 * have no durable element target. `clear` maps to a `click` intent type
 * upstream (ACTION_TO_INTENT_TYPE), but its LOCATOR is still the field, so the
 * frozen plan is correct; the action-type quirk is pre-existing and orthogonal.
 */
export const PLAN_WORTHY_ACTIONS: ReadonlySet<TestAction> = new Set<TestAction>([
  'click', 'fill', 'select', 'hover', 'toggle', 'setRange', 'selectDate', 'clear',
]);

/**
 * Subset whose `value` is meaningful to replay and safe to freeze into the
 * plan: typed text (fill), chosen option (select), range number (setRange),
 * date string (selectDate). Sensitive values are still excluded at call time.
 * click/hover/toggle/clear carry no value.
 */
export const VALUE_CARRYING_ACTIONS: ReadonlySet<TestAction> = new Set<TestAction>([
  'fill', 'select', 'setRange', 'selectDate',
]);

/** Semaphore for bounding concurrent flows */
class Semaphore {
  private current = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly max: number) {}

  async acquire(): Promise<() => void> {
    if (this.current < this.max) {
      this.current++;
      return () => this.release();
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.current++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.current--;
    const next = this.waiters.shift();
    if (next) next();
  }
}

/** Callback for periodic checkpoint saves during flow execution */
export type CheckpointCallback = (completedTasks: FlowExplorationTask[]) => Promise<void>;

export class FlowRunner {
  private stateManager: StateManager;
  private loginCompleted: boolean = false;
  private loginMutex: Promise<void> = Promise.resolve();
  private knownFlowNames: string[] = [];
  private flowsCompleted: number = 0;
  private totalFlows: number = 0;
  private checkpointCallback?: CheckpointCallback;
  private readonly scout: Scout;

  constructor(
    private readonly browser: Browser,
    private readonly config: ExplorationConfig,
    private readonly budget: BudgetTracker,
    private readonly onProgress?: ExplorationProgressCallback,
    private readonly rateLimiter?: RateLimiter,
    private readonly trace?: ExplorationTraceService,
    private readonly blackboard?: ExplorationBlackboard,
  ) {
    this.stateManager = new StateManager(browser);
    this.scout = new Scout(rateLimiter, trace);

    // If the user supplied a pre-seeded auth fixture, plant it in the
    // StateManager *before* any flow runs. This makes the first auth-gated
    // flow skip performLogin() entirely — hasAuthState() returns true.
    // We also mark loginCompleted so concurrent auth-gated flows don't race
    // to trigger the redundant login mutex path.
    if (this.config.authFixture) {
      this.stateManager.preloadAuthState(this.config.authFixture);
      this.loginCompleted = true;
      logger.info('[FLOW_RUNNER] Auth fixture preloaded — login flow will be skipped', {
        cookies: this.config.authFixture.cookies.length,
        origins: this.config.authFixture.origins.length,
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHECKPOINT / RESUME
  // ═══════════════════════════════════════════════════════════════════════

  setCheckpointCallback(cb: CheckpointCallback): void {
    this.checkpointCallback = cb;
  }

  isLoginCompleted(): boolean {
    return this.loginCompleted;
  }

  getKnownFlowNames(): string[] {
    return [...this.knownFlowNames];
  }

  restoreFromCheckpoint(cp: FlowRunnerCheckpoint): void {
    this.loginCompleted = cp.loginCompleted;
    this.knownFlowNames = [...cp.knownFlowNames];
    this.flowsCompleted = cp.flowsCompleted;
  }

  private emitProgress(
    event: 'flow_started' | 'flow_completed' | 'flow_failed' | 'flow_blocked' | 'branch_found' | 'flow_step' | 'auth_started' | 'auth_completed',
    data: Record<string, any>,
  ): void {
    if (!this.onProgress) return;
    // Progress: 30% (survey done) → 95% (flows done). Scale within this range.
    const flowProgress = this.totalFlows > 0
      ? (this.flowsCompleted / this.totalFlows)
      : 0;
    const progressPercent = 30 + Math.round(flowProgress * 65);
    try {
      this.onProgress({
        explorationId: this.config.explorationId,
        phase: 'flow',
        event,
        data,
        progressPercent: Math.min(95, progressPercent),
        timestamp: Date.now(),
      });
    } catch { /* never let progress reporting crash exploration */ }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Run all flows from the queue with bounded concurrency.
   * Returns completed FlowExplorationTask[] (including failed ones).
   */
  async runAll(queue: FlowQueue): Promise<FlowExplorationTask[]> {
    const maxConcurrency = this.config.maxConcurrency || 5;
    const semaphore = new Semaphore(maxConcurrency);
    const results: FlowExplorationTask[] = [];
    const inFlight: Set<Promise<void>> = new Set();

    this.totalFlows = queue.size() + this.flowsCompleted;
    // Don't reset flowsCompleted — it may be restored from checkpoint

    logger.info('[FLOW_RUNNER] Starting flow exploration', {
      queueSize: queue.size(),
      maxConcurrency,
    });

    // Process queue in a loop that re-checks after each flow completes,
    // so newly enqueued branch points get picked up.
    while ((!queue.isEmpty() || inFlight.size > 0) && !this.budget.isExhausted()) {
      // Fill up concurrency slots from queue
      while (!queue.isEmpty() && !this.budget.isExhausted() && this.budget.canExploreMoreFlows()) {
        const entryPoint = queue.dequeue();
        if (!entryPoint) break;

        this.trace?.writeQueueDequeue({
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          category: entryPoint.category,
          priority: entryPoint.priority,
          budget: {
            flowsRemaining: this.budget.remainingFlows(),
            roundsRemaining: this.budget.remainingPipelineRounds(),
            allocatedRounds: this.budget.roundsPerFlow(),
            timeRemainingMs: this.budget.remainingTimeMs(),
          },
        });

        // Acquire semaphore before starting (blocks when at max concurrency)
        const release = await semaphore.acquire();

        // Re-check budget after acquiring semaphore
        if (this.budget.isExhausted()) {
          this.trace?.writeBudgetExhausted({
            reason: 'exhausted_after_semaphore_acquire',
            remaining: { flows: 0 },
          });
          results.push(this.createSkippedTask(entryPoint, 'Budget exhausted'));
          release();
          break;
        }

        const promise = this.executeFlow(entryPoint, queue, results, release)
          .finally(() => inFlight.delete(promise));

        inFlight.add(promise);
      }

      // If queue is empty but flows are still running, wait for one to finish
      // (it may enqueue branch points that we should process)
      if (inFlight.size > 0 && queue.isEmpty()) {
        await Promise.race(inFlight);
      } else if (inFlight.size > 0 && this.budget.isExhausted()) {
        break;
      } else if (queue.isEmpty()) {
        break;
      }
    }

    // Wait for all remaining in-flight flows
    if (inFlight.size > 0) {
      await Promise.allSettled(inFlight);
    }

    logger.info('[FLOW_RUNNER] All flows completed', {
      total: results.length,
      passed: results.filter((r) => r.status === 'completed').length,
      failed: results.filter((r) => r.status === 'failed').length,
    });

    return results;
  }

  /**
   * Cleanup: close all browser contexts.
   */
  async cleanup(): Promise<void> {
    await this.stateManager.closeAll();
  }

  /**
   * Execute a single flow with error handling and resource cleanup.
   */
  private async executeFlow(
    entryPoint: EntryPoint,
    queue: FlowQueue,
    results: FlowExplorationTask[],
    release: () => void,
  ): Promise<void> {
    // Atomically reserve a flow slot before starting execution
    const reserved = await this.budget.reserveFlowSlot();
    if (!reserved) {
      logger.info('[FLOW_RUNNER] Budget exhausted, skipping flow', { name: entryPoint.name });
      results.push(this.createSkippedTask(entryPoint, 'Budget exhausted'));
      release();
      return;
    }

    this.emitProgress('flow_started', {
      entryPointId: entryPoint.id,
      name: entryPoint.name,
      category: entryPoint.category,
      priority: entryPoint.priority,
    });

    try {
      const task = await this.runSingleFlow(entryPoint);
      results.push(task);
      this.flowsCompleted++;

      // Mark as completed for dependency tracking — always, even on failure/blocked.
      // A failed auth flow should not deadlock all auth-gated flows forever;
      // dependents will run (and likely fail on their own if auth is truly needed).
      queue.markCompleted(entryPoint.id);

      // Enqueue newly discovered branch points
      for (const branch of task.branchPoints) {
        await queue.enqueue(branch);
        this.totalFlows++;
      }

      if (task.branchPoints.length > 0) {
        this.trace?.writeBranchEnqueued({
          sourceFlowId: entryPoint.id,
          sourceFlowName: entryPoint.name,
          branches: task.branchPoints.map(b => ({ name: b.name, category: b.category, priority: b.priority })),
          count: task.branchPoints.length,
        });
        this.emitProgress('branch_found', {
          entryPointId: entryPoint.id,
          sourceFlowName: entryPoint.name,
          newFlowsCount: task.branchPoints.length,
          newFlows: task.branchPoints.map(b => b.name),
        });
      }

      // Record budget usage (flow slot was already reserved via reserveFlowSlot)
      await this.budget.recordFlowRounds(task.roundsUsed);

      // Trigger checkpoint callback if configured
      if (this.checkpointCallback) {
        try {
          await this.checkpointCallback(results);
        } catch { /* never let checkpoint saving crash flow execution */ }
      }

      // Emit appropriate completion event
      const progressEvent = task.status === 'blocked' ? 'flow_blocked' as const
        : task.goalAchieved ? 'flow_completed' as const
        : 'flow_failed' as const;

      this.emitProgress(progressEvent, {
        entryPointId: entryPoint.id,
        name: entryPoint.name,
        status: task.status,
        steps: task.discoveredSteps.length,
        branches: task.branchPoints.length,
        goalAchieved: task.goalAchieved,
        durationMs: task.durationMs,
        progressScore: task.progressScore,
        blockerType: task.blockerType || undefined,
        errorMessage: task.errors.length > 0 ? task.errors[0].message : undefined,
        failedAtStep: task.errors.length > 0 ? task.errors[0].stepNumber : undefined,
        errorsCount: task.errors.length,
      });

      this.trace?.writeFlowEnd({
        entryPointId: entryPoint.id,
        name: entryPoint.name,
        status: task.status,
        durationMs: task.durationMs,
        goalAchieved: task.goalAchieved,
        progressScore: task.progressScore,
        stepsCount: task.discoveredSteps.length,
        branchCount: task.branchPoints.length,
        roundsUsed: task.roundsUsed,
      });

      logger.info('[FLOW_RUNNER] Flow completed', {
        name: entryPoint.name,
        status: task.status,
        steps: task.discoveredSteps.length,
        branches: task.branchPoints.length,
      });
    } catch (error) {
      this.flowsCompleted++;
      const errMsg = error instanceof Error ? error.message : String(error);
      logger.error('[FLOW_RUNNER] Flow execution failed', {
        name: entryPoint.name,
        error: errMsg,
      });

      const task = this.createFailedTask(entryPoint, error);

      // Comprehensive blocker classification from error message
      const lowerErr = errMsg.toLowerCase();
      if (lowerErr.includes('captcha') || lowerErr.includes('recaptcha') || lowerErr.includes('hcaptcha')) {
        task.blockerType = 'captcha';
        task.status = 'blocked';
        task.blockedReason = 'CAPTCHA required';
        task.canUserHelp = true;
      } else if (lowerErr.includes('2fa') || lowerErr.includes('two-factor') || lowerErr.includes('verification code') || lowerErr.includes('otp')) {
        task.blockerType = '2fa';
        task.status = 'blocked';
        task.blockedReason = '2FA verification required';
        task.canUserHelp = true;
      } else if (lowerErr.includes('login') || lowerErr.includes('unauthorized') || lowerErr.includes('401') || lowerErr.includes('auth')) {
        task.blockerType = 'login_wall';
        task.status = 'blocked';
        task.blockedReason = 'Authentication required';
        task.canUserHelp = true;
      } else if (lowerErr.includes('timeout') || lowerErr.includes('timed out')) {
        task.blockerType = 'other';
        task.blockedReason = 'Page load or action timeout';
      } else if (lowerErr.includes('rate limit') || lowerErr.includes('429') || lowerErr.includes('too many requests')) {
        task.blockerType = 'external_service';
        task.status = 'blocked';
        task.blockedReason = 'Rate limited by target site';
      } else if (lowerErr.includes('navigation failed') || lowerErr.includes('net::err') || lowerErr.includes('econnrefused') || lowerErr.includes('enotfound')) {
        task.blockerType = 'external_service';
        task.status = 'blocked';
        task.blockedReason = 'Navigation failure';
      } else if (lowerErr.includes('payment') || lowerErr.includes('credit card') || lowerErr.includes('billing')) {
        task.blockerType = 'payment';
        task.status = 'blocked';
        task.blockedReason = 'Payment information required';
      } else if (lowerErr.includes('file upload') || lowerErr.includes('file chooser')) {
        task.blockerType = 'file_upload';
        task.status = 'blocked';
        task.blockedReason = 'File upload required';
      }

      results.push(task);

      this.emitProgress('flow_failed', {
        entryPointId: entryPoint.id,
        name: entryPoint.name,
        error: errMsg,
        blockerType: task.blockerType,
      });
    } finally {
      release();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SINGLE FLOW EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  private async runSingleFlow(entryPoint: EntryPoint): Promise<FlowExplorationTask> {
    const startTime = Date.now();
    // Capture timeout at flow start so it stays stable throughout the flow,
    // even as the global budget shrinks from other concurrent flows.
    const flowTimeoutMs = this.budget.effectiveFlowTimeoutMs();
    const allocatedRounds = this.budget.roundsPerFlow();
    let context: BrowserContext | null = null;

    // Auth is available if we have either a pre-seeded fixture (already
    // loaded into StateManager) or credentials (we can run performLogin).
    // Fixture-only flows MUST still use createAuthenticatedContext, otherwise
    // the whole pre-seeded path regresses to running on a blank context.
    const hasAuthAvailable =
      this.stateManager.hasAuthState() || !!this.config.credentials;
    const needsAuthContext = entryPoint.requiresAuth && hasAuthAvailable;

    this.trace?.writeFlowStart({
      entryPointId: entryPoint.id,
      name: entryPoint.name,
      goal: entryPoint.goal,
      category: entryPoint.category,
      priority: entryPoint.priority,
      contextType: needsAuthContext ? 'authenticated' : 'clean',
      allocatedRounds,
      flowTimeoutMs,
    });

    try {
      // 1. Create browser context (with auth if needed)
      if (needsAuthContext) {
        context = await this.stateManager.createAuthenticatedContext();

        // Only attempt live login when we actually have credentials AND no
        // auth state is cached yet. With a fixture preloaded, hasAuthState()
        // is already true, so this branch is skipped entirely.
        if (
          this.config.credentials &&
          !this.stateManager.hasAuthState() &&
          !this.loginCompleted
        ) {
          await this.withLoginMutex(async () => {
            // Double-check after acquiring mutex (another flow may have completed login)
            if (!this.loginCompleted) {
              await this.performLogin(context!);
            }
          });
        }
      } else {
        context = await this.stateManager.createCleanContext();
      }

      const page = await context.newPage();

      // Block third-party requests for faster navigation
      try {
        const { setupThirdPartyBlocker } = await import('@/agent/playwright/execution/third-party-blocker');
        await setupThirdPartyBlocker(page);
      } catch { /* non-fatal */ }

      // 2. Navigate to the entry point's source page
      const targetUrl = entryPoint.sourcePageUrl || this.config.entryUrl;
      if (this.rateLimiter) {
        const canNavigate = await this.rateLimiter.acquireSlot('navigation');
        if (!canNavigate) {
          throw new Error(`Target site degraded, cannot navigate to ${targetUrl}`);
        }
      }
      try {
        await page.goto(targetUrl, {
          waitUntil: FLOW_NAV_WAIT_UNTIL,
          timeout: FLOW_NAV_TIMEOUT_MS,
        });
        this.rateLimiter?.recordSuccess('target_site');
      } catch (navError) {
        if (this.rateLimiter && RateLimiter.isRateLimitError(navError as Error)) {
          const result = await this.rateLimiter.recordFailure('target_site', navError as Error);
          if (result.shouldRetry) {
            await page.goto(targetUrl, {
              waitUntil: FLOW_NAV_WAIT_UNTIL,
              timeout: FLOW_NAV_TIMEOUT_MS,
            });
            this.rateLimiter.recordSuccess('target_site');
          } else {
            throw new Error(`Rate limited navigating to ${targetUrl}`);
          }
        } else {
          throw navError;
        }
      }

      // 2.5. Dismiss overlays before pipeline starts (cookie consent, promo modals)
      try {
        const overlayResult = await OverlayDismisser.dismissOverlays(page, {
          maxPasses: 2,
          maxTimeMs: 5000,
          mode: 'flow',
        });
        if (overlayResult.overlaysDetected > 0) {
          this.trace?.writeOverlayDetected({
            url: page.url(),
            mode: 'flow',
            obstacles: overlayResult.attempts.map(a => ({ ref: a.ref, type: a.obstacleType, zIndex: 0 })),
            count: overlayResult.overlaysDetected,
          });
          this.trace?.writeOverlayDismissed({
            url: page.url(),
            attempts: overlayResult.attempts,
            durationMs: overlayResult.durationMs,
          });
          logger.info('[FLOW_RUNNER] Pre-pipeline overlay cleanup', {
            flow: entryPoint.name,
            detected: overlayResult.overlaysDetected,
            dismissed: overlayResult.attempts.filter(a => a.dismissed).length,
          });
        }
      } catch {
        // Non-fatal: pipeline's ActionExecutor has its own reactive modal handling
      }

      // 3. Create pipeline integrations
      const actionExecutor = new ActionExecutor(page);
      const networkTracker = new NetworkTracker(page);
      const goalDetector = new GoalDetector(entryPoint.goal, entryPoint.id);

      const integrations: PipelineIntegrations = {
        page,
        actionExecutor,
        networkTracker,
        goalDetector,
        browserContext: context,
        traceWriter: this.trace?.getWriter(),
      };

      // 4. Create and run pipeline
      const pipeline = new TestPipeline(integrations);

      const pipelineConfig: PipelineConfig = {
        url: page.url(),
        credentials: this.config.credentials,
        hasCredentials: !!this.config.credentials,
        testId: entryPoint.id,
        maxRounds: Math.max(1, allocatedRounds),
        timeoutMs: Math.max(5_000, flowTimeoutMs),
        skipDbCancellationCheck: true, // Exploration uses non-UUID testIds (ep-0, ep-1)
        entryPointId: entryPoint.id,
      };

      this.trace?.writeFlowPipelineStart({
        entryPointId: entryPoint.id,
        goal: entryPoint.goal,
        url: page.url(),
        maxRounds: pipelineConfig.maxRounds,
        timeoutMs: pipelineConfig.timeoutMs,
      });

      const pipelineStartTime = Date.now();
      const pipelineResult = await pipeline.run(entryPoint.goal, pipelineConfig);

      // 5. Extract steps from pipeline rounds + attribute network calls.
      //    NetworkTracker has been running since `new NetworkTracker(page)`
      //    above, so everything captured since `pipelineStartTime` belongs
      //    to this flow.
      const { steps: baseSteps, stepsByRound } = await this.extractSteps(pipelineResult, page);
      const successfulCalls = this.collectSuccessfulCalls(networkTracker, pipelineStartTime);
      const discoveredSteps = attributeCallsToSteps({
        steps: baseSteps,
        stepsByRound,
        rounds: pipelineResult.rounds,
        flowStartTime: pipelineStartTime,
        successfulCalls,
      });

      this.trace?.writeFlowPipelineEnd({
        entryPointId: entryPoint.id,
        success: pipelineResult.success,
        roundsUsed: pipelineResult.roundsExecuted,
        progressScore: pipelineResult.progressScore,
        blockedReason: pipelineResult.blockedReason,
        stepsExtracted: discoveredSteps.length,
        durationMs: Date.now() - pipelineStartTime,
      });

      if (discoveredSteps.length > 0) {
        this.trace?.writeFlowStepsExtracted({
          entryPointId: entryPoint.id,
          flowName: entryPoint.name,
          steps: discoveredSteps,
          count: discoveredSteps.length,
        });

        // Emit flow_step events for real-time frontend updates
        for (const step of discoveredSteps) {
          this.emitProgress('flow_step', {
            entryPointId: entryPoint.id,
            name: entryPoint.name,
            stepNumber: step.stepNumber,
            action: step.action,
            description: step.description,
            value: step.value,
            pageUrl: step.pageUrl,
          });
        }
      }

      // 6. Extract errors from pipeline result
      const errors = this.extractErrors(pipelineResult);
      const errorClassification = this.classifyErrors(pipelineResult, errors);

      if (errors.length > 0) {
        this.trace?.writeFlowErrors({
          entryPointId: entryPoint.id,
          flowName: entryPoint.name,
          errors,
          classification: errorClassification,
        });
      }

      // 7. Save auth state if this was a login flow and it succeeded
      if (
        entryPoint.category === 'authentication' &&
        pipelineResult.success &&
        this.config.credentials
      ) {
        await this.stateManager.saveAuthState(context);
        this.loginCompleted = true;
      }

      // 8. Track this flow name for branch dedup
      this.knownFlowNames.push(entryPoint.name);

      // 9. Detect branch points via Scout agent (also for partially-successful flows)
      let branchPoints: EntryPoint[] = [];
      if (pipelineResult.success || pipelineResult.progressScore > 30) {
        branchPoints = await this.detectBranchesWithScout(
          page, entryPoint, discoveredSteps, errors,
          pipelineResult.success ? 'passed' : pipelineResult.blockedReason ? 'blocked' : 'failed',
        );
      }

      // 10. Determine status + extract blocker metadata
      let status: FlowExplorationStatus;
      let blockerType: BlockerType | undefined;
      let canUserHelp: boolean | undefined;

      if (pipelineResult.success) {
        status = 'completed';
      } else if (pipelineResult.blockedReason) {
        status = 'blocked';
        const blockerInfo = this.extractBlockerInfo(pipelineResult.insights, pipelineResult.blockedReason);
        blockerType = blockerInfo.type;
        canUserHelp = blockerInfo.canUserHelp;

        this.trace?.writeFlowBlockerDetected({
          entryPointId: entryPoint.id,
          blockerType,
          canUserHelp,
          reason: pipelineResult.blockedReason,
        });

        // 10a. Request user help for captcha/2FA if possible
        if (
          canUserHelp &&
          (blockerType === 'captcha' || blockerType === '2fa') &&
          this.config.chatSessionId
        ) {
          const clarificationQuestion = blockerType === 'captcha'
            ? 'A CAPTCHA was encountered during exploration. Please solve it in the browser and click "Done".'
            : 'A 2FA verification code is required. Please enter the code.';

          this.trace?.writeFlowUserHelpRequested({
            entryPointId: entryPoint.id,
            type: blockerType === 'captcha' ? 'captcha_solve' : '2fa_code',
            timeoutMs: 120_000,
          });

          const answer = await ClarificationService.requestClarificationViaRedis({
            explorationId: this.config.explorationId,
            chatSessionId: this.config.chatSessionId,
            question: clarificationQuestion,
            type: blockerType === 'captcha' ? 'captcha_solve' : '2fa_code',
            timeout: 120_000,
          });

          this.trace?.writeFlowUserHelpReceived({
            entryPointId: entryPoint.id,
            type: blockerType === 'captcha' ? 'captcha_solve' : '2fa_code',
            received: !!answer,
          });

          if (answer) {
            // User solved it or provided code → retry the flow from the same page
            logger.info('[FLOW_RUNNER] User resolved blocker, retrying flow', {
              name: entryPoint.name,
              blockerType,
            });

            try {
              // If 2FA: type the code the user provided
              if (blockerType === '2fa' && answer !== 'done') {
                const codeInputs = await page.$$('input[type="text"], input[type="tel"], input[type="number"]');
                if (codeInputs.length > 0) {
                  await codeInputs[0].fill(answer);
                  await page.keyboard.press('Enter');
                  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
                }
              }

              // Stop first tracker before creating a new one for retry
              networkTracker.stopTracking();

              // Re-run pipeline from current state
              const retryIntegrations: PipelineIntegrations = {
                page,
                actionExecutor: new ActionExecutor(page),
                networkTracker: new NetworkTracker(page),
                goalDetector: new GoalDetector(entryPoint.goal, entryPoint.id),
                browserContext: context,
                traceWriter: this.trace?.getWriter(),
              };
              const retryPipeline = new TestPipeline(retryIntegrations);
              const retryConfig: PipelineConfig = {
                url: page.url(),
                credentials: this.config.credentials,
                hasCredentials: !!this.config.credentials,
                testId: entryPoint.id,
                maxRounds: Math.max(1, Math.min(5, allocatedRounds)),
                timeoutMs: Math.max(5_000, flowTimeoutMs - (Date.now() - startTime)),
              };
              const retryStartTime = Date.now();
              const retryNetworkTracker = retryIntegrations.networkTracker;
              try {
                const retryResult = await retryPipeline.run(entryPoint.goal, retryConfig);

                if (retryResult.success) {
                  status = 'completed';
                  blockerType = undefined;
                  canUserHelp = undefined;
                  // Merge steps — reuse the same attribution pipeline so
                  // network calls captured during the retry get attached too.
                  const { steps: retrySteps, stepsByRound: retryStepsByRound } = await this.extractSteps(retryResult, page);
                  const retryCalls = this.collectSuccessfulCalls(retryNetworkTracker, retryStartTime);
                  const retryAttributed = attributeCallsToSteps({
                    steps: retrySteps,
                    stepsByRound: retryStepsByRound,
                    rounds: retryResult.rounds,
                    flowStartTime: retryStartTime,
                    successfulCalls: retryCalls,
                  });
                  discoveredSteps.push(...retryAttributed);
                }
              } finally {
                // Must stop the retry tracker — the outer cleanup only stops
                // the original tracker, and leaked trackers keep page listeners alive.
                try { retryNetworkTracker.stopTracking(); } catch { /* best-effort */ }
              }
            } catch (retryError) {
              logger.warn('[FLOW_RUNNER] Retry after user help failed', {
                name: entryPoint.name,
                error: retryError instanceof Error ? retryError.message : String(retryError),
              });
            }
          }
        }
      } else if (Date.now() - startTime >= flowTimeoutMs) {
        status = 'timeout';
      } else {
        status = 'failed';
      }

      // 11. Cleanup — capture the real final URL BEFORE tearing down the page.
      const finalUrl = page.url();
      networkTracker.stopTracking();
      await page.close();
      await this.stateManager.closeContext(context);

      return {
        entryPoint,
        status,
        discoveredSteps,
        branchPoints,
        errors,
        errorClassification,
        durationMs: Date.now() - startTime,
        goalAchieved: pipelineResult.success,
        blockedReason: pipelineResult.blockedReason,
        blockerType,
        canUserHelp,
        progressScore: pipelineResult.progressScore,
        roundsUsed: pipelineResult.roundsExecuted,
        finalUrl,
      };
    } catch (error) {
      // Cleanup on error
      if (context) {
        await this.stateManager.closeContext(context).catch(() => {});
      }
      throw error;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // LOGIN HELPER
  // ═══════════════════════════════════════════════════════════════════════

  private async performLogin(context: BrowserContext): Promise<void> {
    if (!this.config.credentials) return;

    const goals = [
      'Login with provided credentials',
      'Find the email or username input field and fill it with credentials, then find the password field and fill it, then click the login or sign in button to submit the form',
    ];

    // Surface login progress to the UI (frontend reads data.loginUrl / data.success).
    this.emitProgress('auth_started', { loginUrl: this.config.entryUrl });

    for (let attempt = 0; attempt < goals.length; attempt++) {
      const loginStartTime = Date.now();
      try {
        const success = await this.tryLoginWithGoal(context, goals[attempt]);
        this.trace?.writeFlowLoginAttempt({
          goal: goals[attempt],
          attempt,
          success,
          durationMs: Date.now() - loginStartTime,
        });
        if (success) {
          this.emitProgress('auth_completed', { success: true });
          return;
        }
        logger.warn('[FLOW_RUNNER] Login attempt failed', { attempt, goal: goals[attempt] });
      } catch (error) {
        this.trace?.writeFlowLoginAttempt({
          goal: goals[attempt],
          attempt,
          success: false,
          durationMs: Date.now() - loginStartTime,
          error: error instanceof Error ? error.message : String(error),
        });
        logger.warn('[FLOW_RUNNER] Login attempt error', { attempt, error: String(error) });
      }
    }

    this.emitProgress('auth_completed', { success: false });
    logger.warn('[FLOW_RUNNER] All login attempts failed');
  }

  private async tryLoginWithGoal(context: BrowserContext, goal: string): Promise<boolean> {
    const page = await context.newPage();

    // Block third-party requests for faster navigation
    try {
      const { setupThirdPartyBlocker } = await import('@/agent/playwright/execution/third-party-blocker');
      await setupThirdPartyBlocker(page);
    } catch { /* non-fatal */ }

    try {
      if (this.rateLimiter) {
        const canNavigate = await this.rateLimiter.acquireSlot('navigation');
        if (!canNavigate) {
          throw new Error(`Target site degraded, cannot navigate to ${this.config.entryUrl}`);
        }
      }
      try {
        await page.goto(this.config.entryUrl, {
          waitUntil: FLOW_NAV_WAIT_UNTIL,
          timeout: FLOW_NAV_TIMEOUT_MS,
        });
        this.rateLimiter?.recordSuccess('target_site');
      } catch (navError) {
        if (this.rateLimiter && RateLimiter.isRateLimitError(navError as Error)) {
          const result = await this.rateLimiter.recordFailure('target_site', navError as Error);
          if (result.shouldRetry) {
            await page.goto(this.config.entryUrl, {
              waitUntil: FLOW_NAV_WAIT_UNTIL,
              timeout: FLOW_NAV_TIMEOUT_MS,
            });
            this.rateLimiter.recordSuccess('target_site');
          } else {
            throw new Error(`Rate limited navigating to ${this.config.entryUrl}`);
          }
        } else {
          throw navError;
        }
      }

      // Dismiss overlays before login attempt (cookie consent may block login form)
      try {
        await OverlayDismisser.dismissOverlays(page, {
          maxPasses: 2,
          maxTimeMs: 5000,
          mode: 'flow',
        });
      } catch { /* non-fatal */ }

      const actionExecutor = new ActionExecutor(page);
      const networkTracker = new NetworkTracker(page);

      const integrations: PipelineIntegrations = {
        page,
        actionExecutor,
        networkTracker,
        browserContext: context,
        traceWriter: this.trace?.getWriter(),
      };

      const pipeline = new TestPipeline(integrations);
      const result = await pipeline.run(goal, {
        url: page.url(),
        credentials: this.config.credentials,
        hasCredentials: true,
        testId: 'login-for-exploration',
        maxRounds: 5,
        timeoutMs: 60_000,
      });

      networkTracker.stopTracking();
      await page.close();

      if (result.success) {
        // Validate auth state — verify login actually succeeded
        const isStillOnLogin = await this.isStillOnLoginPage(page);
        if (isStillOnLogin) {
          logger.warn('[FLOW_RUNNER] Pipeline reported success but page is still login form');
          return false;
        }

        await this.stateManager.saveAuthState(context);
        this.loginCompleted = true;
        logger.info('[FLOW_RUNNER] Login successful, auth state cached');
        return true;
      }

      return false;
    } catch (error) {
      logger.error('[FLOW_RUNNER] Login error', {
        error: error instanceof Error ? error.message : String(error),
      });
      await page.close().catch(() => {});
      return false;
    }
  }

  /**
   * Check if the page is still on a login form after a login attempt.
   * Validates that the auth state actually changed.
   *
   * On evaluation error we conservatively return `true` (assume still on login):
   * falsely caching a broken auth state causes every downstream auth-gated flow
   * to fail silently, which is worse than one extra login retry.
   */
  private async isStillOnLoginPage(page: Page): Promise<boolean> {
    try {
      const url = page.url().toLowerCase();
      if (/\/(login|signin|sign-in|auth|log-in|sso)\b/i.test(url)) {
        return true;
      }

      // Check if there's still a visible password field (indicates login form still present)
      const hasPasswordField = await page.evaluate(() => {
        const inputs = (globalThis as any).document.querySelectorAll('input[type="password"]');
        for (const input of inputs) {
          const style = (globalThis as any).window.getComputedStyle(input);
          if (style.display !== 'none' && style.visibility !== 'hidden') {
            return true;
          }
        }
        return false;
      });

      return hasPasswordField;
    } catch {
      // Conservative default: treat as still-on-login so caller retries instead
      // of caching a possibly-broken auth state.
      return true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STEP EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract DiscoveredStep[] from pipeline execution rounds.
   * Filters out infrastructure commands (observe_page, wait_for_page).
   *
   * Also returns `stepsByRound`: for each round, the index (in `steps`) of
   * the last interactive step that round emitted, or null if the round
   * produced no user-facing step (pure observe rounds). Used by the network
   * assertion pipeline to attribute captured API calls back to the action
   * that triggered them.
   */
  private async extractSteps(result: TestPipelineResult, page?: Page): Promise<{
    steps: DiscoveredStep[];
    stepsByRound: Array<number | null>;
  }> {
    const steps: DiscoveredStep[] = [];
    const stepsByRound: Array<number | null> = [];
    let stepNumber = 0;

    for (const round of result.rounds) {
      // Use the page URL from the round's snapshot context
      // The snapshot URL is captured before actions execute
      const roundPageUrl = this.extractUrlFromSnapshot(round.pageSnapshotBefore);
      let lastStepIdxInRound: number | null = null;

      for (const executed of round.commands) {
        // Skip failed commands — they produce noise in the final test case
        if (!executed.result.success) continue;

        const step = this.commandToStep(executed, stepNumber + 1, roundPageUrl);
        if (step) {
          step.stepNumber = ++stepNumber;
          // Freeze a compiled locator plan from the element the executor
          // actually acted on. Best-effort: a failure here must never drop
          // the step or fail the flow — the step simply falls back to
          // runtime resolution on first replay (the pre-change behavior).
          await this.attachCompiledPlan(step, executed, roundPageUrl, page);
          steps.push(step);
          lastStepIdxInRound = steps.length - 1;
        }
      }

      stepsByRound.push(lastStepIdxInRound);
    }

    return { steps, stepsByRound };
  }

  /**
   * Build a compiled locator plan for a targeting step from the element the
   * executor resolved at action time (`result.resolvedElement`) and attach it
   * to `step.compiled`. Reuses the same `LocatorPlanBuilder` the preview
   * Run-All and mobile paths use, so exploration-discovered cases hit replay's
   * stage-1 fast path on their first regression run instead of re-resolving
   * every element through the LLM.
   *
   * Passing the live `page` validates each locator (live `count()`), flipping
   * the plan to `unverified: false` and dropping dead locators. With no page
   * the plan is still built but marked `unverified`.
   *
   * Best-effort by contract: any throw is swallowed (step keeps working,
   * just without a frozen plan). PoC scope: click + fill only.
   */
  private async attachCompiledPlan(
    step: DiscoveredStep,
    executed: ExecutedCommand,
    pageUrl: string,
    page?: Page,
  ): Promise<void> {
    const resolvedElement = executed.result.resolvedElement;
    if (!resolvedElement) return;
    // Only element-targeting actions get a compiled locator plan. Non-targeting
    // (navigate/press/scroll) and synthetic (verify) steps have no durable
    // target — they never set `resolvedElement` anyway, but gate explicitly so
    // a future executor change can't silently start compiling them.
    if (!PLAN_WORTHY_ACTIONS.has(step.action)) return;

    try {
      const [node] = adaptLiteElementsToInteractiveNodes([resolvedElement]);
      if (!node) return;

      const intentType = ACTION_TO_INTENT_TYPE[step.action] || 'click';
      // Carry the value only for actions whose value is meaningful to replay
      // (select option / range number / date string / typed text) AND not a
      // credential — secrets must never be frozen into a persisted plan.
      const carriesValue =
        VALUE_CARRYING_ACTIONS.has(step.action) && !step.isSensitive && !!step.value;
      const planStep: IntentStep = {
        id: `step-${step.stepNumber}`,
        type: intentType,
        description: step.description,
        ...(carriesValue ? { value: step.value } : {}),
      };

      const compiled = await LocatorPlanBuilder.buildCompiledPlan({
        step: planStep,
        resolvedNode: node,
        pageUrl,
        page, // live page → validated plan (unverified: false)
      });

      // Only keep a plan that actually carries at least one locator.
      if (compiled?.locatorPlan?.length) {
        step.compiled = compiled;
      }
    } catch (err) {
      logger.debug('[FLOW_RUNNER] Compiled-plan capture skipped', {
        action: step.action,
        ref: step.ref,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Extract URL from formatted snapshot text.
   * Format is typically: "URL: https://... \n Title: ..."
   */
  private extractUrlFromSnapshot(snapshot: string): string {
    const match = snapshot.match(/URL:\s*(\S+)/i);
    return match?.[1] || '';
  }

  /**
   * Pull the successful-responses list from NetworkTracker. Wrapped so a
   * tracker missing the getter (e.g. a partial test mock) degrades to an
   * empty list instead of blowing up the flow.
   */
  private collectSuccessfulCalls(
    tracker: NetworkTracker,
    sinceMs: number,
  ): NetworkSuccess[] {
    try {
      if (typeof tracker?.getSuccessfulResponsesSince !== 'function') return [];
      return tracker.getSuccessfulResponsesSince(sinceMs) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Convert a single executed command to a DiscoveredStep.
   * Returns null for infrastructure commands.
   */
  private commandToStep(executed: ExecutedCommand, stepNumber: number, pageUrl: string): DiscoveredStep | null {
    const cmd = executed.command;
    // Use result.output for human-readable descriptions (e.g. 'Clicked "CONTACT" (a)')
    // Strip [POST-ACTION: ...] suffix — it's internal context, not user-facing
    const output = (executed.result.output || '').replace(/\s*\[POST-ACTION:.*$/s, '').trim();

    switch (cmd.name) {
      case 'fill_field':
        return {
          stepNumber,
          description: output || `Fill "${cmd.args.ref}" with ${cmd.args.is_sensitive ? '[credential]' : `"${cmd.args.value}"`}`,
          action: 'fill',
          ref: cmd.args.ref,
          value: cmd.args.is_sensitive ? undefined : cmd.args.value,
          isSensitive: cmd.args.is_sensitive,
          pageUrl,
          expectedOutcome: 'Field is filled with the value',
        };

      case 'click_element':
        return {
          stepNumber,
          description: output || `Click "${cmd.args.ref}"`,
          action: 'click',
          ref: cmd.args.ref,
          pageUrl,
          expectedOutcome: executed.result.success ? 'Element clicked successfully' : undefined,
        };

      case 'select_option':
        return {
          stepNumber,
          description: output || `Select option "${cmd.args.value}" in "${cmd.args.ref}"`,
          action: 'select',
          ref: cmd.args.ref,
          value: cmd.args.value,
          pageUrl,
        };

      case 'press_key':
        return {
          stepNumber,
          description: output || `Press key "${cmd.args.key}"`,
          action: 'press',
          value: cmd.args.key,
          pageUrl,
        };

      case 'hover_element':
        return {
          stepNumber,
          description: output || `Hover over "${cmd.args.ref}"`,
          action: 'hover',
          ref: cmd.args.ref,
          pageUrl,
        };

      case 'scroll_page':
      case 'scroll_to_element':
        return {
          stepNumber,
          description: output || (cmd.name === 'scroll_to_element'
            ? `Scroll to element "${cmd.args.ref}"`
            : `Scroll ${cmd.args.direction || 'down'}`),
          action: 'scroll',
          ref: cmd.args.ref,
          pageUrl,
        };

      case 'navigate_to':
        return {
          stepNumber,
          description: output || `Navigate to ${cmd.args.url}`,
          action: 'navigate',
          value: cmd.args.url,
          pageUrl,
        };

      case 'toggle_element':
        return {
          stepNumber,
          description: output || `Toggle "${cmd.args.ref}"`,
          action: 'toggle',
          ref: cmd.args.ref,
          pageUrl,
          expectedOutcome: 'Element toggled successfully',
        };

      case 'set_range':
        return {
          stepNumber,
          description: output || `Set range "${cmd.args.ref}" to "${cmd.args.value}"`,
          action: 'setRange',
          ref: cmd.args.ref,
          value: cmd.args.value,
          pageUrl,
        };

      case 'select_date':
        return {
          stepNumber,
          description: output || `Set date "${cmd.args.ref}" to "${cmd.args.value}"`,
          action: 'selectDate',
          ref: cmd.args.ref,
          value: cmd.args.value,
          pageUrl,
        };

      case 'clear_field':
        return {
          stepNumber,
          description: output || `Clear field "${cmd.args.ref}"`,
          action: 'clear',
          ref: cmd.args.ref,
          pageUrl,
        };

      case 'mark_done':
        return {
          stepNumber,
          description: `Verify: ${cmd.args.evidence || 'Goal achieved'}`,
          action: 'verify',
          pageUrl,
          expectedOutcome: cmd.args.evidence,
        };

      // Skip infrastructure commands
      case 'observe_page':
      case 'wait_for_page':
      case 'report_blocked':
        return null;

      default:
        logger.debug('[FLOW_RUNNER] Unmapped command, skipping', { command: cmd.name });
        return null;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ERROR EXTRACTION & CLASSIFICATION
  // ═══════════════════════════════════════════════════════════════════════

  private extractErrors(result: TestPipelineResult): FlowError[] {
    const errors: FlowError[] = [];
    let stepNumber = 0;

    for (const round of result.rounds) {
      for (const executed of round.commands) {
        stepNumber++;
        if (!executed.result.success && executed.result.error) {
          errors.push({
            source: 'playwright',
            message: executed.result.error,
            severity: 'error',
            stepNumber,
            recovered: false, // Will be updated below
            context: `Command: ${executed.command.name}`,
          });
        }
      }
    }

    // Mark errors as recovered if the overall flow succeeded
    // (meaning the agent worked around the error)
    if (result.success) {
      for (const error of errors) {
        error.recovered = true;
      }
    } else if (errors.length > 1) {
      // If flow failed, mark all errors except the last one as recovered
      // (the last error is likely the one that actually blocked progress)
      for (let i = 0; i < errors.length - 1; i++) {
        errors[i].recovered = true;
      }
    }

    // Add blocked reason as a critical error
    if (result.blockedReason) {
      errors.push({
        source: 'ai',
        message: result.blockedReason,
        severity: 'critical',
        stepNumber: 0,
        recovered: false,
        context: 'Flow blocked',
      });
    }

    return errors;
  }

  private classifyErrors(
    result: TestPipelineResult,
    errors: FlowError[],
  ): ErrorClassification {
    if (errors.length === 0) return 'no_errors';

    // Check for blocking errors
    if (result.blockedReason) return 'blocking';

    // Check for app bugs (500 errors, JS crashes)
    const hasCritical = errors.some((e) => e.severity === 'critical' && !e.recovered);
    if (hasCritical) return 'app_bug';

    // Check if all errors were recovered
    const allRecovered = errors.every((e) => e.recovered);
    if (allRecovered) return 'recoverable';

    // Default to blocking if flow failed
    if (!result.success) return 'blocking';

    return 'recoverable';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BLOCKER EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract blocker type and canUserHelp from pipeline insights.
   * CommandExecutor writes: "BLOCKED [captcha]: CAPTCHA required (user can help unblock)"
   */
  private extractBlockerInfo(insights: string[], blockedReason?: string): {
    type: BlockerType;
    canUserHelp: boolean;
  } {
    const VALID_BLOCKER_TYPES: BlockerType[] = [
      'captcha', '2fa', 'payment', 'external_service', 'login_wall', 'file_upload', 'other',
    ];

    // 1. Strongest signal: explicit BLOCKED [type] from report_blocked command
    for (const insight of insights) {
      const match = insight.match(/BLOCKED\s*\[(\w+)]/i);
      if (match) {
        const rawType = match[1].toLowerCase();
        const type = VALID_BLOCKER_TYPES.includes(rawType as BlockerType)
          ? (rawType as BlockerType)
          : 'other';
        const canUserHelp = insight.includes('user can help');
        return { type, canUserHelp };
      }
    }

    // 2. Keyword heuristics — search insights AND blockedReason (ReviewerAgent's verdict).
    //    blockedReason often contains the real reason when ReviewerAgent says "blocked"
    //    but doesn't add a BLOCKED [...] formatted insight.
    //    IMPORTANT: Only match specific captcha indicators (cloudflare, recaptcha, hcaptcha),
    //    NOT generic "verification" which could be form validation.
    const searchText = [...insights, blockedReason || ''].join(' ').toLowerCase();

    // Captcha: require specific captcha product names or "captcha" keyword
    if (
      searchText.includes('captcha') ||
      searchText.includes('cloudflare') ||
      searchText.includes('recaptcha') ||
      searchText.includes('hcaptcha')
    ) {
      return { type: 'captcha', canUserHelp: true };
    }

    if (searchText.includes('2fa') || searchText.includes('two-factor') || searchText.includes('verification code') || searchText.includes('authenticator'))
      return { type: '2fa', canUserHelp: true };
    if (searchText.includes('payment') || searchText.includes('credit card') || searchText.includes('stripe'))
      return { type: 'payment', canUserHelp: false };
    if (searchText.includes('file upload'))
      return { type: 'file_upload', canUserHelp: false };
    if (searchText.includes('login') || searchText.includes('sign in') || searchText.includes('auth'))
      return { type: 'login_wall', canUserHelp: true };

    // Default: "other" — NOT captcha. Most blocked flows are stuck/validation issues.
    return { type: 'other', canUserHelp: false };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BRANCH DETECTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Scout-based branch detection — delegates AI call to Scout agent.
   * Keeps overlay dismissal + snapshot collection in FlowRunner.
   */
  private async detectBranchesWithScout(
    page: Page,
    completedEntry: EntryPoint,
    discoveredSteps: DiscoveredStep[],
    errors: FlowError[],
    flowStatus: 'passed' | 'failed' | 'blocked',
  ): Promise<EntryPoint[]> {
    try {
      // Dismiss post-flow overlays (reuse existing logic)
      try {
        await OverlayDismisser.dismissOverlays(page, { maxPasses: 2, maxTimeMs: 3000, mode: 'flow' });
      } catch { /* non-fatal */ }

      try {
        await VisualStability.waitForPageReady(page, { timeout: 3000 });
      } catch { /* non-fatal */ }

      const snapshot = await SnapshotRouter.collect(page, { context: 'exploration-flow', fullPage: true });

      // Collect known pages from blackboard (prevents Scout from re-discovering surveyed pages)
      const knownPages = this.blackboard?.tree?.getAllNodes?.()?.map((n: any) => n.url) ?? [];

      // Look up Cartographer insight for the current page (enriches Scout's context)
      const pageInsight = this.findPageInsight(page.url());

      const scoutInput: ScoutInput = {
        completedFlow: {
          name: completedEntry.name,
          goal: completedEntry.goal,
          category: completedEntry.category,
          status: flowStatus,
          steps: discoveredSteps,
          finalUrl: page.url(),
          errorsFound: errors.length,
        },
        snapshot,
        knownFlows: [...this.knownFlowNames],
        knownPages,
        pageInsight,
        flowsRemaining: this.budget.remainingFlows(),
      };

      const scoutResult = await this.scout.detect(scoutInput);

      // Record the discovery on the blackboard so the Strategist's re-evaluation
      // can see what Scout surfaced (insight + new pages/flows). Without this the
      // recentDiscoveries channel stays empty and re-strategy is blind to Scout.
      if (this.blackboard && (scoutResult.newEntryPoints.length > 0 || scoutResult.newPages.length > 0)) {
        this.blackboard.discoveredBranches.push(
          Scout.toDiscovery(completedEntry.id, completedEntry.name, scoutResult),
        );
      }

      // Filter out branches discovered on external domains
      const currentOrigin = new URL(page.url()).origin;
      const entryOrigin = new URL(this.config.entryUrl).origin;
      const isExternalPage = currentOrigin !== entryOrigin;

      if (isExternalPage) {
        logger.info('[FLOW_RUNNER] Skipping Scout branches — flow ended on external domain', {
          flow: completedEntry.name,
          pageOrigin: currentOrigin,
          entryOrigin,
          branchesSkipped: scoutResult.newEntryPoints.length,
        });
        return [];
      }

      return scoutResult.newEntryPoints.map((bp, index) => ({
        ...bp,
        id: `ep-scout-${completedEntry.id}-${index}`,
        sourceNodeId: completedEntry.sourceNodeId,
        sourcePageUrl: page.url(),
      }));
    } catch (error) {
      logger.warn('[FLOW_RUNNER] Scout branch detection failed', {
        flow: completedEntry.name,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Look up Cartographer insight for a given URL from the blackboard.
   * Used to enrich Scout input with cross-page knowledge.
   */
  private findPageInsight(url: string): CartographerInsight | undefined {
    if (!this.blackboard?.pageInsights) return undefined;
    const normalized = this.normalizeUrl(url);

    // Direct lookup: match pageInsight key by normalized URL via tree node
    const nodes = this.blackboard.tree?.getAllNodes?.() ?? [];
    for (const node of nodes) {
      if (this.normalizeUrl(node.url) === normalized) {
        // pageInsights map is keyed by pageId
        const insight = this.blackboard.pageInsights.get(node.id || '');
        if (insight) return insight;
      }
    }

    // Fallback: iterate all insights and match by related pages
    for (const [, insight] of this.blackboard.pageInsights) {
      if (insight.relatedPages?.some(rp => this.normalizeUrl(rp) === normalized)) {
        return insight;
      }
    }

    return undefined;
  }

  private normalizeUrl(url: string): string {
    return normalizeUrlWithPattern(url);
  }

  /**
   * Promise-chaining mutex for login — ensures only one login attempt at a time.
   * Same pattern as BudgetTracker.withMutex.
   */
  private async withLoginMutex<T>(fn: () => Promise<T>): Promise<T> {
    const prev = this.loginMutex;
    let resolve: () => void;
    this.loginMutex = new Promise<void>((r) => { resolve = r; });
    await prev;
    try {
      return await fn();
    } finally {
      resolve!();
    }
  }

  /**
   * LEGACY: After a flow completes, analyze the final page for new entry points.
   * Kept as reference — new code uses detectBranchesWithScout() above.
   */
  private async detectBranchPoints(
    page: Page,
    completedEntry: EntryPoint,
    existingFlowNames: string[] = [],
    flowOutcome?: string,
  ): Promise<EntryPoint[]> {
    // Skip if OpenAI is degraded — branch detection is optional enrichment
    if (this.rateLimiter?.isDegraded('openai')) {
      return [];
    }

    try {
      // Dismiss post-flow overlays (success modals, toasts) before branch detection snapshot
      let branchOverlaySummary: string | null = null;
      try {
        const overlayResult = await OverlayDismisser.dismissOverlays(page, {
          maxPasses: 2,
          maxTimeMs: 3000,
          mode: 'flow',
        });
        branchOverlaySummary = overlayResult.overlaySummary;
        if (overlayResult.overlaysDetected > 0) {
          logger.debug('[FLOW_RUNNER] Pre-branch-detection overlay cleanup', {
            flow: completedEntry.name,
            detected: overlayResult.overlaysDetected,
            dismissed: overlayResult.attempts.filter(a => a.dismissed).length,
          });
        }
      } catch {
        // Non-fatal: proceed with snapshot even if overlay cleanup fails
      }

      // Wait for network + DOM + loading state before branch detection snapshot
      try {
        await VisualStability.waitForPageReady(page, { timeout: 3000 });
      } catch {
        // Non-fatal
      }

      const snapshot = await SnapshotRouter.collect(page, { context: 'exploration-flow', fullPage: true });
      const formattedSnapshot = SnapshotCollector.format(snapshot);

      const prompt = buildBranchDetectionPrompt({
        formattedSnapshot,
        url: page.url(),
        completedFlowName: completedEntry.name,
        completedFlowGoal: completedEntry.goal,
        existingFlowNames,
        overlaySummary: branchOverlaySummary ?? undefined,
        hasCredentials: !!this.config.credentials,
        flowOutcome,
      });

      if (this.rateLimiter) await this.rateLimiter.acquireSlot('ai');

      const branchSystemPrompt = 'You are a QA test discovery agent. Identify new testable flows on the current page. Respond with valid JSON only.';

      this.trace?.writeBranchDetectionPrompt({
        entryPointId: completedEntry.id,
        model: AI_MODELS.fast,
        systemPrompt: branchSystemPrompt,
        userPrompt: prompt,
      });

      const branchAiStartTime = Date.now();

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            { role: 'system', content: branchSystemPrompt },
            { role: 'user', content: prompt },
          ],
          {
            model: AI_MODELS.fast,
            temperature: 0.2,
            max_tokens: 1000,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Branch detection timeout')), 10_000),
        ),
      ]);

      this.rateLimiter?.recordSuccess('openai');
      const branches = parseBranchDetectionResponse(response.content);

      this.trace?.writeBranchDetectionResponse({
        entryPointId: completedEntry.id,
        model: AI_MODELS.fast,
        rawResponse: response.content,
        parsedBranches: branches.map(b => ({ name: b.name, category: b.category, priority: b.priority })),
        latencyMs: Date.now() - branchAiStartTime,
      });

      return branches.map((bp, index) => ({
        ...bp,
        id: `ep-branch-${completedEntry.id}-${index}`,
        sourceNodeId: completedEntry.sourceNodeId,
        sourcePageUrl: page.url(),
      }));
    } catch (error) {
      if (this.rateLimiter && RateLimiter.isRateLimitError(error as Error)) {
        await this.rateLimiter.recordFailure('openai', error as Error);
        // No retry — branch detection is optional enrichment
      }
      logger.warn('[FLOW_RUNNER] Branch detection failed — discovery quality degraded', {
        flow: completedEntry.name,
        error: error instanceof Error ? error.message : String(error),
        isTimeout: error instanceof Error && error.message.includes('timeout'),
      });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // HELPER FACTORIES
  // ═══════════════════════════════════════════════════════════════════════

  private createSkippedTask(entryPoint: EntryPoint, reason: string): FlowExplorationTask {
    return {
      entryPoint,
      status: 'skipped',
      discoveredSteps: [],
      branchPoints: [],
      errors: [],
      errorClassification: 'no_errors',
      durationMs: 0,
      goalAchieved: false,
      progressScore: 0,
      roundsUsed: 0,
      infraError: reason,
    };
  }

  private createFailedTask(entryPoint: EntryPoint, error: unknown): FlowExplorationTask {
    return {
      entryPoint,
      status: 'failed',
      discoveredSteps: [],
      branchPoints: [],
      errors: [{
        source: 'playwright',
        message: error instanceof Error ? error.message : String(error),
        severity: 'critical',
        stepNumber: 0,
        recovered: false,
        context: 'Infrastructure error',
      }],
      errorClassification: 'blocking',
      durationMs: 0,
      goalAchieved: false,
      progressScore: 0,
      roundsUsed: 0,
      infraError: error instanceof Error ? error.message : String(error),
    };
  }
}
