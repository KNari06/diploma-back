import { ApiTestRequest, ApiTestResponse } from '@/types';
import { logger } from '@/utils/logger';
import { executeApiTest } from './apiTest.service';

/**
 * API Test Scenario - represents a single test case
 */
export interface ApiTestScenario {
  name: string;
  description: string;
  request: ApiTestRequest;
  expectedOutcome: string;
}

/**
 * API Test Suite - collection of scenarios for comprehensive testing
 */
export interface ApiTestSuite {
  route: string;
  method: string;
  scenarios: ApiTestScenario[];
  totalScenarios: number;
}

/**
 * API Test Execution Result
 */
export interface ApiTestExecutionResult {
  scenario: ApiTestScenario;
  result: ApiTestResponse;
  passed: boolean;
  executedAt: Date;
}

/**
 * API Test Suite Results
 */
export interface ApiTestSuiteResults {
  suite: ApiTestSuite;
  results: ApiTestExecutionResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    successRate: number;
  };
  executedAt: Date;
  durationMs: number;
}

/**
 * Generate comprehensive API test scenarios for a given route
 * This function creates various test cases that a QA engineer would typically run
 */
export function generateApiTestScenarios(
  route: string,
  method: string = 'GET',
  baseUrl?: string
): ApiTestSuite {
  const fullUrl = baseUrl ? `${baseUrl}${route}` : route;
  const scenarios: ApiTestScenario[] = [];

  // Normalize method
  const httpMethod = method.toUpperCase();

  // 1. Happy Path - Basic successful request
  scenarios.push({
    name: 'Happy Path',
    description: `Successful ${httpMethod} request to ${route}`,
    request: {
      method: httpMethod,
      url: fullUrl,
      expectedStatus: 200,
      timeout: 10000,
    },
    expectedOutcome: 'Should return 200 OK with valid response data',
  });

  // 2. Response Time Test
  scenarios.push({
    name: 'Response Time',
    description: `Check if ${route} responds within acceptable time`,
    request: {
      method: httpMethod,
      url: fullUrl,
      expectedStatus: 200,
      timeout: 5000, // Stricter timeout
    },
    expectedOutcome: 'Should respond within 5 seconds',
  });

  // 3. Headers Test
  scenarios.push({
    name: 'Headers Validation',
    description: `Test ${route} with various headers`,
    request: {
      method: httpMethod,
      url: fullUrl,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'QAIT-Test-Agent/1.0',
        'X-Test-Header': 'test-value',
      },
      expectedStatus: 200,
    },
    expectedOutcome: 'Should handle custom headers correctly',
  });

  // Method-specific scenarios
  if (httpMethod === 'GET') {
    // Query parameters test
    scenarios.push({
      name: 'Query Parameters',
      description: `Test ${route} with query parameters`,
      request: {
        method: 'GET',
        url: `${fullUrl}?limit=10&offset=0&sort=created_at`,
        expectedStatus: 200,
      },
      expectedOutcome: 'Should handle query parameters correctly',
    });

    // Large response test
    scenarios.push({
      name: 'Large Response',
      description: `Test ${route} with parameters that might return large response`,
      request: {
        method: 'GET',
        url: `${fullUrl}?limit=1000`,
        expectedStatus: 200,
        timeout: 15000,
      },
      expectedOutcome: 'Should handle large responses without timeout',
    });
  }

  if (['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
    // Valid JSON body
    scenarios.push({
      name: 'Valid JSON Body',
      description: `Test ${route} with valid JSON payload`,
      request: {
        method: httpMethod,
        url: fullUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          name: 'Test Item',
          description: 'Test description',
          active: true,
        },
        expectedStatus: httpMethod === 'POST' ? 201 : 200,
      },
      expectedOutcome: `Should accept valid JSON and return ${httpMethod === 'POST' ? '201 Created' : '200 OK'}`,
    });

    // Empty body test
    scenarios.push({
      name: 'Empty Body',
      description: `Test ${route} with empty body`,
      request: {
        method: httpMethod,
        url: fullUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        body: {},
        expectedStatus: 400,
      },
      expectedOutcome: 'Should return 400 Bad Request for empty body',
    });

    // Invalid JSON test
    scenarios.push({
      name: 'Invalid JSON',
      description: `Test ${route} with malformed JSON`,
      request: {
        method: httpMethod,
        url: fullUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        body: '{"invalid": json}', // Malformed JSON
        expectedStatus: 400,
      },
      expectedOutcome: 'Should return 400 Bad Request for invalid JSON',
    });

    // Large payload test
    scenarios.push({
      name: 'Large Payload',
      description: `Test ${route} with large JSON payload`,
      request: {
        method: httpMethod,
        url: fullUrl,
        headers: {
          'Content-Type': 'application/json',
        },
        body: {
          name: 'Test Item',
          description: 'A'.repeat(10000), // Large description
          data: Array.from({ length: 100 }, (_, i) => ({ id: i, value: `item-${i}` })),
        },
        expectedStatus: httpMethod === 'POST' ? 201 : 200,
        timeout: 15000,
      },
      expectedOutcome: 'Should handle large payloads correctly',
    });
  }

  if (httpMethod === 'DELETE') {
    // Delete existing resource
    scenarios.push({
      name: 'Delete Existing',
      description: `Test deleting existing resource at ${route}`,
      request: {
        method: 'DELETE',
        url: fullUrl,
        expectedStatus: 200,
      },
      expectedOutcome: 'Should return 200 OK when deleting existing resource',
    });

    // Delete non-existent resource
    scenarios.push({
      name: 'Delete Non-existent',
      description: `Test deleting non-existent resource`,
      request: {
        method: 'DELETE',
        url: `${fullUrl}/non-existent-id`,
        expectedStatus: 404,
      },
      expectedOutcome: 'Should return 404 Not Found for non-existent resource',
    });
  }

  // Error scenarios (common for all methods)
  scenarios.push(
    {
      name: 'Invalid URL',
      description: `Test with invalid URL path`,
      request: {
        method: httpMethod,
        url: `${fullUrl}/invalid-path-that-should-not-exist`,
        expectedStatus: 404,
      },
      expectedOutcome: 'Should return 404 Not Found for invalid paths',
    },
    {
      name: 'Unsupported Method',
      description: `Test with unsupported HTTP method`,
      request: {
        method: 'TRACE', // Usually unsupported
        url: fullUrl,
        expectedStatus: 405,
      },
      expectedOutcome: 'Should return 405 Method Not Allowed',
    },
    {
      name: 'Missing Content-Type',
      description: `Test ${httpMethod} without Content-Type header`,
      request: {
        method: httpMethod,
        url: fullUrl,
        headers: {}, // No Content-Type
        body: ['POST', 'PUT', 'PATCH'].includes(httpMethod) ? { test: 'data' } : undefined,
        expectedStatus: ['POST', 'PUT', 'PATCH'].includes(httpMethod) ? 400 : 200,
      },
      expectedOutcome: ['POST', 'PUT', 'PATCH'].includes(httpMethod)
        ? 'Should return 400 Bad Request without Content-Type'
        : 'Should work normally for GET/DELETE',
    }
  );

  return {
    route,
    method: httpMethod,
    scenarios,
    totalScenarios: scenarios.length,
  };
}

/**
 * Execute a complete API test suite
 */
export async function executeApiTestSuite(
  suite: ApiTestSuite,
  options?: {
    parallel?: boolean;
    stopOnFirstFailure?: boolean;
    maxConcurrency?: number;
  }
): Promise<ApiTestSuiteResults> {
  const startTime = Date.now();
  const results: ApiTestExecutionResult[] = [];

  logger.info('Starting API test suite execution', {
    route: suite.route,
    method: suite.method,
    totalScenarios: suite.totalScenarios,
    parallel: options?.parallel || false,
  });

  try {
    if (options?.parallel) {
      // Execute scenarios in parallel
      const maxConcurrency = options.maxConcurrency || 5;
      const chunks = [];

      for (let i = 0; i < suite.scenarios.length; i += maxConcurrency) {
        chunks.push(suite.scenarios.slice(i, i + maxConcurrency));
      }

      for (const chunk of chunks) {
        const chunkPromises = chunk.map(async (scenario) => {
          const result = await executeApiTest(scenario.request);
          const passed = scenario.request.expectedStatus
            ? result.status === scenario.request.expectedStatus
            : result.success;

          return {
            scenario,
            result,
            passed,
            executedAt: new Date(),
          };
        });

        // Use Promise.allSettled to handle individual failures gracefully
        const chunkResults = await Promise.allSettled(chunkPromises);
        const successfulResults = chunkResults
          .filter((result): result is PromiseFulfilledResult<any> => result.status === 'fulfilled')
          .map(result => result.value);

        const failedResults = chunkResults
          .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
          .map((result, index) => ({
            scenario: chunk[index],
            result: {
              success: false,
              status: 0,
              durationMs: 0,
              responseHeaders: {},
              responseBody: null,
              error: result.reason instanceof Error ? result.reason.message : String(result.reason),
              matchesExpected: false,
            },
            passed: false,
            executedAt: new Date(),
          }));

        results.push(...successfulResults, ...failedResults);

        // Stop on first failure if requested
        if (options?.stopOnFirstFailure && failedResults.length > 0) {
          logger.info('Stopping test suite execution due to failure');
          break;
        }
      }
    } else {
      // Execute scenarios sequentially
      for (const scenario of suite.scenarios) {
        const result = await executeApiTest(scenario.request);
        const passed = scenario.request.expectedStatus
          ? result.status === scenario.request.expectedStatus
          : result.success;

        const executionResult: ApiTestExecutionResult = {
          scenario,
          result,
          passed,
          executedAt: new Date(),
        };

        results.push(executionResult);

        logger.info('API test scenario completed', {
          name: scenario.name,
          passed,
          status: result.status,
          durationMs: result.durationMs,
        });

        // Stop on first failure if requested
        if (options?.stopOnFirstFailure && !passed) {
          logger.info('Stopping test suite execution due to failure');
          break;
        }
      }
    }

    const durationMs = Date.now() - startTime;
    const passed = results.filter(r => r.passed).length;
    const failed = results.length - passed;
    const successRate = results.length > 0 ? (passed / results.length) * 100 : 0;

    const suiteResults: ApiTestSuiteResults = {
      suite,
      results,
      summary: {
        total: results.length,
        passed,
        failed,
        successRate: Math.round(successRate * 100) / 100,
      },
      executedAt: new Date(),
      durationMs,
    };

    logger.info('API test suite completed', {
      route: suite.route,
      total: results.length,
      passed,
      failed,
      successRate: suiteResults.summary.successRate,
      durationMs,
    });

    return suiteResults;
  } catch (error) {
    logger.error('API test suite execution failed', { error, route: suite.route });
    throw error;
  }
}

/**
 * Generate a human-readable summary of test results
 */
export function formatApiTestResults(results: ApiTestSuiteResults): string {
  const { suite, summary, durationMs } = results;

  let report = `🧪 **API Test Results for ${suite.method} ${suite.route}**\n\n`;

  // Summary
  report += `📊 **Summary:**\n`;
  report += `- Total Tests: ${summary.total}\n`;
  report += `- ✅ Passed: ${summary.passed}\n`;
  report += `- ❌ Failed: ${summary.failed}\n`;
  report += `- 📈 Success Rate: ${summary.successRate}%\n`;
  report += `- ⏱️ Duration: ${durationMs}ms\n\n`;

  // Detailed results
  report += `📋 **Detailed Results:**\n\n`;

  results.results.forEach((result, index) => {
    const { scenario, result: apiResult, passed } = result;
    const status = passed ? '✅' : '❌';

    report += `${index + 1}. ${status} **${scenario.name}**\n`;
    report += `   - Status: ${apiResult.status} ${apiResult.statusText || ''}\n`;
    report += `   - Duration: ${apiResult.durationMs}ms\n`;
    report += `   - Expected: ${scenario.expectedOutcome}\n`;

    if (!passed) {
      report += `   - ⚠️ Issue: ${apiResult.error || 'Status code mismatch'}\n`;
    }

    report += '\n';
  });

  // Recommendations
  if (summary.failed > 0) {
    report += `🔧 **Recommendations:**\n`;

    const failedResults = results.results.filter(r => !r.passed);
    const commonIssues = new Map<string, number>();

    failedResults.forEach(result => {
      const issue = result.result.error || `Status ${result.result.status}`;
      commonIssues.set(issue, (commonIssues.get(issue) || 0) + 1);
    });

    commonIssues.forEach((count, issue) => {
      report += `- Fix "${issue}" (affects ${count} test${count > 1 ? 's' : ''})\n`;
    });
  }

  return report;
}
