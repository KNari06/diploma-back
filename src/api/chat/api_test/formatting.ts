import { logger } from '@/utils/core/logger';
import { CONSTANTS } from '../shared/constants';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: FORMAT API RESPONSE
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function formatApiResponse(
  apiTestResult: any,
  fuzzingReport: any,
  plan: any,
  apiDetails: any
): Promise<{ finalMessage: string; responseBodyDisplay: string }> {
  // ✅ FIX #12: Validate inputs to prevent null/undefined access
  if (!apiTestResult || typeof apiTestResult !== 'object') {
    throw new Error('Invalid apiTestResult');
  }

  if (!plan || typeof plan !== 'object' || !plan.url) {
    throw new Error('Invalid plan or missing plan.url');
  }

  if (!apiDetails || typeof apiDetails !== 'object') {
    throw new Error('Invalid apiDetails');
  }

  // Format response body
  let responseBodyDisplay = '';

  if (apiTestResult.responseBody) {
    if (typeof apiTestResult.responseBody === 'object') {
      // ✅ FIX #8: Safe JSON.stringify with circular reference handling
      try {
        responseBodyDisplay = '\n**Response Body:**\n```json\n' +
          JSON.stringify(apiTestResult.responseBody, getCircularReplacer(), 2) + '\n```';
      } catch (stringifyError) {
        logger.warn('[API_TEST] Failed to stringify response body', {
          error: stringifyError instanceof Error ? stringifyError.message : String(stringifyError),
        });
        responseBodyDisplay = '\n**Response Body:** [Object - too complex to display]\n';
      }
    } else if (typeof apiTestResult.responseBody === 'string' && apiTestResult.responseBody.length > 0) {
      try {
        const parsed = JSON.parse(apiTestResult.responseBody);
        responseBodyDisplay = '\n**Response Body:**\n```json\n' +
          JSON.stringify(parsed, getCircularReplacer(), 2) + '\n```';
      } catch {
        const truncated = apiTestResult.responseBody.length > 500
          ? apiTestResult.responseBody.substring(0, 500) + '...'
          : apiTestResult.responseBody;
        responseBodyDisplay = '\n**Response Body:**\n```\n' + truncated + '\n```';
      }
    }
  }

  let finalMessage = '';

  if (fuzzingReport) {
    const { ApiFuzzingFormatterService } = await import('@/services/testing/api/fuzzing/api-fuzzing-formatter.service');
    const fuzzingFormatted = ApiFuzzingFormatterService.formatComprehensiveReport(fuzzingReport);

    finalMessage = `✅ **API Test Results**\n` +
      `**Happy Path Test:** PASSED ✅\n` +
      `• URL: ${plan.url}\n` +
      `• Method: ${apiDetails.method || 'GET'}\n` +
      `• Status: ${apiTestResult.status || 'N/A'}\n` +
      `• Duration: ${apiTestResult.durationMs || 0}ms\n` +
      responseBodyDisplay + '\n' +
      '─────────────────────────────────────────────\n' +
      fuzzingFormatted;
  } else {
    finalMessage = `✅ API test executed successfully!

**URL:** ${plan.url}
**Method:** ${apiDetails.method || 'GET'}
**Status Code:** ${apiTestResult.status || 'N/A'}
**Success:** ${apiTestResult.success ? 'Yes' : 'No'}
**Duration:** ${apiTestResult.durationMs || 0}ms${responseBodyDisplay}`;
  }

  return { finalMessage, responseBodyDisplay };
}

/**
 * Helper to handle circular references in JSON.stringify
 */
export function getCircularReplacer() {
  const seen = new WeakSet();
  return (key: string, value: any) => {
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) {
        return '[Circular]';
      }
      seen.add(value);
    }
    return value;
  };
}

/**
 * Convert ApiTestPlan to unified TestPlan format
 * This allows API tests to use the same storage and execution flow as UI tests
 */
export function convertApiTestPlanToTestPlan(apiPlan: any): any {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + CONSTANTS.TEST_PLAN_EXPIRY_HOURS);

  return {
    id: apiPlan.id,
    status: 'pending_confirmation',
    url: apiPlan.url,
    scope: 'api_test', // Special scope for API tests
    summary: apiPlan.summary,
    steps: apiPlan.validation_steps.map((step: string, index: number) => ({
      id: `step_${index + 1}`,
      action: 'validate',
      description: step,
    })),
    commands: [], // No browser automation commands for API tests
    estimatedDuration: apiPlan.estimated_duration,
    whatWillBeTested: apiPlan.what_will_be_tested,
    whatWillNotBeTested: [], // Not provided in ApiTestPlan
    risks: apiPlan.potential_issues || [],
    createdAt: new Date().toISOString(),
    expiresAt: expiresAt.toISOString(),
    // Store API-specific data in metadata
    metadata: {
      type: 'api_test',
      method: apiPlan.method,
      headers: apiPlan.headers,
      body: apiPlan.body,
      expectedStatus: apiPlan.expected_status,
    },
  };
}
