/**
 * API Agent Step Executor
 * Executes a single HTTP request step with timeout and error handling.
 * Includes schema inference and consistency checking for HARD level.
 */

import { logger } from '@/utils/core/logger';
import { executeApiTest } from '../apiTest.service';
import { randomUUID } from 'crypto';
import type {
  ApiAgentPlannedStep,
  ApiAgentStepResult,
  ApiAgentFinding,
} from './api-agent.types';
import { SchemaConsistencyService } from './schema-consistency.service';

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
  private static isTimeoutError(error?: string): boolean {
    return (error || '').toLowerCase().includes('timeout');
  }

  /**
   * Cap severity for prod_readonly runs to avoid "critical exploit" language.
   * @param severity - Original severity
   * @param executionProfile - Execution profile
   * @returns Capped severity
   */
  private static capSeverityForProfile(
    severity: ApiAgentFinding['severity'],
    executionProfile: 'prod_readonly' | 'nonprod'
  ): ApiAgentFinding['severity'] {
    if (executionProfile !== 'prod_readonly') return severity;
    if (severity === 'critical') return 'high';
    return severity;
  }

  private static isNetworkUnreachableError(error?: string): boolean {
    const e = (error || '').toLowerCase();
    if (!e) return false;
    if (this.isTimeoutError(error)) return false;

    // Common network/DNS/socket errors (axios/node/fetch variants)
    const patterns = [
      'network error',
      'unable to reach server',
      'getaddrinfo enotfound',
      'enotfound',
      'econnrefused',
      'econnreset',
      'socket hang up',
      'fetch failed',
      'failed to fetch',
      'connection refused',
      'connection reset',
      'dns',
    ];
    return patterns.some((p) => e.includes(p));
  }

  /**
   * Execute a single planned step
   */
  static async executeStep(
    step: ApiAgentPlannedStep,
    stepIndex: number,
    chatSessionId?: string,
    options?: {
      executionProfile?: 'prod_readonly' | 'nonprod';
      /** Remaining request budget for this run; multi-request steps must respect it */
      requestBudgetRemaining?: number;
    }
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
      const profile = options?.executionProfile || 'nonprod';
      const remainingBudget = options?.requestBudgetRemaining ?? Number.POSITIVE_INFINITY;

      // Multi-request step handlers (respect request budget)
      if (step.stepType === 'auth_matrix') {
        return await this.executeAuthMatrixStep(step, stepId, timestamp, chatSessionId, profile, remainingBudget);
      }
      if (step.stepType === 'rate_limit_probe_safe') {
        return await this.executeRateLimitProbeStep(step, stepId, timestamp, chatSessionId, profile, remainingBudget);
      }
      if (step.stepType === 'content_negotiation') {
        return await this.executeContentNegotiationStep(step, stepId, timestamp, chatSessionId, profile, remainingBudget);
      }
      if (step.stepType === 'idor_probe') {
        return await this.executeIdorProbeStep(step, stepId, timestamp, chatSessionId, profile, remainingBudget);
      }

      // Default: single request execution
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
      const findings = this.analyzeResponseForFindings(step, result, profile);

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
        requestsExecuted: 1,
        timestamp,
      };

      logger.info('[API_AGENT_STEP] Step completed', {
        stepId,
        success: result.success,
        status: result.status,
        baseFindingsCount: findings.length,
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
        requestsExecuted: 0,
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
    chatSessionId?: string,
    options?: {
      executionProfile?: 'prod_readonly' | 'nonprod';
      requestBudgetRemaining?: number;
    }
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
    const firstResult = await this.executeStep(withCorrelation(step, 1), stepIndex, chatSessionId, options);
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
        chatSessionId,
        options
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
    result: any,
    executionProfile: 'prod_readonly' | 'nonprod' = 'nonprod'
  ): ApiAgentFinding[] {
    const findings: ApiAgentFinding[] = [];
    const findingId = () => `finding_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Network failures (status=0 from executeApiTest)
    if (result.status === 0 && this.isNetworkUnreachableError(result.error)) {
      findings.push({
        id: findingId(),
        type: 'network_error',
        severity: 'high',
        title: 'Network error',
        description: result.error || 'Network error - unable to reach server',
        evidence: {
          request: step.request,
        },
        recommendation: 'Verify host availability, DNS, firewall rules, and request routing',
      });
    }

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
      } else if (result.status > 0 && result.status !== 405 && result.status < 400) {
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

    // ═══════════════════════════════════════════════════════════════════════════
    // NEW HARD STEP TYPE FINDINGS
    // ═══════════════════════════════════════════════════════════════════════════

    // Auth matrix findings - detect auth bypasses
    if (step.stepType === 'auth_matrix') {
      // If we get 2xx without proper auth, that's a bypass
      if (result.status >= 200 && result.status < 300) {
        findings.push({
          id: findingId(),
          type: 'auth_matrix_issue',
          severity: this.capSeverityForProfile('critical', executionProfile),
          title: executionProfile === 'prod_readonly'
            ? 'Possible authentication bypass'
            : 'Authentication bypass detected',
          description: executionProfile === 'prod_readonly'
            ? `Endpoint returned ${result.status} for an invalid/missing auth variation (suspected bypass)`
            : `Endpoint returned ${result.status} without proper authentication headers`,
          evidence: {
            request: step.request,
            response: { status: result.status, body: this.truncateBody(result.responseBody) },
          },
          recommendation: 'Implement proper authentication middleware to verify tokens/credentials',
        });
      }
    }

    // Header security check findings
    if (step.stepType === 'header_security_check') {
      const headers = result.responseHeaders || {};
      const issues: string[] = [];

      // Check for missing security headers
      if (!headers['x-content-type-options']) {
        issues.push('Missing X-Content-Type-Options header (should be "nosniff")');
      }
      if (!headers['x-frame-options'] && !headers['content-security-policy']) {
        issues.push('Missing X-Frame-Options or CSP frame-ancestors (clickjacking risk)');
      }
      if (!headers['strict-transport-security'] && step.request.url.startsWith('https')) {
        issues.push('Missing Strict-Transport-Security header (HSTS)');
      }

      // Check for CORS misconfiguration
      if (headers['access-control-allow-origin'] === '*') {
        issues.push('CORS allows all origins (*) - potential security risk');
      }

      // Check for sensitive caching
      const cacheControl = headers['cache-control'] || '';
      if (!cacheControl.includes('no-store') && !cacheControl.includes('private')) {
        if (result.status === 200) {
          issues.push('Response may be cached publicly (missing no-store/private)');
        }
      }

      if (issues.length > 0) {
        findings.push({
          id: findingId(),
          type: 'header_security_issue',
          severity: issues.some(i => i.includes('CORS') || i.includes('clickjacking')) ? 'medium' : 'low',
          title: 'Security header misconfiguration',
          description: issues.join('; '),
          evidence: { response: { headers } },
          recommendation: 'Configure proper security headers according to OWASP guidelines',
        });
      }
    }

    // Error leak check findings
    if (step.stepType === 'error_leak_check') {
      const bodyStr = typeof result.responseBody === 'string'
        ? result.responseBody
        : JSON.stringify(result.responseBody || '');

      const leakPatterns = [
        { pattern: /stack\s*trace/i, type: 'Stack trace' },
        { pattern: /at\s+\w+\s*\(.*:\d+:\d+\)/i, type: 'Stack trace' },
        { pattern: /SQLException|ORA-\d+|mysql_|pg_|sqlite/i, type: 'SQL error' },
        { pattern: /SQLSTATE\[/i, type: 'SQL error' },
        { pattern: /syntax error.*near/i, type: 'SQL syntax error' },
        { pattern: /DEBUG|debug\s*=\s*true/i, type: 'Debug mode' },
        { pattern: /Laravel|Django|Express|Rails|Spring|ASP\.NET/i, type: 'Framework info' },
        { pattern: /\/usr\/|\/var\/|C:\\|\/home\//i, type: 'Server path' },
        { pattern: /password|api_key|secret|token.*=.*[a-zA-Z0-9]{8,}/i, type: 'Credentials leak' },
      ];

      for (const { pattern, type } of leakPatterns) {
        if (pattern.test(bodyStr)) {
          findings.push({
            id: findingId(),
            type: 'error_leak',
            severity: type === 'Credentials leak' ? 'critical' : type === 'SQL error' ? 'high' : 'medium',
            title: `${type} detected in response`,
            description: `Response contains ${type.toLowerCase()} information that should not be exposed`,
            evidence: { response: { body: this.truncateBody(result.responseBody, 200) } },
            recommendation: 'Configure error handling to hide sensitive information in production',
          });
          break; // One finding per response is enough
        }
      }
    }

    // Content negotiation findings
    if (step.stepType === 'content_negotiation') {
      const contentType = (result.responseHeaders?.['content-type'] || '').toLowerCase();
      const acceptHeader = (step.request.headers?.['Accept'] || '').toLowerCase();

      // If we asked for HTML but got JSON API data, that's fine
      // If we asked for HTML and got HTML with error/debug info, that's a problem
      if (acceptHeader.includes('text/html') && contentType.includes('text/html')) {
        // Check if HTML contains sensitive info
        const bodyStr = typeof result.responseBody === 'string' ? result.responseBody : '';
        if (/<pre>|<code>|stacktrace|debug/i.test(bodyStr)) {
          findings.push({
            id: findingId(),
            type: 'content_type_mismatch',
            severity: 'medium',
            title: 'HTML error page with debug info',
            description: 'Endpoint returned HTML page with potential debug/error information for HTML Accept header',
            evidence: { response: { contentType, body: this.truncateBody(result.responseBody, 200) } },
            recommendation: 'Ensure API endpoints return consistent JSON responses regardless of Accept header',
          });
        }
      }
    }

    // IDOR probe findings
    if (step.stepType === 'idor_probe') {
      // If we get 2xx with actual data for an ID we shouldn't have access to
      if (result.status >= 200 && result.status < 300 && result.responseBody) {
        const bodyStr = JSON.stringify(result.responseBody);
        // If body has actual data (not empty/null), potential IDOR
        if (bodyStr.length > 10 && bodyStr !== '{}' && bodyStr !== '[]' && bodyStr !== 'null') {
          findings.push({
            id: findingId(),
            type: 'idor_vulnerability',
            severity: this.capSeverityForProfile('high', executionProfile),
            title: 'Potential IDOR vulnerability',
            description: 'Endpoint returned data for a resource ID that may not belong to the current user',
            evidence: {
              request: step.request,
              response: { status: result.status, body: this.truncateBody(result.responseBody) },
            },
            recommendation: 'Implement proper authorization checks to verify resource ownership',
          });
        }
      }
    }

    // Rate limit probe findings
    if (step.stepType === 'rate_limit_probe_safe') {
      if (result.status !== 429) {
        // No rate limiting detected after burst
        findings.push({
          id: findingId(),
          type: 'rate_limit_issue',
          severity: this.capSeverityForProfile('medium', executionProfile),
          title: 'No rate limiting detected',
          description: 'Endpoint did not return 429 after multiple rapid requests',
          evidence: { response: { status: result.status } },
          recommendation: 'Implement rate limiting to prevent abuse and DDoS attacks',
        });
      } else {
        // Rate limiting works - check for Retry-After header
        const retryAfter = result.responseHeaders?.['retry-after'];
        if (!retryAfter) {
          findings.push({
            id: findingId(),
            type: 'rate_limit_issue',
            severity: this.capSeverityForProfile('low', executionProfile),
            title: 'Rate limit missing Retry-After header',
            description: 'Endpoint returns 429 but does not include Retry-After header',
            evidence: { response: { status: result.status, headers: result.responseHeaders } },
            recommendation: 'Add Retry-After header to 429 responses for better client experience',
          });
        }
      }
    }

    // Consistency check findings - use schema inference
    if (step.stepType === 'consistency_check' || step.stepType === 'schema_validation') {
      if (result.success && result.responseBody !== null) {
        try {
          // Infer schema from response
          const schema = SchemaConsistencyService.inferSchema(result.responseBody);

          // Store inferred schema in finding for future comparison
          findings.push({
            id: findingId(),
            type: 'capability_discovered',
            severity: 'info',
            title: 'Response schema inferred',
            description: `Response type: ${schema.type}${schema.fields ? `, fields: ${Object.keys(schema.fields).length}` : ''}${schema.arrayItemFields ? `, array item fields: ${Object.keys(schema.arrayItemFields).length}` : ''}`,
            evidence: { diff: { inferredSchema: schema } },
          });

          // Check for pagination patterns in list responses
          if (schema.type === 'object' && schema.fields) {
            const paginationFields = ['page', 'limit', 'offset', 'total', 'totalCount', 'next', 'prev', 'hasMore'];
            const foundPagination = Object.keys(schema.fields).filter(f =>
              paginationFields.some(pf => f.toLowerCase().includes(pf.toLowerCase()))
            );

            if (foundPagination.length > 0) {
              findings.push({
                id: findingId(),
                type: 'capability_discovered',
                severity: 'info',
                title: 'Pagination detected',
                description: `Response contains pagination fields: ${foundPagination.join(', ')}`,
                evidence: { diff: { paginationFields: foundPagination } },
              });
            }
          }
        } catch (schemaError) {
          logger.debug('[API_AGENT_STEP] Schema inference failed', {
            error: schemaError instanceof Error ? schemaError.message : String(schemaError),
          });
        }
      }
    }

    return findings;
  }

  /**
   * Execute an auth matrix step (multiple requests with different auth headers).
   * @param step - Planned step\n+   * @param stepId - Step ID\n+   * @param timestamp - Timestamp\n+   * @param chatSessionId - Optional chat session id\n+   * @param executionProfile - Execution profile\n+   * @param requestBudgetRemaining - Remaining request budget\n+   * @returns Step result\n+   */
  private static async executeAuthMatrixStep(
    step: ApiAgentPlannedStep,
    stepId: string,
    timestamp: string,
    chatSessionId: string | undefined,
    executionProfile: 'prod_readonly' | 'nonprod',
    requestBudgetRemaining: number
  ): Promise<ApiAgentStepResult> {
    const variants = [
      { name: 'No auth', headers: {} as Record<string, string> },
      { name: 'Empty Authorization', headers: { Authorization: '' } },
      { name: 'Malformed Bearer', headers: { Authorization: 'Bearer' } },
      { name: 'Invalid Bearer', headers: { Authorization: 'Bearer invalid_token_12345' } },
    ];

    const maxRequests = Math.min(variants.length, Math.max(0, requestBudgetRemaining));
    const toRun = variants.slice(0, maxRequests);

    const findings: ApiAgentFinding[] = [];
    let lastResult: any = null;
    let executed = 0;

    for (const v of toRun) {
      executed++;
      const mergedHeaders = { ...(step.request.headers || {}), ...v.headers };
      const result = await executeApiTest(
        {
          method: step.request.method,
          url: step.request.url,
          headers: mergedHeaders,
          body: step.request.body,
          timeout: DEFAULT_STEP_TIMEOUT,
        },
        chatSessionId
      );
      lastResult = result;

      const perRequestFindings = this.analyzeResponseForFindings(
        { ...step, request: { ...step.request, headers: mergedHeaders } },
        result,
        executionProfile
      );

      // If any bypass signal appears, keep it
      findings.push(
        ...perRequestFindings.map((f) => ({
          ...f,
          description: `[${v.name}] ${f.description}`,
        }))
      );
    }

    // If we could not run due to budget, report
    if (toRun.length === 0) {
      findings.push({
        id: `finding_${stepId}_budget`,
        type: 'consistency_error',
        severity: 'low',
        title: 'Auth matrix skipped (budget)',
        description: 'Auth matrix step skipped due to request budget limit',
      });
    }

    return {
      stepId,
      stepType: step.stepType,
      description: step.description,
      request: step.request,
      response: lastResult
        ? {
            status: lastResult.status,
            statusText: lastResult.statusText || '',
            headers: lastResult.responseHeaders || {},
            body: lastResult.responseBody,
            durationMs: lastResult.durationMs,
          }
        : null,
      success: lastResult?.success === true,
      error: lastResult?.error,
      findings,
      aiTokensUsed: 0,
      requestsExecuted: executed,
      timestamp,
    };
  }

  /**
   * Execute safe rate limit probing with a small burst of requests.
   * @param step - Planned step\n+   * @param stepId - Step ID\n+   * @param timestamp - Timestamp\n+   * @param chatSessionId - Optional chat session id\n+   * @param executionProfile - Execution profile\n+   * @param requestBudgetRemaining - Remaining request budget\n+   * @returns Step result\n+   */
  private static async executeRateLimitProbeStep(
    step: ApiAgentPlannedStep,
    stepId: string,
    timestamp: string,
    chatSessionId: string | undefined,
    executionProfile: 'prod_readonly' | 'nonprod',
    requestBudgetRemaining: number
  ): Promise<ApiAgentStepResult> {
    const targetCount = executionProfile === 'prod_readonly' ? 5 : 10;
    const count = Math.min(targetCount, Math.max(0, requestBudgetRemaining));

    const findings: ApiAgentFinding[] = [];
    let lastResult: any = null;
    let executed = 0;
    let got429 = false;

    for (let i = 0; i < count; i++) {
      executed++;
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
      lastResult = result;
      if (result.status === 429) {
        got429 = true;
        break; // Stop early once rate limited
      }

      // Add small delay to reduce load
      await this.sleep(executionProfile === 'prod_readonly' ? 250 : 100);
    }

    // Analyze last response as representative (detect 429 and retry-after)
    if (lastResult) {
      findings.push(...this.analyzeResponseForFindings(step, lastResult, executionProfile));
    }

    // If no 429 seen, create explicit finding (prod_readonly -> medium at most)
    if (!got429) {
      findings.push({
        id: `finding_${stepId}_no429`,
        type: 'rate_limit_issue',
        severity: this.capSeverityForProfile('medium', executionProfile),
        title: 'No rate limiting detected (safe probe)',
        description: `No 429 observed after ${executed} request(s). This is a suspected gap (not a confirmed exploit).`,
        recommendation: 'Consider adding rate limiting on sensitive endpoints',
      });
    }

    if (count === 0) {
      findings.push({
        id: `finding_${stepId}_budget`,
        type: 'rate_limit_issue',
        severity: 'low',
        title: 'Rate limit probe skipped (budget)',
        description: 'Rate limit probe skipped due to request budget limit',
      });
    }

    return {
      stepId,
      stepType: step.stepType,
      description: step.description,
      request: step.request,
      response: lastResult
        ? {
            status: lastResult.status,
            statusText: lastResult.statusText || '',
            headers: lastResult.responseHeaders || {},
            body: lastResult.responseBody,
            durationMs: lastResult.durationMs,
          }
        : null,
      success: lastResult?.success === true,
      error: lastResult?.error,
      findings,
      aiTokensUsed: 0,
      requestsExecuted: executed,
      timestamp,
    };
  }

  /**
   * Execute content negotiation checks (multiple Accept headers).
   * @param step - Planned step\n+   * @param stepId - Step ID\n+   * @param timestamp - Timestamp\n+   * @param chatSessionId - Optional chat session id\n+   * @param executionProfile - Execution profile\n+   * @param requestBudgetRemaining - Remaining request budget\n+   * @returns Step result\n+   */
  private static async executeContentNegotiationStep(
    step: ApiAgentPlannedStep,
    stepId: string,
    timestamp: string,
    chatSessionId: string | undefined,
    executionProfile: 'prod_readonly' | 'nonprod',
    requestBudgetRemaining: number
  ): Promise<ApiAgentStepResult> {
    const variants = [
      { name: 'Accept: application/json', accept: 'application/json' },
      { name: 'Accept: text/html', accept: 'text/html' },
      { name: 'Accept: */*', accept: '*/*' },
    ];

    const count = Math.min(variants.length, Math.max(0, requestBudgetRemaining));
    const toRun = variants.slice(0, count);

    const findings: ApiAgentFinding[] = [];
    let lastResult: any = null;
    let executed = 0;

    for (const v of toRun) {
      executed++;
      const headers = { ...(step.request.headers || {}), Accept: v.accept };
      const result = await executeApiTest(
        {
          method: step.request.method,
          url: step.request.url,
          headers,
          body: step.request.body,
          timeout: DEFAULT_STEP_TIMEOUT,
        },
        chatSessionId
      );
      lastResult = result;
      const per = this.analyzeResponseForFindings(
        { ...step, request: { ...step.request, headers } },
        result,
        executionProfile
      );
      findings.push(
        ...per.map((f) => ({
          ...f,
          description: `[${v.name}] ${f.description}`,
        }))
      );
    }

    if (toRun.length === 0) {
      findings.push({
        id: `finding_${stepId}_budget`,
        type: 'content_type_mismatch',
        severity: 'low',
        title: 'Content negotiation skipped (budget)',
        description: 'Content negotiation step skipped due to request budget limit',
      });
    }

    return {
      stepId,
      stepType: step.stepType,
      description: step.description,
      request: step.request,
      response: lastResult
        ? {
            status: lastResult.status,
            statusText: lastResult.statusText || '',
            headers: lastResult.responseHeaders || {},
            body: lastResult.responseBody,
            durationMs: lastResult.durationMs,
          }
        : null,
      success: lastResult?.success === true,
      error: lastResult?.error,
      findings,
      aiTokensUsed: 0,
      requestsExecuted: executed,
      timestamp,
    };
  }

  /**
   * Execute a safe IDOR probe with synthetic IDs (no enumeration/bruteforce).
   * @param step - Planned step\n+   * @param stepId - Step ID\n+   * @param timestamp - Timestamp\n+   * @param chatSessionId - Optional chat session id\n+   * @param executionProfile - Execution profile\n+   * @param requestBudgetRemaining - Remaining request budget\n+   * @returns Step result\n+   */
  private static async executeIdorProbeStep(
    step: ApiAgentPlannedStep,
    stepId: string,
    timestamp: string,
    chatSessionId: string | undefined,
    executionProfile: 'prod_readonly' | 'nonprod',
    requestBudgetRemaining: number
  ): Promise<ApiAgentStepResult> {
    const syntheticIds = [
      '00000000-0000-0000-0000-000000000000',
      '11111111-1111-1111-1111-111111111111',
      '99999999-9999-9999-9999-999999999999',
    ];

    const count = Math.min(syntheticIds.length, Math.max(0, requestBudgetRemaining));
    const ids = syntheticIds.slice(0, count);

    const findings: ApiAgentFinding[] = [];
    let lastResult: any = null;
    let executed = 0;

    for (const id of ids) {
      executed++;
      const url = this.injectPayloadInUrl(step.request.url, id, 'id');
      const result = await executeApiTest(
        {
          method: step.request.method,
          url,
          headers: step.request.headers,
          body: step.request.body,
          timeout: DEFAULT_STEP_TIMEOUT,
        },
        chatSessionId
      );
      lastResult = result;
      const per = this.analyzeResponseForFindings(
        { ...step, request: { ...step.request, url } },
        result,
        executionProfile
      );
      findings.push(...per);
    }

    if (ids.length === 0) {
      findings.push({
        id: `finding_${stepId}_budget`,
        type: 'idor_vulnerability',
        severity: 'low',
        title: 'IDOR probe skipped (budget)',
        description: 'IDOR probe step skipped due to request budget limit',
      });
    }

    return {
      stepId,
      stepType: step.stepType,
      description: step.description,
      request: step.request,
      response: lastResult
        ? {
            status: lastResult.status,
            statusText: lastResult.statusText || '',
            headers: lastResult.responseHeaders || {},
            body: lastResult.responseBody,
            durationMs: lastResult.durationMs,
          }
        : null,
      success: lastResult?.success === true,
      error: lastResult?.error,
      findings,
      aiTokensUsed: 0,
      requestsExecuted: executed,
      timestamp,
    };
  }

  /**
   * Inject a payload into URL query parameters.\n+   * @param url - Original URL\n+   * @param payload - Payload to inject\n+   * @param keyHint - Preferred query param key\n+   * @returns Modified URL\n+   */
  private static injectPayloadInUrl(url: string, payload: string, keyHint: string = 'q'): string {
    try {
      const urlObj = new URL(url);
      const firstParam = urlObj.searchParams.keys().next();
      const key = (!firstParam.done && firstParam.value) ? firstParam.value : keyHint;
      urlObj.searchParams.set(key, payload);
      return urlObj.toString();
    } catch {
      return `${url}${url.includes('?') ? '&' : '?'}${encodeURIComponent(keyHint)}=${encodeURIComponent(payload)}`;
    }
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
