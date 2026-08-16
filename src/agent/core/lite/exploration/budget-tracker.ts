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
  private cancelled: boolean = false;

  constructor(private readonly budget: ExplorationBudget) {
    this.startTime = Date.now();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CANCELLATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Request a cooperative stop. Every phase loop already gates on
   * `isExhausted()`, so folding cancellation in here stops the survey BFS, the
   * flow queue and the extra Sentinel round without threading a second signal
   * through five call sites.
   *
   * Cooperative, NOT preemptive: an in-flight flow finishes its current step
   * (a Playwright action cannot be safely torn out mid-action), so a cancel
   * lands within roughly one step, not instantly. The partial result is still
   * built and persisted — the work is already paid for, and discarding it would
   * lose test cases the run genuinely discovered.
   *
   * One-way: a cancelled run never un-cancels.
   */
  cancel(): void {
    this.cancelled = true;
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXHAUSTION CHECKS
  // ═══════════════════════════════════════════════════════════════════════

  isExhausted(): boolean {
    return (
      this.cancelled ||
      this.isTimedOut() ||
      this.flowsCompleted >= this.budget.maxFlows ||
      this.pipelineRoundsUsed >= this.budget.maxTotalPipelineRounds
    );
  }

  isTimedOut(): boolean {
    return Date.now() - this.startTime >= this.budget.totalTimeoutMs;
  }

  canSurveyMorePages(): boolean {
    // Gates on `cancelled` as well as time: the survey BFS is the one loop that
    // checks this instead of `isExhausted()`, so without it a cancel issued
    // during Phase 1 would crawl to the page cap before stopping.
    return this.pagesSurveyed < this.budget.maxSurveyPages && !this.isTimedOut() && !this.cancelled;
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
    if (remaining <= 0) return 1; // Always give at least 1 round to any started flow
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

  /**
   * Atomically reserve a flow slot BEFORE starting execution.
   * Returns true if reserved successfully, false if budget exhausted.
   * On success, increments flowsCompleted immediately to prevent over-allocation
   * by concurrent flows. Call recordFlowRounds() after completion to record actual rounds used.
   */
  async reserveFlowSlot(): Promise<boolean> {
    let reserved = false;
    await this.withMutex(() => {
      if (this.flowsCompleted < this.budget.maxFlows && !this.isTimedOut()) {
        this.flowsCompleted++;
        reserved = true;
      }
    });
    return reserved;
  }

  /**
   * Record rounds used after a flow completes.
   * Called after reserveFlowSlot() + flow execution.
   */
  async recordFlowRounds(roundsUsed: number): Promise<void> {
    await this.withMutex(() => {
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
