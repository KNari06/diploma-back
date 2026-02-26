import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from './config';
import type {
  BlackboardExecution,
  BlackboardPlan,
  PipelineBlackboard,
  PlanStepStatus,
  ReviewerResult,
  RouterResult,
  PlannerResult,
  ToolExecutionRecord,
  TrackedPlanStep,
} from './types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PIPELINE BLACKBOARD — Shared State Across All Agents
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Inspired by LiteEngine's WorkingMemory pattern. A typed state container
 * that flows through every agent in the pipeline:
 *
 *   Router writes → Planner writes → Executor(s) update → Reviewer writes → Responder reads
 *
 * Key design decisions:
 * - Mutable state with typed accessors (agents write directly)
 * - snapshot() for read-only copies
 * - Scoped to one pipeline.execute() call (no persistence, no Redis)
 * - Synchronous reads/writes (in-process memory, single-threaded)
 * - insights[] bounded to prevent unbounded growth
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export class Blackboard {
  private state: PipelineBlackboard;

  constructor(userGoal: string) {
    this.state = {
      userGoal,
      pipelineStartedAt: Date.now(),
      insights: [],
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GOAL
  // ═══════════════════════════════════════════════════════════════════════

  getGoal(): string {
    return this.state.userGoal;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ROUTER
  // ═══════════════════════════════════════════════════════════════════════

  setRouterResult(result: RouterResult): void {
    this.state.router = { ...result };
  }

  getRouterResult(): RouterResult | undefined {
    return this.state.router;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PLAN
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Write planner output to blackboard with tracked step statuses.
   * @param plan - Planner result with steps
   * @param parallelGroups - Optional groups of step numbers that can run concurrently
   */
  setPlan(plan: PlannerResult, parallelGroups?: number[][]): void {
    const trackedSteps: TrackedPlanStep[] = plan.steps.map(step => ({
      ...step,
      status: 'pending' as PlanStepStatus,
    }));

    // Assign parallel group numbers to steps
    if (parallelGroups) {
      for (let groupIdx = 0; groupIdx < parallelGroups.length; groupIdx++) {
        for (const stepNum of parallelGroups[groupIdx]) {
          const step = trackedSteps.find(s => s.stepNumber === stepNum);
          if (step) {
            step.parallelGroup = groupIdx;
          }
        }
      }
    }

    this.state.plan = {
      summary: plan.summary,
      steps: trackedSteps,
      canParallelize: !!parallelGroups && parallelGroups.some(group => group.length > 1),
      parallelGroups,
    };
  }

  getPlan(): BlackboardPlan | undefined {
    return this.state.plan;
  }

  /**
   * Status transition precedence (higher = more final).
   * Guards against backward transitions during concurrent sub-executor updates.
   * E.g. prevents completed → in_progress if a late update arrives out of order.
   */
  private static readonly STATUS_PRECEDENCE: Record<PlanStepStatus, number> = {
    pending: 0,
    in_progress: 1,
    completed: 3,
    failed: 3,
    skipped: 2,
  };

  /**
   * Update the status of a specific plan step (called by executor during execution).
   *
   * Concurrent-safe: guards against backward status transitions that can happen
   * when parallel sub-executors update the same blackboard across await boundaries.
   * E.g. if step is already 'completed', a late 'in_progress' update is ignored.
   *
   * Exception: 'pending' reset (used by retry loop) is always allowed regardless of current status.
   */
  updateStepStatus(
    stepNumber: number,
    status: PlanStepStatus,
    toolResults?: ToolExecutionRecord[],
    error?: string,
    executorId?: string,
  ): void {
    if (!this.state.plan) return;

    const step = this.state.plan.steps.find(s => s.stepNumber === stepNumber);
    if (!step) {
      logger.warn('[BLACKBOARD] Step not found for status update', { stepNumber, status });
      return;
    }

    // Guard against backward transitions (except explicit reset to pending for retries)
    const currentPrecedence = Blackboard.STATUS_PRECEDENCE[step.status] ?? 0;
    const newPrecedence = Blackboard.STATUS_PRECEDENCE[status] ?? 0;
    if (status !== 'pending' && newPrecedence < currentPrecedence) {
      logger.warn('[BLACKBOARD] Ignoring backward status transition', {
        stepNumber,
        from: step.status,
        to: status,
        executorId,
      });
      return;
    }

    step.status = status;
    if (toolResults) step.toolResults = toolResults;
    if (error) step.error = error;
    if (executorId) step.executorId = executorId;
  }

  /**
   * Get plan steps filtered by status.
   */
  getStepsByStatus(status: PlanStepStatus): TrackedPlanStep[] {
    return this.state.plan?.steps.filter(s => s.status === status) ?? [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXECUTION
  // ═══════════════════════════════════════════════════════════════════════

  setExecutionResults(execution: BlackboardExecution): void {
    this.state.execution = execution;
  }

  getExecutionResults(): BlackboardExecution | undefined {
    return this.state.execution;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REVIEW
  // ═══════════════════════════════════════════════════════════════════════

  setReviewResult(review: ReviewerResult): void {
    this.state.review = review;
  }

  getReviewResult(): ReviewerResult | undefined {
    return this.state.review;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INSIGHTS (accumulated by any agent)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Add an insight from any agent. Bounded to last N entries (configured via maxBlackboardInsights).
   */
  addInsight(insight: string): void {
    this.state.insights.push(insight);
    const maxInsights = SUB_AGENT_CONFIG.maxBlackboardInsights;
    if (this.state.insights.length > maxInsights) {
      this.state.insights = this.state.insights.slice(-maxInsights);
    }
  }

  getInsights(): readonly string[] {
    return this.state.insights;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SNAPSHOT & SERIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Return a shallow-frozen snapshot of the blackboard.
   * Steps array is copied so concurrent mutations don't affect the reader.
   * Used by Responder (reads full context) and Reviewer (reads execution results).
   */
  snapshot(): Readonly<PipelineBlackboard> {
    return {
      ...this.state,
      // Copy steps array so reader sees a stable list even if sub-executors update during iteration
      plan: this.state.plan
        ? {
            ...this.state.plan,
            steps: this.state.plan.steps.map(s => ({ ...s })),
          }
        : undefined,
      insights: [...this.state.insights],
    };
  }

  /**
   * Compact summary for logging (no large data blobs).
   */
  toLogSummary(): Record<string, any> {
    const plan = this.state.plan;
    const execution = this.state.execution;
    return {
      goal: this.state.userGoal.slice(0, 100),
      classification: this.state.router?.classification,
      routerConfidence: this.state.router?.confidence,
      planSteps: plan?.steps.length ?? 0,
      completedSteps: plan?.steps.filter(s => s.status === 'completed').length ?? 0,
      failedSteps: plan?.steps.filter(s => s.status === 'failed').length ?? 0,
      canParallelize: plan?.canParallelize ?? false,
      toolsExecuted: execution?.ungroupedResults?.length ?? 0,
      subExecutors: execution?.subExecutorIds?.length ?? 0,
      reviewVerdict: this.state.review?.verdict,
      goalAlignment: this.state.review?.goalAlignment,
      insightCount: this.state.insights.length,
      elapsedMs: Date.now() - this.state.pipelineStartedAt,
    };
  }
}
