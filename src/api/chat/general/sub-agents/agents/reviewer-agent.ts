import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { raceWithTimeout } from '../tool-constants';
import { buildReviewerPrompt } from '../prompts/reviewer-prompt';
import type { Blackboard } from '../blackboard';
import type { ReviewerResult, ToolExecutionRecord } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REVIEWER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Verifies executor output against user's original goal.
 * Adapted from LiteEngine's CriticAgent (double-blind pattern).
 *
 * Two phases:
 * 1. Deterministic checks (0 tokens, <1ms) — plan completion, error detection
 * 2. AI assessment (gemini-2.5-flash-lite) — goal alignment, response guidance
 *
 * Key principle: Double-blind — does NOT see planner's reasoning.
 * Key safety: Defaults to 'approved' on any failure (never blocks pipeline).
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Build a results summary for the reviewer (without plan reasoning — double-blind).
 */
function buildResultsSummaryForReviewer(
  toolResults: ToolExecutionRecord[]
): string {
  if (toolResults.length === 0) return '(no tool results)';

  const truncateLimit = SUB_AGENT_CONFIG.reviewerResultTruncateChars;
  return toolResults.map(r => {
    const status = r.result.success ? 'SUCCESS' : 'FAILED';
    const data = r.result.data
      ? JSON.stringify(r.result.data).substring(0, truncateLimit)
      : r.result.message;
    return `[${status}] ${r.toolName}: ${data}`;
  }).join('\n\n');
}

/**
 * Review the pipeline execution results against the user's original goal.
 *
 * Returns null only on catastrophic failure — otherwise always returns a ReviewerResult.
 * Defaults to 'approved' on any error to prevent blocking the pipeline.
 */
export async function reviewExecution(
  blackboard: Blackboard,
  abortSignal?: AbortSignal
): Promise<ReviewerResult> {
  const startMs = Date.now();
  const goal = blackboard.getGoal();
  const plan = blackboard.getPlan();
  const execution = blackboard.getExecutionResults();

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 1: Deterministic Checks (0 tokens, <1ms)
  // ═══════════════════════════════════════════════════════════════════════

  const allSteps = plan?.steps ?? [];
  const completedSteps = allSteps.filter(s => s.status === 'completed');
  const failedSteps = allSteps.filter(s => s.status === 'failed');
  const failedStepNumbers = failedSteps.map(s => s.stepNumber);
  const planCompletionRate = allSteps.length > 0
    ? completedSteps.length / allSteps.length
    : 1; // No plan = single_tool path, consider complete

  // Gather all tool results (from plan steps + ungrouped)
  const allToolResults: ToolExecutionRecord[] = [];
  if (execution?.ungroupedResults) {
    allToolResults.push(...execution.ungroupedResults);
  }
  if (execution?.stepResults) {
    for (const results of execution.stepResults.values()) {
      allToolResults.push(...results);
    }
  }
  // Also gather from tracked steps
  for (const step of allSteps) {
    if (step.toolResults) {
      allToolResults.push(...step.toolResults);
    }
  }

  // Deduplicate by toolName+args hash+durationMs (rough dedup — same tool, same args, same timing = same call)
  const seenKeys = new Set<string>();
  const uniqueToolResults = allToolResults.filter(r => {
    const argsKey = JSON.stringify(r.args).substring(0, 200);
    const key = `${r.toolName}-${argsKey}-${r.durationMs}`;
    if (seenKeys.has(key)) return false;
    seenKeys.add(key);
    return true;
  });

  // FAST REJECT: All steps failed → immediate needs_retry (no AI needed)
  if (allSteps.length > 0 && completedSteps.length === 0 && failedSteps.length > 0) {
    logger.info('[REVIEWER_AGENT] All steps failed — immediate needs_retry', {
      failedSteps: failedStepNumbers,
      durationMs: Date.now() - startMs,
    });
    return {
      verdict: 'needs_retry',
      planCompletionRate: 0,
      failedSteps: failedStepNumbers,
      goalAlignment: 0,
      retrySteps: failedStepNumbers,
      reasoning: 'All plan steps failed — retry all',
    };
  }

  // FAST APPROVE: No plan (single_tool path) + all tools succeeded → skip AI
  if (allSteps.length === 0 && uniqueToolResults.every(r => r.result.success)) {
    logger.info('[REVIEWER_AGENT] All tools succeeded (no plan) — fast approve', {
      toolCount: uniqueToolResults.length,
      durationMs: Date.now() - startMs,
    });
    return {
      verdict: 'approved',
      planCompletionRate: 1,
      failedSteps: [],
      goalAlignment: SUB_AGENT_CONFIG.reviewerFastApproveAlignment,
      reasoning: 'All tools executed successfully (deterministic fast-path)',
    };
  }

  // FAST APPROVE: All plan steps completed + all tools succeeded → skip AI
  if (allSteps.length > 0 && planCompletionRate === 1 && uniqueToolResults.every(r => r.result.success)) {
    logger.info('[REVIEWER_AGENT] All plan steps completed successfully — fast approve', {
      stepCount: allSteps.length,
      durationMs: Date.now() - startMs,
    });
    return {
      verdict: 'approved',
      planCompletionRate: 1,
      failedSteps: [],
      goalAlignment: SUB_AGENT_CONFIG.reviewerFullPlanApproveAlignment,
      reasoning: 'All plan steps completed successfully (deterministic fast-path)',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // Phase 2: AI Assessment (gemini-2.5-flash-lite, double-blind)
  // Only reaches here for: partial failures, mixed results, ambiguous outcomes
  // ═══════════════════════════════════════════════════════════════════════

  const resultsSummary = buildResultsSummaryForReviewer(uniqueToolResults);
  const prompt = buildReviewerPrompt(goal, resultsSummary, planCompletionRate, failedStepNumbers);

  try {
    const aiPromise = getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: AI_TASK_MODELS.chatReviewer,
        temperature: SUB_AGENT_CONFIG.reviewerTemperature,
        max_tokens: SUB_AGENT_CONFIG.reviewerMaxTokens,
        response_format: { type: 'json_object' },
        abortSignal,
      }
    );

    const response = await raceWithTimeout(aiPromise, SUB_AGENT_CONFIG.reviewerTimeoutMs);

    if (!response || !response.content) {
      logger.warn('[REVIEWER_AGENT] Timeout — defaulting to approved', {
        durationMs: Date.now() - startMs,
      });
      return {
        verdict: 'approved',
        planCompletionRate,
        failedSteps: failedStepNumbers,
        goalAlignment: SUB_AGENT_CONFIG.reviewerFallbackAlignment,
        reasoning: 'Reviewer timed out — defaulting to approved',
      };
    }

    // Parse AI response
    const cleanContent = response.content.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    const result: ReviewerResult = {
      verdict: ['approved', 'needs_retry', 'needs_clarification'].includes(parsed.verdict)
        ? parsed.verdict
        : 'approved',
      planCompletionRate,
      failedSteps: failedStepNumbers,
      goalAlignment: typeof parsed.goalAlignment === 'number'
        ? Math.max(0, Math.min(1, parsed.goalAlignment))
        : SUB_AGENT_CONFIG.reviewerFallbackAlignment,
      responseGuidance: parsed.responseGuidance || undefined,
      retrySteps: parsed.verdict === 'needs_retry' && Array.isArray(parsed.retrySteps)
        ? parsed.retrySteps.filter((n: any) => typeof n === 'number')
        : undefined,
      clarificationNeeded: parsed.verdict === 'needs_clarification'
        ? parsed.clarificationNeeded
        : undefined,
      reasoning: parsed.reasoning || 'no reasoning',
    };

    logger.info('[REVIEWER_AGENT] Review complete', {
      verdict: result.verdict,
      goalAlignment: result.goalAlignment,
      planCompletionRate: result.planCompletionRate,
      failedSteps: result.failedSteps,
      durationMs: Date.now() - startMs,
    });

    return result;
  } catch (error) {
    // On any failure, default to 'approved' — reviewer should NEVER block
    logger.error('[REVIEWER_AGENT] AI review failed — defaulting to approved', {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startMs,
    });

    return {
      verdict: 'approved',
      planCompletionRate,
      failedSteps: failedStepNumbers,
      goalAlignment: SUB_AGENT_CONFIG.reviewerFallbackAlignment,
      reasoning: `Reviewer error: ${error instanceof Error ? error.message : String(error)} — defaulting to approved`,
    };
  }
}
