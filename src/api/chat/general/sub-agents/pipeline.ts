import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from './config';
import { chatCircuitBreaker } from './circuit-breaker';
import { getToolsForCategories, getValidCategories } from './tool-groups';
import { Blackboard } from './blackboard';
import { classifyRequest } from './agents/router-agent';
import { createPlan, identifyParallelGroups } from './agents/planner-agent';
import { executeTools } from './agents/executor-agent';
import { formatResponse, generateSimpleResponse } from './agents/responder-agent';
import { reviewExecution } from './agents/reviewer-agent';
import { validateEditorSteps, extractStepsFromContent, formatValidationWarnings } from './agents/step-validator-agent';
import { SubAgentSpawner } from './spawner';
import { injectQuickActions } from './quick-actions-injector';
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

/**
 * Noise: emoji-only, punctuation-only, repeated characters, very short gibberish.
 * These are NOT tool requests — sending them to executor wastes an LLM call.
 */
const NOISE_MESSAGE = /^[\p{Emoji}\p{Emoji_Component}\s]+$|^[.!?,;:…\-—_*#@^&()+=~`'"<>{}[\]\\/|]+$|^(.)\1{2,}$/u;

// ── Smart Simple-Chat Guardrail ───────────────────────────────────────────
// If the router says "simple_chat" but tools are available, we check whether
// the message is truly a no-tool conversation (greeting, thanks, opinion).
// Uses message length + router confidence instead of hardcoded keyword lists.

/** Confidence above which we trust the router's simple_chat verdict. */
const SIMPLE_CHAT_TRUST_THRESHOLD = 0.85;

/** Short messages (≤3 words) with high router confidence are likely greetings/thanks — trust the router. */
const MAX_SIMPLE_CHAT_WORDS = 3;

function shouldOverrideSimpleChat(
  userMessage: string,
  hasToolsAvailable: boolean,
  routerConfidence: number,
): boolean {
  if (!hasToolsAvailable) return false;

  const trimmed = userMessage.trim();

  // Noise messages (emoji, punctuation, gibberish) → never override, let simple_chat handle
  if (NOISE_MESSAGE.test(trimmed)) {
    return false;
  }

  const wordCount = trimmed.split(/\s+/).length;

  // Short message + high confidence → trust the router (greetings, thanks, yes/no, etc.)
  if (routerConfidence >= SIMPLE_CHAT_TRUST_THRESHOLD && wordCount <= MAX_SIMPLE_CHAT_WORDS) {
    return false;
  }

  // Low confidence simple_chat with tools available → override to single_tool
  if (routerConfidence < SIMPLE_CHAT_TRUST_THRESHOLD) {
    return true;
  }

  // High confidence but message is longer than a greeting → override
  // (genuine simple_chat messages are almost always short)
  if (wordCount > MAX_SIMPLE_CHAT_WORDS) {
    return true;
  }

  return false;
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
 * - simple_chat: Router → Responder (no tools, gemini-2.5-flash-lite only, zero blackboard overhead)
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
    emitProcessingStep(
      this.context.chatSessionId,
      step,
      message,
      progress,
      metadata,
      this.context.testCaseId,
    );
  }

  async execute(input: PipelineInput): Promise<SubAgentPipelineResult> {
    const pipelineStart = Date.now();
    const metrics: PipelineMetrics = {
      routerMs: 0,
      plannerMs: 0,
      executorMs: 0,
      responderMs: 0,
      reviewerMs: 0,
      stepValidatorMs: 0,
      totalMs: 0,
      routerClassification: '',
      routerConfidence: 0,
      toolCategories: [],
      toolsProvided: 0,
      toolRounds: 0,
      toolsExecuted: [],
      subExecutorsSpawned: 0,
      reviewerVerdict: '',
      stepValidatorVerdict: '',
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

      // ═══ FAST PATH: Skip Router when Intent Parser already classified as no-tools ═══
      // The Intent Parser (LLM) already runs before the pipeline. When it returns
      // needsTools=false, we trust its classification and skip the Router LLM call (~600ms).
      // This is NOT a hardcoded regex — it's the AI's own decision from intent parsing.
      // Falls through to normal Router flow if needsTools is undefined (backward compat).
      if (input.needsTools === false) {
        logger.info('[SUB_AGENT_PIPELINE] Fast path: Intent Parser said needsTools=false, skipping Router', {
          userMessage: input.userMessage.substring(0, 50),
        });
        this.emitStep('agent_thinking', 'Composing response...', PROGRESS.PIPELINE_FORMATTING);

        try {
          // Extract context messages (skip first system message + current user message)
          const lastIndex = input.messages.length - 1;
          let skippedFirst = false;
          const fastPathContext = input.messages.filter((m, idx) => {
            if (idx === lastIndex) return false;
            if (m.role === 'system' && !skippedFirst) { skippedFirst = true; return false; }
            return true;
          }) as ChatCompletionMessageParam[];

          const responderStart = Date.now();
          const response = await generateSimpleResponse(
            input.userMessage,
            fastPathContext,
            input.skillDescriptions,
            input.abortSignal,
            input.userContent
          );
          metrics.responderMs = Date.now() - responderStart;
          metrics.totalMs = Date.now() - pipelineStart;
          metrics.routerClassification = 'simple_chat (intent_fast_path)';
          metrics.routerConfidence = 1.0;

          chatCircuitBreaker.recordResult(true);

          logger.info('[SUB_AGENT_PIPELINE] Intent fast path complete', {
            durationMs: metrics.totalMs,
            savedRouterMs: 'skipped',
          });
          return {
            success: true,
            content: response.content,
            path: 'simple_chat',
            metrics,
          };
        } catch (fastPathError) {
          logger.warn('[SUB_AGENT_PIPELINE] Intent fast path failed — falling through to Router', {
            error: fastPathError instanceof Error ? fastPathError.message : String(fastPathError),
          });
          // Fall through to normal Router flow
        }
      }

      // ═══ PHASE 1: ROUTER ═══
      this.emitStep('agent_thinking', 'Classifying your request...', PROGRESS.PIPELINE_ROUTING);
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
        ? 'Preparing a direct answer...'
        : routerResult.classification === 'single_tool'
        ? `Looking up the right tool (${routerResult.toolCategories[0] || 'data'})...`
        : `Planning a multi-step approach (${routerResult.toolCategories.length} tool groups)...`;
      this.emitStep('agent_thinking', routeDescription, PROGRESS.PIPELINE_ROUTING_DONE, {
        classification: routerResult.classification,
        reasoning: routerResult.reasoning,
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

      // ═══ GUARDRAIL: Override simple_chat when tools are available but router misjudged ═══
      // simple_chat = ZERO tools. If we're wrong, the user gets "I don't have access".
      // Better to give the executor tools and let it decide not to call them.
      if (
        routerResult.classification === 'simple_chat' &&
        shouldOverrideSimpleChat(input.userMessage, input.availableTools.length > 0, routerResult.confidence)
      ) {
        logger.warn('[SUB_AGENT_PIPELINE] Guardrail: overriding simple_chat → single_tool', {
          userMessage: input.userMessage.substring(0, 100),
          originalConfidence: routerResult.confidence,
          reason: 'tools available but simple_chat not trusted',
        });

        routerResult.classification = 'single_tool';
        // Don't guess the category — give all AVAILABLE categories.
        // The executor LLM will pick the right tools from the available set.
        const availToolNames = new Set(input.availableTools.map(t => t.function.name));
        routerResult.toolCategories = getValidCategories(availToolNames);
        routerResult.confidence = 0.7;
        metrics.routerClassification = 'single_tool (guardrail)';

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
        const toolHint = routerResult.toolCategories[0]?.replace(/_/g, ' ') || 'data';
        this.emitStep('agent_thinking', `Querying ${toolHint}...`, PROGRESS.PIPELINE_TOOL_BASE);
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

        // ═══ STEP VALIDATOR (Editor Mode Only) ═══
        // Validates AI-generated IntentSteps against DOM + user goal BEFORE showing to user.
        // Only runs when: editor mode + executor produced steps as text + validator enabled.
        if (
          this.context.mode === 'editor' &&
          SUB_AGENT_CONFIG.enableStepValidator &&
          executorResult.assistantContent &&
          extractStepsFromContent(executorResult.assistantContent) &&
          !input.abortSignal?.aborted
        ) {
          this.emitStep('agent_reviewing', 'Validating generated steps...', PROGRESS.PIPELINE_REVIEWING);
          const validatorStart = Date.now();
          const validationResult = await validateEditorSteps(
            input.userMessage,
            executorResult.assistantContent,
            contextMessages,
            input.abortSignal
          );
          metrics.stepValidatorMs = Date.now() - validatorStart;

          if (validationResult) {
            metrics.stepValidatorVerdict = validationResult.verdict;

            // Append validation warnings/suggestions to the assistant content
            // so the responder includes them in the final message
            const warnings = formatValidationWarnings(validationResult);
            if (warnings) {
              executorResult.assistantContent += '\n\n' + warnings;
              // Update blackboard with enriched content
              blackboard.setExecutionResults({
                stepResults: new Map(),
                ungroupedResults: executorResult.toolResults,
                assistantContent: executorResult.assistantContent,
                totalToolRounds: executorResult.toolRounds,
                subExecutorIds: [],
              });
            }

            logger.info('[SUB_AGENT_PIPELINE] Step validation complete', {
              verdict: validationResult.verdict,
              goalCoverage: validationResult.goalCoverage,
              issueCount: validationResult.issues.length,
              missingStepCount: validationResult.missingSteps.length,
              durationMs: validationResult.durationMs,
            });
          }
        }

        // Lightweight reviewer for single_tool: run if enabled and not aborted.
        // Uses the same reviewer — deterministic fast-paths handle most cases (0 tokens).
        // Only reaches AI phase for partial failures or ambiguous outcomes.
        if (SUB_AGENT_CONFIG.enableReviewer && !input.abortSignal?.aborted) {
          const singleReviewStart = Date.now();
          const singleReviewResult = await reviewExecution(blackboard, input.abortSignal);
          metrics.reviewerMs = Date.now() - singleReviewStart;
          metrics.reviewerVerdict = singleReviewResult.verdict;
          blackboard.setReviewResult(singleReviewResult);

          // Retry: reviewer says tool failed — re-execute once
          if (
            singleReviewResult.verdict === 'needs_retry' &&
            metrics.retryCount < SUB_AGENT_CONFIG.maxReviewRetries &&
            !input.abortSignal?.aborted
          ) {
            metrics.retryCount++;
            logger.info('[SUB_AGENT_PIPELINE] Single-tool reviewer requested retry', {
              retryCount: metrics.retryCount,
              failedTools: executorResult.toolResults.filter(r => !r.result.success).map(r => r.toolName),
            });

            this.emitStep('agent_executing_tool', 'Re-executing tool...', PROGRESS.PIPELINE_TOOL_BASE + 5);

            const retryStart = Date.now();
            const retryResult = await executeTools(
              input.userMessage,
              contextMessages,
              filteredTools,
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

            // Update blackboard
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

          // Level 2 clarification: reviewer says results are ambiguous — ask user
          const finalSingleReview = blackboard.getReviewResult();
          if (finalSingleReview?.verdict === 'needs_clarification' && finalSingleReview.clarificationNeeded) {
            logger.info('[SUB_AGENT_PIPELINE] Reviewer requested clarification (single_tool)', {
              clarificationNeeded: finalSingleReview.clarificationNeeded,
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
              content: clarifyResponse.content || finalSingleReview.clarificationNeeded,
              path: 'single_tool',
              metrics,
              needsClarification: true,
            };
          }
        }

        // Format response (with blackboard context)
        const toolNames = executorResult.toolResults.map(r => r.toolName.replace(/^qa_/, '').replace(/_/g, ' '));
        const formatHint = toolNames.length > 0 ? `Formatting ${toolNames[0]} results...` : 'Composing response...';
        this.emitStep('agent_thinking', formatHint, PROGRESS.PIPELINE_FORMATTING);
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

        // Guard: empty response → fallback (pass executed tools so monolithic tracker is seeded)
        if (!response.content) {
          logger.warn('[SUB_AGENT_PIPELINE] Single-tool: empty responder output — falling back');
          chatCircuitBreaker.recordResult(false);
          const priorTools = executorResult.toolResults.map(r => ({ toolName: r.toolName, args: r.args }));
          return this.fallbackResult(metrics, pipelineStart, priorTools);
        }

        chatCircuitBreaker.recordResult(true);

        // Synthesize quick action descriptors from tool results so the
        // frontend can render inline buttons under the AI message.
        const quickActions = injectQuickActions(executorResult.toolResults, {
          mode: this.context.mode,
          previewSessionId: this.context.previewSessionId,
          chatSessionId: this.context.chatSessionId,
          projectId: this.context.projectId,
          userId: this.context.userId,
        });

        logger.info('[SUB_AGENT_PIPELINE] Single-tool complete', {
          metrics,
          blackboard: blackboard.toLogSummary(),
          quickActionsCount: quickActions.length,
        });
        return {
          success: true,
          content: response.content,
          path: 'single_tool',
          metrics,
          ...(quickActions.length > 0 ? { quickActions } : {}),
        };
      }

      // ═══ PATH C: MULTI TOOL ═══

      // Phase 1: Plan
      const catList = routerResult.toolCategories.map(c => c.replace(/_/g, ' ')).join(', ');
      this.emitStep('agent_thinking', `Planning steps across ${catList}...`, PROGRESS.PIPELINE_PLANNING, {
        toolCategories: routerResult.toolCategories,
      });
      const plannerStart = Date.now();
      const plannerToolNames = new Set(input.availableTools.map(t => t.function.name));
      const planResult = await createPlan(
        input.userMessage,
        routerResult.toolCategories,
        input.abortSignal,
        plannerToolNames
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
        this.emitStep('agent_thinking', 'Double-checking the results...', PROGRESS.PIPELINE_REVIEWING);
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
      this.emitStep('agent_thinking', 'Putting it all together...', PROGRESS.PIPELINE_FORMATTING);
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

      // Guard: empty response → fallback (pass executed tools so monolithic tracker is seeded)
      if (!response.content) {
        logger.warn('[SUB_AGENT_PIPELINE] Multi-tool: empty responder output — falling back');
        chatCircuitBreaker.recordResult(false);
        const priorTools = executorResult.toolResults.map(r => ({ toolName: r.toolName, args: r.args }));
        return this.fallbackResult(metrics, pipelineStart, priorTools);
      }

      chatCircuitBreaker.recordResult(true);

      // Synthesize quick action descriptors from tool results so the
      // frontend can render inline buttons under the AI message.
      const multiToolQuickActions = injectQuickActions(executorResult.toolResults, {
        mode: this.context.mode,
        previewSessionId: this.context.previewSessionId,
        chatSessionId: this.context.chatSessionId,
        projectId: this.context.projectId,
        userId: this.context.userId,
      });

      logger.info('[SUB_AGENT_PIPELINE] Multi-tool complete', {
        metrics,
        blackboard: blackboard.toLogSummary(),
        quickActionsCount: multiToolQuickActions.length,
      });
      return {
        success: true,
        content: response.content,
        path: 'multi_tool',
        metrics,
        ...(multiToolQuickActions.length > 0 ? { quickActions: multiToolQuickActions } : {}),
      };

    } catch (error) {
      logger.error('[SUB_AGENT_PIPELINE] Pipeline error', {
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - pipelineStart,
        blackboard: blackboard.toLogSummary(),
      });
      chatCircuitBreaker.recordResult(false);
      // Extract any tools already executed before the error — seed monolithic tracker
      const execution = blackboard.getExecutionResults();
      const priorTools = execution?.ungroupedResults?.map(r => ({ toolName: r.toolName, args: r.args }));
      return this.fallbackResult(metrics, pipelineStart, priorTools);
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

  private fallbackResult(
    metrics: PipelineMetrics,
    pipelineStart: number,
    executedTools?: Array<{ toolName: string; args: Record<string, any> }>,
  ): SubAgentPipelineResult {
    metrics.totalMs = Date.now() - pipelineStart;
    return {
      success: false,
      content: '',
      path: 'fallback',
      metrics,
      executedTools,
    };
  }
}
