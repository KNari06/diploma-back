import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from './config';
import { chatCircuitBreaker } from './circuit-breaker';
import { getToolsForCategories } from './tool-groups';
import { Blackboard } from './blackboard';
import { classifyRequest } from './agents/router-agent';
import { createPlan, identifyParallelGroups } from './agents/planner-agent';
import { executeTools } from './agents/executor-agent';
import { formatResponse, generateSimpleResponse } from './agents/responder-agent';
import { reviewExecution } from './agents/reviewer-agent';
import { SubAgentSpawner } from './spawner';
import type {
  ExecutorResult,
  PipelineContext,
  PipelineInput,
  PipelineMetrics,
  SubAgentPipelineResult,
  ToolExecutionRecord,
} from './types';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { emitProcessingStep } from '@/api/chat/shared/utils';
import { PROGRESS } from '@/api/chat/shared/constants';
import type { ChatProcessingStepPayload } from '@/websocket/types/types';

// ── Router Guardrail ──────────────────────────────────────────────────────
// Deterministic safety net: if the router says "simple_chat" but the user
// message clearly references QA entities or action verbs, we reclassify to
// "single_tool" so the executor actually receives tools.
// This prevents the LLM hallucinating "I don't have access" when tools are
// available but the router misjudged.

const QA_ENTITY_PATTERNS = /(?:тест(?:\s*[-_]?\s*)?(?:кейс|шаг|степ|ран|результат|сценарий|план|набор|ов|ы|а|ам|ами)?)|test\s*(?:case|step|result|run|execution|plan|suite|s)?|regression|регресси|coverage|покрыти|fixture|фикстур|module|модул|flow|analytics|аналитик|dashboard|дашборд|bug|баг|report|отчёт/i;
const ACTION_VERB_PATTERNS = /(?:получи|покажи|выведи|дай|найди|создай|измени|обнови|удали|запусти|добавь|отредактируй|список|перечисли)|(?:^|\s)(?:get|fetch|list|show|find|search|create|update|change|modify|delete|remove|run|execute|add|edit)\b/i;

function shouldOverrideSimpleChat(
  userMessage: string,
  hasToolsAvailable: boolean,
): boolean {
  if (!hasToolsAvailable) return false;
  // Both entity + action verb must match to avoid false positives on e.g. "what is a test case?"
  // But entity alone is enough for imperative commands like "тест кейсы" (implied "show me")
  const hasEntity = QA_ENTITY_PATTERNS.test(userMessage);
  const hasAction = ACTION_VERB_PATTERNS.test(userMessage);
  return hasEntity && hasAction;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SUB-AGENT PIPELINE ORCHESTRATOR — Cooperative Multi-Agent System
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Coordinates: Router → [Planner] → Executor(s) → Reviewer → Responder
 * All agents share a Blackboard for cross-agent context.
 *
 * Three paths:
 * - simple_chat: Router → Responder (no tools, gpt-4o-mini only, zero blackboard overhead)
 * - single_tool: Router → Executor → [Reviewer] → Responder (filtered tools)
 * - multi_tool:  Router → Planner → Executor(s) → Reviewer → Responder (planned execution)
 *
 * Cooperative features:
 * - Blackboard: shared state across all agents (goal, plan, results, insights)
 * - Reviewer: double-blind verification of results against user goal
 * - Sub-agent spawning: parallel execution of independent plan steps
 * - Retry loop: re-execute failed steps on reviewer rejection (max 1 retry)
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
      reviewerMs: 0,
      totalMs: 0,
      routerClassification: '',
      routerConfidence: 0,
      toolCategories: [],
      toolsProvided: 0,
      toolRounds: 0,
      toolsExecuted: [],
      subExecutorsSpawned: 0,
      reviewerVerdict: '',
      retryCount: 0,
    };

    // ═══ CREATE BLACKBOARD ═══
    const blackboard = new Blackboard(input.userMessage);

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
        .slice(-SUB_AGENT_CONFIG.routerRecentMessagesLimit)
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

      // Write router result to blackboard
      blackboard.setRouterResult(routerResult);

      const routeDescription = routerResult.classification === 'simple_chat'
        ? 'Preparing a direct answer'
        : routerResult.classification === 'single_tool'
        ? 'Found the right tool to help'
        : 'Planning a multi-step approach';
      this.emitStep('agent_routing', routeDescription, PROGRESS.PIPELINE_ROUTING_DONE, {
        classification: routerResult.classification,
      });

      // Low confidence → clarification or fallback
      if (routerResult.confidence < SUB_AGENT_CONFIG.routerConfidenceThreshold) {
        // Clarification band: confidence is low but router generated a question to ask
        if (
          routerResult.confidence >= SUB_AGENT_CONFIG.routerClarificationThreshold &&
          routerResult.clarificationQuestion
        ) {
          logger.info('[SUB_AGENT_PIPELINE] Router confidence in clarification band — asking user', {
            confidence: routerResult.confidence,
            clarificationThreshold: SUB_AGENT_CONFIG.routerClarificationThreshold,
            confidenceThreshold: SUB_AGENT_CONFIG.routerConfidenceThreshold,
          });

          this.emitStep('agent_routing', 'Need more information...', PROGRESS.PIPELINE_ROUTING_DONE);

          metrics.totalMs = Date.now() - pipelineStart;
          chatCircuitBreaker.recordResult(true);

          return {
            success: true,
            content: routerResult.clarificationQuestion,
            path: routerResult.classification,
            metrics,
            needsClarification: true,
          };
        }

        // Below clarification threshold or no question → true fallback
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

      // ═══ GUARDRAIL: Override simple_chat if user clearly wants tool action ═══
      if (
        routerResult.classification === 'simple_chat' &&
        shouldOverrideSimpleChat(input.userMessage, input.availableTools.length > 0)
      ) {
        logger.warn('[SUB_AGENT_PIPELINE] Guardrail: overriding simple_chat → single_tool (QA entity + action detected)', {
          userMessage: input.userMessage.substring(0, 100),
          originalConfidence: routerResult.confidence,
        });

        // Reclassify to single_tool with qa_read (safe default — executor can still write if needed)
        routerResult.classification = 'single_tool';
        routerResult.toolCategories = ['qa_read'];
        routerResult.confidence = 0.7; // Synthetic confidence
        metrics.routerClassification = 'single_tool (guardrail)';

        // Update blackboard with corrected classification
        blackboard.setRouterResult(routerResult);
      }

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
        // Execute directly (with blackboard)
        this.emitStep('agent_executing_tool', 'Running tool...', PROGRESS.PIPELINE_TOOL_BASE);
        const executorStart = Date.now();
        const executorResult = await executeTools(
          input.userMessage,
          contextMessages,
          filteredTools,
          this.context,
          undefined,
          input.abortSignal,
          input.userContent,
          blackboard
        );
        metrics.executorMs = Date.now() - executorStart;
        metrics.toolRounds = executorResult.toolRounds;
        metrics.toolsExecuted = executorResult.toolResults.map(r => r.toolName);

        if (!executorResult.success && executorResult.toolResults.length === 0) {
          // Executor produced nothing useful — fallback
          chatCircuitBreaker.recordResult(false);
          return this.fallbackResult(metrics, pipelineStart);
        }

        // Write execution results to blackboard
        blackboard.setExecutionResults({
          stepResults: new Map(),
          ungroupedResults: executorResult.toolResults,
          assistantContent: executorResult.assistantContent,
          totalToolRounds: executorResult.toolRounds,
          subExecutorIds: [],
        });

        // Lightweight reviewer for single_tool: run if enabled and not aborted.
        // Uses the same reviewer — deterministic fast-paths handle most cases (0 tokens).
        // Only reaches AI phase for partial failures or ambiguous outcomes.
        if (SUB_AGENT_CONFIG.enableReviewer && !input.abortSignal?.aborted) {
          const singleReviewStart = Date.now();
          const singleReviewResult = await reviewExecution(blackboard, input.abortSignal);
          metrics.reviewerMs = Date.now() - singleReviewStart;
          metrics.reviewerVerdict = singleReviewResult.verdict;
          blackboard.setReviewResult(singleReviewResult);

          // Level 2 clarification: reviewer says results are ambiguous — ask user
          if (singleReviewResult.verdict === 'needs_clarification' && singleReviewResult.clarificationNeeded) {
            logger.info('[SUB_AGENT_PIPELINE] Reviewer requested clarification (single_tool)', {
              clarificationNeeded: singleReviewResult.clarificationNeeded,
            });

            this.emitStep('agent_formatting', 'Composing a question...', PROGRESS.PIPELINE_FORMATTING);
            const clarifyResponderStart = Date.now();
            const clarifyResponse = await formatResponse(
              input.userMessage,
              executorResult.toolResults,
              executorResult.assistantContent,
              contextMessages,
              input.abortSignal,
              blackboard
            );
            metrics.responderMs = Date.now() - clarifyResponderStart;
            metrics.totalMs = Date.now() - pipelineStart;

            chatCircuitBreaker.recordResult(true);

            return {
              success: true,
              content: clarifyResponse.content || singleReviewResult.clarificationNeeded,
              path: 'single_tool',
              metrics,
              needsClarification: true,
            };
          }
        }

        // Format response (with blackboard context)
        this.emitStep('agent_formatting', 'Formatting results...', PROGRESS.PIPELINE_FORMATTING);
        const responderStart = Date.now();
        const response = await formatResponse(
          input.userMessage,
          executorResult.toolResults,
          executorResult.assistantContent,
          contextMessages,
          input.abortSignal,
          blackboard
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

        logger.info('[SUB_AGENT_PIPELINE] Single-tool complete', {
          metrics,
          blackboard: blackboard.toLogSummary(),
        });
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

      if (planResult && planResult.steps.length > 0) {
        // Identify parallel groups and write to blackboard
        const parallelGroups = identifyParallelGroups(planResult.steps);
        blackboard.setPlan(planResult, parallelGroups);

        const stepWord = planResult.steps.length === 1 ? 'step' : 'steps';
        this.emitStep('agent_planning', `Plan ready: ${planResult.steps.length} ${stepWord}`, PROGRESS.PIPELINE_PLANNING_DONE, {
          summary: planResult.summary,
          stepCount: planResult.steps.length,
          canParallelize: parallelGroups.some(g => g.length > 1),
        });
      } else {
        // Planner failed or returned empty plan — log and continue as unplanned multi_tool.
        // Executor will operate without structured steps (like enhanced single_tool).
        logger.warn('[SUB_AGENT_PIPELINE] Planner returned no plan — executing without structured plan', {
          plannerResult: planResult ? 'empty steps' : 'null',
        });
        blackboard.addInsight('Planner could not create a plan — executing tools directly');
      }

      // Phase 2: Execute (potentially parallel)
      let executorResult: ExecutorResult;
      const plan = blackboard.getPlan();

      if (
        SUB_AGENT_CONFIG.enableParallelExecution &&
        plan?.canParallelize &&
        plan.parallelGroups &&
        plan.steps.length >= SUB_AGENT_CONFIG.minStepsForParallel
      ) {
        // ═══ PARALLEL EXECUTION WITH SUB-AGENTS ═══
        this.emitStep('agent_spawning', 'Spawning sub-agents for parallel execution...', PROGRESS.PIPELINE_SPAWNING);
        executorResult = await this.executeWithSubAgents(
          input, contextMessages, filteredTools, blackboard, metrics
        );
      } else {
        // ═══ SEQUENTIAL EXECUTION (with blackboard) ═══
        this.emitStep('agent_executing_tool', 'Executing plan...', PROGRESS.PIPELINE_TOOL_BASE);
        const executorStart = Date.now();
        executorResult = await executeTools(
          input.userMessage,
          contextMessages,
          filteredTools,
          this.context,
          undefined, // plan is read from blackboard
          input.abortSignal,
          input.userContent,
          blackboard
        );
        metrics.executorMs = Date.now() - executorStart;
        metrics.toolRounds = executorResult.toolRounds;
        metrics.toolsExecuted = executorResult.toolResults.map(r => r.toolName);
      }

      // Write execution results to blackboard
      blackboard.setExecutionResults({
        stepResults: new Map(),
        ungroupedResults: executorResult.toolResults,
        assistantContent: executorResult.assistantContent,
        totalToolRounds: executorResult.toolRounds,
        subExecutorIds: [],
      });

      if (!executorResult.success && executorResult.toolResults.length === 0) {
        chatCircuitBreaker.recordResult(false);
        return this.fallbackResult(metrics, pipelineStart);
      }

      // Phase 3: REVIEWER (feature-flagged, skip if aborted)
      if (SUB_AGENT_CONFIG.enableReviewer && !input.abortSignal?.aborted) {
        this.emitStep('agent_reviewing', 'Verifying results...', PROGRESS.PIPELINE_REVIEWING);
        const reviewerStart = Date.now();
        const reviewResult = await reviewExecution(blackboard, input.abortSignal);
        metrics.reviewerMs = Date.now() - reviewerStart;
        metrics.reviewerVerdict = reviewResult.verdict;

        blackboard.setReviewResult(reviewResult);

        // Retry loop: re-execute failed steps if reviewer rejects
        if (
          reviewResult.verdict === 'needs_retry' &&
          reviewResult.retrySteps &&
          reviewResult.retrySteps.length > 0 &&
          metrics.retryCount < SUB_AGENT_CONFIG.maxReviewRetries &&
          !input.abortSignal?.aborted
        ) {
          metrics.retryCount++;
          logger.info('[SUB_AGENT_PIPELINE] Reviewer requested retry', {
            retrySteps: reviewResult.retrySteps,
            retryCount: metrics.retryCount,
          });

          this.emitStep('agent_executing_tool', 'Re-executing failed steps...', PROGRESS.PIPELINE_TOOL_BASE + 5);

          // Reset ONLY the failed steps to pending (completed steps remain completed)
          for (const stepNum of reviewResult.retrySteps) {
            blackboard.updateStepStatus(stepNum, 'pending');
          }

          // Narrow tools to only the categories needed by failed steps
          const failedStepCategories = (blackboard.getPlan()?.steps ?? [])
            .filter(s => reviewResult.retrySteps!.includes(s.stepNumber))
            .map(s => s.category);
          const retryCategories = [...new Set([...failedStepCategories, 'memory'])];
          const retryTools = getToolsForCategories(input.availableTools, retryCategories);

          const retryStart = Date.now();
          const retryResult = await executeTools(
            input.userMessage,
            contextMessages,
            retryTools.length > 0 ? retryTools : filteredTools, // fallback to all if narrowing yields nothing
            this.context,
            undefined,
            input.abortSignal,
            input.userContent,
            blackboard
          );

          // Merge retry results
          executorResult.toolResults.push(...retryResult.toolResults);
          executorResult.toolRounds += retryResult.toolRounds;
          metrics.executorMs += Date.now() - retryStart;
          metrics.toolsExecuted.push(...retryResult.toolResults.map(r => r.toolName));

          // Update blackboard execution
          blackboard.setExecutionResults({
            stepResults: new Map(),
            ungroupedResults: executorResult.toolResults,
            assistantContent: retryResult.assistantContent || executorResult.assistantContent,
            totalToolRounds: executorResult.toolRounds,
            subExecutorIds: [],
          });

          // Re-run reviewer on updated results
          const retryReviewStart = Date.now();
          const retryReviewResult = await reviewExecution(blackboard, input.abortSignal);
          metrics.reviewerMs += Date.now() - retryReviewStart;
          metrics.reviewerVerdict = retryReviewResult.verdict;
          blackboard.setReviewResult(retryReviewResult);
        }
      }

      // Level 2 clarification: reviewer says results are ambiguous — ask user
      const finalReview = blackboard.getReviewResult();
      if (finalReview?.verdict === 'needs_clarification' && finalReview.clarificationNeeded) {
        logger.info('[SUB_AGENT_PIPELINE] Reviewer requested clarification (multi_tool)', {
          clarificationNeeded: finalReview.clarificationNeeded,
        });

        this.emitStep('agent_formatting', 'Composing a question...', PROGRESS.PIPELINE_FORMATTING);
        const clarifyResponderStart = Date.now();
        const clarifyResponse = await formatResponse(
          input.userMessage,
          executorResult.toolResults,
          executorResult.assistantContent,
          contextMessages,
          input.abortSignal,
          blackboard
        );
        metrics.responderMs = Date.now() - clarifyResponderStart;
        metrics.totalMs = Date.now() - pipelineStart;

        chatCircuitBreaker.recordResult(true);

        return {
          success: true,
          content: clarifyResponse.content || finalReview.clarificationNeeded,
          path: 'multi_tool',
          metrics,
          needsClarification: true,
        };
      }

      // Phase 4: Format response (with full blackboard context)
      this.emitStep('agent_formatting', 'Formatting results...', PROGRESS.PIPELINE_FORMATTING);
      const responderStart = Date.now();
      const response = await formatResponse(
        input.userMessage,
        executorResult.toolResults,
        executorResult.assistantContent,
        contextMessages,
        input.abortSignal,
        blackboard
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

      logger.info('[SUB_AGENT_PIPELINE] Multi-tool complete', {
        metrics,
        blackboard: blackboard.toLogSummary(),
      });
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
        blackboard: blackboard.toLogSummary(),
      });
      chatCircuitBreaker.recordResult(false);
      return this.fallbackResult(metrics, pipelineStart);
    }
  }

  /**
   * Execute plan steps using parallel sub-agent spawning.
   * Groups independent steps and runs them concurrently via SubAgentSpawner.
   */
  private async executeWithSubAgents(
    input: PipelineInput,
    contextMessages: ChatCompletionMessageParam[],
    filteredTools: import('openai/resources/chat/completions').ChatCompletionTool[],
    blackboard: Blackboard,
    metrics: PipelineMetrics
  ): Promise<ExecutorResult> {
    const spawner = new SubAgentSpawner(SUB_AGENT_CONFIG.maxSubExecutors);
    const plan = blackboard.getPlan();
    if (!plan || !plan.parallelGroups) {
      logger.warn('[SUB_AGENT_PIPELINE] executeWithSubAgents called without plan — returning empty');
      return { success: false, toolResults: [], assistantContent: '', toolRounds: 0 };
    }
    const allResults: ToolExecutionRecord[] = [];
    let totalRounds = 0;
    let assistantContent = '';

    const executorStart = Date.now();

    // Execute each parallel group sequentially (groups are ordered by dependency level)
    for (const group of plan.parallelGroups) {
      // Check abort between groups — stop launching new groups if cancelled
      if (input.abortSignal?.aborted) {
        logger.info('[SUB_AGENT_PIPELINE] Request aborted between parallel groups');
        break;
      }

      const groupSteps = group
        .map(n => plan.steps.find(s => s.stepNumber === n))
        .filter(Boolean) as import('./types').TrackedPlanStep[];

      if (groupSteps.length === 0) continue;

      if (groupSteps.length === 1) {
        // Single step in group — use main executor (cheaper)
        blackboard.updateStepStatus(groupSteps[0].stepNumber, 'in_progress');

        this.emitStep('agent_executing_tool', `Running step ${groupSteps[0].stepNumber}...`, PROGRESS.PIPELINE_TOOL_BASE + 5);

        const stepResult = await executeTools(
          input.userMessage,
          contextMessages,
          filteredTools,
          this.context,
          undefined,
          input.abortSignal,
          input.userContent,
          blackboard
        );

        allResults.push(...stepResult.toolResults);
        totalRounds += stepResult.toolRounds;
        if (stepResult.assistantContent) assistantContent = stepResult.assistantContent;
      } else {
        // Multiple steps — spawn sub-executors in parallel
        metrics.subExecutorsSpawned += groupSteps.length;
        this.emitStep('agent_spawning', `Running ${groupSteps.length} steps in parallel...`, PROGRESS.PIPELINE_SPAWNING);

        const subResults = await spawner.executeParallel(
          groupSteps,
          input.userMessage,
          contextMessages,
          filteredTools,
          this.context,
          blackboard,
          input.abortSignal
        );

        // Merge results
        for (const sr of subResults) {
          allResults.push(...sr.toolResults);
          totalRounds += sr.toolRounds;
          if (sr.assistantContent) assistantContent = sr.assistantContent;
        }
      }
    }

    metrics.executorMs = Date.now() - executorStart;
    metrics.toolRounds = totalRounds;
    metrics.toolsExecuted = allResults.map(r => r.toolName);

    return {
      success: allResults.length === 0 || allResults.some(r => r.result.success),
      toolResults: allResults,
      assistantContent,
      toolRounds: totalRounds,
    };
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
