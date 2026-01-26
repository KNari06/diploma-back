/**
 * API Agent Step Executor
 * Executes a single HTTP request step with timeout and error handling
 */

import { logger } from '@/utils/core/logger';
import { executeApiTest } from '../apiTest.service';
import { randomUUID } from 'crypto';
import type {
  ApiAgentPlannedStep,
  ApiAgentStepResult,
  ApiAgentFinding,
} from './api-agent.types';

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_STEP_TIMEOUT = 10000; // 10 seconds per step
// const MAX_STEP_TIMEOUT = 30000; // 30 seconds max (reserved)
const RETRY_DELAY_MS = 500; // Delay between retries
const JITTER_MAX_MS = 200; // Random jitter added to retry delay
const CORRELATION_ID_HEADER = 'x-qai-correlation-id';

// ═══════════════════════════════════════════════════════════════════════════
// STEP EXECUTOR SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ApiAgentStepExecutorService {
  /**
   * Execute a single planned step
   */
  static async executeStep(
    step: ApiAgentPlannedStep,
    stepIndex: number,
    chatSessionId?: string
  ): Promise<ApiAgentStepResult> {
    const stepId = `step_${stepIndex}_${Date.now()}`;
    const timestamp = new Date().toISOString();

    logger.info('[API_AGENT_STEP] Executing step', {
      stepId,
      stepType: step.stepType,
      method: step.request.method,
      url: step.request.url,
    });

    try {
      // Execute the HTTP request using existing executeApiTest
      const result = await executeApiTest(
        {
          method: step.request.method,
          url: step.request.url,
          headers: step.request.headers,
          body: step.request.body,
          timeout: DEFAULT_STEP_TIMEOUT,
        },
        chatSessionId
      );

      // Analyze findings from the response
      const findings = this.analyzeResponseForFindings(step, result);

      const stepResult: ApiAgentStepResult = {
        stepId,
        stepType: step.stepType,
        description: step.description,
        request: step.request,
        response: {
          status: result.status,
          statusText: result.statusText || '',
          headers: result.responseHeaders || {},
          body: result.responseBody,
          durationMs: result.durationMs,
        },
        success: result.success,
        error: result.error,
        findings,
        aiTokensUsed: 0, // Will be updated by orchestrator after AI calls
        timestamp,
      };

      logger.info('[API_AGENT_STEP] Step completed', {
        stepId,
        success: result.success,
        status: result.status,
        findingsCount: findings.length,
      });

      return stepResult;
    } catch (error) {
      logger.error('[API_AGENT_STEP] Step execution failed', {
        stepId,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        stepId,
        stepType: step.stepType,
        description: step.description,
        request: step.request,
        response: null,
        success: false,
        error: error instanceof Error ? error.message : String(error),
        findings: [
          {
            id: `finding_${stepId}_error`,
            type: 'server_error',
            severity: 'high',
            title: 'Step execution error',
            description: error instanceof Error ? error.message : String(error),
          },
        ],
        aiTokensUsed: 0,
        timestamp,
      };
    }
  }

  /**
   * Execute step with retry on 5xx errors (for HARD level)
   * Returns array of results from all attempts
   */
  static async executeStepWithRetry(
    step: ApiAgentPlannedStep,
    stepIndex: number,
    maxRetries: number,
    chatSessionId?: string
  ): Promise<{
    results: ApiAgentStepResult[];
    finalResult: ApiAgentStepResult;
    retryCount: number;
  }> {
    const results: ApiAgentStepResult[] = [];
    let retryCount = 0;

    // Correlation id groups this step and all retries
    const baseCorrelationId = `qai-${randomUUID()}`;

    const withCorrelation = (s: ApiAgentPlannedStep, attempt: number): ApiAgentPlannedStep => ({
      ...s,
      request: {
        ...s.request,
        headers: {
          ...(s.request.headers || {}),
          [CORRELATION_ID_HEADER]: `${baseCorrelationId}:${attempt}`,
        },
      },
    });

    // First attempt (attempt=1)
    const firstResult = await this.executeStep(withCorrelation(step, 1), stepIndex, chatSessionId);
    results.push(firstResult);

    // Check if we should retry (5xx or high-risk signal)
    const shouldRetry = this.isHighRiskSignal(firstResult);

    if (!shouldRetry || maxRetries <= 0) {
      return { results, finalResult: firstResult, retryCount: 0 };
    }

    // Retry loop
    for (let i = 0; i < maxRetries; i++) {
      retryCount++;
      const attemptNumber = retryCount + 1; // attempt 2..N

      // Add jitter delay
      const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
      await this.sleep(RETRY_DELAY_MS + jitter);

      logger.info('[API_AGENT_STEP] Retrying step', {
        stepIndex,
        attempt: attemptNumber,
        maxRetries,
        correlationId: baseCorrelationId,
      });

      const retryResult = await this.executeStep(
        withCorrelation(
          { ...step, description: `${step.description} (retry ${retryCount})` },
          attemptNumber
        ),
        stepIndex,
        chatSessionId
      );
      results.push(retryResult);

      // Stop if no longer high-risk
      if (!this.isHighRiskSignal(retryResult)) {
        break;
      }
    }

    const finalResult = results[results.length - 1];

    // Add finding about consistent high-risk signal
    if (this.isHighRiskSignal(finalResult) && retryCount > 0) {
      finalResult.findings.push({
        id: `finding_retry_${Date.now()}`,
        type: 'server_error',
        severity: 'high',
        title: 'Consistent server error across retries',
        description: `Endpoint returned 5xx error on ${retryCount + 1} consecutive attempts`,
        evidence: {
          response: {
            correlationId: baseCorrelationId,
            attempts: results.map((r) => ({
              status: r.response?.status,
              error: r.error,
              correlationId: r.request?.headers?.[CORRELATION_ID_HEADER],
            })),
          },
        },
        recommendation: 'Investigate server stability and error handling',
      });
    }

    return { results, finalResult, retryCount };
  }

  /**
   * Check if result indicates high-risk signal (warrants retry)
   */
  private static isHighRiskSignal(result: ApiAgentStepResult): boolean {
    if (!result.response) return true; // No response = network error

    const status = result.response.status;

    // 5xx server errors
    if (status >= 500 && status < 600) return true;

    // Timeout-like errors
    if (result.error?.toLowerCase().includes('timeout')) return true;

    return false;
  }

  /**
   * Sleep helper
   */
  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Analyze response for findings based on step type
   */
  private static analyzeResponseForFindings(
    step: ApiAgentPlannedStep,
    result: any
  ): ApiAgentFinding[] {
    const findings: ApiAgentFinding[] = [];
    const findingId = () => `finding_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Check for server errors (5xx)
    if (result.status >= 500) {
      findings.push({
        id: findingId(),
        type: 'server_error',
        severity: result.status >= 500 && result.status < 510 ? 'high' : 'medium',
        title: `Server error: ${result.status}`,
        description: `Endpoint returned ${result.status} ${result.statusText || 'Server Error'}`,
        evidence: {
          request: step.request,
          response: { status: result.status, body: this.truncateBody(result.responseBody) },
        },
        recommendation: 'Investigate server-side error handling',
      });
    }

    // Method contract check findings
    if (step.stepType === 'method_contract') {
      if (result.success && result.status >= 200 && result.status < 300) {
        // Unexpected success - endpoint supports this method
        findings.push({
          id: findingId(),
          type: 'capability_discovered',
          severity: 'info',
          title: `Endpoint supports ${step.request.method}`,
          description: `Endpoint responded with ${result.status} for ${step.request.method} method`,
          evidence: { request: step.request, response: { status: result.status } },
        });
      } else if (result.status !== 405 && result.status < 400) {
        // Not 405 and not an error - unusual
        findings.push({
          id: findingId(),
          type: 'contract_violation',
          severity: 'low',
          title: `Unexpected response for disallowed method`,
          description: `Expected 405 Method Not Allowed for ${step.request.method}, got ${result.status}`,
          evidence: { request: step.request, response: { status: result.status } },
        });
      }
    }

    // Negative case findings
    if (step.stepType === 'negative_case') {
      if (result.success && result.status >= 200 && result.status < 300) {
        // Should have failed but succeeded
        findings.push({
          id: findingId(),
          type: 'validation_bypass',
          severity: 'medium',
          title: 'Validation bypass detected',
          description: `Negative test case succeeded when it should have failed: ${step.description}`,
          evidence: {
            request: step.request,
            response: { status: result.status, body: this.truncateBody(result.responseBody) },
          },
          recommendation: 'Add server-side validation for this case',
        });
      }
    }

    // Schema validation findings
    if (step.stepType === 'schema_validation' || step.stepType === 'happy_path') {
      // Check if response is valid JSON when expected
      if (result.success && result.responseBody !== null) {
        const contentType = result.responseHeaders?.['content-type'] || '';
        if (contentType.includes('application/json')) {
          if (typeof result.responseBody === 'string') {
            try {
              JSON.parse(result.responseBody);
            } catch {
              findings.push({
                id: findingId(),
                type: 'schema_mismatch',
                severity: 'medium',
                title: 'Invalid JSON response',
                description: 'Response has JSON content-type but body is not valid JSON',
                evidence: { response: { body: this.truncateBody(result.responseBody) } },
              });
            }
          }
        }

        // Check for empty response
        if (
          result.responseBody === null ||
          result.responseBody === '' ||
          (typeof result.responseBody === 'object' && Object.keys(result.responseBody).length === 0)
        ) {
          findings.push({
            id: findingId(),
            type: 'schema_mismatch',
            severity: 'low',
            title: 'Empty response body',
            description: 'Response body is empty or has no fields',
            evidence: { response: { status: result.status, body: result.responseBody } },
          });
        }
      }
    }

    // Auth-related findings
    if (result.status === 401 || result.status === 403) {
      if (step.stepType !== 'auth_bypass' && step.stepType !== 'negative_case') {
        findings.push({
          id: findingId(),
          type: 'auth_issue',
          severity: step.stepType === 'happy_path' ? 'high' : 'info',
          title: `Authentication required (${result.status})`,
          description: `Endpoint requires authentication: ${result.status} ${result.statusText || ''}`,
          evidence: { response: { status: result.status } },
        });
      }
    }

    // Performance findings
    if (result.durationMs > 5000) {
      findings.push({
        id: findingId(),
        type: 'performance_anomaly',
        severity: result.durationMs > 10000 ? 'medium' : 'low',
        title: 'Slow response time',
        description: `Response took ${result.durationMs}ms (expected < 5000ms)`,
        evidence: { response: { durationMs: result.durationMs } },
        recommendation: 'Investigate endpoint performance',
      });
    }

    // Rate limiting
    if (result.status === 429) {
      findings.push({
        id: findingId(),
        type: 'rate_limit_issue',
        severity: 'info',
        title: 'Rate limited',
        description: 'Endpoint returned 429 Too Many Requests',
        evidence: { response: { status: result.status, headers: result.responseHeaders } },
      });
    }

    return findings;
  }

  /**
   * Truncate body for evidence (avoid huge payloads)
   */
  private static truncateBody(body: any, maxLength: number = 500): any {
    if (body === null || body === undefined) return body;
    if (typeof body === 'string') {
      return body.length > maxLength ? body.substring(0, maxLength) + '...[truncated]' : body;
    }
    const str = JSON.stringify(body);
    if (str.length > maxLength) {
      return str.substring(0, maxLength) + '...[truncated]';
    }
    return body;
  }
}
