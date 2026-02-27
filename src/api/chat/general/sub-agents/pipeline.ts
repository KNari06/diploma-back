import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from './config';
import { chatCircuitBreaker } from './circuit-breaker';
import { getToolsForCategories } from './tool-groups';
import { classifyRequest } from './agents/router-agent';
import { createPlan } from './agents/planner-agent';
import { executeTools } from './agents/executor-agent';
import { formatResponse, generateSimpleResponse } from './agents/responder-agent';
import type { PipelineContext, PipelineInput, PipelineMetrics, SubAgentPipelineResult } from './types';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { emitProcessingStep } from '@/api/chat/shared/utils';
import { PROGRESS } from '@/api/chat/shared/constants';
import type { ChatProcessingStepPayload } from '@/websocket/types/types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-AGENT PIPELINE ORCHESTRATOR
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Coordinates: Router → [Planner] → Executor → Responder
 *
 * Three paths:
 * - simple_chat: Router → Responder (no tools, gpt-4o-mini only)
 * - single_tool: Router → Executor → Responder (filtered tools)
 * - multi_tool:  Router → Planner → Executor → Responder (planned execution)
 *
 * Fallback: returns { success: false } → handler.ts runs monolithic loop
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

export class SubAgentPipeline {
  private context: PipelineContext;

  constructor(context: PipelineContext) {
    this.context = context;
  }

  /** Fire-and-forget thinking step emission. Never throws, never blocks. */
  private emitStep(
    step: ChatProcessingStepPayload['step'],
    message: string,
    progress: number,
    metadata?: Record<string, any>
  ): void {
    emitProcessingStep(this.context.chatSessionId, step, message, progress, metadata);
  }

  async execute(input: PipelineInput): Promise<SubAgentPipelineResult> {
    const pipelineStart = Date.now();
    const metrics: PipelineMetrics = {
      routerMs: 0,
      plannerMs: 0,
      executorMs: 0,
      responderMs: 0,
      totalMs: 0,
      routerClassification: '',
      routerConfidence: 0,
      toolCategories: [],
      toolsProvided: 0,
      toolRounds: 0,
      toolsExecuted: [],
    };

    try {
      // ═══ CIRCUIT BREAKER CHECK ═══
      if (chatCircuitBreaker.shouldSkip()) {
        logger.info('[SUB_AGENT_PIPELINE] Circuit breaker open — skipping pipeline');
        return this.fallbackResult(metrics, pipelineStart);
      }

      // ═══ PHASE 1: ROUTER ═══
      this.emitStep('agent_routing', 'Analyzing your request...', PROGRESS.PIPELINE_ROUTING);
      const routerStart = Date.now();
      const recentMessages = input.messages
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .slice(-6)
        .map(m => ({
          role: m.role as string,
          // Extract text from multimodal content arrays (e.g. when images are attached)
          content: typeof m.content === 'string'
            ? m.content
            : Array.isArray(m.content)
              ? (m.content.find((p: any) => p.type === 'text') as any)?.text ?? ''
              : String(m.content ?? ''),
        })) as Array<{ role: string; content: string }>;

      const routerResult = await classifyRequest(
        input.userMessage,
        recentMessages,
        input.availableTools,
        input.abortSignal
      );

      metrics.routerMs = Date.now() - routerStart;
      metrics.routerClassification = routerResult.classification;
      metrics.routerConfidence = routerResult.confidence;
      metrics.toolCategories = routerResult.toolCategories;

      const routeDescription = routerResult.classification === 'simple_chat'
        ? 'Preparing a direct answer'
        : routerResult.classification === 'single_tool'
        ? 'Found the right tool to help'
        : 'Planning a multi-step approach';
      this.emitStep('agent_routing', routeDescription, PROGRESS.PIPELINE_ROUTING_DONE, {
        classification: routerResult.classification,
      });

      // Low confidence → fallback (not a pipeline failure, don't penalize circuit breaker)
      if (routerResult.confidence < SUB_AGENT_CONFIG.routerConfidenceThreshold) {
        logger.info('[SUB_AGENT_PIPELINE] Low router confidence — falling back', {
          confidence: routerResult.confidence,
          threshold: SUB_AGENT_CONFIG.routerConfidenceThreshold,
        });
        return this.fallbackResult(metrics, pipelineStart);
      }

      // Extract context messages:
      // - Skip first system message (main chat prompt with all 74 tool descriptions — executor has its own)
      // - Keep other system messages (agent memory, workspace memory, KB context)
      // - Keep conversation history (user/assistant)
      // - Skip last message (current user message — passed separately)
      const lastIndex = input.messages.length - 1;
      let skippedFirstSystem = false;
      const contextMessages = input.messages.filter((m, idx) => {
        if (idx === lastIndex) return false; // skip current user message
        if (m.role === 'system' && !skippedFirstSystem) {
          skippedFirstSystem = true;
          return false; // skip main system prompt (tool descriptions already filtered for executor)
        }
        return true;
      }) as ChatCompletionMessageParam[];

      // ═══ PATH A: SIMPLE CHAT ═══
      if (routerResult.classification === 'simple_chat') {
        try {
          this.emitStep('agent_formatting', 'Composing response...', PROGRESS.PIPELINE_FORMATTING);
          const responderStart = Date.now();
          const response = await generateSimpleResponse(
            input.userMessage,
            contextMessages,
            input.skillDescriptions,
            input.abortSignal,
            input.userContent
          );
          metrics.responderMs = Date.now() - responderStart;
          metrics.totalMs = Date.now() - pipelineStart;

          chatCircuitBreaker.recordResult(true);

          logger.info('[SUB_AGENT_PIPELINE] Simple chat complete', { metrics });
          return {
            success: true,
            content: response.content,
            path: 'simple_chat',
            metrics,
          };
        } catch (chatError) {
          logger.warn('[SUB_AGENT_PIPELINE] Simple chat failed — falling back', {
            error: chatError instanceof Error ? chatError.message : String(chatError),
          });
          chatCircuitBreaker.recordResult(false);
          return this.fallbackResult(metrics, pipelineStart);
        }
      }

      // ═══ FILTER TOOLS ═══
      // Always include memory tools for tool paths
      const categories = routerResult.requiresMemory
        ? routerResult.toolCategories
        : [...routerResult.toolCategories, 'memory' as const];
      // Deduplicate
      const uniqueCategories = [...new Set(categories)];
      const filteredTools = getToolsForCategories(input.availableTools, uniqueCategories);
      metrics.toolsProvided = filteredTools.length;

      logger.info('[SUB_AGENT_PIPELINE] Tools filtered', {
        from: input.availableTools.length,
        to: filteredTools.length,
        categories: uniqueCategories,
      });

      // If no tools available after filtering → fallback (integration not connected, etc.)
      if (filteredTools.length === 0) {
        logger.warn('[SUB_AGENT_PIPELINE] No tools available after filtering — falling back', {
          categories: uniqueCategories,
        });
        return this.fallbackResult(metrics, pipelineStart);
      }

      // ═══ PATH B: SINGLE TOOL ═══
      if (routerResult.classification === 'single_tool') {
        // Execute directly
        this.emitStep('agent_executing_tool', 'Running tool...', PROGRESS.PIPELINE_TOOL_BASE);
        const executorStart = Date.now();
        const executorResult = await executeTools(
          input.userMessage,
          contextMessages,
          filteredTools,
          this.context,
          undefined,
          input.abortSignal,
          input.userContent
        );
        metrics.executorMs = Date.now() - executorStart;
        metrics.toolRounds = executorResult.toolRounds;
        metrics.toolsExecuted = executorResult.toolResults.map(r => r.toolName);

        if (!executorResult.success && executorResult.toolResults.length === 0) {
          // Executor produced nothing useful — fallback
          chatCircuitBreaker.recordResult(false);
          return this.fallbackResult(metrics, pipelineStart);
        }

        // Format response
        this.emitStep('agent_formatting', 'Formatting results...', PROGRESS.PIPELINE_FORMATTING);
        const responderStart = Date.now();
        const response = await formatResponse(
          input.userMessage,
          executorResult.toolResults,
          executorResult.assistantContent,
          contextMessages,
          input.abortSignal
        );
        metrics.responderMs = Date.now() - responderStart;
        metrics.totalMs = Date.now() - pipelineStart;

        // Guard: empty response → fallback
        if (!response.content) {
          logger.warn('[SUB_AGENT_PIPELINE] Single-tool: empty responder output — falling back');
          chatCircuitBreaker.recordResult(false);
          return this.fallbackResult(metrics, pipelineStart);
        }

        chatCircuitBreaker.recordResult(true);

        logger.info('[SUB_AGENT_PIPELINE] Single-tool complete', { metrics });
        return {
          success: true,
          content: response.content,
          path: 'single_tool',
          metrics,
        };
      }

      // ═══ PATH C: MULTI TOOL ═══
      // Phase 1: Plan
      this.emitStep('agent_planning', 'Creating an execution plan...', PROGRESS.PIPELINE_PLANNING, {
        toolCategories: routerResult.toolCategories,
      });
      const plannerStart = Date.now();
      const planResult = await createPlan(
        input.userMessage,
        routerResult.toolCategories,
        input.abortSignal
      );
      metrics.plannerMs = Date.now() - plannerStart;

      if (planResult) {
        const stepWord = planResult.steps.length === 1 ? 'step' : 'steps';
        this.emitStep('agent_planning', `Plan ready: ${planResult.steps.length} ${stepWord}`, PROGRESS.PIPELINE_PLANNING_DONE, {
          summary: planResult.summary,
          stepCount: planResult.steps.length,
        });
      }

      // Build plan text for executor
      const planText = planResult
        ? planResult.steps.map(s => `${s.stepNumber}. ${s.description} [${s.category}]`).join('\n')
        : undefined;

      // Phase 2: Execute with plan
      this.emitStep('agent_executing_tool', 'Executing plan...', PROGRESS.PIPELINE_TOOL_BASE);
      const executorStart = Date.now();
      const executorResult = await executeTools(
        input.userMessage,
        contextMessages,
        filteredTools,
        this.context,
        planText,
        input.abortSignal,
        input.userContent
      );
      metrics.executorMs = Date.now() - executorStart;
      metrics.toolRounds = executorResult.toolRounds;
      metrics.toolsExecuted = executorResult.toolResults.map(r => r.toolName);

      if (!executorResult.success && executorResult.toolResults.length === 0) {
        chatCircuitBreaker.recordResult(false);
        return this.fallbackResult(metrics, pipelineStart);
      }

      // Phase 3: Format response
      this.emitStep('agent_formatting', 'Formatting results...', PROGRESS.PIPELINE_FORMATTING);
      const responderStart = Date.now();
      const response = await formatResponse(
        input.userMessage,
        executorResult.toolResults,
        executorResult.assistantContent,
        contextMessages,
        input.abortSignal
      );
      metrics.responderMs = Date.now() - responderStart;
      metrics.totalMs = Date.now() - pipelineStart;

      // Guard: empty response → fallback
      if (!response.content) {
        logger.warn('[SUB_AGENT_PIPELINE] Multi-tool: empty responder output — falling back');
        chatCircuitBreaker.recordResult(false);
        return this.fallbackResult(metrics, pipelineStart);
      }

      chatCircuitBreaker.recordResult(true);

      logger.info('[SUB_AGENT_PIPELINE] Multi-tool complete', { metrics });
      return {
        success: true,
        content: response.content,
        path: 'multi_tool',
        metrics,
      };

    } catch (error) {
      logger.error('[SUB_AGENT_PIPELINE] Pipeline error', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - pipelineStart,
      });
      chatCircuitBreaker.recordResult(false);
      return this.fallbackResult(metrics, pipelineStart);
    }
  }

  private fallbackResult(metrics: PipelineMetrics, pipelineStart: number): SubAgentPipelineResult {
    metrics.totalMs = Date.now() - pipelineStart;
    return {
      success: false,
      content: '',
      path: 'fallback',
      metrics,
    };
  }
}
