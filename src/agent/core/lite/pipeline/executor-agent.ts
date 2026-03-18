/**
 * ═══════════════════════════════════════════════════════════════════════════
 * EXECUTOR AGENT — "Do it."
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The core tool-calling LLM loop. Reads the plan from Blackboard,
 * executes Playwright commands, writes results back.
 *
 * Modeled after: src/api/chat/general/sub-agents/agents/executor-agent.ts
 *
 * Pattern:
 *   while (round < maxRounds) {
 *     response = LLM.call(messages, { tools: PLAYWRIGHT_COMMANDS })
 *     for (toolCall of response.tool_calls) {
 *       result = CommandExecutor.execute(toolCall)
 *       messages.push(toolResult)  // context grows
 *     }
 *   }
 *
 * Reads from Blackboard:
 * - plan — what Planner decided
 * - currentSnapshot — current page state
 *
 * Writes to Blackboard:
 * - rounds[] — execution history (commands + results)
 * - currentSnapshot — updated after observe_page
 * - insights — observations during execution
 * - phase — 'done' or 'blocked' on terminal commands
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import type { ChatCompletionMessageParam } from 'openai/resources';
import type { LiteTraceWriter } from '../trace/lite-trace-writer';
import { TestBlackboard } from './blackboard';
import { CommandExecutor } from './command-executor';
import { PLAYWRIGHT_COMMANDS } from './commands';
import { ContextManager } from './context-manager';
import { buildExecutorSystemPrompt, buildExecutorUserMessage } from './prompts';
import type { CommandName, CommandResult, ExecutedCommand, ExecutionRound, PlaywrightCommand } from './types';

/** Executor configuration */
const EXECUTOR_CONFIG = {
  /** Max tool-calling rounds per executor invocation */
  maxCommandRounds: 3,
  /** LLM temperature (low for deterministic execution) */
  temperature: 0.1,
  /** Max tokens for executor response */
  maxTokens: 1500,
  /** Timeout per LLM call in ms */
  timeoutMs: 30000,
} as const;

export class ExecutorAgent {
  private messages: ChatCompletionMessageParam[] = [];
  private traceWriter?: LiteTraceWriter;

  /**
   * Execute the plan by calling Playwright commands in a tool-calling loop.
   *
   * Reads Blackboard: plan, currentSnapshot
   * Writes Blackboard: rounds[], currentSnapshot, insights, phase
   */
  async execute(
    blackboard: TestBlackboard,
    commandExecutor: CommandExecutor,
    abortSignal?: AbortSignal,
    traceWriter?: LiteTraceWriter,
  ): Promise<void> {
    this.traceWriter = traceWriter;
    const pipelineRound = blackboard.getRounds().length + 1;

    // Build initial messages from Blackboard context
    const systemPrompt = buildExecutorSystemPrompt(blackboard);
    const userMessage = buildExecutorUserMessage(blackboard);
    this.messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ];

    // Trace: full prompts sent to executor
    this.trace('executor_prompt', {
      pipelineRound,
      model: AI_TASK_MODELS.chatExecutor,
      systemPrompt,
      userMessage,
      planSummary: blackboard.getPlan()?.summary,
      planSteps: blackboard.getPlan()?.steps.map(s => s.description),
    });

    let round = 0;

    while (round < EXECUTOR_CONFIG.maxCommandRounds) {
      round++;

      // Check abort
      if (abortSignal?.aborted) {
        blackboard.addInsight('Execution aborted by user');
        break;
      }

      // Smart context compression if approaching token limit
      ContextManager.compressIfNeeded(this.messages);

      const llmStart = Date.now();

      try {
        // Single LLM call with Playwright commands available
        const response = await getChatCompletionWithMessages(this.messages, {
          model: AI_TASK_MODELS.chatExecutor,
          temperature: EXECUTOR_CONFIG.temperature,
          max_tokens: EXECUTOR_CONFIG.maxTokens,
          tools: PLAYWRIGHT_COMMANDS,
          tool_choice: 'auto',
          abortSignal,
        });

        const toolCalls = response.tool_calls;

        // No tool calls = model wants to talk or thinks it's done
        if (!toolCalls || toolCalls.length === 0) {
          if (response.content) {
            logger.debug('[EXECUTOR] Model response without commands', {
              content: response.content.slice(0, 100),
            });
            blackboard.addInsight(response.content.slice(0, 200));
          }
          this.trace('executor_no_tools', {
            pipelineRound,
            executorRound: round,
            modelContent: response.content?.slice(0, 500),
            latencyMs: Date.now() - llmStart,
          });
          break;
        }

        // Trace: tool calls chosen by AI
        this.trace('executor_tool_calls', {
          pipelineRound,
          executorRound: round,
          toolCalls: toolCalls.map(tc => ({
            name: tc.function.name,
            args: tc.function.arguments?.slice(0, 500),
          })),
          modelContent: response.content?.slice(0, 200),
          latencyMs: Date.now() - llmStart,
          tokensUsed: response.usage?.totalTokens,
        });

        // Push assistant message with tool calls (preserves context)
        this.messages.push({
          role: 'assistant',
          content: response.content || '',
          tool_calls: toolCalls,
        } as any);

        const executedCommands: ExecutedCommand[] = [];
        const roundStartTime = Date.now();
        // Capture snapshot BEFORE executing commands (for accurate pageSnapshotBefore)
        const snapshotBeforeRound = blackboard.getCurrentSnapshot() || '';

        // Execute EACH command (model can batch: fill + fill + click)
        for (const toolCall of toolCalls) {
          const commandName = toolCall.function.name;
          let commandArgs: Record<string, any>;

          try {
            commandArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            commandArgs = {};
            logger.warn('[EXECUTOR] Failed to parse command args', {
              command: commandName,
              raw: toolCall.function.arguments?.slice(0, 100),
            });
          }

          const cmdStart = Date.now();
          const result = await commandExecutor.execute(commandName, commandArgs);
          const cmdDuration = Date.now() - cmdStart;

          // Trace: per-command execution result
          this.trace('executor_command_result', {
            pipelineRound,
            executorRound: round,
            command: commandName,
            args: commandArgs,
            success: result.success,
            output: result.output?.slice(0, 500),
            error: result.error?.slice(0, 300),
            done: result.done,
            blocked: result.blocked,
            durationMs: cmdDuration,
          });

          // Track executed command
          executedCommands.push({
            command: { name: commandName as CommandName, args: commandArgs },
            result,
            durationMs: cmdDuration,
          });

          // Push tool result back to messages — model sees it next round
          this.messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify(result),
          } as any);

          // Update plan step status based on command success
          this.updatePlanStepFromCommand(blackboard, commandName, result);

          // Check terminal states
          if (result.done) {
            blackboard.setPhase('done');
            this.recordRound(blackboard, executedCommands, roundStartTime, snapshotBeforeRound);
            logger.info('[EXECUTOR] Goal achieved', { reason: result.output });
            return;
          }

          if (result.blocked) {
            blackboard.setPhase('blocked');
            this.recordRound(blackboard, executedCommands, roundStartTime, snapshotBeforeRound);
            logger.info('[EXECUTOR] Test blocked', { reason: result.output });
            return;
          }

          // If command failed, log insight for team awareness
          if (!result.success) {
            blackboard.addInsight(`Command ${commandName} failed: ${result.error?.slice(0, 100)}`);
          }
        }

        // Record this round in Blackboard (Reviewer & Planner will see it)
        this.recordRound(blackboard, executedCommands, roundStartTime, snapshotBeforeRound);

        logger.debug('[EXECUTOR] Round completed', {
          round,
          commands: executedCommands.length,
          successes: executedCommands.filter(c => c.result.success).length,
        });
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn('[EXECUTOR] LLM call error', { round, error: errorMsg });
        blackboard.addInsight(`Executor error in round ${round}: ${errorMsg}`);

        this.trace('executor_error', {
          pipelineRound,
          executorRound: round,
          error: errorMsg,
          latencyMs: Date.now() - llmStart,
        });

        // On error, break out of loop — Reviewer will decide what to do
        break;
      }
    }
  }

  /** Write trace entry (fire-and-forget) */
  private trace(eventType: string, payload: Record<string, any>): void {
    try {
      this.traceWriter?.write({
        stage: 'pipeline',
        eventType,
        spanId: this.traceWriter.generateSpanId(),
        payload,
      });
    } catch { /* never break agent for trace failures */ }
  }

  /**
   * Record an execution round in the Blackboard.
   * @param snapshotBefore — snapshot captured BEFORE commands ran (not current state)
   */
  private recordRound(
    blackboard: TestBlackboard,
    executedCommands: ExecutedCommand[],
    startTime: number,
    snapshotBefore: string,
  ): void {
    const round: ExecutionRound = {
      roundNumber: blackboard.getRounds().length + 1,
      commands: executedCommands,
      pageSnapshotBefore: snapshotBefore,
      durationMs: Date.now() - startTime,
    };
    blackboard.addRound(round);
  }

  /**
   * Heuristic: update plan step status based on command execution.
   * If a fill_field or click_element succeeds, mark matching plan step as completed.
   */
  private updatePlanStepFromCommand(
    blackboard: TestBlackboard,
    commandName: string,
    result: CommandResult,
  ): void {
    const plan = blackboard.getPlan();
    if (!plan) return;

    // Find first pending step and mark it based on command result
    const pendingSteps = blackboard.getStepsByStatus('pending');
    const inProgressSteps = blackboard.getStepsByStatus('in_progress');

    // Mark first pending as in_progress if none are in progress
    if (pendingSteps.length > 0 && inProgressSteps.length === 0) {
      blackboard.updateStepStatus(pendingSteps[0].stepNumber, 'in_progress');
    }

    // On successful action commands, progress the plan
    if (result.success && ['fill_field', 'click_element', 'select_option', 'navigate_to'].includes(commandName)) {
      const currentStep = inProgressSteps[0] || pendingSteps[0];
      if (currentStep) {
        blackboard.updateStepStatus(currentStep.stepNumber, 'completed');

        // Advance next pending step to in_progress
        const nextPending = blackboard.getStepsByStatus('pending');
        if (nextPending.length > 0) {
          blackboard.updateStepStatus(nextPending[0].stepNumber, 'in_progress');
        }
      }
    }

    // On failure, mark current step as failed
    if (!result.success && result.error && ['fill_field', 'click_element', 'select_option'].includes(commandName)) {
      const currentStep = inProgressSteps[0];
      if (currentStep) {
        blackboard.updateStepStatus(currentStep.stepNumber, 'failed', result.error);
      }
    }
  }
}
