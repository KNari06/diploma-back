/**
 * API Agent Orchestrator
 * Main execution loop: think → execute → observe → decide
 */

import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import type { ApiAgentStepPayload } from '@/websocket/types/types';
import { randomUUID } from 'crypto';
import { ApiAgentEvaluatorService } from './api-agent-evaluator.service';
import { ApiAgentExpectationService } from './api-agent-expectation.service';
import { ApiAgentExpectationValidatorService } from './api-agent-expectation-validator.service';
import { ApiAgentPlannerService } from './api-agent-planner.service';
import {
  getBaselineCredits,
  getPolicyWithOverrides,
  isValidLevel,
} from './api-agent-policy';
import {
  addAiTokens,
  addStepResult,
  createInitialState,
  getDurationMs,
  getFindingsCounts,
  getTopFindings,
  hasSuccessfulHappyPath,
  markCompleted,
  markFailed,
  markStopped,
  updateConsumedTime,
} from './api-agent-state';
import { ApiAgentStepExecutorService } from './api-agent-step-executor.service';
import { ApiAgentTraceService } from './api-agent-trace.service';
import type {
  ApiAgentLevelPolicy,
  ApiAgentRequest,
  ApiAgentResponse,
  ApiAgentRunState,
  ApiAgentStopReason,
  ApiAgentSummary,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// ORCHESTRATOR SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ApiAgentOrchestratorService {
  /**
   * Run the API agent with the given request
   * Main entry point for agent execution
   */
  static async run(request: ApiAgentRequest): Promise<ApiAgentResponse> {
    const testId = request.testId && String(request.testId).trim().length > 0
      ? String(request.testId).trim()
      : `api_agent_${randomUUID()}`;
    const runId = randomUUID();
    const startTime = Date.now();

    // Validate level
    if (!isValidLevel(request.level)) {
      return {
        success: false,
        summary: this.createErrorSummary(testId, request, 'Invalid level'),
        error: `Invalid level: ${request.level}. Must be 'light', 'medium', or 'hard'.`,
      };
    }

    // Get policy with optional overrides
    const policy = getPolicyWithOverrides(request.level, request.budgetOverrides);

    // Initialize state
    const state = createInitialState(testId, request.level, runId);

    // Initialize trace writer
    const traceService = new ApiAgentTraceService(testId, runId, request.userId);
    traceService.writeRunStart(request, policy);

    logger.info('[API_AGENT] Starting agent run', {
      testId,
      runId,
      level: request.level,
      url: request.url,
      method: request.method,
      budget: policy.budget,
    });

    // Emit initial progress
    this.emitProgress(request.chatSessionId, 'Starting API agent test...', 0);

    try {
      // Interpretation stage: build expectation model once per run (JSON-first, 1 AI fallback)
      if (request.expectedBehavior) {
        const maxTokens = policy.level === 'light' ? 250 : 350;
        const { model, tokensUsed } = await ApiAgentExpectationService.buildExpectationModel(request, {
          maxTokens,
        });
        state.expectationModel = model || undefined;
        addAiTokens(state, tokensUsed);
      }

      // Main execution loop with trace service
      await this.executeLoop(request, state, policy, startTime, traceService);

      // Finalize state
      if (state.status === 'running') {
        markCompleted(state, state.stopReason || 'completed');
      }

      // Build summary
      const summary = this.buildSummary(state, request);

      // Write run end to trace
      traceService.writeRunEnd(state, summary);

      // Upload trace and get path
      const tracePath = await traceService.closeAndUpload();
      if (tracePath) {
        summary.traceLogPath = tracePath;
      }

      logger.info('[API_AGENT] Agent run completed', {
        testId,
        status: state.status,
        stopReason: state.stopReason,
        stepsExecuted: state.consumed.steps,
        findingsCount: state.findings.length,
        durationMs: getDurationMs(state),
        tracePath,
      });

      // Emit completion
      this.emitProgress(
        request.chatSessionId,
        `Test complete: ${state.findings.length} finding(s)`,
        100
      );

      return {
        success: hasSuccessfulHappyPath(state),
        summary,
        fullState: state,
      };
    } catch (error) {
      logger.error('[API_AGENT] Agent run failed', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Write error to trace
      traceService.writeError(
        error instanceof Error ? error.message : String(error)
      );

      // Try to upload trace even on error
      await traceService.closeAndUpload().catch(() => {});

      markFailed(state, error instanceof Error ? error.message : String(error));

      return {
        success: false,
        summary: this.buildSummary(state, request),
        fullState: state,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Main execution loop
   */
  private static async executeLoop(
    request: ApiAgentRequest,
    state: ApiAgentRunState,
    policy: ApiAgentLevelPolicy,
    startTime: number,
    traceService: ApiAgentTraceService
  ): Promise<void> {
    const maxIterations = policy.budget.maxSteps + 5; // Safety margin
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;
      const elapsed = Date.now() - startTime;
      updateConsumedTime(state, elapsed);

      // Check stopping conditions
      const stopCheck = ApiAgentEvaluatorService.shouldStop(state, policy, elapsed);
      if (stopCheck.shouldStop) {
        logger.info('[API_AGENT] Stopping due to condition', {
          reason: stopCheck.reason,
          iteration,
        });
        markStopped(state, stopCheck.reason as ApiAgentStopReason);
        return;
      }

      // Emit progress
      const progressPercent = Math.min(
        95,
        Math.floor((state.consumed.steps / policy.budget.maxSteps) * 90) + 5
      );
      this.emitProgress(
        request.chatSessionId,
        `Step ${state.consumed.steps + 1}: planning...`,
        progressPercent
      );

      // THINK: Plan next step
      const { decision, tokensUsed } = await ApiAgentPlannerService.planNextStep(
        request,
        state,
        policy
      );

      addAiTokens(state, tokensUsed);

      // Write planning to trace
      traceService.writeStepPlanning(state.consumed.steps, decision);

      // Check if AI decided to stop
      if (decision.shouldStop) {
        logger.info('[API_AGENT] Planner decided to stop', {
          reason: decision.reasoning,
          stopReason: decision.stopReason,
        });
        markStopped(state, decision.stopReason || 'completed');
        return;
      }

      // If AI produced no actionable nextStep (e.g., safety gate blocked), continue planning.
      // This prevents premature termination when shouldStop=false but nextStep=null.
      if (!decision.nextStep) {
        logger.info('[API_AGENT] Planner returned no nextStep, retrying planning', {
          reason: decision.reasoning,
        });
        continue;
      }

      // Emit planning step to frontend (only for real nextStep)
      this.emitStepEvent(request.chatSessionId, state.testId, state.runId, {
        stepIndex: state.consumed.steps,
        stepType: decision.nextStep.stepType,
        stage: 'planning',
        description: decision.nextStep.description,
        expectedOutcome: decision.nextStep.expectedOutcome,
        reasoning: decision.reasoning,
        noveltyEstimate: decision.noveltyEstimate,
        riskLevel: decision.nextStep.riskLevel,
        novelty: state.novelty,
        totalFindings: state.findings.length,
        aiTokensUsed: tokensUsed,
      });

      // EXECUTE: Run the planned step
      this.emitProgress(
        request.chatSessionId,
        `Step ${state.consumed.steps + 1}: ${decision.nextStep.description}`,
        progressPercent + 2
      );

      // Write step start to trace
      traceService.writeStepStart(state.consumed.steps, decision.nextStep);

      // Emit executing step to frontend
      this.emitStepEvent(request.chatSessionId, state.testId, state.runId, {
        stepIndex: state.consumed.steps,
        stepType: decision.nextStep.stepType,
        stage: 'executing',
        description: decision.nextStep.description,
        expectedOutcome: decision.nextStep.expectedOutcome,
        request: {
          method: decision.nextStep.request.method,
          url: decision.nextStep.request.url,
          headers: this.redactHeadersForUi(decision.nextStep.request.headers),
          bodyPreview: this.toPreview(decision.nextStep.request.body),
        },
        riskLevel: decision.nextStep.riskLevel,
        novelty: state.novelty,
        totalFindings: state.findings.length,
        aiTokensUsed: tokensUsed,
      });

      // Execute with automatic retry on high-risk signals (HARD policy)
      // Requirement: if 5xx/high-risk → re-attack 3–5 times (bounded by policy.maxRetryOnHighRisk)
      const execResult =
        policy.maxRetryOnHighRisk > 0
          ? await ApiAgentStepExecutorService.executeStepWithRetry(
              decision.nextStep,
              state.consumed.steps,
              policy.maxRetryOnHighRisk,
              request.chatSessionId
            )
          : {
              results: [],
              finalResult: await ApiAgentStepExecutorService.executeStep(
                decision.nextStep,
                state.consumed.steps,
                request.chatSessionId
              ),
              retryCount: 0,
            };

      const stepResult = execResult.finalResult;

      if (execResult.retryCount > 0) {
        logger.info('[API_AGENT] Step executed with retries', {
          retryCount: execResult.retryCount,
          totalAttempts: execResult.results.length,
        });
      }

      // Update step with AI tokens from planning
      stepResult.aiTokensUsed = tokensUsed;

      // Expectation-driven validator (adds additional findings, severity assigned by code)
      if (state.expectationModel || request.expectedBehavior) {
        const extra = ApiAgentExpectationValidatorService.validateStep({
          plannedStep: decision.nextStep,
          stepResult,
          expectationModel: state.expectationModel,
          expectedBehaviorRaw: request.expectedBehavior,
        });
        if (extra.findings.length > 0) {
          stepResult.findings.push(...extra.findings);
        }
      }

      // Write step result to trace
      traceService.writeStepResult(state.consumed.steps, stepResult);

      // OBSERVE: Add result to state
      addStepResult(state, stepResult);

      // DECIDE: Evaluate result and update novelty
      ApiAgentEvaluatorService.evaluateStep(state, stepResult);

      // Write state update to trace
      traceService.writeStateUpdate(state);

      // Emit completed step to frontend
      const completedIndex = state.steps.length - 1;
      const correlationIdHeader = 'x-qai-correlation-id';
      const correlationId =
        stepResult.request?.headers?.[correlationIdHeader] ||
        stepResult.request?.headers?.[correlationIdHeader.toLowerCase()] ||
        undefined;

      const httpOk = stepResult.success;
      const status = stepResult.response?.status ?? 0;
      const bugFindingTypes = new Set([
        'invalid_method_handling',
        'invalid_input_handling',
        'expectation_violation',
        'validation_bypass',
        'schema_mismatch',
        'network_error',
        'server_error',
      ]);
      const hasBugFinding = stepResult.findings.some((f) => bugFindingTypes.has(f.type as any));
      const hasTimeout = (stepResult.error || '').toLowerCase().includes('timeout');
      const isBug =
        hasBugFinding ||
        hasTimeout ||
        status === 0 ||
        status >= 500 ||
        (decision.nextStep.stepType === 'happy_path' && status >= 400);

      const isExpectedErrorStep =
        decision.nextStep.stepType === 'method_contract' || decision.nextStep.stepType === 'negative_case';
      const isExpectedError = isExpectedErrorStep && status >= 400 && status < 500 && !isBug;
      const stepVerdict: 'pass' | 'expected_error' | 'bug' = isBug ? 'bug' : isExpectedError ? 'expected_error' : 'pass';

      this.emitStepEvent(request.chatSessionId, state.testId, state.runId, {
        stepIndex: Math.max(0, completedIndex),
        stepType: stepResult.stepType,
        stage: 'completed',
        description: stepResult.description,
        expectedOutcome: decision.nextStep.expectedOutcome,
        summary: stepResult.response
          ? `${stepResult.response.status} ${stepResult.response.statusText}`.trim()
          : (stepResult.error || 'No response'),
        // `success` for UI: expected 4xx should not render as failure
        success: stepVerdict !== 'bug',
        httpOk,
        stepVerdict,
        isBug,
        error: stepResult.error,
        response: stepResult.response
          ? {
              status: stepResult.response.status,
              statusText: stepResult.response.statusText,
              durationMs: stepResult.response.durationMs,
              bodyPreview: this.toPreview(stepResult.response.body),
            }
          : undefined,
        findingsCount: stepResult.findings.length,
        findings: stepResult.findings.slice(0, 5).map((f) => ({
          severity: f.severity,
          title: f.title,
          type: f.type,
        })),
        novelty: state.novelty,
        totalFindings: state.findings.length,
        aiTokensUsed: stepResult.aiTokensUsed,
        isRetry: execResult.retryCount > 0,
        retryAttempt: execResult.retryCount,
        maxRetries: policy.maxRetryOnHighRisk,
        request: correlationId
          ? {
              method: stepResult.request.method,
              url: stepResult.request.url,
              headers: this.redactHeadersForUi(stepResult.request.headers),
              bodyPreview: this.toPreview(stepResult.request.body),
              correlationId,
            }
          : undefined,
      });

      logger.debug('[API_AGENT] Step completed', {
        stepId: stepResult.stepId,
        success: stepResult.success,
        novelty: state.novelty,
        totalFindings: stepResult.findings.length,
      });
    }

    // Max iterations reached (shouldn't happen with proper budgets)
    logger.warn('[API_AGENT] Max iterations reached', { iteration });
    markStopped(state, 'budget_steps');
  }

  /**
   * Build summary from state
   */
  private static buildSummary(state: ApiAgentRunState, request: ApiAgentRequest): ApiAgentSummary {
    const findingsCounts = getFindingsCounts(state);
    const topFindings = getTopFindings(state, 5);
    const securityScore = ApiAgentEvaluatorService.computeSecurityScore(state);
    const hasExpectedBehavior = !!request.expectedBehavior && request.expectedBehavior.trim().length > 0;
    const expectationSatisfied = !state.findings.some((f) => f.type === 'expectation_violation');

    const hasFailingExpectation =
      state.findings.some((f) => f.type === 'expectation_violation') ||
      state.findings.some((f) => f.type === 'invalid_method_handling') ||
      state.findings.some((f) => f.type === 'invalid_input_handling');

    const hasHighOrCritical = state.findings.some((f) => f.severity === 'high' || f.severity === 'critical');
    const hasMedium = state.findings.some((f) => f.severity === 'medium');

    const finalVerdict: 'pass' | 'pass_with_risks' | 'fail' =
      (hasExpectedBehavior && !expectationSatisfied) || hasFailingExpectation || hasHighOrCritical
        ? 'fail'
        : hasMedium
          ? 'pass_with_risks'
          : 'pass';

    return {
      level: state.level,
      runId: state.runId,
      testId: state.testId,
      url: request.url,
      method: request.method,
      success: hasSuccessfulHappyPath(state),
      durationMs: getDurationMs(state),
      stepsExecuted: state.consumed.steps,
      findingsCounts,
      topFindings,
      discoveredMethods: state.discoveredMethods,
      securityScore,
      stopReason: state.stopReason || 'completed',
      creditsCharged: getBaselineCredits(state.level), // Base, incremental added later
      aiTokensUsed: state.consumed.aiTokens,
      expectationSatisfied: hasExpectedBehavior ? expectationSatisfied : undefined,
      finalVerdict,
    };
  }

  /**
   * Create error summary for early failures
   */
  private static createErrorSummary(
    testId: string,
    request: ApiAgentRequest,
    error: string
  ): ApiAgentSummary {
    return {
      level: request.level,
      runId: randomUUID(),
      testId,
      url: request.url,
      method: request.method,
      success: false,
      durationMs: 0,
      stepsExecuted: 0,
      findingsCounts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      topFindings: [
        {
          id: 'err_validation',
          type: 'server_error',
          severity: 'critical',
          title: 'Validation Error',
          description: error,
        },
      ],
      discoveredMethods: [],
      securityScore: 0,
      stopReason: 'error',
      creditsCharged: 0,
      aiTokensUsed: 0,
    };
  }

  /**
   * Emit progress via WebSocket
   */
  private static emitProgress(
    chatSessionId: string | undefined,
    message: string,
    progress: number
  ): void {
    if (!chatSessionId) return;

    webSocketService.emitChatProcessingStep(chatSessionId, {
      sessionId: chatSessionId,
      step: 'executing_test',
      message,
      progress,
      timestamp: new Date().toISOString(),
    });
  }

  private static toPreview(value: unknown, maxLen: number = 200): string | undefined {
    if (value === null || value === undefined) return undefined;
    try {
      const str = typeof value === 'string' ? value : JSON.stringify(value);
      return str.length > maxLen ? `${str.slice(0, maxLen)}...` : str;
    } catch {
      return undefined;
    }
  }

  private static redactHeadersForUi(
    headers?: Record<string, string>
  ): Record<string, string> | undefined {
    if (!headers) return undefined;

    const redactedKeys = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
      'api-key',
      'x-auth-token',
    ]);

    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(headers)) {
      const lower = k.toLowerCase();
      out[k] = redactedKeys.has(lower) ? '[REDACTED]' : v;
    }
    return out;
  }

  /**
   * Emit detailed API agent step event via WebSocket (for frontend step cards)
   */
  private static emitStepEvent(
    chatSessionId: string | undefined,
    testId: string,
    runId: string,
    payload: Omit<ApiAgentStepPayload, 'testId' | 'runId' | 'sessionId' | 'timestamp'>
  ): void {
    if (!chatSessionId) return;

    webSocketService.emitApiAgentStep(chatSessionId, {
      ...payload,
      testId,
      runId,
      sessionId: chatSessionId,
      timestamp: new Date().toISOString(),
    });
  }
}
