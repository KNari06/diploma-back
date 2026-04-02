/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLANNER AGENT — "What should we do?"
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Analyzes the current page state (from Blackboard) and creates a
 * step-by-step plan for the Executor to follow.
 *
 * Reads from Blackboard:
 * - currentSnapshot — what's on the page right now
 * - rounds[] — what Executor did in previous rounds
 * - review — what Reviewer said about last execution
 * - insights — accumulated team knowledge
 *
 * Writes to Blackboard:
 * - plan — ordered steps for Executor
 *
 * Single LLM call: ~500 tokens output, gpt-5.4-mini, temperature 0.15
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import type { LiteTraceWriter } from '../trace/lite-trace-writer';
import { TestBlackboard } from './blackboard';
import { buildPlannerPrompt } from './prompts';
import type { TestPlan, PlanStep } from './types';

/** Planner configuration */
const PLANNER_CONFIG = {
  temperature: 0.15,
  maxTokens: 600,
  timeoutMs: 10000,
} as const;

export class PlannerAgent {
  /**
   * Analyze current page and create a step-by-step plan.
   *
   * Reads Blackboard: currentSnapshot, rounds, review, insights
   * Returns: TestPlan to be written to Blackboard by pipeline
   */
  static async plan(blackboard: TestBlackboard, traceWriter?: LiteTraceWriter): Promise<TestPlan> {
    const prompt = buildPlannerPrompt(blackboard);
    const round = blackboard.getRounds().length + 1;

    // Trace: full prompt sent to AI
    PlannerAgent.trace(traceWriter, 'planner_prompt', {
      round,
      model: AI_TASK_MODELS.chatPlanner,
      prompt,
      goal: blackboard.getGoal(),
      hasSnapshot: !!blackboard.getCurrentSnapshot(),
      hasReview: !!blackboard.getReview(),
      previousRounds: blackboard.getRounds().length,
    });

    const llmStart = Date.now();

    try {
      const aiPromise = getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: AI_TASK_MODELS.chatPlanner,
          temperature: PLANNER_CONFIG.temperature,
          max_tokens: PLANNER_CONFIG.maxTokens,
          response_format: { type: 'json_object' },
        }
      );

      // Race against timeout
      const timeoutPromise = new Promise<null>((resolve) =>
        setTimeout(() => resolve(null), PLANNER_CONFIG.timeoutMs)
      );

      const result = await Promise.race([aiPromise, timeoutPromise]);

      if (!result) {
        logger.warn('[PLANNER] Timeout — returning default plan');
        PlannerAgent.trace(traceWriter, 'planner_timeout', {
          round,
          timeoutMs: PLANNER_CONFIG.timeoutMs,
        });
        return PlannerAgent.buildDefaultPlan(blackboard);
      }

      // Parse JSON response
      const content = result.content?.trim() || '';
      const cleaned = content.replace(/```json\s*/g, '').replace(/```\s*/g, '');

      // Trace: full raw response from AI
      PlannerAgent.trace(traceWriter, 'planner_response', {
        round,
        model: AI_TASK_MODELS.chatPlanner,
        rawResponse: content,
        latencyMs: Date.now() - llmStart,
        tokensUsed: result.usage?.totalTokens,
      });

      // Extract first balanced JSON object — LLM sometimes appends text after closing '}'
      const jsonStr = extractBalancedJson(cleaned);
      if (!jsonStr) {
        logger.warn('[PLANNER] No valid JSON object found in response');
        PlannerAgent.trace(traceWriter, 'planner_error', {
          round,
          error: 'No JSON object found in response',
          latencyMs: Date.now() - llmStart,
        });
        return PlannerAgent.buildDefaultPlan(blackboard);
      }
      const parsed = JSON.parse(jsonStr);

      // Validate plan structure
      if (!parsed.summary || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
        logger.warn('[PLANNER] Invalid plan structure, using default');
        PlannerAgent.trace(traceWriter, 'planner_fallback', {
          round,
          reason: 'invalid_plan_structure',
          rawResponse: content,
        });
        return PlannerAgent.buildDefaultPlan(blackboard);
      }

      // Normalize steps (including optional grounded element refs)
      const steps: PlanStep[] = parsed.steps.map((s: any, idx: number) => ({
        stepNumber: s.stepNumber || idx + 1,
        description: s.description || `Step ${idx + 1}`,
        status: 'pending' as const,
        ...(s.targetRef ? { targetRef: String(s.targetRef) } : {}),
      }));

      // Cap at 8 steps
      const cappedSteps = steps.slice(0, 8);

      const plan: TestPlan = {
        summary: parsed.summary,
        steps: cappedSteps,
      };

      logger.debug('[PLANNER] Plan created', {
        summary: plan.summary.slice(0, 80),
        stepCount: plan.steps.length,
      });

      return plan;
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.warn('[PLANNER] Error creating plan', { error: errorMsg });
      PlannerAgent.trace(traceWriter, 'planner_error', {
        round,
        error: errorMsg,
        latencyMs: Date.now() - llmStart,
      });
      return PlannerAgent.buildDefaultPlan(blackboard);
    }
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

  /**
   * Fallback plan when AI fails — observe the page and take action.
   */
  private static buildDefaultPlan(bb: TestBlackboard): TestPlan {
    const hasSnapshot = !!bb.getCurrentSnapshot();

    if (!hasSnapshot) {
      return {
        summary: 'Observe page and take initial action',
        steps: [
          { stepNumber: 1, description: 'Observe the current page state', status: 'pending' },
          { stepNumber: 2, description: 'Take action based on page content', status: 'pending' },
        ],
      };
    }

    return {
      summary: 'Continue working toward goal',
      steps: [
        { stepNumber: 1, description: 'Analyze current page and take next action toward goal', status: 'pending' },
      ],
    };
  }
}

/**
 * Extract the first balanced JSON object from a string.
 * Handles LLM responses that append text after the closing '}'.
 */
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
  return null; // Unbalanced
}
