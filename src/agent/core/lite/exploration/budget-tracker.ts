/**
 * ═══════════════════════════════════════════════════════════════════════════
 * BUDGET TRACKER — Centralized limit enforcement for exploration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Tracks time, flows completed, pipeline rounds used, and pages surveyed.
 * Thread-safe for concurrent sub-agent access (async mutex on mutations).
 *
 * All sub-agents check budget before starting new work.
 */

import type { ExplorationBudget, BudgetUsage, BudgetCheckpoint } from './types';

export class BudgetTracker {
  private readonly startTime: number;
  private flowsCompleted: number = 0;
  private pipelineRoundsUsed: number = 0;
  private pagesSurveyed: number = 0;
  private mutexPromise: Promise<void> = Promise.resolve();
  private degradedTargets: Set<string> = new Set();

  constructor(private readonly budget: ExplorationBudget) {
    this.startTime = Date.now();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXHAUSTION CHECKS
  // ═══════════════════════════════════════════════════════════════════════

  isExhausted(): boolean {
    return (
      this.isTimedOut() ||
      this.flowsCompleted >= this.budget.maxFlows ||
      this.pipelineRoundsUsed >= this.budget.maxTotalPipelineRounds
    );
  }

  isTimedOut(): boolean {
    return Date.now() - this.startTime >= this.budget.totalTimeoutMs;
  }

  canSurveyMorePages(): boolean {
    return this.pagesSurveyed < this.budget.maxSurveyPages && !this.isTimedOut();
  }

  canExploreMoreFlows(): boolean {
    return this.flowsCompleted < this.budget.maxFlows && !this.isExhausted();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REMAINING BUDGETS
  // ═══════════════════════════════════════════════════════════════════════

  remainingPipelineRounds(): number {
    return Math.max(0, this.budget.maxTotalPipelineRounds - this.pipelineRoundsUsed);
  }

  remainingFlows(): number {
    return Math.max(0, this.budget.maxFlows - this.flowsCompleted);
  }

  remainingTimeMs(): number {
    return Math.max(0, this.budget.totalTimeoutMs - (Date.now() - this.startTime));
  }

  /**
   * Max pipeline rounds to allocate to a single flow.
   * Distributes remaining rounds evenly across remaining flows,
   * with a minimum of 5 and a maximum of 10.
   */
  roundsPerFlow(): number {
    const remaining = this.remainingFlows();
    if (remaining <= 0) return 0;
    const perFlow = Math.floor(this.remainingPipelineRounds() / remaining);
    return Math.max(5, Math.min(10, perFlow));
  }

  /**
   * Effective timeout for a single flow, capped by both
   * per-flow budget and remaining total time.
   */
  effectiveFlowTimeoutMs(): number {
    return Math.min(this.budget.perFlowTimeoutMs, this.remainingTimeMs());
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MUTATIONS (async-safe for concurrent sub-agents)
  // ═══════════════════════════════════════════════════════════════════════

  async recordFlowCompletion(roundsUsed: number): Promise<void> {
    await this.withMutex(() => {
      this.flowsCompleted++;
      this.pipelineRoundsUsed += roundsUsed;
    });
  }

  async recordPageSurvey(): Promise<void> {
    await this.withMutex(() => {
      this.pagesSurveyed++;
    });
  }

  async markDegraded(target: string): Promise<void> {
    await this.withMutex(() => {
      this.degradedTargets.add(target);
    });
  }

  isTargetDegraded(target: string): boolean {
    return this.degradedTargets.has(target);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // USAGE REPORT
  // ═══════════════════════════════════════════════════════════════════════

  getUsage(): BudgetUsage {
    return {
      timeUsedMs: Date.now() - this.startTime,
      timeRemainingMs: this.remainingTimeMs(),
      flowsUsed: this.flowsCompleted,
      flowsRemaining: this.remainingFlows(),
      pipelineRoundsUsed: this.pipelineRoundsUsed,
      pipelineRoundsRemaining: this.remainingPipelineRounds(),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHECKPOINT / RESUME
  // ═══════════════════════════════════════════════════════════════════════

  toCheckpoint(): BudgetCheckpoint {
    return {
      flowsCompleted: this.flowsCompleted,
      pipelineRoundsUsed: this.pipelineRoundsUsed,
      pagesSurveyed: this.pagesSurveyed,
      startTime: this.startTime,
    };
  }

  static fromCheckpoint(budget: ExplorationBudget, cp: BudgetCheckpoint): BudgetTracker {
    const tracker = new BudgetTracker(budget);
    tracker.flowsCompleted = cp.flowsCompleted;
    tracker.pipelineRoundsUsed = cp.pipelineRoundsUsed;
    tracker.pagesSurveyed = cp.pagesSurveyed;
    // Keep startTime from checkpoint so remaining time is calculated correctly
    (tracker as any).startTime = cp.startTime;
    return tracker;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL: simple async mutex
  // ═══════════════════════════════════════════════════════════════════════

  private async withMutex(fn: () => void): Promise<void> {
    const prev = this.mutexPromise;
    let resolve: () => void;
    this.mutexPromise = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      fn();
    } finally {
      resolve!();
    }
  }
}
