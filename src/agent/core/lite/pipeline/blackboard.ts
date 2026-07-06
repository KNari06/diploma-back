/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST BLACKBOARD — Shared State Across All Pipeline Agents
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Modeled after: src/api/chat/general/sub-agents/blackboard.ts
 *
 * A typed state container that flows through every agent in the pipeline:
 *
 *   Planner writes plan → Executor executes commands → Reviewer validates → loop
 *
 * Key design decisions:
 * - Mutable state with typed accessors (agents write via methods)
 * - snapshot() for read-only frozen copies
 * - Scoped to one pipeline.run() call (in-process, no persistence)
 * - insights[] bounded to prevent unbounded growth
 * - Status precedence guards for plan steps (prevents backward transitions)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import type { LiteSnapshot } from '../lite-types';
import type { DismissalAttempt } from '../exploration/overlay-dismisser';
import type { RecordedDismissal } from '../exploration/overlay-step.util';
import type {
  ExecutionRound,
  PipelinePhase,
  PlanStep,
  PlanStepStatus,
  ReviewResult,
  TestBlackboardState,
  TestPlan,
} from './types';

/** Maximum insights before oldest are trimmed */
const MAX_INSIGHTS = 15;
/** Bound on recorded overlay dismissals (mirrors MAX_INSIGHTS — a flow that
 *  dismisses more than this many distinct overlays is pathological). */
const MAX_DISMISSALS = 15;

export class TestBlackboard {
  private state: TestBlackboardState;

  constructor(goal: string, url: string, testId: string, hasCredentials: boolean) {
    this.state = {
      goal,
      url,
      testId,
      hasCredentials,
      phase: 'planning',
      pipelineStartedAt: Date.now(),
      rounds: [],
      insights: [],
      dismissals: [],
      progressScore: 0,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMMUTABLE CONTEXT (set once at construction)
  // ═══════════════════════════════════════════════════════════════════════

  getGoal(): string {
    return this.state.goal;
  }

  getUrl(): string {
    return this.state.url;
  }

  getTestId(): string {
    return this.state.testId;
  }

  getHasCredentials(): boolean {
    return this.state.hasCredentials;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE
  // ═══════════════════════════════════════════════════════════════════════

  getPhase(): PipelinePhase {
    return this.state.phase;
  }

  setPhase(phase: PipelinePhase): void {
    this.state.phase = phase;
  }

  isTerminal(): boolean {
    return this.state.phase === 'done' || this.state.phase === 'blocked';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PLAN (written by Planner, read by Executor)
  // ═══════════════════════════════════════════════════════════════════════

  setPlan(plan: TestPlan): void {
    this.state.plan = {
      summary: plan.summary,
      steps: plan.steps.map(s => ({ ...s })),
    };
  }

  getPlan(): TestPlan | undefined {
    return this.state.plan;
  }

  /**
   * Status transition precedence (higher = more final).
   * Guards against backward transitions during execution.
   */
  private static readonly STATUS_PRECEDENCE: Record<PlanStepStatus, number> = {
    pending: 0,
    in_progress: 1,
    completed: 3,
    failed: 3,
  };

  /**
   * Update plan step status (called by Executor during execution).
   * Guards against backward transitions (e.g. completed → in_progress is ignored).
   * Exception: 'pending' reset for replanning is always allowed.
   */
  updateStepStatus(stepNumber: number, status: PlanStepStatus, error?: string): void {
    if (!this.state.plan) return;

    const step = this.state.plan.steps.find(s => s.stepNumber === stepNumber);
    if (!step) {
      logger.warn('[BLACKBOARD] Step not found for status update', { stepNumber, status });
      return;
    }

    // Guard against backward transitions (except reset to pending for replanning)
    const currentPrecedence = TestBlackboard.STATUS_PRECEDENCE[step.status] ?? 0;
    const newPrecedence = TestBlackboard.STATUS_PRECEDENCE[status] ?? 0;
    if (status !== 'pending' && newPrecedence < currentPrecedence) {
      logger.debug('[BLACKBOARD] Ignoring backward status transition', {
        stepNumber,
        from: step.status,
        to: status,
      });
      return;
    }

    step.status = status;
    if (error) step.error = error;
  }

  /**
   * Reset failed steps to pending (for replanning).
   */
  resetFailedSteps(stepNumbers?: number[]): void {
    if (!this.state.plan) return;

    for (const step of this.state.plan.steps) {
      if (stepNumbers) {
        if (stepNumbers.includes(step.stepNumber) && step.status === 'failed') {
          step.status = 'pending';
          step.error = undefined;
        }
      } else {
        // Reset all failed
        if (step.status === 'failed') {
          step.status = 'pending';
          step.error = undefined;
        }
      }
    }
  }

  getStepsByStatus(status: PlanStepStatus): PlanStep[] {
    return this.state.plan?.steps.filter(s => s.status === status) ?? [];
  }

  // ═══════════════════════════════════════════════════════════════════════
  // EXECUTION ROUNDS (written by Executor, read by Reviewer & Planner)
  // ═══════════════════════════════════════════════════════════════════════

  addRound(round: ExecutionRound): void {
    this.state.rounds.push(round);
  }

  getRounds(): readonly ExecutionRound[] {
    return this.state.rounds;
  }

  getLastRound(): ExecutionRound | undefined {
    return this.state.rounds[this.state.rounds.length - 1];
  }

  getTotalCommandsExecuted(): number {
    return this.state.rounds.reduce((sum, r) => sum + r.commands.length, 0);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE SNAPSHOT (written by CommandExecutor, read by all agents)
  // ═══════════════════════════════════════════════════════════════════════

  setCurrentSnapshot(formatted: string, url?: string, raw?: LiteSnapshot): void {
    this.state.currentSnapshot = formatted;
    if (url) this.state.currentUrl = url;
    if (raw) this.state.currentPageSnapshot = raw;
  }

  getCurrentSnapshot(): string | undefined {
    return this.state.currentSnapshot;
  }

  getCurrentUrl(): string | undefined {
    return this.state.currentUrl;
  }

  getCurrentPageSnapshot(): LiteSnapshot | undefined {
    return this.state.currentPageSnapshot;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // REVIEW (written by Reviewer, read by Planner)
  // ═══════════════════════════════════════════════════════════════════════

  setReview(review: ReviewResult): void {
    this.state.review = { ...review };
  }

  getReview(): ReviewResult | undefined {
    return this.state.review;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INSIGHTS (accumulated by any agent, bounded to MAX_INSIGHTS)
  // ═══════════════════════════════════════════════════════════════════════

  addInsight(insight: string): void {
    this.state.insights.push(insight);
    if (this.state.insights.length > MAX_INSIGHTS) {
      this.state.insights = this.state.insights.slice(-MAX_INSIGHTS);
    }
  }

  getInsights(): readonly string[] {
    return this.state.insights;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // OVERLAY DISMISSALS (recorded so the flow runner can replay them as steps)
  // ═══════════════════════════════════════════════════════════════════════

  /** Record successful overlay dismissals that happened during a round. Only
   *  `dismissed` attempts are kept (the rest aren't replayable). Bounded. */
  addDismissals(attempts: readonly DismissalAttempt[], pageUrl: string): void {
    for (const attempt of attempts) {
      if (!attempt.dismissed) continue;
      this.state.dismissals.push({ attempt, pageUrl });
    }
    if (this.state.dismissals.length > MAX_DISMISSALS) {
      this.state.dismissals = this.state.dismissals.slice(-MAX_DISMISSALS);
    }
  }

  getDismissals(): readonly RecordedDismissal[] {
    return this.state.dismissals;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PROGRESS
  // ═══════════════════════════════════════════════════════════════════════

  setProgressScore(score: number): void {
    this.state.progressScore = Math.max(0, Math.min(100, score));
  }

  getProgressScore(): number {
    return this.state.progressScore;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // GOAL EXPANSION (set once at pipeline start by GoalExpander)
  // ═══════════════════════════════════════════════════════════════════════

  setExpandedGoalKeywords(keywords: string[]): void {
    this.state.expandedGoalKeywords = keywords;
  }

  getExpandedGoalKeywords(): string[] | undefined {
    return this.state.expandedGoalKeywords;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXTUAL HINTS (updated by GoalDetector per round)
  // ═══════════════════════════════════════════════════════════════════════

  setContextualHints(hints: string[]): void {
    this.state.contextualHints = hints;
  }

  getContextualHints(): string[] | undefined {
    return this.state.contextualHints;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIOR CROSS-FLOW LEARNINGS (set once at pipeline start from config;
  // read-only summary of sibling flows' accomplishments / blockers + strategy).
  // ═══════════════════════════════════════════════════════════════════════

  setPriorLearnings(text: string): void {
    this.state.priorLearnings = text;
  }

  getPriorLearnings(): string | undefined {
    return this.state.priorLearnings;
  }

  /** Structured blocker info from report_blocked (blockerType + canUserHelp + reason). */
  setBlockedInfo(info: { blockerType: string; canUserHelp: boolean; reason: string }): void {
    this.state.blockedInfo = info;
  }

  getBlockedInfo(): { blockerType: string; canUserHelp: boolean; reason: string } | undefined {
    return this.state.blockedInfo;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PAGE HEALTH (written by CommandExecutor per action/round, read by
  // Reviewer prompt + auditDone gate). Best-effort technical-health verdict.
  // ═══════════════════════════════════════════════════════════════════════

  setPageHealth(health: import('../collectors/page-health').PageHealth | undefined): void {
    this.state.pageHealth = health;
  }

  getPageHealth(): import('../collectors/page-health').PageHealth | undefined {
    return this.state.pageHealth;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ROUND INFO (set by TestPipeline before each Planner call so the Planner
  // knows how much budget remains and can change strategy / give up).
  // ═══════════════════════════════════════════════════════════════════════

  setRoundInfo(current: number, max: number): void {
    this.state.roundInfo = { current, max };
  }

  getRoundInfo(): { current: number; max: number } | undefined {
    return this.state.roundInfo;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // NO-PROGRESS COUNTER (set by TestPipeline from same-state detection).
  // Number of consecutive rounds where the page state did NOT meaningfully
  // change. Read by the Reviewer to escalate from "retry same action" to
  // "the action has no effect — pivot or report_blocked" instead of looping.
  // ═══════════════════════════════════════════════════════════════════════

  setNoProgressRounds(n: number): void {
    this.state.noProgressRounds = n;
  }

  getNoProgressRounds(): number {
    return this.state.noProgressRounds ?? 0;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PR-HYBRID: SUPERVISOR BLACKBOARD (written by TestPipeline per round,
  // read by CommandExecutor for forbidden-action enforcement)
  // ═══════════════════════════════════════════════════════════════════════

  setSupervisorBlackboard(
    bb: import('../agents/types').SupervisorBlackboard | undefined,
  ): void {
    this.state.supervisorBlackboard = bb;
  }

  getSupervisorBlackboard():
    | import('../agents/types').SupervisorBlackboard
    | undefined {
    return this.state.supervisorBlackboard;
  }

  setGoalUrl(url: string | undefined): void {
    this.state.goalUrl = url;
  }

  getGoalUrl(): string | undefined {
    return this.state.goalUrl;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SNAPSHOT & SERIALIZATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Return a shallow-frozen snapshot of the blackboard.
   * Arrays are copied so mutations don't affect the reader.
   */
  snapshot(): Readonly<TestBlackboardState> {
    return Object.freeze({
      ...this.state,
      plan: this.state.plan
        ? {
            ...this.state.plan,
            steps: this.state.plan.steps.map(s => ({ ...s })),
          }
        : undefined,
      rounds: this.state.rounds.map(r => ({
        ...r,
        commands: r.commands.map(c => ({ ...c })),
      })),
      insights: [...this.state.insights],
      dismissals: this.state.dismissals.map(d => ({ ...d, attempt: { ...d.attempt } })),
    });
  }

  /**
   * Compact summary for logging (no large data blobs).
   */
  toLogSummary(): Record<string, any> {
    const plan = this.state.plan;
    return {
      goal: this.state.goal.slice(0, 100),
      phase: this.state.phase,
      planSteps: plan?.steps.length ?? 0,
      completedSteps: plan?.steps.filter(s => s.status === 'completed').length ?? 0,
      failedSteps: plan?.steps.filter(s => s.status === 'failed').length ?? 0,
      totalRounds: this.state.rounds.length,
      totalCommands: this.getTotalCommandsExecuted(),
      reviewVerdict: this.state.review?.verdict,
      goalAlignment: this.state.review?.goalAlignment,
      progressScore: this.state.progressScore,
      insightCount: this.state.insights.length,
      elapsedMs: Date.now() - this.state.pipelineStartedAt,
    };
  }

  /**
   * Format execution history for agent prompts.
   * Concise summary of what happened so far (not raw data).
   */
  formatHistoryForPrompt(): string {
    if (this.state.rounds.length === 0) {
      return 'No actions taken yet.';
    }

    const lines: string[] = [];

    for (const round of this.state.rounds) {
      const commands = round.commands.map(c => {
        const cmdName = c.command.name;
        const success = c.result.success ? '✓' : '✗';
        const detail = c.result.error
          ? ` — ${c.result.error.slice(0, 80)}`
          : c.result.output
            ? ` — ${c.result.output.slice(0, 80)}`
            : '';
        return `  ${success} ${cmdName}(${JSON.stringify(c.command.args).slice(0, 60)})${detail}`;
      });
      lines.push(`Round ${round.roundNumber} (${round.durationMs}ms):`);
      lines.push(...commands);
    }

    return lines.join('\n');
  }

  /**
   * Format plan for agent prompts.
   */
  formatPlanForPrompt(): string {
    if (!this.state.plan) {
      return 'No plan created yet.';
    }

    const lines: string[] = [];
    lines.push(`PLAN: ${this.state.plan.summary}`);

    for (const step of this.state.plan.steps) {
      const statusIcon =
        step.status === 'completed' ? '✓' :
        step.status === 'failed' ? '✗' :
        step.status === 'in_progress' ? '→' : '○';
      const refTag = step.targetRef ? `[${step.targetRef}] ` : '';
      const errorSuffix = step.error ? ` (error: ${step.error.slice(0, 60)})` : '';
      lines.push(`  ${statusIcon} ${step.stepNumber}. ${refTag}${step.description}${errorSuffix}`);
    }

    return lines.join('\n');
  }
}
