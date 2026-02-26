import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from './config';
import { getToolsForCategories } from './tool-groups';
import { executeToolsForStep } from './agents/sub-executor';
import type { Blackboard } from './blackboard';
import type { PipelineContext, SubExecutorResult, TrackedPlanStep } from './types';
import type { ChatCompletionTool, ChatCompletionMessageParam } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-AGENT SPAWNER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages creation, lifecycle, and concurrency of temporary sub-executor agents
 * for parallel plan step execution.
 *
 * Uses Promise.allSettled for resilience — individual sub-executor failures
 * don't crash other parallel steps.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export class SubAgentSpawner {
  private maxConcurrency: number;

  constructor(maxConcurrency: number) {
    this.maxConcurrency = Math.min(maxConcurrency, SUB_AGENT_CONFIG.absoluteMaxConcurrency);
  }

  /**
   * Execute a group of independent plan steps in parallel.
   * Each step gets its own sub-executor with tools filtered to that step's category.
   *
   * @param steps - Independent steps that can run concurrently
   * @param userMessage - User's original message
   * @param contextMessages - Conversation context (history, memory, KB)
   * @param allFilteredTools - All tools available for the current pipeline
   * @param context - Pipeline context (userId, workspaceId, etc.)
   * @param blackboard - Shared pipeline state
   * @param abortSignal - Cancellation signal
   */
  async executeParallel(
    steps: TrackedPlanStep[],
    userMessage: string,
    contextMessages: ChatCompletionMessageParam[],
    allFilteredTools: ChatCompletionTool[],
    context: PipelineContext,
    blackboard: Blackboard,
    abortSignal?: AbortSignal
  ): Promise<SubExecutorResult[]> {
    // Guard: nothing to execute
    if (steps.length === 0) return [];

    // Early abort check — don't start parallel work if already cancelled
    if (abortSignal?.aborted) {
      logger.info('[SPAWNER] Request already aborted — skipping parallel execution');
      return [];
    }

    // Limit to max concurrency
    const stepsToExecute = steps.slice(0, this.maxConcurrency);
    const userGoal = blackboard.getGoal();

    logger.info('[SPAWNER] Launching parallel sub-executors', {
      totalSteps: steps.length,
      executing: stepsToExecute.length,
      stepNumbers: stepsToExecute.map(s => s.stepNumber),
    });

    const promises = stepsToExecute.map(async (step): Promise<SubExecutorResult> => {
      const executorId = `sub-${step.stepNumber}-${Date.now()}`;

      // Filter tools to just this step's category
      const stepTools = getToolsForCategories(allFilteredTools, [step.category]);

      // Mark step as in_progress on blackboard
      blackboard.updateStepStatus(step.stepNumber, 'in_progress', undefined, undefined, executorId);

      try {
        const result = await executeToolsForStep(
          step,
          userMessage,
          contextMessages,
          stepTools,
          context,
          abortSignal,
          userGoal
        );

        // Update blackboard with results
        blackboard.updateStepStatus(
          step.stepNumber,
          result.success ? 'completed' : 'failed',
          result.toolResults,
          result.success ? undefined : 'Sub-executor failed',
          executorId
        );

        return {
          ...result,
          stepNumber: step.stepNumber,
          executorId,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        logger.error('[SPAWNER] Sub-executor failed', {
          step: step.stepNumber,
          executorId,
          error: errorMsg,
        });

        blackboard.updateStepStatus(step.stepNumber, 'failed', undefined, errorMsg, executorId);

        return {
          stepNumber: step.stepNumber,
          executorId,
          success: false,
          toolResults: [],
          assistantContent: '',
          toolRounds: 0,
        };
      }
    });

    const settled = await Promise.allSettled(promises);

    const results: SubExecutorResult[] = settled.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }

      // Promise rejection (shouldn't happen since we catch in the map, but just in case)
      const step = stepsToExecute[idx];
      logger.error('[SPAWNER] Promise rejected for step', {
        step: step.stepNumber,
        reason: result.reason instanceof Error ? result.reason.message : String(result.reason),
      });

      return {
        stepNumber: step.stepNumber,
        executorId: `sub-${step.stepNumber}-rejected`,
        success: false,
        toolResults: [],
        assistantContent: '',
        toolRounds: 0,
      };
    });

    logger.info('[SPAWNER] Parallel execution complete', {
      total: results.length,
      succeeded: results.filter(r => r.success).length,
      failed: results.filter(r => !r.success).length,
    });

    return results;
  }
}
