import { logger } from '@/utils/core/logger';
import {
  ApiTestResponse,
  FuzzingScenario,
  FuzzingScenarioResult,
  FuzzingReport,
  SecurityIssue,
  IssueSeverity,
} from '@/types';
import { executeApiTest } from '../apiTest.service';
import { FUZZING_CONFIG } from './fuzzing-config';
import pLimit from 'p-limit';

/**
 * API Fuzzing Executor Service (REFACTORED)
 * FIX #1: Added AbortSignal support
 * FIX #2: Proper cleanup on timeout
 * FIX #3: Using centralized constants
 * FIX #4: Better error categorization
 * FIX #5: Progress reporting callback
 */
export class ApiFuzzingExecutorService {
  /**
   * Execute all fuzzing scenarios
   * @param scenarios - Array of fuzzing scenarios to execute
   * @param happyPathResult - Result from the original happy path test
   * @param abortSignal - Optional signal to abort execution
   * @param onProgress - Optional callback for progress updates
   * @returns Comprehensive fuzzing report
   */
  static async executeFuzzingScenarios(
    scenarios: FuzzingScenario[],
    happyPathResult: ApiTestResponse,
    abortSignal?: AbortSignal,
    onProgress?: (completed: number, total: number) => void
  ): Promise<FuzzingReport> {
    const startTime = Date.now();

    logger.info('[FUZZING_EXECUTOR] Starting fuzzing execution', {
      scenarioCount: scenarios.length,
      concurrencyLimit: FUZZING_CONFIG.MAX_CONCURRENT_REQUESTS,
      hasAbortSignal: !!abortSignal,
    });

    // FIX #1 & #2: Check abort signal before starting
    if (abortSignal?.aborted) {
      throw new Error('Fuzzing aborted before execution');
    }

    // Execute scenarios with concurrency limit + progress tracking
    let completed = 0;
    const limit = pLimit(FUZZING_CONFIG.MAX_CONCURRENT_REQUESTS);

    const scenarioPromises = scenarios.map(scenario =>
      limit(async () => {
        // FIX #2: Check abort signal before each scenario
        if (abortSignal?.aborted) {
          throw new Error('Fuzzing aborted');
        }

        const result = await this.executeScenario(scenario, abortSignal);

        // FIX #5: Report progress
        completed++;
        if (completed % FUZZING_CONFIG.PROGRESS_UPDATE_INTERVAL === 0 || completed === scenarios.length) {
          onProgress?.(completed, scenarios.length);
        }

        return result;
      })
    );

    // FIX #1: Race with abort signal
    const results = await Promise.race([
      Promise.allSettled(scenarioPromises),
      new Promise<never>((_, reject) => {
        if (abortSignal) {
          abortSignal.addEventListener('abort', () => {
            reject(new Error('Fuzzing aborted by timeout'));
          });
        }
      }),
    ]) as PromiseSettledResult<FuzzingScenarioResult>[];

    // Process results
    const scenarioResults: FuzzingScenarioResult[] = [];
    let passed = 0;
    let failed = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        scenarioResults.push(result.value);
        if (result.value.passed) {
          passed++;
        } else {
          failed++;
        }
      } else {
        // FIX #4: Better error categorization
        const errorType = this.categorizeErrorType(result.reason);

        logger.warn('[FUZZING_EXECUTOR] Scenario execution failed', {
          scenario: scenarios[index].id,
          errorType,
          error: result.reason?.message || String(result.reason),
        });

        scenarioResults.push({
          scenario: scenarios[index],
          result: {
            success: false,
            status: 0,
            durationMs: 0,
            responseHeaders: {},
            responseBody: null,
            error: `[${errorType}] ${result.reason?.message || 'Execution failed'}`,
            matchesExpected: false,
          },
          passed: false,
        });
        failed++;
      }
    });

    const duration = Date.now() - startTime;

    // Analyze results and identify issues
    const issues = this.analyzeResults(scenarioResults);

    // Calculate security score
    const securityScore = this.calculateSecurityScore(scenarioResults, issues);

    // Generate recommendations
    const recommendations = this.generateRecommendations(issues);

    const report: FuzzingReport = {
      happyPathResult,
      scenarios: scenarioResults,
      summary: {
        totalTests: scenarios.length,
        passed,
        failed,
        duration,
      },
      issues,
      securityScore,
      recommendations,
    };

    logger.info('[FUZZING_EXECUTOR] Fuzzing completed', {
      totalTests: scenarios.length,
      passed,
      failed,
      issuesFound: issues.length,
      securityScore,
      duration,
    });

    return report;
  }

  /**
   * Execute a single fuzzing scenario
   * FIX #2: Added abort signal support
   */
  private static async executeScenario(
    scenario: FuzzingScenario,
    abortSignal?: AbortSignal
  ): Promise<FuzzingScenarioResult> {
    try {
      // FIX #2: Check if aborted before execution
      if (abortSignal?.aborted) {
        throw new Error('Scenario aborted');
      }

      logger.debug('[FUZZING_EXECUTOR] Executing scenario', {
        id: scenario.id,
        type: scenario.type,
      });

      // FIX #3: Use centralized timeout
      const result = await executeApiTest({
        ...scenario.request,
        expectedStatus: scenario.expectedStatus,
        timeout: FUZZING_CONFIG.SCENARIO_TIMEOUT,
      });

      // Analyze if scenario passed (API behaved securely)
      const passed = this.evaluateScenario(scenario, result);

      // If failed, create security issue
      const issue = passed ? undefined : this.createSecurityIssue(scenario, result);

      return {
        scenario,
        result,
        passed,
        issue,
      };
    } catch (error) {
      logger.error('[FUZZING_EXECUTOR] Scenario execution error', {
        scenarioId: scenario.id,
        error,
      });

      return {
        scenario,
        result: {
          success: false,
          status: 0,
          durationMs: 0,
          responseHeaders: {},
          responseBody: null,
          error: error instanceof Error ? error.message : String(error),
          matchesExpected: false,
        },
        passed: false,
      };
    }
  }

  /**
   * Evaluate if scenario passed (API behaved securely)
   */
  private static evaluateScenario(
    scenario: FuzzingScenario,
    result: ApiTestResponse
  ): boolean {
    // For security tests, passing means getting the EXPECTED secure response
    // For example:
    // - Auth test expects 401 → if got 401, PASSED (API is secure)
    // - SQL injection expects 400 → if got 400, PASSED (input sanitized)

    // Check if status matches expected secure behavior
    if (result.status === scenario.expectedStatus) {
      return true;
    }

    // Special cases
    switch (scenario.type) {
      case 'authentication':
        // Accept 401 or 403 as secure
        return result.status === 401 || result.status === 403;

      case 'authorization':
        // Accept 403 or 401 as secure
        return result.status === 403 || result.status === 401;

      case 'security':
        // For security tests, NOT getting 200 with malicious payload is good
        // Accept 400, 401, 403, 422 as secure responses
        return [400, 401, 403, 422].includes(result.status);

      case 'method_validation':
        // Accept 405 or 404 as secure
        return result.status === 405 || result.status === 404;

      case 'payload_validation':
        // Accept 400, 422, 413 as secure
        return [400, 422, 413].includes(result.status);

      case 'rate_limiting':
        // Expect 429 if rate limiting exists, but its absence is medium severity
        return result.status === 429;

      case 'performance':
        // Check if completed without timeout
        return !result.error || !result.error.includes('timeout');

      default:
        return result.status === scenario.expectedStatus;
    }
  }

  /**
   * Create security issue from failed scenario
   */
  private static createSecurityIssue(
    scenario: FuzzingScenario,
    result: ApiTestResponse
  ): SecurityIssue {
    const severity = this.determineSeverity(scenario, result);

    let title = '';
    let description = '';
    let recommendation = '';

    switch (scenario.type) {
      case 'authentication':
        title = 'Missing Authentication';
        description = `Endpoint ${scenario.request.url} responded with ${result.status} instead of 401 Unauthorized when no authentication was provided.`;
        recommendation = 'Implement authentication middleware to verify JWT tokens or API keys before processing requests.';
        break;

      case 'authorization':
        title = 'Insufficient Authorization';
        description = `Endpoint allowed access with ${result.status} instead of 403 Forbidden. Users may access resources they shouldn't.`;
        recommendation = 'Implement role-based access control (RBAC) and verify user permissions before granting access.';
        break;

      case 'security':
        title = 'Security Vulnerability Detected';
        description = `Endpoint accepted potentially malicious input (${scenario.description}) and responded with ${result.status}. This may indicate ${this.identifyVulnerabilityType(scenario)}.`;
        recommendation = 'Implement input validation and sanitization. Use parameterized queries for databases, escape HTML output, and validate all user input.';
        break;

      case 'method_validation':
        title = 'HTTP Method Not Validated';
        description = `Endpoint accepted ${scenario.request.method} method with ${result.status} instead of 405 Method Not Allowed.`;
        recommendation = 'Configure web server or framework to only allow specific HTTP methods for each endpoint.';
        break;

      case 'payload_validation':
        title = 'Insufficient Input Validation';
        description = `Endpoint accepted malformed or invalid payload (${scenario.description}) with ${result.status}.`;
        recommendation = 'Implement strict input validation using schemas (e.g., Joi, Zod) and return 400 Bad Request for invalid input.';
        break;

      case 'rate_limiting':
        title = 'No Rate Limiting Detected';
        description = `Endpoint did not enforce rate limits. Multiple requests were not throttled (responded with ${result.status}).`;
        recommendation = 'Implement rate limiting using middleware (e.g., express-rate-limit) to prevent abuse and DDoS attacks.';
        break;

      case 'performance':
        title = 'Performance Issue';
        description = `Endpoint experienced performance issues: ${scenario.description}. Response: ${result.status}.`;
        recommendation = 'Optimize database queries, implement caching, and add timeouts to prevent resource exhaustion.';
        break;

      default:
        title = 'Security Test Failed';
        description = `Scenario "${scenario.description}" failed. Expected ${scenario.expectedStatus}, got ${result.status}.`;
        recommendation = 'Review and implement proper security controls for this endpoint.';
    }

    // Build detailed evidence with full request/response
    const evidenceParts = [
      '═══ REQUEST SENT ═══',
      `${scenario.request.method} ${scenario.request.url}`,
      '',
    ];

    // Add headers if present
    if (scenario.request.headers && Object.keys(scenario.request.headers).length > 0) {
      evidenceParts.push('Headers:');
      Object.entries(scenario.request.headers).forEach(([key, value]) => {
        evidenceParts.push(`  ${key}: ${value}`);
      });
      evidenceParts.push('');
    }

    // Add request body if present
    if (scenario.request.body) {
      evidenceParts.push('Body:');
      const bodyStr = typeof scenario.request.body === 'string'
        ? scenario.request.body
        : JSON.stringify(scenario.request.body, null, 2);
      evidenceParts.push(
        bodyStr.length > FUZZING_CONFIG.MAX_BODY_PREVIEW
          ? bodyStr.substring(0, FUZZING_CONFIG.MAX_BODY_PREVIEW) + '...'
          : bodyStr
      );
      evidenceParts.push('');
    }

    evidenceParts.push('═══ RESPONSE RECEIVED ═══');
    evidenceParts.push(`Status: ${result.status}`);
    evidenceParts.push(`Duration: ${result.durationMs}ms`);
    evidenceParts.push('');

    // Add response headers if present (limited)
    if (result.responseHeaders && Object.keys(result.responseHeaders).length > 0) {
      evidenceParts.push('Response Headers:');
      Object.entries(result.responseHeaders)
        .slice(0, FUZZING_CONFIG.MAX_HEADER_COUNT)
        .forEach(([key, value]) => {
          evidenceParts.push(`  ${key}: ${value}`);
        });
      evidenceParts.push('');
    }

    // Add response body (truncated if too long)
    if (result.responseBody) {
      evidenceParts.push('Response Body:');
      const bodyStr = typeof result.responseBody === 'string'
        ? result.responseBody
        : JSON.stringify(result.responseBody, null, 2);
      evidenceParts.push(
        bodyStr.length > FUZZING_CONFIG.MAX_BODY_PREVIEW
          ? bodyStr.substring(0, FUZZING_CONFIG.MAX_BODY_PREVIEW) + '...'
          : bodyStr
      );
    }

    // Add error if present
    if (result.error) {
      evidenceParts.push('');
      evidenceParts.push(`Error: ${result.error}`);
    }

    evidenceParts.push('');
    evidenceParts.push('═══ EXPECTED BEHAVIOR ═══');
    evidenceParts.push(`Expected Status: ${scenario.expectedStatus}`);
    evidenceParts.push(`Expected: ${scenario.expectedBehavior}`);
    evidenceParts.push(`Risk if Fails: ${scenario.riskIfFails}`);

    return {
      severity,
      type: scenario.type,
      title,
      description,
      evidence: evidenceParts.join('\n'),
      risk: scenario.riskIfFails,
      recommendation,
      cwe: this.getCWE(scenario.type),
    };
  }

  /**
   * Determine severity based on scenario and result
   */
  private static determineSeverity(
    scenario: FuzzingScenario,
    result: ApiTestResponse
  ): IssueSeverity {
    // Critical: Auth/security issues with 200 OK response
    if (
      ['authentication', 'security'].includes(scenario.type) &&
      result.status === 200
    ) {
      return 'critical';
    }

    // High: Authorization issues
    if (scenario.type === 'authorization' && result.status === 200) {
      return 'high';
    }

    // Medium: Missing rate limiting, method validation
    if (['rate_limiting', 'method_validation'].includes(scenario.type)) {
      return 'medium';
    }

    // Low: Payload validation issues
    if (scenario.type === 'payload_validation') {
      return 'low';
    }

    // Info: Performance issues
    if (scenario.type === 'performance') {
      return 'info';
    }

    return 'medium';
  }

  /**
   * Identify specific vulnerability type from scenario description
   */
  private static identifyVulnerabilityType(scenario: FuzzingScenario): string {
    const desc = scenario.description.toLowerCase();
    if (desc.includes('sql')) return 'SQL Injection vulnerability';
    if (desc.includes('xss')) return 'Cross-Site Scripting (XSS) vulnerability';
    if (desc.includes('path traversal')) return 'Path Traversal vulnerability';
    if (desc.includes('command injection')) return 'Command Injection vulnerability';
    return 'security vulnerability';
  }

  /**
   * Get CWE (Common Weakness Enumeration) ID for issue type
   */
  private static getCWE(type: string): string {
    const cweMap: Record<string, string> = {
      authentication: 'CWE-287', // Improper Authentication
      authorization: 'CWE-862', // Missing Authorization
      security: 'CWE-89', // SQL Injection (generic)
      method_validation: 'CWE-749', // Exposed Dangerous Method
      payload_validation: 'CWE-20', // Improper Input Validation
      rate_limiting: 'CWE-770', // Allocation of Resources Without Limits
    };
    return cweMap[type] || 'CWE-noinfo';
  }

  /**
   * Analyze all results and extract issues
   */
  private static analyzeResults(results: FuzzingScenarioResult[]): SecurityIssue[] {
    return results
      .filter(r => !r.passed && r.issue)
      .map(r => r.issue!)
      .sort((a, b) => {
        // Sort by severity: critical > high > medium > low > info
        const severityOrder: Record<IssueSeverity, number> = {
          critical: 0,
          high: 1,
          medium: 2,
          low: 3,
          info: 4,
        };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });
  }

  /**
   * Calculate security score (0-10) based on results
   */
  private static calculateSecurityScore(
    results: FuzzingScenarioResult[],
    issues: SecurityIssue[]
  ): number {
    const total = results.length;
    const passed = results.filter(r => r.passed).length;

    // Base score from passed tests
    let score = (passed / total) * 10;

    // Deduct points for critical issues
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    const highCount = issues.filter(i => i.severity === 'high').length;

    score -= criticalCount * 2; // -2 points per critical
    score -= highCount * 1; // -1 point per high

    // Minimum score is 0
    return Math.max(0, Math.round(score * 10) / 10);
  }

  /**
   * FIX #4: Categorize error types for better debugging
   */
  private static categorizeErrorType(error: any): string {
    if (!error) return 'unknown';

    const errorMsg = error.message || String(error);

    if (error.name === 'AbortError' || errorMsg.includes('aborted')) return 'aborted';
    if (error.name === 'TimeoutError' || errorMsg.includes('timeout')) return 'timeout';
    if (error.code === 'ENOTFOUND' || errorMsg.includes('getaddrinfo')) return 'dns_error';
    if (error.code === 'ECONNREFUSED') return 'connection_refused';
    if (errorMsg.includes('SSL') || errorMsg.includes('certificate')) return 'ssl_error';
    if (errorMsg.includes('network')) return 'network_error';

    return 'execution_error';
  }

  /**
   * Generate recommendations based on issues
   */
  private static generateRecommendations(issues: SecurityIssue[]): string[] {
    const recommendations: string[] = [];

    // Group by type
    const byType = issues.reduce((acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    // Generate specific recommendations
    if (byType.authentication) {
      recommendations.push(
        'Implement JWT or API key authentication for all endpoints'
      );
    }

    if (byType.authorization) {
      recommendations.push(
        'Add role-based access control (RBAC) and verify user permissions'
      );
    }

    if (byType.security) {
      recommendations.push(
        'Add input validation and sanitization using express-validator or Joi'
      );
      recommendations.push(
        'Use parameterized queries or ORM to prevent SQL injection'
      );
    }

    if (byType.rate_limiting) {
      recommendations.push(
        'Implement rate limiting with express-rate-limit middleware'
      );
    }

    if (byType.method_validation) {
      recommendations.push(
        'Configure allowed HTTP methods for each route in Express/framework'
      );
    }

    if (byType.payload_validation) {
      recommendations.push(
        'Add request body validation schemas and reject invalid payloads with 400'
      );
    }

    return recommendations;
  }
}
