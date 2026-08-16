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
import type { PipelineConfig, TestPipelineResult, ExecutionRound } from '../pipeline/types';
import type { FormAnalysis } from '../agents/types';
import { formatBriefForPlanner } from './phase0/brief-format';
import { ActionExecutor } from '../execution/action-executor';
import { NetworkTracker } from '../collectors/network-tracker';
import { GoalDetector } from '../analysis/goal-detector';
import { SnapshotCollector } from '../collectors/snapshot-collector';
import { SnapshotRouter } from '@/services/testing/ui/preview/snapshot-router.service';
import { OverlayDismisser } from './overlay-dismisser';
import { buildSelfContainedSteps, type RecordedDismissal } from './overlay-step.util';
import { VisualStability } from '../collectors/visual-stability';

import {
  type ExplorationConfig,
  type EntryPoint,
  type FlowExplorationTask,
  type FlowExplorationStatus,
  type FlowRunnerCheckpoint,
  type DiscoveredStep,
  type FlowError,
  type ErrorClassification,
  type BlockerType,
  type ExplorationProgressCallback,
  DEFAULT_MAX_CONCURRENCY,
  categoryAllowsAssertAuthoring,
} from './types';
import type { NetworkSuccess } from '../lite-types';
import { attributeCallsToSteps } from './network-assertions';
import { extractDiscoveredSteps } from './pipeline-step-extractor';
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
import type { ScoutInput, ExplorationBlackboard, CartographerInsight } from './agents/agent-types';
import { normalizeUrlWithPattern } from './url-pattern';
import { recordFlowOutcome } from './agents/blackboard';
import { buildPriorLearnings } from './prior-learnings';
import { buildFlowStepPayload } from './flow-step-feed';
import { redactCredentialValues } from '@/utils/interpolation/redact-secrets';

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
 * Page-insight hint sent to the Planner (forms / interactive areas / entities).
 * Caps keep the hint compact so it informs without bloating the prompt budget.
 */
const PAGE_INSIGHT_MAX_ITEMS_PER_LIST = 4;
/**
 * Raised from 300 when form FIELD LABELS replaced a bare `forms: N` count. A
 * checkout form's labels alone can run ~120 chars, and truncating mid-list is
 * worse than a slightly longer hint: a Planner that sees half a field list will
 * confidently submit an incomplete form.
 */
const PAGE_INSIGHT_MAX_CHARS = 600;
/** Field labels shown per form before collapsing to `+N`. */
const PAGE_INSIGHT_MAX_FORM_FIELDS = 6;

/**
 * Separate cap for the Phase 0 brief slice prepended to the Planner's context.
 * Kept independent of `PAGE_INSIGHT_MAX_CHARS` so a verbose brief can never
 * squeeze out the page understanding — they answer different questions ("what is
 * this flow for" vs "what is on this page") and the Planner needs both.
 */
const PLANNER_BRIEF_MAX_CHARS = 700;


// Step-extraction (rounds → DiscoveredStep + compiled plans) now lives in the
// shared pipeline-step-extractor so the editor iterative-authoring service
// builds steps identically. Re-export the gate constants for backward compat
// (exploration-qa.test.ts imports them from here).
export { PLAN_WORTHY_ACTIONS, VALUE_CARRYING_ACTIONS } from './pipeline-step-extractor';

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
  /**
   * Per-flow live step counter (entryPointId → last emitted stepNumber).
   * Rounds restart their own numbering at 1, but the frontend dedups on
   * stepNumber, so the sequence has to be continuous across the whole flow.
   * Flows run concurrently, hence a map rather than a single counter.
   */
  private readonly flowStepCounters = new Map<string, number>();
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

  /**
   * Ask the caller whether the run has been cancelled and, if so, flip the
   * budget — every loop condition here already gates on `isExhausted()`.
   *
   * Best-effort in both directions: no probe configured means no cancellation,
   * and a throwing probe is swallowed. A transient status-read failure must
   * never abort a healthy run; it only delays the stop to the next check.
   */
  private async pollCancellation(): Promise<void> {
    if (!this.config.onCancelCheck || this.budget.isCancelled()) return;
    try {
      if (await this.config.onCancelCheck()) {
        this.budget.cancel();
        logger.info('[FLOW_RUNNER] Cancellation detected — draining queue, in-flight flows will finish');
      }
    } catch { /* a failed probe is not a cancellation */ }
  }

  isLoginCompleted(): boolean {
    return this.loginCompleted;
  }

  getKnownFlowNames(): string[] {
    return [...this.knownFlowNames];
  }

  /** Cached auth storageState from this runner's login, for handoff to another runner. Null before login. */
  getAuthState(): object | null {
    return this.stateManager.getAuthState();
  }

  restoreFromCheckpoint(cp: FlowRunnerCheckpoint): void {
    this.knownFlowNames = [...cp.knownFlowNames];
    this.flowsCompleted = cp.flowsCompleted;
    // Reuse the prior runner's session: preload auth state so a runner that
    // inherits loginCompleted=true actually has the cookies to back it up
    // (otherwise createAuthenticatedContext falls through to a clean, logged-out
    // context and every auth-gated flow silently runs unauthenticated).
    if (cp.authState) {
      this.stateManager.preloadAuthState(cp.authState);
    }
    // Honor loginCompleted ONLY when a session actually backs it — either the
    // authState we just preloaded (Phase 2.5 in-process handoff) or a fixture
    // preloaded by the constructor. The ON-DISK checkpoint deliberately does
    // NOT persist authState (session cookies at rest), so a crash-resume lands
    // here with loginCompleted=true and no cookies; keeping the flag would skip
    // performLogin AND get a clean context = every auth flow silently logged
    // out. Dropping the flag costs one re-login on demand instead.
    this.loginCompleted = cp.loginCompleted && this.stateManager.hasAuthState();
    if (cp.loginCompleted && !this.loginCompleted) {
      logger.info('[FLOW_RUNNER] Checkpoint had loginCompleted but no auth state — will re-login on demand');
    }
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

  /**
   * Stream one `flow_step` per command as the round that ran them completes.
   *
   * Wired to `PipelineIntegrations.onRoundComplete`, the same hook the editor
   * authoring service uses for `preview:run:step`. Replaces a loop that ran
   * AFTER the whole flow finished, over `extractSteps` output — which had
   * already dropped every failed command and hardcoded `success: true`, so the
   * "live" feed was neither live nor capable of showing a failure.
   *
   * `result.success` is the executor's real per-command verdict, so a failed
   * click now reaches the UI as a failure instead of vanishing.
   *
   * Best-effort by contract: the pipeline swallows a throwing listener, but do
   * not rely on that — a broken feed must never fail the flow it reports on.
   */
  private emitRoundSteps(entryPoint: EntryPoint, round: ExecutionRound, page?: Page): void {
    if (!this.onProgress) return;
    try {
      // `CommandResult` carries no per-command URL, so read the live page once
      // per round rather than inventing a field. Best-effort: a closed page
      // must not break the feed.
      let pageUrl: string | undefined;
      try {
        pageUrl = page?.url();
      } catch { /* page gone — omit the URL rather than fail */ }

      for (const executed of round.commands) {
        // `stepNumber` must stay 1-based and monotonic per flow (see
        // buildFlowStepPayload) — but only INCREMENT for a command that is
        // actually emitted, so a filtered infrastructure command cannot leave a
        // gap the frontend reads as a lost step. Hence the payload is built
        // first, and the counter advances only if it survived.
        const candidate = buildFlowStepPayload(executed, {
          stepNumber: (this.flowStepCounters.get(entryPoint.id) ?? 0) + 1,
          roundNumber: round.roundNumber,
          pageUrl,
          credentials: this.config.credentials,
        });
        if (!candidate) continue;

        this.flowStepCounters.set(entryPoint.id, candidate.stepNumber);
        this.emitProgress('flow_step', {
          entryPointId: entryPoint.id,
          name: entryPoint.name,
          ...candidate,
        });
      }
    } catch (error) {
      logger.debug('[FLOW_RUNNER] Failed to emit round steps', {
        entryPointId: entryPoint.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MAIN EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Run all flows from the queue with bounded concurrency.
   * Returns completed FlowExplorationTask[] (including failed ones).
   */
  async runAll(queue: FlowQueue): Promise<FlowExplorationTask[]> {
    const maxConcurrency = this.config.maxConcurrency || DEFAULT_MAX_CONCURRENCY;
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
      // Poll for cancellation once per iteration — i.e. after each flow
      // completes. The loop conditions below all read `isExhausted()`, which
      // `cancel()` satisfies, so setting the flag here is what makes a cancel
      // land BETWEEN flows instead of only at the engine's phase boundaries
      // (which would mean waiting out the entire flow phase). One indexed
      // lookup per completed flow, against flows that take tens of seconds.
      await this.pollCancellation();
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

      // Fold this flow into working memory BEFORE the next one starts, so its
      // Planner can read it. `bb.completedFlows` is only filled after Phase 2
      // returns, which is far too late to inform anything inside Phase 2.
      this.recordOutcomeInWorkingMemory(task);

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
        // Human-readable blocker reason + whether the user can unblock it
        // (CAPTCHA/2FA/login). The FE renders these live on a blocked flow;
        // both are populated alongside blockerType when status==='blocked'.
        blockerReason: task.blockedReason || undefined,
        canUserHelp: task.canUserHelp ?? undefined,
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
        // 2FA — strong authenticator-2FA anchors only. "verification code"/"otp"
        // are ambiguous (SMS/phone confirmation, password recovery) and were
        // mislabelling those as 2FA. Kept in sync with extractBlockerInfo below.
      } else if (lowerErr.includes('2fa') || lowerErr.includes('two-factor') || lowerErr.includes('two factor') || lowerErr.includes('authenticator') || lowerErr.includes('totp')) {
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

      // An infra-level failure is a learning too — recorded AFTER the blocker
      // classification above, so the memory carries the classified reason
      // ("Rate limited by target site") rather than a raw stack message.
      this.recordOutcomeInWorkingMemory(task);

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

      // Overlay dismissals recorded across this flow (pre-pipeline here +
      // intra-round from the pipeline) → prepended as replayable steps so a
      // re-run clears the same overlays instead of stalling on them.
      const recordedDismissals: RecordedDismissal[] = [];

      // 2.5. Dismiss overlays before pipeline starts (cookie consent, promo modals)
      try {
        const overlayResult = await OverlayDismisser.dismissOverlays(page, {
          maxPasses: 2,
          maxTimeMs: 5000,
          mode: 'flow',
        });
        for (const attempt of overlayResult.attempts) {
          if (attempt.dismissed) recordedDismissals.push({ attempt, pageUrl: page.url() });
        }
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
      const actionExecutor = new ActionExecutor(page, { timeoutProfile: 'fast' });
      const networkTracker = new NetworkTracker(page);
      const goalDetector = new GoalDetector(entryPoint.goal, entryPoint.id);

      const integrations: PipelineIntegrations = {
        page,
        actionExecutor,
        networkTracker,
        goalDetector,
        browserContext: context,
        traceWriter: this.trace?.getWriter(),
        // Live per-step feed: fires as each round finishes, carrying the real
        // per-command result (see emitRoundSteps).
        onRoundComplete: (round) => this.emitRoundSteps(entryPoint, round, page),
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
        // Auth flows EXPECT to land on a login URL — tell the page-health
        // check so it doesn't misread that as a "session lost" regression.
        flowIsAuth: entryPoint.category === 'authentication',
        // Let the Executor freeze a deterministic text assertion, so a discovered
        // case re-verifies a real value on replay instead of relying solely on the
        // terminal ai_check self-judge. Safe autonomously because the value itself
        // is screened by `checkAssertVolatility` — see invariant #24.
        enableAssertAuthoring: categoryAllowsAssertAuthoring(entryPoint.category),
        // Hand the Planner the Cartographer's understanding of this page so it
        // plans against known forms/entities instead of re-deriving from DOM.
        pageInsightContext: this.formatPageInsightContext(page.url(), entryPoint.name),
        // Cross-flow memory: what sibling flows accomplished / got blocked on +
        // strategy focus, so the Planner reuses their outcomes (invariant #10 safe).
        priorLearnings: this.formatPriorLearnings(),
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
      const { steps: baseSteps, stepsByRound } = await extractDiscoveredSteps(pipelineResult, page);
      const successfulCalls = this.collectSuccessfulCalls(networkTracker, pipelineStartTime);
      const discoveredSteps = attributeCallsToSteps({
        steps: baseSteps,
        stepsByRound,
        rounds: pipelineResult.rounds,
        flowStartTime: pipelineStartTime,
        successfulCalls,
      });

      // Merge intra-round dismissals (from the pipeline) with the pre-pipeline
      // ones. `recordedDismissals` now holds every overlay the agent cleared
      // during this flow, in roughly the order they were encountered.
      recordedDismissals.push(...pipelineResult.dismissals);

      // NOTE: the SELF-CONTAINED step list is built LATER, just before the
      // return — NOT here. A 2FA/CAPTCHA retry branch below can still append to
      // `discoveredSteps` + `recordedDismissals`; building the list here would
      // snapshot it pre-retry and silently drop the retry's actions/dismissals
      // from the saved test case. See buildSelfContainedSteps at the return.

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
      /**
       * Goal/progress outcome as of the LATEST attempt. Tracked separately from
       * `pipelineResult` because the recovery retry below can succeed after the
       * first attempt failed: the retry set `status='completed'` but the return
       * still read `pipelineResult.success`, so a genuinely recovered flow was
       * saved as `goalAchieved: false` → TestCaseBuilder marked it `'failed'`
       * while `status` said `'completed'`, and the summary counted it in BOTH
       * `flowsPassed`-eligible and `flowsFailed`.
       */
      let effectiveGoalAchieved = pipelineResult.success;
      let effectiveProgressScore = pipelineResult.progressScore;
      let effectiveRoundsUsed = pipelineResult.roundsExecuted;
      let effectiveBlockedReason = pipelineResult.blockedReason;

      if (pipelineResult.success) {
        status = 'completed';
      } else if (pipelineResult.blockedReason) {
        status = 'blocked';
        // Prefer the STRUCTURED blocker the Executor reported (report_blocked →
        // pipelineResult.blockerType) over keyword-guessing the reason string;
        // fall back to keyword extraction when the Executor didn't set one.
        if (pipelineResult.blockerType) {
          blockerType = pipelineResult.blockerType as BlockerType;
          canUserHelp = pipelineResult.canUserHelp ?? true;
        } else {
          const blockerInfo = this.extractBlockerInfo(pipelineResult.insights, pipelineResult.blockedReason);
          blockerType = blockerInfo.type;
          canUserHelp = blockerInfo.canUserHelp;
        }

        this.trace?.writeFlowBlockerDetected({
          entryPointId: entryPoint.id,
          blockerType,
          canUserHelp,
          // The blocked reason is an LLM summary, but it can quote a page string
          // that echoed a credential — redact before it lands in the (now
          // prod-uploaded) trace. Belt-and-suspenders for invariant #10.
          reason: redactCredentialValues(pipelineResult.blockedReason || '', this.config.credentials),
        });

        // 10a. Request user help for a user-resolvable blocker. captcha/2fa ask
        // the user to solve/enter a code; needs_data asks for a real value the
        // agent could not invent (promo/referral code, account number, a
        // one-time code that isn't strictly 2FA) — the user types it, we fill it
        // into the blocking field, and the flow retries. (login_wall is NOT here:
        // supplying credentials mid-run needs a dedicated SECURE form, not this
        // free-text channel — see the credentials note; it stays blocked today.)
        if (
          canUserHelp &&
          (blockerType === 'captcha' || blockerType === '2fa' || blockerType === 'needs_data') &&
          this.config.chatSessionId
        ) {
          const clarificationType: 'captcha_solve' | '2fa_code' | 'test_data' =
            blockerType === 'captcha' ? 'captcha_solve'
            : blockerType === '2fa' ? '2fa_code'
            : 'test_data';

          const clarificationQuestion =
            blockerType === 'captcha'
              ? 'A CAPTCHA was encountered during exploration. Please solve it in the browser and click "Done".'
              : blockerType === '2fa'
                ? 'A 2FA verification code is required. Please enter the code.'
                // needs_data: surface the executor's reason so the user knows WHAT
                // value is being asked for (redacted — it's a page-derived string).
                : `The exploration needs a value to continue: ${redactCredentialValues(
                    pipelineResult.blockedReason || 'a required field value',
                    this.config.credentials,
                  )}. Please provide it.`;

          this.trace?.writeFlowUserHelpRequested({
            entryPointId: entryPoint.id,
            type: clarificationType,
            timeoutMs: 120_000,
          });

          const answer = await ClarificationService.requestClarificationViaRedis({
            explorationId: this.config.explorationId,
            chatSessionId: this.config.chatSessionId,
            question: clarificationQuestion,
            type: clarificationType,
            timeout: 120_000,
          });

          this.trace?.writeFlowUserHelpReceived({
            entryPointId: entryPoint.id,
            type: clarificationType,
            received: !!answer,
          });

          if (answer) {
            // User solved it or provided code → retry the flow from the same page
            logger.info('[FLOW_RUNNER] User resolved blocker, retrying flow', {
              name: entryPoint.name,
              blockerType,
            });

            try {
              // 2FA or needs_data: type the user-provided value into the first
              // editable field, then submit. (captcha is solved in-browser by the
              // user, so there's nothing to type — answer is just the 'done'
              // sentinel.) Best-effort: if no input is found the retry still runs
              // and the Planner re-observes.
              if ((blockerType === '2fa' || blockerType === 'needs_data') && answer !== 'done') {
                const codeInputs = await page.$$('input[type="text"], input[type="tel"], input[type="number"], input[type="email"]');
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
                actionExecutor: new ActionExecutor(page, { timeoutProfile: 'fast' }),
                networkTracker: new NetworkTracker(page),
                goalDetector: new GoalDetector(entryPoint.goal, entryPoint.id),
                browserContext: context,
                traceWriter: this.trace?.getWriter(),
                // Keep the live feed running through the recovery retry too —
                // otherwise the UI goes silent exactly when a flow is struggling.
                onRoundComplete: (round) => this.emitRoundSteps(entryPoint, round, page),
              };
              const retryPipeline = new TestPipeline(retryIntegrations);
              const retryConfig: PipelineConfig = {
                url: page.url(),
                credentials: this.config.credentials,
                hasCredentials: !!this.config.credentials,
                testId: entryPoint.id,
                // Exploration testIds are non-UUID (ep-N); without this the retry
                // pipeline keeps hitting the DB cancellation lookup for a row that
                // doesn't exist (wasted 5s DB race + warning spam) — the primary
                // config sets it too.
                skipDbCancellationCheck: true,
                // entryPointId ties retry round/command traces back to this flow;
                // omitting it (as before) left retried rounds uncorrelated.
                entryPointId: entryPoint.id,
                maxRounds: Math.max(1, Math.min(5, allocatedRounds)),
                timeoutMs: Math.max(5_000, flowTimeoutMs - (Date.now() - startTime)),
                // Keep page-health context consistent with the primary config so
                // an auth flow's login landing isn't misread as "session lost"
                // and the Planner keeps its page understanding on retry too.
                flowIsAuth: entryPoint.category === 'authentication',
                enableAssertAuthoring: categoryAllowsAssertAuthoring(entryPoint.category),
                pageInsightContext: this.formatPageInsightContext(page.url(), entryPoint.name),
                priorLearnings: this.formatPriorLearnings(),
              };
              const retryStartTime = Date.now();
              const retryNetworkTracker = retryIntegrations.networkTracker;
              try {
                const retryResult = await retryPipeline.run(entryPoint.goal, retryConfig);

                if (retryResult.success) {
                  status = 'completed';
                  blockerType = undefined;
                  canUserHelp = undefined;
                  // Adopt the retry's outcome for every derived field, not just
                  // `status` — see `effectiveGoalAchieved`.
                  effectiveGoalAchieved = true;
                  effectiveProgressScore = retryResult.progressScore;
                  effectiveRoundsUsed = pipelineResult.roundsExecuted + retryResult.roundsExecuted;
                  effectiveBlockedReason = undefined;
                  // Merge steps — reuse the same attribution pipeline so
                  // network calls captured during the retry get attached too.
                  const { steps: retrySteps, stepsByRound: retryStepsByRound } = await extractDiscoveredSteps(retryResult, page);
                  const retryCalls = this.collectSuccessfulCalls(retryNetworkTracker, retryStartTime);
                  const retryAttributed = attributeCallsToSteps({
                    steps: retrySteps,
                    stepsByRound: retryStepsByRound,
                    rounds: retryResult.rounds,
                    flowStartTime: retryStartTime,
                    successfulCalls: retryCalls,
                  });
                  discoveredSteps.push(...retryAttributed);
                  // Carry the retry's intra-round dismissals too, so the
                  // self-contained step list reflects overlays cleared during
                  // the retry (same gap as the main path, on the retry branch).
                  recordedDismissals.push(...retryResult.dismissals);
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

      // Build the SELF-CONTAINED step list NOW (after the optional 2FA/CAPTCHA
      // retry has appended to discoveredSteps/recordedDismissals), so the saved
      // test case includes retry-path actions + overlay dismissals:
      //   [navigate to entry URL] + [dismiss overlays] + [flow steps]
      // Kept SEPARATE from `discoveredSteps` (which Scout consumed above) —
      // Scout must see only the real flow actions, not the prepended setup.
      const finalSteps = buildSelfContainedSteps(
        entryPoint.sourcePageUrl,
        recordedDismissals,
        discoveredSteps,
      );

      return {
        entryPoint,
        status,
        // Self-contained list (navigate + dismissals + flow steps). NOT the
        // raw `discoveredSteps` — that was already handed to Scout above
        // without the prepended setup.
        discoveredSteps: finalSteps,
        branchPoints,
        errors,
        errorClassification,
        durationMs: Date.now() - startTime,
        goalAchieved: effectiveGoalAchieved,
        blockedReason: effectiveBlockedReason,
        blockerType,
        canUserHelp,
        progressScore: effectiveProgressScore,
        roundsUsed: effectiveRoundsUsed,
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

      const actionExecutor = new ActionExecutor(page, { timeoutProfile: 'fast' });
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
    // MUST stay in sync with the BlockerType union. `needs_data` was missing, so
    // an Executor that correctly reported `BLOCKED [needs_data]` had it silently
    // downgraded to 'other' — and 'other' is not in the clarification allow-list
    // below, so the user was never asked for the value and the flow stayed dead.
    const VALID_BLOCKER_TYPES: BlockerType[] = [
      'captcha', '2fa', 'payment', 'external_service', 'login_wall', 'file_upload',
      'needs_data', 'other',
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

    // 2FA — match only STRONG authenticator-2FA anchors. "verification code" /
    // "otp" alone are ambiguous: SMS/phone-confirmation and password-recovery
    // flows use them too, and mislabelling those as "2FA" showed a confusing
    // "2FA verification required" modal on sites that have no 2FA. A generic
    // code the agent can't obtain still blocks the flow — as a truthful
    // 'other' (user-help), not a wrong 2FA label.
    if (searchText.includes('2fa') || searchText.includes('two-factor') || searchText.includes('two factor') || searchText.includes('authenticator') || searchText.includes('totp'))
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

  /**
   * Condense the Cartographer insight for a page into a short hint string for
   * the Planner (forms / interactive areas / data entities). Mirrors the
   * Scout prompt's "CURRENT PAGE CONTEXT" shape. Returns undefined when the
   * page wasn't surveyed. Length-capped so it can't bloat the Planner prompt.
   */
  /**
   * Render a form list as `"Login"[email*, password*] + 1 more` — labels the
   * Planner can act on, with `*` marking required fields, and the submit control
   * named so it doesn't have to guess which button commits the form.
   *
   * Defensive by necessity: `forms` comes straight from an LLM response
   * (`parseCartographerResponse` passes `insight.forms` through with only an
   * Array check), so any field may be missing or the wrong type.
   */
  private summarizeForms(forms: FormAnalysis[], cap: number): string {
    const shown = forms.slice(0, cap).map((form) => {
      const fields = Array.isArray(form?.fields) ? form.fields : [];
      const labels = fields
        .slice(0, PAGE_INSIGHT_MAX_FORM_FIELDS)
        .map((f) => {
          const name = typeof f?.label === 'string' && f.label.trim() ? f.label.trim() : f?.type || 'field';
          return f?.required ? `${name}*` : name;
        })
        .filter(Boolean);
      const extra = fields.length > PAGE_INSIGHT_MAX_FORM_FIELDS
        ? `, +${fields.length - PAGE_INSIGHT_MAX_FORM_FIELDS}`
        : '';
      const submit = typeof form?.submitButtonText === 'string' && form.submitButtonText.trim()
        ? ` → "${form.submitButtonText.trim()}"`
        : '';
      return labels.length ? `[${labels.join(', ')}${extra}]${submit}` : `[unknown fields]${submit}`;
    });
    const remaining = forms.length - shown.length;
    return shown.join(' ') + (remaining > 0 ? ` +${remaining} more form(s)` : '');
  }

  private formatPageInsightContext(url: string, flowName?: string): string | undefined {
    // Phase 0's brief is flow-independent and valuable on its own, so it must
    // survive the no-page-insight early return below — a page we never surveyed
    // is exactly where the Planner most needs product orientation.
    const briefText = this.blackboard?.productBrief
      ? formatBriefForPlanner(this.blackboard.productBrief, flowName)
      : undefined;

    const insight = this.findPageInsight(url);
    if (!insight) return briefText;
    const formCount = insight.forms?.length ?? 0;
    const cap = PAGE_INSIGHT_MAX_ITEMS_PER_LIST;
    const parts = [
      `Page understanding (from survey): ${insight.pageType}, complexity ${insight.complexity}`,
      // Field LABELS, not just a count. "forms: 2" told the Planner nothing it
      // could act on; the required-field list is the whole reason Cartographer's
      // prompt calls `forms` mandatory ("an empty forms array means the planner
      // cannot fill the form"). Only reachable now that pageInsights is written.
      formCount > 0 ? `forms: ${this.summarizeForms(insight.forms, cap)}` : '',
      insight.interactiveAreas?.length ? `interactive: ${insight.interactiveAreas.slice(0, cap).join(', ')}` : '',
      insight.dataEntities?.length ? `entities: ${insight.dataEntities.slice(0, cap).join(', ')}` : '',
    ].filter(Boolean);
    // Redact any credential value the surveyed page may have echoed into its
    // form labels / entity names before this string reaches the Planner prompt
    // (CLAUDE.md invariant #10 — the insight is page-derived, LLM-facing text).
    const text = redactCredentialValues(parts.join(' | '), this.config.credentials);
    const pageText = text.length > PAGE_INSIGHT_MAX_CHARS ? text.slice(0, PAGE_INSIGHT_MAX_CHARS) : text;

    // Brief FIRST: it says what the flow is for, which frames how to read the
    // page. Capped separately so a long brief can never squeeze out the page
    // understanding — the two answer different questions and the Planner needs
    // both. (The brief is already credential-redacted by the normalizer.)
    if (!briefText) return pageText;
    const cappedBrief = briefText.length > PLANNER_BRIEF_MAX_CHARS
      ? briefText.slice(0, PLANNER_BRIEF_MAX_CHARS)
      : briefText;
    return `${cappedBrief}\n${pageText}`;
  }

  /**
   * Publish a finished flow into the blackboard's working memory.
   *
   * Best-effort by contract: memory is an optimization, so a failure here must
   * never fail the flow that just succeeded (CLAUDE.md hard invariant #11). The
   * blocker reason is page-derived text, so it is credential-redacted at the
   * SOURCE rather than relying on the redaction in `formatPriorLearnings` —
   * `categoriesExplored` and the stored strings outlive that one read
   * (invariant #10).
   */
  private recordOutcomeInWorkingMemory(task: FlowExplorationTask): void {
    if (!this.blackboard) return;
    try {
      // Redact on a SHALLOW COPY — mutating `task.blockedReason` in place would
      // change what the caller then emits, traces and returns.
      recordFlowOutcome(this.blackboard, {
        ...task,
        blockedReason: task.blockedReason
          ? redactCredentialValues(task.blockedReason, this.config.credentials)
          : undefined,
      });
    } catch (error) {
      logger.warn('[FLOW_RUNNER] Failed to record flow outcome in working memory', {
        name: task.entryPoint.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Condense what OTHER flows in this exploration already learned into a short,
   * Planner-facing slice: recent accomplishments (cookies accepted, logged in),
   * the most recent blockers per category (so this flow doesn't re-hit a dead
   * end), and the active strategy focus. Returns undefined for the first flow
   * (nothing learned yet) or when there's no blackboard. Recency-ordered and
   * capped both ways so it's a signal, not prompt bloat. Credential-redacted
   * (invariant #10 — accomplishments/blocker reasons are LLM-facing text).
   */
  private formatPriorLearnings(): string | undefined {
    if (!this.blackboard) return undefined;
    // Blockers come from WORKING MEMORY, not `completedFlows` — the latter is
    // filled only after Phase 2 returns, so every reader inside Phase 2 saw an
    // empty list and this section never rendered at all.
    const text = buildPriorLearnings({
      blockersByCategory: this.blackboard.workingMemory?.blockersByCategory ?? {},
      accomplishments: this.blackboard.workingMemory?.accomplishments ?? [],
      focusAreas: this.blackboard.currentStrategy?.focusAreas,
      maxFocusAreas: PAGE_INSIGHT_MAX_ITEMS_PER_LIST,
    });
    if (!text) return undefined;

    // Redacted AFTER capping: the mask (3 chars) is never longer than what it
    // replaces (min 4), so redaction can only shrink the block — capping first
    // therefore cannot break the limit, and cannot cut a mask in half.
    return redactCredentialValues(text, this.config.credentials);
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
