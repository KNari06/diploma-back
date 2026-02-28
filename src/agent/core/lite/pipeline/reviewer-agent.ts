/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REVIEWER AGENT — "Did it work?"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Validates execution results against the test goal.
 * Uses a THREE-phase approach:
 *
 * Phase 0: auditDone() validation (when Executor claims done)
 *   - GoalDetector.auditDone() → gpt-4o final check
 *   - Prevents false "done" claims
 *
 * Phase 1: Deterministic fast-paths (0 tokens, <1ms)
 *   - All succeeded + high progress → continue
 *   - All failed → replan
 *
 * Phase 2: AI assessment (gpt-4o-mini, only for ambiguous cases)
 *   - Reads Blackboard context: plan, execution, snapshot
 *   - Double-blind: doesn't see Planner's reasoning
 *
 * Reads from Blackboard:
 * - goal, plan, rounds, currentSnapshot, progressScore
 *
 * Writes to Blackboard:
 * - review — verdict + guidance for Planner
 * - insights — observations about execution quality
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildSnapshotSummary } from '../analysis/ai-goal-evaluator';
import type { GoalDetector } from '../analysis/goal-detector';
import type { GoalContext, StuckCheck } from '../lite-types';
import { TestBlackboard } from './blackboard';
import { buildReviewerPrompt } from './prompts';
import type { ReviewResult } from './types';

/** Reviewer configuration */
const REVIEWER_CONFIG = {
  temperature: 0.1,
  maxTokens: 300,
  timeoutMs: 8000,
  /** Progress score threshold for fast-approve (continue) */
  progressThresholdContinue: 30,
  /** Progress score threshold for fast-approve (done) */
  progressThresholdDone: 85,
  /** Auditor cooldown: skip gpt-4o calls for N rounds after rejection */
  auditCooldownRounds: 2,
} as const;

export class ReviewerAgent {
  /**
   * Per-blackboard cooldown tracking.
   * Uses WeakMap so entries are GC'd when the TestBlackboard is released.
   * This prevents cross-test contamination when multiple tests run concurrently.
   */
  private static auditCooldowns = new WeakMap<TestBlackboard, number>();

  /** Get cooldown remaining for a specific test (via its blackboard) */
  private static getCooldown(bb: TestBlackboard): number {
    return ReviewerAgent.auditCooldowns.get(bb) || 0;
  }

  /** Set cooldown remaining for a specific test */
  private static setCooldown(bb: TestBlackboard, value: number): void {
    ReviewerAgent.auditCooldowns.set(bb, value);
  }

  /**
   * Validate execution results against the goal.
   *
   * Reads Blackboard: goal, plan, rounds, currentSnapshot, progressScore
   * Returns: ReviewResult to be written to Blackboard by pipeline
   *
   * @param goalDetector — Optional GoalDetector for auditDone() validation.
   *   When Executor claims mark_done, this enables gpt-4o double-check.
   */
  static async review(
    blackboard: TestBlackboard,
    goalDetector?: GoalDetector,
  ): Promise<ReviewResult> {
    // ═══════════════════════════════════════════════════════════════════
    // Phase 0: auditDone() — validate "done" claims with gpt-4o
    // This is the CRITICAL check that prevents false completions.
    // ═══════════════════════════════════════════════════════════════════

    if (blackboard.getPhase() === 'done') {
      return ReviewerAgent.validateDoneClaim(blackboard, goalDetector);
    }

    if (blackboard.getPhase() === 'blocked') {
      logger.debug('[REVIEWER] Fast-path: blocked (executor reported blocker)');
      return {
        verdict: 'blocked',
        reason: 'Executor reported test blocked',
        goalAlignment: 0,
      };
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 1: Deterministic fast-paths (0 tokens, <1ms)
    // ═══════════════════════════════════════════════════════════════════

    const lastRound = blackboard.getLastRound();
    if (!lastRound || lastRound.commands.length === 0) {
      logger.debug('[REVIEWER] Fast-path: continue (no execution yet)');
      return {
        verdict: 'continue',
        reason: 'No commands executed yet',
        goalAlignment: 0,
      };
    }

    const allCommands = lastRound.commands;
    const allSucceeded = allCommands.every(c => c.result.success);
    const allFailed = allCommands.every(c => !c.result.success);
    const progressScore = blackboard.getProgressScore();

    // Check if pipeline detected same-page stuck state.
    // When stuck, skip "all succeeded" fast-paths and escalate to AI review.
    // This prevents looping forever on wrong credentials, validation errors, etc.
    const isStuckOnSamePage = blackboard.getInsights().some(
      i => i.includes('page state unchanged'),
    );

    // All commands failed → replan (wrong approach)
    if (allFailed) {
      const errors = allCommands
        .filter(c => c.result.error)
        .map(c => c.result.error!.slice(0, 60))
        .join('; ');

      logger.debug('[REVIEWER] Fast-path: replan (all commands failed)', { errors });

      // Find which plan steps failed
      const failedStepNumbers = blackboard.getStepsByStatus('failed').map(s => s.stepNumber);

      return {
        verdict: 'replan',
        reason: `All commands failed: ${errors}`,
        goalAlignment: 0,
        failedSteps: failedStepNumbers.length > 0 ? failedStepNumbers : undefined,
        guidance: 'Try a different approach — the current page state may have changed.',
      };
    }

    // All succeeded + very high progress → signal Executor should verify and mark_done
    // IMPORTANT: Check high threshold BEFORE moderate threshold (85% before 30%)
    // Otherwise, the 30% check would always match first and this path would be unreachable.
    // NOTE: Skip if stuck on same page — high progress might be stale/wrong.
    if (allSucceeded && progressScore >= REVIEWER_CONFIG.progressThresholdDone && !isStuckOnSamePage) {
      logger.debug('[REVIEWER] Fast-path: continue (high progress, need mark_done)', { progressScore });
      return {
        verdict: 'continue',
        reason: `High progress (${progressScore}%), executor should verify goal and mark_done`,
        goalAlignment: progressScore / 100,
      };
    }

    // All commands succeeded + moderate progress → continue execution
    // NOTE: Skip if stuck on same page — let AI review assess the situation.
    if (allSucceeded && progressScore >= REVIEWER_CONFIG.progressThresholdContinue && !isStuckOnSamePage) {
      logger.debug('[REVIEWER] Fast-path: continue (all succeeded, good progress)', { progressScore });
      return {
        verdict: 'continue',
        reason: `All ${allCommands.length} commands succeeded, progress at ${progressScore}%`,
        goalAlignment: progressScore / 100,
      };
    }

    // If stuck on same page, log that we're escalating to AI review
    if (isStuckOnSamePage) {
      logger.debug('[REVIEWER] Skipping fast-path: page state unchanged, escalating to AI review');
    }

    // Mixed results with low progress and few rounds → continue to see what happens
    const totalRounds = blackboard.getRounds().length;
    if (totalRounds <= 2 && progressScore < REVIEWER_CONFIG.progressThresholdContinue) {
      logger.debug('[REVIEWER] Fast-path: continue (early rounds, low progress)');
      return {
        verdict: 'continue',
        reason: 'Still in early rounds, continuing execution',
        goalAlignment: progressScore / 100,
      };
    }

    // Decrement audit cooldown each review cycle
    const cooldown = ReviewerAgent.getCooldown(blackboard);
    if (cooldown > 0) {
      ReviewerAgent.setCooldown(blackboard, cooldown - 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 2: AI assessment (only for ambiguous cases)
    // ═══════════════════════════════════════════════════════════════════

    return ReviewerAgent.aiReview(blackboard);
  }

  /**
   * Validate Executor's "done" claim with GoalDetector.auditDone().
   *
   * This is the gpt-4o double-check that prevents false completions.
   * If GoalDetector is not available, falls back to heuristic + AI review.
   *
   * With audit cooldown: after auditor rejects, don't call again for N rounds.
   */
  private static async validateDoneClaim(
    blackboard: TestBlackboard,
    goalDetector?: GoalDetector,
  ): Promise<ReviewResult> {
    // If no GoalDetector, trust Executor's claim (same as before)
    if (!goalDetector) {
      logger.debug('[REVIEWER] No GoalDetector — trusting executor done claim');
      return {
        verdict: 'done',
        reason: 'Executor marked goal as achieved (no auditor available)',
        goalAlignment: 1.0,
      };
    }

    // Check cooldown: skip expensive gpt-4o call if recently rejected.
    // Decrement cooldown each time it's checked so it eventually expires.
    const currentCooldown = ReviewerAgent.getCooldown(blackboard);
    if (currentCooldown > 0) {
      const remaining = currentCooldown - 1;
      ReviewerAgent.setCooldown(blackboard, remaining);
      logger.debug('[REVIEWER] Auditor on cooldown, rejecting done claim', {
        cooldownRemaining: remaining,
      });
      // Force back to "continue" — Executor should keep working
      blackboard.setPhase('executing');
      blackboard.addInsight('Reviewer rejected done claim (auditor cooldown active). Keep working.');
      return {
        verdict: 'continue',
        reason: 'Done claim rejected by auditor cooldown — keep executing',
        goalAlignment: blackboard.getProgressScore() / 100,
      };
    }

    // Build GoalContext for auditor
    const snapshot = blackboard.getCurrentPageSnapshot();
    const goalContext: GoalContext = {
      goal: blackboard.getGoal(),
      page: {
        url: snapshot?.url || blackboard.getCurrentUrl() || blackboard.getUrl(),
        title: snapshot?.title || '',
      },
      snapshotSummary: snapshot ? buildSnapshotSummary(snapshot.elements) : [],
      history: blackboard.formatHistoryForPrompt(),
      stuckCheck: { stuck: false } as StuckCheck,
      consecutiveStuckCount: 0,
      recentErrors: [],
      iteration: blackboard.getRounds().length,
    };

    // Get last action from execution history
    const lastRound = blackboard.getLastRound();
    const lastCmd = lastRound?.commands[lastRound.commands.length - 1];
    const lastAction = lastCmd
      ? `${lastCmd.command.name}: ${lastCmd.result.output?.slice(0, 100) || lastCmd.result.error?.slice(0, 100) || ''}`
      : undefined;

    try {
      logger.info('[REVIEWER] Calling auditDone (gpt-4o) to validate done claim', {
        testId: blackboard.getTestId(),
        url: goalContext.page.url,
        progressScore: blackboard.getProgressScore(),
      });

      const auditResult = await goalDetector.auditDone(goalContext, lastAction);

      if (auditResult.isDone) {
        // ✅ CONFIRMED: goal is really done
        logger.info('[REVIEWER] Auditor CONFIRMED done', {
          confidence: auditResult.confidence,
          reason: auditResult.reason,
        });
        ReviewerAgent.setCooldown(blackboard, 0); // reset cooldown
        return {
          verdict: 'done',
          reason: `Goal achieved (auditor confirmed: ${auditResult.reason})`,
          goalAlignment: Math.max(0.9, auditResult.confidence),
        };
      }

      if (auditResult.isBlocked) {
        // 🚫 BLOCKED: auditor detected hard block
        logger.info('[REVIEWER] Auditor detected BLOCKED state', {
          blockedReason: auditResult.blockedReason,
          canUserHelp: auditResult.canUserHelp,
        });
        blackboard.addInsight(`Auditor: ${auditResult.blockedReason || 'Test blocked'}`);
        return {
          verdict: 'blocked',
          reason: auditResult.blockedReason || 'Auditor detected blocker',
          goalAlignment: auditResult.confidence,
        };
      }

      // ❌ REJECTED: goal is NOT done yet
      logger.info('[REVIEWER] Auditor REJECTED done claim', {
        confidence: auditResult.confidence,
        reason: auditResult.reason,
        nextStep: auditResult.nextStepIfMissing,
      });

      // Set cooldown to prevent repeated expensive gpt-4o calls
      ReviewerAgent.setCooldown(blackboard, REVIEWER_CONFIG.auditCooldownRounds);

      // Force back to executing — Executor needs to keep working
      blackboard.setPhase('executing');

      // Add guidance as insight so Planner/Executor can see it
      const guidance = auditResult.nextStepIfMissing
        ? `Auditor: Not done yet — ${auditResult.nextStepIfMissing}`
        : `Auditor: Not done yet — ${auditResult.reason}`;
      blackboard.addInsight(guidance);

      return {
        verdict: 'continue',
        reason: `Done claim rejected by auditor: ${auditResult.reason}`,
        goalAlignment: auditResult.confidence,
        guidance: auditResult.nextStepIfMissing,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[REVIEWER] auditDone failed, trusting executor claim', { error: errorMsg });

      // On auditor failure, trust Executor (conservative fallback)
      return {
        verdict: 'done',
        reason: 'Executor marked goal as achieved (auditor unavailable)',
        goalAlignment: 1.0,
      };
    }
  }

  /**
   * AI-powered review for ambiguous cases.
   * Uses gpt-4o-mini for cost efficiency.
   */
  private static async aiReview(blackboard: TestBlackboard): Promise<ReviewResult> {
    const prompt = buildReviewerPrompt(blackboard);

    try {
      const aiPromise = getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: AI_TASK_MODELS.chatReviewer,
          temperature: REVIEWER_CONFIG.temperature,
          max_tokens: REVIEWER_CONFIG.maxTokens,
          response_format: { type: 'json_object' },
        }
      );

      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), REVIEWER_CONFIG.timeoutMs)
      );

      const result = await Promise.race([aiPromise, timeoutPromise]);

      if (!result) {
        logger.warn('[REVIEWER] AI timeout — defaulting to continue');
        return ReviewerAgent.safeDefault(blackboard);
      }

      // Parse response
      const content = result.content?.trim() || '';
      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      const parsed = JSON.parse(cleaned);

      // Validate verdict.
      // IMPORTANT: AI reviewer is NOT allowed to return 'done' — only the Executor's
      // mark_done → auditDone() path can declare completion. If AI says 'done',
      // downgrade to 'continue' so the Executor must explicitly verify and mark_done.
      const validVerdicts = ['continue', 'blocked', 'replan'];
      const verdict = validVerdicts.includes(parsed.verdict) ? parsed.verdict : 'continue';

      const review: ReviewResult = {
        verdict,
        reason: parsed.reason || 'AI review completed',
        goalAlignment: typeof parsed.goalAlignment === 'number'
          ? Math.max(0, Math.min(1, parsed.goalAlignment))
          : blackboard.getProgressScore() / 100,
        failedSteps: Array.isArray(parsed.failedSteps) ? parsed.failedSteps : undefined,
        guidance: parsed.guidance,
      };

      logger.debug('[REVIEWER] AI review completed', {
        verdict: review.verdict,
        goalAlignment: review.goalAlignment,
        reason: review.reason.slice(0, 80),
      });

      return review;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[REVIEWER] AI review error — defaulting to continue', { error: errorMsg });
      return ReviewerAgent.safeDefault(blackboard);
    }
  }

  /**
   * Safe default: never block the pipeline.
   * If Reviewer fails, allow execution to continue.
   */
  private static safeDefault(blackboard: TestBlackboard): ReviewResult {
    return {
      verdict: 'continue',
      reason: 'Reviewer defaulted to continue',
      goalAlignment: blackboard.getProgressScore() / 100,
    };
  }
}
