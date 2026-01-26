/**
 * API Agent Orchestrator
 * Main execution loop: think → execute → observe → decide
 */

import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import { randomUUID } from 'crypto';
import { ApiAgentEvaluatorService } from './api-agent-evaluator.service';
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
      if (decision.shouldStop || !decision.nextStep) {
        logger.info('[API_AGENT] Planner decided to stop', {
          reason: decision.reasoning,
          stopReason: decision.stopReason,
        });
        markStopped(state, decision.stopReason || 'completed');
        return;
      }

      // EXECUTE: Run the planned step
      this.emitProgress(
        request.chatSessionId,
        `Step ${state.consumed.steps + 1}: ${decision.nextStep.description}`,
        progressPercent + 2
      );

      // Write step start to trace
      traceService.writeStepStart(state.consumed.steps, decision.nextStep);

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

      // Write step result to trace
      traceService.writeStepResult(state.consumed.steps, stepResult);

      // OBSERVE: Add result to state
      addStepResult(state, stepResult);

      // DECIDE: Evaluate result and update novelty
      ApiAgentEvaluatorService.evaluateStep(state, stepResult);

      // Write state update to trace
      traceService.writeStateUpdate(state);

      logger.debug('[API_AGENT] Step completed', {
        stepId: stepResult.stepId,
        success: stepResult.success,
        novelty: state.novelty,
        findingsAdded: stepResult.findings.length,
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
}
