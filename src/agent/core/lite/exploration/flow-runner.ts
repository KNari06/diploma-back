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

import type {
  ExplorationConfig,
  EntryPoint,
  FlowExplorationTask,
  FlowExplorationStatus,
  DiscoveredStep,
  FlowError,
  ErrorClassification,
  BlockerType,
  ExplorationProgressCallback,
} from './types';
import { FlowQueue } from './flow-queue';
import { BudgetTracker } from './budget-tracker';
import { StateManager } from './state-manager';
import {
  buildBranchDetectionPrompt,
  parseBranchDetectionResponse,
} from './prompts';

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

export class FlowRunner {
  private stateManager: StateManager;
  private loginCompleted: boolean = false;
  private knownFlowNames: string[] = [];
  private flowsCompleted: number = 0;
  private totalFlows: number = 0;

  constructor(
    private readonly browser: Browser,
    private readonly config: ExplorationConfig,
    private readonly budget: BudgetTracker,
    private readonly onProgress?: ExplorationProgressCallback,
  ) {
    this.stateManager = new StateManager(browser);
  }

  private emitProgress(
    event: 'flow_started' | 'flow_completed' | 'flow_failed' | 'flow_blocked' | 'branch_found',
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

    this.totalFlows = queue.size();
    this.flowsCompleted = 0;

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

        // Acquire semaphore before starting (blocks when at max concurrency)
        const release = await semaphore.acquire();

        // Re-check budget after acquiring semaphore
        if (this.budget.isExhausted()) {
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
    this.emitProgress('flow_started', {
      name: entryPoint.name,
      category: entryPoint.category,
      priority: entryPoint.priority,
    });

    try {
      const task = await this.runSingleFlow(entryPoint);
      results.push(task);
      this.flowsCompleted++;

      // Mark as completed for dependency tracking
      if (task.goalAchieved) {
        queue.markCompleted(entryPoint.id);
      }

      // Enqueue newly discovered branch points
      for (const branch of task.branchPoints) {
        await queue.enqueue(branch);
        this.totalFlows++;
      }

      if (task.branchPoints.length > 0) {
        this.emitProgress('branch_found', {
          flow: entryPoint.name,
          branchCount: task.branchPoints.length,
          branchNames: task.branchPoints.map(b => b.name),
        });
      }

      // Record budget usage
      await this.budget.recordFlowCompletion(task.roundsUsed);

      // Emit appropriate completion event
      const progressEvent = task.status === 'blocked' ? 'flow_blocked' as const
        : task.goalAchieved ? 'flow_completed' as const
        : 'flow_failed' as const;

      this.emitProgress(progressEvent, {
        name: entryPoint.name,
        status: task.status,
        steps: task.discoveredSteps.length,
        branches: task.branchPoints.length,
        goalAchieved: task.goalAchieved,
      });

      logger.info('[FLOW_RUNNER] Flow completed', {
        name: entryPoint.name,
        status: task.status,
        steps: task.discoveredSteps.length,
        branches: task.branchPoints.length,
      });
    } catch (error) {
      this.flowsCompleted++;
      logger.error('[FLOW_RUNNER] Flow execution failed', {
        name: entryPoint.name,
        error: error instanceof Error ? error.message : String(error),
      });
      results.push(this.createFailedTask(entryPoint, error));

      this.emitProgress('flow_failed', {
        name: entryPoint.name,
        error: error instanceof Error ? error.message : String(error),
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

    try {
      // 1. Create browser context (with auth if needed)
      if (entryPoint.requiresAuth && this.config.credentials) {
        context = await this.stateManager.createAuthenticatedContext();

        // If no cached auth state, we need to login first
        if (!this.stateManager.hasAuthState() && !this.loginCompleted) {
          await this.performLogin(context);
        }
      } else {
        context = await this.stateManager.createCleanContext();
      }

      const page = await context.newPage();

      // 2. Navigate to the entry point's source page
      const targetUrl = entryPoint.sourcePageUrl || this.config.entryUrl;
      await page.goto(targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

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
      };

      const pipelineResult = await pipeline.run(entryPoint.goal, pipelineConfig);

      // 5. Extract steps from pipeline rounds
      const discoveredSteps = this.extractSteps(pipelineResult);

      // 6. Extract errors from pipeline result
      const errors = this.extractErrors(pipelineResult);
      const errorClassification = this.classifyErrors(pipelineResult, errors);

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

      // 9. Detect branch points on final page (also for partially-successful flows)
      let branchPoints: EntryPoint[] = [];
      if (pipelineResult.success || pipelineResult.progressScore > 30) {
        branchPoints = await this.detectBranchPoints(page, entryPoint, this.knownFlowNames);
      }

      // 10. Determine status + extract blocker metadata
      let status: FlowExplorationStatus;
      let blockerType: BlockerType | undefined;
      let canUserHelp: boolean | undefined;

      if (pipelineResult.success) {
        status = 'completed';
      } else if (pipelineResult.blockedReason) {
        status = 'blocked';
        const blockerInfo = this.extractBlockerInfo(pipelineResult.insights);
        blockerType = blockerInfo.type;
        canUserHelp = blockerInfo.canUserHelp;
      } else if (Date.now() - startTime >= flowTimeoutMs) {
        status = 'timeout';
      } else {
        status = 'failed';
      }

      // 11. Cleanup
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

    for (let attempt = 0; attempt < goals.length; attempt++) {
      try {
        const success = await this.tryLoginWithGoal(context, goals[attempt]);
        if (success) return;
        logger.warn('[FLOW_RUNNER] Login attempt failed', { attempt, goal: goals[attempt] });
      } catch (error) {
        logger.warn('[FLOW_RUNNER] Login attempt error', { attempt, error: String(error) });
      }
    }

    logger.warn('[FLOW_RUNNER] All login attempts failed');
  }

  private async tryLoginWithGoal(context: BrowserContext, goal: string): Promise<boolean> {
    const page = await context.newPage();

    try {
      await page.goto(this.config.entryUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 15_000,
      });

      const actionExecutor = new ActionExecutor(page);
      const networkTracker = new NetworkTracker(page);

      const integrations: PipelineIntegrations = {
        page,
        actionExecutor,
        networkTracker,
        browserContext: context,
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

  // ═══════════════════════════════════════════════════════════════════════
  // STEP EXTRACTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Extract DiscoveredStep[] from pipeline execution rounds.
   * Filters out infrastructure commands (observe_page, wait_for_page).
   */
  private extractSteps(result: TestPipelineResult): DiscoveredStep[] {
    const steps: DiscoveredStep[] = [];
    let stepNumber = 0;

    for (const round of result.rounds) {
      // Use the page URL from the round's snapshot context
      // The snapshot URL is captured before actions execute
      const roundPageUrl = this.extractUrlFromSnapshot(round.pageSnapshotBefore);

      for (const executed of round.commands) {
        const step = this.commandToStep(executed, ++stepNumber, roundPageUrl);
        if (step) {
          steps.push(step);
        }
      }
    }

    return steps;
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
   * Convert a single executed command to a DiscoveredStep.
   * Returns null for infrastructure commands.
   */
  private commandToStep(executed: ExecutedCommand, stepNumber: number, pageUrl: string): DiscoveredStep | null {
    const cmd = executed.command;

    switch (cmd.name) {
      case 'fill_field':
        return {
          stepNumber,
          description: `Fill "${cmd.args.ref}" with ${cmd.args.is_sensitive ? '[credential]' : `"${cmd.args.value}"`}`,
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
          description: `Click "${cmd.args.ref}"`,
          action: 'click',
          ref: cmd.args.ref,
          pageUrl,
          expectedOutcome: executed.result.success ? 'Element clicked successfully' : undefined,
        };

      case 'select_option':
        return {
          stepNumber,
          description: `Select option "${cmd.args.value}" in "${cmd.args.ref}"`,
          action: 'select',
          ref: cmd.args.ref,
          value: cmd.args.value,
          pageUrl,
        };

      case 'press_key':
        return {
          stepNumber,
          description: `Press key "${cmd.args.key}"`,
          action: 'press',
          value: cmd.args.key,
          pageUrl,
        };

      case 'hover_element':
        return {
          stepNumber,
          description: `Hover over "${cmd.args.ref}"`,
          action: 'hover',
          ref: cmd.args.ref,
          pageUrl,
        };

      case 'scroll_page':
      case 'scroll_to_element':
        return {
          stepNumber,
          description: cmd.name === 'scroll_to_element'
            ? `Scroll to element "${cmd.args.ref}"`
            : `Scroll ${cmd.args.direction || 'down'}`,
          action: 'scroll',
          ref: cmd.args.ref,
          pageUrl,
        };

      case 'navigate_to':
        return {
          stepNumber,
          description: `Navigate to ${cmd.args.url}`,
          action: 'navigate',
          value: cmd.args.url,
          pageUrl,
        };

      case 'toggle_element':
        return {
          stepNumber,
          description: `Toggle "${cmd.args.ref}"`,
          action: 'toggle',
          ref: cmd.args.ref,
          pageUrl,
          expectedOutcome: 'Element toggled successfully',
        };

      case 'set_range':
        return {
          stepNumber,
          description: `Set range "${cmd.args.ref}" to "${cmd.args.value}"`,
          action: 'setRange',
          ref: cmd.args.ref,
          value: cmd.args.value,
          pageUrl,
        };

      case 'select_date':
        return {
          stepNumber,
          description: `Set date "${cmd.args.ref}" to "${cmd.args.value}"`,
          action: 'selectDate',
          ref: cmd.args.ref,
          value: cmd.args.value,
          pageUrl,
        };

      case 'clear_field':
        return {
          stepNumber,
          description: `Clear field "${cmd.args.ref}"`,
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
  private extractBlockerInfo(insights: string[]): {
    type: BlockerType;
    canUserHelp: boolean;
  } {
    const VALID_BLOCKER_TYPES: BlockerType[] = [
      'captcha', '2fa', 'payment', 'external_service', 'login_wall', 'file_upload', 'other',
    ];

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

    // Heuristic fallback: detect blocker type from keywords in any insight
    const allInsights = insights.join(' ').toLowerCase();
    if (allInsights.includes('captcha')) return { type: 'captcha', canUserHelp: true };
    if (allInsights.includes('2fa') || allInsights.includes('two-factor') || allInsights.includes('verification code'))
      return { type: '2fa', canUserHelp: true };
    if (allInsights.includes('payment') || allInsights.includes('credit card'))
      return { type: 'payment', canUserHelp: false };
    if (allInsights.includes('file upload'))
      return { type: 'file_upload', canUserHelp: false };
    if (allInsights.includes('login') || allInsights.includes('auth'))
      return { type: 'login_wall', canUserHelp: true };

    return { type: 'other', canUserHelp: false };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // BRANCH DETECTION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * After a flow completes, analyze the final page for new entry points.
   */
  private async detectBranchPoints(
    page: Page,
    completedEntry: EntryPoint,
    existingFlowNames: string[] = [],
  ): Promise<EntryPoint[]> {
    try {
      const snapshot = await SnapshotCollector.collect(page);
      const formattedSnapshot = SnapshotCollector.format(snapshot);

      const prompt = buildBranchDetectionPrompt({
        formattedSnapshot,
        url: page.url(),
        completedFlowName: completedEntry.name,
        completedFlowGoal: completedEntry.goal,
        existingFlowNames,
      });

      const response = await Promise.race([
        getChatCompletionWithMessages(
          [
            {
              role: 'system',
              content: 'You are a QA test discovery agent. Identify new testable flows on the current page. Respond with valid JSON only.',
            },
            { role: 'user', content: prompt },
          ],
          {
            model: AI_MODELS.fast, // Use fast model for branch detection
            temperature: 0.2,
            max_tokens: 1000,
            response_format: { type: 'json_object' },
          },
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Branch detection timeout')), 10_000),
        ),
      ]);

      const branches = parseBranchDetectionResponse(response.content);

      return branches.map((bp, index) => ({
        ...bp,
        id: `ep-branch-${completedEntry.id}-${index}`,
        sourceNodeId: completedEntry.sourceNodeId,
        sourcePageUrl: page.url(),
      }));
    } catch (error) {
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
