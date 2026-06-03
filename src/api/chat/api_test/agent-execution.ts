/**
 * API Agent Execution Flow
 * Entry point for LIGHT/MEDIUM/HARD agent-based API testing
 * Called when context.apiTest.level is provided from UI
 */

import {
  ApiAgentCreditsService,
  ApiAgentOrchestratorService,
  isValidLevel,
  type ApiAgentLevel,
  type ApiAgentRequest,
  type ApiAgentResponse,
} from '@/services/testing/api/agent';
import { ApiTestStorageService } from '@/services/testing/api/api-test-storage.service';
import { ChatService } from '@/services/utils/chat.service';
import { logger } from '@/utils/core/logger';
import { Response } from 'express';
import { emitProcessingStep } from '../shared/utils';

// ═══════════════════════════════════════════════════════════════════════════
// AGENT EXECUTION FLOW
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Execute API test using the new agent-based approach
 * Called when parsedIntent.agentLevel is set (from UI)
 */
export async function executeApiAgentTestFlow(
  res: Response,
  params: {
    level: ApiAgentLevel;
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: any;
    expectedStatus?: number;
    expectedBehavior?: string;
    userId: string;
    chatSessionId?: string;
    projectId?: string;
    workspaceId?: string;
    userMessage?: string;
    abortSignal?: AbortSignal;
  }
): Promise<void> {
  const {
    level,
    url,
    method,
    headers,
    body,
    expectedStatus,
    expectedBehavior,
    userId,
    chatSessionId,
    projectId,
    userMessage,
    abortSignal,
  } = params;

  // If UI didn't provide explicit expectedBehavior, fallback to a trimmed user message.
  // This keeps expectation validation working for "verify X in response" prompts.
  const expectedBehaviorFallback =
    !expectedBehavior || expectedBehavior.trim().length === 0
      ? (userMessage || '').trim().slice(0, 800) || undefined
      : expectedBehavior;

  logger.info('[API_AGENT_FLOW] Starting agent test flow', {
    level,
    url,
    method,
    userId: userId.substring(0, 8) + '...',
    chatSessionId,
  });

  // Validate level
  if (!isValidLevel(level)) {
    const errorMsg = `Invalid level: ${level}. Must be 'light', 'medium', or 'hard'.`;
    logger.error('[API_AGENT_FLOW] Invalid level', { level });

    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'ai', content: `❌ ${errorMsg}` },
      ]);
    }

    res.status(400).json({
      success: false,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  // Emit initial progress
  emitProcessingStep(chatSessionId, 'executing_test', `Starting ${level.toUpperCase()} API test...`, 5);

  // Deduct baseline credits before execution
  const testId = `api_agent_${Date.now()}`;
  const creditResult = await ApiAgentCreditsService.deductBaselineCredits(
    userId,
    level,
    testId,
    `API Agent (${level.toUpperCase()}) test: ${method} ${url}`
  );

  if (!creditResult.success) {
    const errorMsg = creditResult.error?.includes('insufficient')
      ? 'Insufficient credits. Please upgrade your plan or wait for credit refresh.'
      : creditResult.error || 'Failed to process payment';

    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'ai', content: `❌ ${errorMsg}` },
      ]);
    }

    res.status(402).json({
      success: false,
      error: errorMsg,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  logger.info('[API_AGENT_FLOW] Baseline credits deducted', {
    credits: creditResult.credits,
    level,
  });

  try {
    // Build agent request
    const agentRequest: ApiAgentRequest = {
      level,
      testId,
      url,
      method,
      headers,
      body,
      expectedStatus,
      expectedBehavior: expectedBehaviorFallback,
      userId,
      chatSessionId,
      projectId,
      userMessage,
      abortSignal,
    };

    // Run the agent
    const agentResponse = await ApiAgentOrchestratorService.run(agentRequest);

    // If the user cancelled mid-run, refund the baseline and skip billing/
    // persistence — the run was halted and produced no deliverable result.
    if (abortSignal?.aborted) {
      await ApiAgentCreditsService.refundBaselineCredits(
        userId,
        level,
        testId,
        'cancelled by user'
      );
      res.status(499).json({
        success: false,
        error: 'Request was cancelled by user',
        timestamp: new Date().toISOString(),
        sessionId: chatSessionId,
      });
      return;
    }

    // Deduct incremental credits for AI usage (if exceeded baseline)
    const incrementalResult = await ApiAgentCreditsService.deductIncrementalCredits(
      userId,
      agentResponse.summary
    );

    // Update summary with total credits charged
    if (incrementalResult.credits > 0) {
      agentResponse.summary.creditsCharged += incrementalResult.credits;
    }

    // Save to database
    await saveAgentResult(agentResponse, params);

    // Format and send response
    const formattedMessage = formatAgentResponse(agentResponse);

    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'user', content: userMessage || `Run ${level.toUpperCase()} API test` },
        {
          role: 'ai',
          content: formattedMessage,
          metadata: {
            testType: 'api_agent',
            level,
            summary: agentResponse.summary,
          },
        },
      ]);
    }

    res.json({
      success: agentResponse.success,
      reply: formattedMessage,
      summary: agentResponse.summary,
      testId: agentResponse.summary.testId,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });

    logger.info('[API_AGENT_FLOW] Agent test completed', {
      success: agentResponse.success,
      stepsExecuted: agentResponse.summary.stepsExecuted,
      findingsCount: Object.values(agentResponse.summary.findingsCounts).reduce((a, b) => a + b, 0),
    });
  } catch (error) {
    logger.error('[API_AGENT_FLOW] Agent execution failed', {
      error: error instanceof Error ? error.message : String(error),
    });

    const errorMsg = error instanceof Error ? error.message : 'API Agent test failed';

    // Refund the baseline credits — the run failed before producing any result,
    // so the user should not be billed for it. Best-effort; never masks errorMsg.
    await ApiAgentCreditsService.refundBaselineCredits(userId, level, testId, errorMsg);

    if (chatSessionId) {
      await ChatService.saveChatMessages(chatSessionId, [
        { role: 'ai', content: `❌ Error: ${errorMsg}` },
      ]);
    }

    res.status(500).json({
      success: false,
      error: errorMsg,
      timestamp: new Date().toISOString(),
      sessionId: chatSessionId,
    });
  }
}


/**
 * Save agent result to database
 * Stores summary + trace pointer in validation_results
 */
async function saveAgentResult(
  response: ApiAgentResponse,
  params: {
    url: string;
    method: string;
    headers?: Record<string, string>;
    body?: any;
    userId: string;
    chatSessionId?: string;
    projectId?: string;
    workspaceId?: string;
  }
): Promise<void> {
  try {
    // Find happy path step for request/response data
    const happyPathStep = response.fullState?.steps.find((s) => s.stepType === 'happy_path');

    // Build comprehensive validation_results with summary + trace
    const validationResults = {
      success: response.success,
      testType: 'api_agent',
      // Agent summary
      summary: {
        level: response.summary.level,
        stepsExecuted: response.summary.stepsExecuted,
        durationMs: response.summary.durationMs,
        securityScore: response.summary.securityScore,
        stopReason: response.summary.stopReason,
        findingsCounts: response.summary.findingsCounts,
        discoveredMethods: response.summary.discoveredMethods,
        topFindings: response.summary.topFindings.map((f) => ({
          id: f.id,
          type: f.type,
          severity: f.severity,
          title: f.title,
          description: f.description,
        })),
      },
      // Agent metadata
      agent: {
        version: '1.0.0',
        runId: response.summary.runId,
        aiTokensUsed: response.summary.aiTokensUsed,
        creditsCharged: response.summary.creditsCharged,
      },
      // Trace log reference
      traceLog: response.summary.traceLogPath
        ? {
            path: response.summary.traceLogPath,
            runId: response.summary.runId,
          }
        : undefined,
    };

    await ApiTestStorageService.saveApiTestExecution({
      userId: params.userId,
      testId: response.summary.testId,
      chatSessionId: params.chatSessionId,
      projectId: params.projectId,
      workspaceId: params.workspaceId,
      request: {
        method: params.method,
        url: params.url,
        headers: params.headers,
        body: params.body,
      },
      response: {
        status: happyPathStep?.response?.status || 0,
        statusText: happyPathStep?.response?.statusText || '',
        headers: happyPathStep?.response?.headers || {},
        body: happyPathStep?.response?.body,
        durationMs: happyPathStep?.response?.durationMs || 0,
      },
      success: response.success,
      errorMessage: response.error,
      metadata: validationResults,
      fuzzingReport: undefined, // Agent doesn't use legacy fuzzing format
    });

    logger.info('[API_AGENT_FLOW] Agent result saved', {
      testId: response.summary.testId,
      level: response.summary.level,
      hasTracePath: !!response.summary.traceLogPath,
    });
  } catch (error) {
    logger.error('[API_AGENT_FLOW] Failed to save agent result', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Format agent response for chat display
 */
function formatAgentResponse(response: ApiAgentResponse): string {
  const { summary } = response;
  const successEmoji = summary.success ? '✅' : '❌';
  const levelEmoji = summary.level === 'light' ? '🟢' : summary.level === 'medium' ? '🟡' : '🔴';

  let message = `${successEmoji} **API Test Complete** (${levelEmoji} ${summary.level.toUpperCase()})\n\n`;

  message += `**Endpoint:** \`${summary.method}\` ${summary.url}\n`;
  message += `**Duration:** ${summary.durationMs}ms | **Steps:** ${summary.stepsExecuted}\n`;
  message += `**Security Score:** ${summary.securityScore}/10\n`;
  if (summary.finalVerdict) {
    message += `**Verdict:** ${summary.finalVerdict}\n`;
  }
  if (typeof summary.expectationSatisfied === 'boolean') {
    message += `**Expectation:** ${summary.expectationSatisfied ? 'satisfied' : 'violated'}\n`;
  }
  message += '\n';

  // Findings summary
  const totalFindings =
    summary.findingsCounts.critical +
    summary.findingsCounts.high +
    summary.findingsCounts.medium +
    summary.findingsCounts.low +
    summary.findingsCounts.info;

  if (totalFindings > 0) {
    message += `**Findings:** ${totalFindings} total\n`;
    if (summary.findingsCounts.critical > 0) {
      message += `- 🔴 Critical: ${summary.findingsCounts.critical}\n`;
    }
    if (summary.findingsCounts.high > 0) {
      message += `- 🟠 High: ${summary.findingsCounts.high}\n`;
    }
    if (summary.findingsCounts.medium > 0) {
      message += `- 🟡 Medium: ${summary.findingsCounts.medium}\n`;
    }
    if (summary.findingsCounts.low > 0) {
      message += `- 🟢 Low: ${summary.findingsCounts.low}\n`;
    }
    if (summary.findingsCounts.info > 0) {
      message += `- ℹ️ Info: ${summary.findingsCounts.info}\n`;
    }
    message += '\n';
  }

  // Top findings
  if (summary.topFindings.length > 0) {
    message += `**Top Issues:**\n`;
    for (const finding of summary.topFindings.slice(0, 3)) {
      const severityIcon =
        finding.severity === 'critical'
          ? '🔴'
          : finding.severity === 'high'
            ? '🟠'
            : finding.severity === 'medium'
              ? '🟡'
              : '🟢';
      message += `${severityIcon} ${finding.title}\n`;
    }
    message += '\n';
  }

  // Discovered methods
  if (summary.discoveredMethods.length > 1) {
    message += `**Supported Methods:** ${summary.discoveredMethods.join(', ')}\n`;
  }

  // Stop reason
  if (summary.stopReason !== 'completed') {
    message += `\n*Stopped: ${summary.stopReason.replace(/_/g, ' ')}*`;
  }

  return message;
}

// Export helper functions for use in this module
export { formatAgentResponse, saveAgentResult };
