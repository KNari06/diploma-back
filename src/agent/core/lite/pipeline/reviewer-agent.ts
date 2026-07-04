/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REVIEWER AGENT — "Did it work?"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Validates execution results against the test goal.
 * Uses a THREE-phase approach:
 *
 * Phase 0: auditDone() validation (when Executor claims done)
 *   - GoalDetector.auditDone() → gpt-5.4-mini final check
 *   - Prevents false "done" claims
 *
 * Phase 1: Deterministic fast-paths (0 tokens, <1ms)
 *   - All succeeded + high progress → continue
 *   - All failed → replan
 *
 * Phase 2: AI assessment (gemini-2.5-flash-lite, only for ambiguous cases)
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
import { getChatCompletionWithMessages, type OpenAIResponse } from '@/services/ai/core/openai.service';
import { buildSnapshotSummary } from '../analysis/ai-goal-evaluator';
import type { GoalDetector } from '../analysis/goal-detector';
import type { GoalContext, StuckCheck } from '../lite-types';
import type { LiteTraceWriter } from '../trace/lite-trace-writer';
import { TestBlackboard } from './blackboard';
import { buildReviewerPrompt } from './prompts';
import type { ReviewResult } from './types';

/** Reviewer configuration */
const REVIEWER_CONFIG = {
  temperature: 0.1,
  maxTokens: 300,
  timeoutMs: 8000,
  /** Max retry attempts on transient AI failures (rate limit, network) */
  maxRetries: 2,
  /** Base delay between retries in ms (actual = base + attempt * increment) */
  retryBaseDelayMs: 1000,
  /** Delay increment per retry attempt in ms */
  retryIncrementMs: 500,
  /** Progress score threshold for fast-approve (continue) */
  progressThresholdContinue: 30,
  /** Progress score threshold for fast-approve (done) */
  progressThresholdDone: 85,
  /** Auditor cooldown: skip gpt-5.4-mini calls for N rounds after rejection */
  auditCooldownRounds: 2,
  /**
   * Consecutive server-error (5xx) rounds before the health gate escalates
   * from "replan" (transient, retry) to "blocked" (app persistently down).
   * Stops a hard-down server from burning the whole round budget on retries.
   */
  serverErrorBlockAfter: 2,
  /**
   * Consecutive rate-limited (HTTP 429) rounds before the gate escalates from
   * "replan + back off" to "blocked". More lenient than 5xx: throttling often
   * clears if we simply wait, so we give it more rounds before giving up.
   */
  rateLimitBlockAfter: 3,
} as const;

export class ReviewerAgent {
  /**
   * Per-blackboard cooldown tracking.
   * Uses WeakMap so entries are GC'd when the TestBlackboard is released.
   * This prevents cross-test contamination when multiple tests run concurrently.
   */
  private static auditCooldowns = new WeakMap<TestBlackboard, number>();

  /**
   * Per-blackboard count of CONSECUTIVE server-error (5xx) rounds. Same WeakMap
   * lifetime semantics as auditCooldowns. Reset to 0 on the first clean round
   * so a recovered app starts the streak over.
   */
  private static serverErrorStreaks = new WeakMap<TestBlackboard, number>();

  /** Per-blackboard count of CONSECUTIVE rate-limited (429) rounds. */
  private static rateLimitStreaks = new WeakMap<TestBlackboard, number>();

  /** Get cooldown remaining for a specific test (via its blackboard) */
  private static getCooldown(bb: TestBlackboard): number {
    return ReviewerAgent.auditCooldowns.get(bb) || 0;
  }

  /** Set cooldown remaining for a specific test */
  private static setCooldown(bb: TestBlackboard, value: number): void {
    ReviewerAgent.auditCooldowns.set(bb, value);
  }

  /** Consecutive 5xx streak for a specific test (via its blackboard). */
  private static getServerErrorStreak(bb: TestBlackboard): number {
    return ReviewerAgent.serverErrorStreaks.get(bb) || 0;
  }

  private static setServerErrorStreak(bb: TestBlackboard, value: number): void {
    ReviewerAgent.serverErrorStreaks.set(bb, value);
  }

  /** Consecutive 429 streak for a specific test (via its blackboard). */
  private static getRateLimitStreak(bb: TestBlackboard): number {
    return ReviewerAgent.rateLimitStreaks.get(bb) || 0;
  }

  private static setRateLimitStreak(bb: TestBlackboard, value: number): void {
    ReviewerAgent.rateLimitStreaks.set(bb, value);
  }

  /**
   * Validate execution results against the goal.
   *
   * Reads Blackboard: goal, plan, rounds, currentSnapshot, progressScore
   * Returns: ReviewResult to be written to Blackboard by pipeline
   *
   * @param goalDetector — Optional GoalDetector for auditDone() validation.
   *   When Executor claims mark_done, this enables gpt-5.4-mini double-check.
   */
  static async review(
    blackboard: TestBlackboard,
    goalDetector?: GoalDetector,
    traceWriter?: LiteTraceWriter,
  ): Promise<ReviewResult> {
    const round = blackboard.getRounds().length;

    // ═══════════════════════════════════════════════════════════════════
    // Phase -1: PAGE HEALTH gate (deterministic, runs BEFORE the done-claim
    // check so it catches the no-auditor / cooldown paths that would
    // otherwise trust a "done" on a broken page). Only the unambiguous
    // failures override here: a hard server error (5xx) or a mid-flow logout.
    // A transient 4xx alone is left to the AI reviewer / done-auditor.
    // ═══════════════════════════════════════════════════════════════════
    const health = blackboard.getPageHealth();
    if (health?.serverErrorStatus) {
      // Track consecutive 5xx rounds: transient → replan (retry), but a
      // persistently-down server escalates to blocked so we stop burning the
      // round budget on doomed retries (the round limit alone would just
      // time out ungracefully).
      const streak = ReviewerAgent.getServerErrorStreak(blackboard) + 1;
      ReviewerAgent.setServerErrorStreak(blackboard, streak);
      const escalate = streak >= REVIEWER_CONFIG.serverErrorBlockAfter;
      logger.debug('[REVIEWER] Health gate: server error', {
        status: health.serverErrorStatus, streak, verdict: escalate ? 'blocked' : 'replan',
      });
      const result: ReviewResult = escalate
        ? {
            verdict: 'blocked',
            reason: `Server error HTTP ${health.serverErrorStatus} persisted for ${streak} rounds — the app appears down, goal not achievable`,
            goalAlignment: 0,
          }
        : {
            verdict: 'replan',
            reason: `Server error HTTP ${health.serverErrorStatus} — the page failed, goal not achieved`,
            goalAlignment: 0,
            guidance: 'The app returned a server error. Retry the action or a different path; do not treat this page as success.',
          };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round, path: 'health_server_error', verdict: result.verdict, status: health.serverErrorStatus, streak,
      });
      return result;
    }
    // Clean round (no 5xx): reset the streak so a later transient error starts
    // a fresh count and a recovered app isn't escalated on stale history.
    ReviewerAgent.setServerErrorStreak(blackboard, 0);

    // Rate limited (429): the app is ALIVE but throttling us — not a failure.
    // Back off and retry; escalate to blocked only if it persists (the site is
    // refusing us for now). More lenient than 5xx (rateLimitBlockAfter > 5xx).
    if (health?.rateLimited) {
      const streak = ReviewerAgent.getRateLimitStreak(blackboard) + 1;
      ReviewerAgent.setRateLimitStreak(blackboard, streak);
      const escalate = streak >= REVIEWER_CONFIG.rateLimitBlockAfter;
      const result: ReviewResult = escalate
        ? {
            verdict: 'blocked',
            reason: `Rate limited (HTTP 429) for ${streak} rounds — the site keeps throttling; goal not achievable right now`,
            goalAlignment: 0,
          }
        : {
            verdict: 'replan',
            reason: `Rate limited (HTTP 429) — the site is throttling requests, not failing`,
            goalAlignment: blackboard.getProgressScore() / 100,
            guidance: 'The site returned HTTP 429 (too many requests). Wait before retrying and slow the pace — do NOT treat this as goal failure or keep hammering the same action.',
          };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round, path: 'health_rate_limited', verdict: result.verdict, streak,
      });
      return result;
    }
    ReviewerAgent.setRateLimitStreak(blackboard, 0);

    if (health?.sessionLost) {
      logger.debug('[REVIEWER] Health gate: session lost → blocked');
      const result: ReviewResult = {
        verdict: 'blocked',
        reason: 'Redirected to a login page mid-flow — the session was lost, goal not achieved',
        goalAlignment: 0,
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round, path: 'health_session_lost', verdict: result.verdict,
      });
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 0: auditDone() — validate "done" claims with gpt-4o
    // This is the CRITICAL check that prevents false completions.
    // ═══════════════════════════════════════════════════════════════════

    if (blackboard.getPhase() === 'done') {
      return ReviewerAgent.validateDoneClaim(blackboard, goalDetector, traceWriter);
    }

    if (blackboard.getPhase() === 'blocked') {
      logger.debug('[REVIEWER] Fast-path: blocked (executor reported blocker)');
      const result: ReviewResult = {
        verdict: 'blocked',
        reason: 'Executor reported test blocked',
        goalAlignment: 0,
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round,
        path: 'blocked_by_executor',
        verdict: result.verdict,
        reason: result.reason,
      });
      return result;
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 1: Deterministic fast-paths (0 tokens, <1ms)
    // ═══════════════════════════════════════════════════════════════════

    const lastRound = blackboard.getLastRound();
    if (!lastRound || lastRound.commands.length === 0) {
      logger.debug('[REVIEWER] Fast-path: continue (no execution yet)');
      const result: ReviewResult = {
        verdict: 'continue',
        reason: 'No commands executed yet',
        goalAlignment: 0,
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round,
        path: 'no_commands',
        verdict: result.verdict,
      });
      return result;
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

      const result: ReviewResult = {
        verdict: 'replan',
        reason: `All commands failed: ${errors}`,
        goalAlignment: 0,
        failedSteps: failedStepNumbers.length > 0 ? failedStepNumbers : undefined,
        guidance: 'Try a different approach — the current page state may have changed.',
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round,
        path: 'all_failed_replan',
        verdict: result.verdict,
        errors,
        failedSteps: failedStepNumbers,
        commandCount: allCommands.length,
      });
      return result;
    }

    // All succeeded + very high progress → signal Executor should verify and mark_done
    // IMPORTANT: Check high threshold BEFORE moderate threshold (85% before 30%)
    // Otherwise, the 30% check would always match first and this path would be unreachable.
    // NOTE: Skip if stuck on same page — high progress might be stale/wrong.
    if (allSucceeded && progressScore >= REVIEWER_CONFIG.progressThresholdDone && !isStuckOnSamePage) {
      logger.debug('[REVIEWER] Fast-path: continue (high progress, need mark_done)', { progressScore });
      const result: ReviewResult = {
        verdict: 'continue',
        reason: `High progress (${progressScore}%), executor should verify goal and mark_done`,
        goalAlignment: progressScore / 100,
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round,
        path: 'high_progress_continue',
        verdict: result.verdict,
        progressScore,
      });
      return result;
    }

    // All commands succeeded + moderate progress → continue execution
    // NOTE: Skip if stuck on same page — let AI review assess the situation.
    if (allSucceeded && progressScore >= REVIEWER_CONFIG.progressThresholdContinue && !isStuckOnSamePage) {
      logger.debug('[REVIEWER] Fast-path: continue (all succeeded, good progress)', { progressScore });
      const result: ReviewResult = {
        verdict: 'continue',
        reason: `All ${allCommands.length} commands succeeded, progress at ${progressScore}%`,
        goalAlignment: progressScore / 100,
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round,
        path: 'moderate_progress_continue',
        verdict: result.verdict,
        progressScore,
        commandCount: allCommands.length,
      });
      return result;
    }

    // If stuck on same page, log that we're escalating to AI review
    if (isStuckOnSamePage) {
      logger.debug('[REVIEWER] Skipping fast-path: page state unchanged, escalating to AI review');
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path_skipped', {
        round,
        reason: 'stuck_on_same_page',
        progressScore,
        allSucceeded,
      });
    }

    // Mixed results with low progress and few rounds → continue to see what happens
    const totalRounds = blackboard.getRounds().length;
    if (totalRounds <= 2 && progressScore < REVIEWER_CONFIG.progressThresholdContinue) {
      logger.debug('[REVIEWER] Fast-path: continue (early rounds, low progress)');
      const result: ReviewResult = {
        verdict: 'continue',
        reason: 'Still in early rounds, continuing execution',
        goalAlignment: progressScore / 100,
      };
      ReviewerAgent.trace(traceWriter, 'reviewer_fast_path', {
        round,
        path: 'early_rounds_continue',
        verdict: result.verdict,
        progressScore,
        totalRounds,
      });
      return result;
    }

    // Decrement audit cooldown each review cycle
    const cooldown = ReviewerAgent.getCooldown(blackboard);
    if (cooldown > 0) {
      ReviewerAgent.setCooldown(blackboard, cooldown - 1);
    }

    // ═══════════════════════════════════════════════════════════════════
    // Phase 2: AI assessment (only for ambiguous cases)
    // ═══════════════════════════════════════════════════════════════════

    ReviewerAgent.trace(traceWriter, 'reviewer_escalate_to_ai', {
      round,
      reason: 'ambiguous_case',
      progressScore,
      allSucceeded,
      allFailed,
      commandCount: allCommands.length,
      totalRounds,
      isStuckOnSamePage,
    });

    return ReviewerAgent.aiReview(blackboard, traceWriter);
  }

  /**
   * Validate Executor's "done" claim with GoalDetector.auditDone().
   *
   * This is the gpt-5.4-mini double-check that prevents false completions.
   * If GoalDetector is not available, falls back to heuristic + AI review.
   *
   * With audit cooldown: after auditor rejects, don't call again for N rounds.
   */
  private static async validateDoneClaim(
    blackboard: TestBlackboard,
    goalDetector?: GoalDetector,
    traceWriter?: LiteTraceWriter,
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

    // Check cooldown: skip expensive gpt-5.4-mini call if recently rejected.
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
      logger.info('[REVIEWER] Calling auditDone (gpt-5.4-mini) to validate done claim', {
        testId: blackboard.getTestId(),
        url: goalContext.page.url,
        progressScore: blackboard.getProgressScore(),
      });

      const auditStart = Date.now();
      const auditResult = await goalDetector.auditDone(goalContext, lastAction);

      // Trace: auditDone result (critical decision point)
      ReviewerAgent.trace(traceWriter, 'reviewer_audit_done', {
        round: blackboard.getRounds().length,
        isDone: auditResult.isDone,
        isBlocked: auditResult.isBlocked,
        confidence: auditResult.confidence,
        reason: auditResult.reason,
        nextStepIfMissing: auditResult.nextStepIfMissing,
        blockedReason: auditResult.blockedReason,
        lastAction,
        latencyMs: Date.now() - auditStart,
      });

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

      // Set cooldown to prevent repeated expensive gpt-5.4-mini calls
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
      logger.warn('[REVIEWER] auditDone failed, NOT trusting executor claim (conservative)', { error: errorMsg });

      ReviewerAgent.trace(traceWriter, 'reviewer_audit_error', {
        round: blackboard.getRounds().length,
        error: errorMsg,
      });

      // ✅ FIX: On auditor failure, do NOT trust Executor — conservative means "don't complete"
      // Previously returned verdict: 'done' which was the OPPOSITE of conservative
      return {
        verdict: 'continue',
        reason: 'Executor marked goal as achieved but auditor unavailable — re-verify next iteration',
        goalAlignment: 0.5,
      };
    }
  }

  /**
   * AI-powered review for ambiguous cases.
   * Uses gemini-2.5-flash-lite for cost efficiency.
   */
  private static async aiReview(blackboard: TestBlackboard, traceWriter?: LiteTraceWriter): Promise<ReviewResult> {
    const prompt = buildReviewerPrompt(blackboard);
    const round = blackboard.getRounds().length;

    // Trace: full prompt sent to reviewer AI
    ReviewerAgent.trace(traceWriter, 'reviewer_ai_prompt', {
      round,
      model: AI_TASK_MODELS.chatReviewer,
      prompt,
      progressScore: blackboard.getProgressScore(),
    });

    const llmStart = Date.now();

    try {
      // Retry loop with backoff (handles transient rate limits / network errors)
      let result: OpenAIResponse | null = null;
      let lastError: string | undefined;

      for (let attempt = 0; attempt < REVIEWER_CONFIG.maxRetries; attempt++) {
        if (attempt > 0) {
          await new Promise((r) => setTimeout(r, REVIEWER_CONFIG.retryBaseDelayMs + attempt * REVIEWER_CONFIG.retryIncrementMs));
        }

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

          result = await Promise.race([aiPromise, timeoutPromise]);
          if (result) break; // success
          lastError = 'timeout';
        } catch (retryErr) {
          lastError = retryErr instanceof Error ? retryErr.message : String(retryErr);
          // Only retry on transient errors (rate limit, network), not on auth/model errors
          const status = (retryErr as any)?.status;
          if (status === 401 || status === 403 || status === 404) break;
        }
      }

      if (!result) {
        logger.warn('[REVIEWER] AI failed after retries — defaulting to heuristic', { lastError });
        ReviewerAgent.trace(traceWriter, 'reviewer_ai_timeout', {
          round,
          timeoutMs: REVIEWER_CONFIG.timeoutMs,
          lastError,
        });
        return ReviewerAgent.safeDefault(blackboard);
      }

      // Parse response — extract first balanced JSON object to handle LLM trailing text
      const content = result.content?.trim() || '';
      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');
      const jsonStr = extractBalancedJson(cleaned);
      if (!jsonStr) {
        logger.warn('[REVIEWER] No valid JSON object found in AI response');
        return ReviewerAgent.safeDefault(blackboard);
      }
      const parsed = JSON.parse(jsonStr);

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

      // Trace: full raw response from reviewer AI
      ReviewerAgent.trace(traceWriter, 'reviewer_ai_response', {
        round,
        model: AI_TASK_MODELS.chatReviewer,
        rawResponse: content,
        parsedVerdict: verdict,
        parsedReason: review.reason,
        goalAlignment: review.goalAlignment,
        guidance: review.guidance,
        failedSteps: review.failedSteps,
        latencyMs: Date.now() - llmStart,
        tokensUsed: result.usage?.totalTokens,
      });

      logger.debug('[REVIEWER] AI review completed', {
        verdict: review.verdict,
        goalAlignment: review.goalAlignment,
        reason: review.reason.slice(0, 80),
      });

      return review;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      const httpStatus = (error as any)?.status;
      const errorCode = (error as any)?.code;
      logger.warn('[REVIEWER] AI review error — defaulting to heuristic', {
        error: errorMsg,
        httpStatus,
        errorCode,
      });
      ReviewerAgent.trace(traceWriter, 'reviewer_ai_error', {
        round,
        error: errorMsg,
        httpStatus,
        errorCode,
        latencyMs: Date.now() - llmStart,
      });
      return ReviewerAgent.safeDefault(blackboard);
    }
  }

  /**
   * Smart fallback when AI reviewer fails.
   * Uses deterministic heuristics instead of blindly returning "continue".
   */
  private static safeDefault(blackboard: TestBlackboard): ReviewResult {
    const progressScore = blackboard.getProgressScore();
    const totalRounds = blackboard.getRounds().length;

    // High progress — likely done, let executor verify
    if (progressScore >= 80) {
      return {
        verdict: 'continue',
        reason: `Reviewer fallback: high progress (${progressScore}%), executor should verify`,
        goalAlignment: progressScore / 100,
      };
    }

    // Too many rounds with low progress — stuck, replan
    if (totalRounds >= 8 && progressScore < 30) {
      return {
        verdict: 'replan',
        reason: `Reviewer fallback: ${totalRounds} rounds but only ${progressScore}% progress — likely stuck`,
        goalAlignment: progressScore / 100,
        guidance: 'The current approach is not making progress. Try a different strategy.',
      };
    }

    // Default: continue but with reduced alignment to signal caution
    return {
      verdict: 'continue',
      reason: `Reviewer fallback: continuing (${progressScore}% progress, round ${totalRounds})`,
      goalAlignment: progressScore / 100,
    };
  }

  /** Write trace entry (fire-and-forget) */
  private static trace(traceWriter: LiteTraceWriter | undefined, eventType: string, payload: Record<string, any>): void {
    try {
      traceWriter?.write({
        stage: 'pipeline',
        eventType,
        spanId: traceWriter.generateSpanId(),
        payload,
      });
    } catch { /* never break agent for trace failures */ }
  }
}

/** Extract first balanced JSON object from text (handles LLM trailing text). */
function extractBalancedJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return text.slice(start, i + 1); }
  }
  return null;
}
