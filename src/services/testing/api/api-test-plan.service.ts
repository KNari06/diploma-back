import { buildApiTestPlanPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { logger } from '@/utils/core/logger';
import { randomUUID } from 'crypto';

/**
 * API Test Plan interface
 */
export interface ApiTestPlan {
  id: string;
  summary: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: any;
  expected_status: number;
  validation_steps: string[];
  what_will_be_tested: string[];
  potential_issues: string[];
  estimated_duration: string;
}

/**
 * API Test Plan Service
 * Generates detailed test plans for API requests
 */
export class ApiTestPlanService {
  /**
   * Generate comprehensive API test plan
   */
  static async generateApiTestPlan(params: {
    method: string;
    url: string;
    body?: any;
    headers?: Record<string, string>;
    userMessage: string;
  }): Promise<ApiTestPlan> {
    try {
      logger.info('[API_TEST_PLAN] Generating test plan', {
        method: params.method,
        url: params.url,
      });

      // Use centralized prompt
      const prompt = buildApiTestPlanPrompt(params);

      // Get test plan from GPT
      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: 'You are an API testing expert. Generate detailed API test plans in JSON format.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          temperature: 0.3,
          response_format: { type: 'json_object' },
        }
      );

      const testPlan = JSON.parse(response.content);

      // Validate and normalize
      // IMPORTANT: Use UUID format for compatibility with test plan lookup
      const normalized: ApiTestPlan = {
        id: randomUUID(), // Use UUID instead of timestamp-based ID
        summary: testPlan.summary || `API Test: ${params.method} ${params.url}`,
        method: params.method,
        url: params.url,
        headers: params.headers || testPlan.headers || {},
        body: params.body || testPlan.body,
        expected_status: testPlan.expected_status || this.inferExpectedStatus(params.method),
        validation_steps: testPlan.validation_steps || [],
        what_will_be_tested: testPlan.what_will_be_tested || [],
        potential_issues: testPlan.potential_issues || [],
        estimated_duration: testPlan.estimated_duration || '< 5 seconds',
      };

      logger.info('[API_TEST_PLAN] Test plan generated', {
        planId: normalized.id,
        validationSteps: normalized.validation_steps.length,
      });

      return normalized;
    } catch (error) {
      logger.error('[API_TEST_PLAN] Error generating test plan', { error });

      // Fallback: create basic test plan
      return this.createFallbackTestPlan(params);
    }
  }


  /**
   * Infer expected status code based on HTTP method
   */
  private static inferExpectedStatus(method: string): number {
    switch (method.toUpperCase()) {
      case 'GET':
        return 200;
      case 'POST':
        return 201;
      case 'PUT':
      case 'PATCH':
        return 200;
      case 'DELETE':
        return 204;
      default:
        return 200;
    }
  }

  /**
   * Create fallback test plan if GPT fails
   */
  private static createFallbackTestPlan(params: {
    method: string;
    url: string;
    body?: any;
    headers?: Record<string, string>;
  }): ApiTestPlan {
    const expectedStatus = this.inferExpectedStatus(params.method);

    return {
      id: `api_test_${Date.now()}`,
      summary: `${params.method} request to ${params.url}`,
      method: params.method,
      url: params.url,
      headers: params.headers || {
        'Content-Type': 'application/json',
      },
      body: params.body,
      expected_status: expectedStatus,
      validation_steps: [
        `Verify response status code is ${expectedStatus}`,
        'Verify response is valid JSON',
        'Verify response time is under 5 seconds',
      ],
      what_will_be_tested: [
        'API endpoint availability',
        'Response status code',
        'Response format',
      ],
      potential_issues: [
        'Authentication might be required',
        'CORS might block request',
        'Rate limiting might apply',
      ],
      estimated_duration: '< 5 seconds',
    };
  }

  /**
   * Format test plan for user confirmation (compact version)
   */
  static formatApiTestPlanForConfirmation(plan: ApiTestPlan): string {
    let formatted = `📋 **API Test Plan**\n\n`;
    formatted += `${plan.summary}\n\n`;

    // Request details (compact)
    formatted += `**Request:** \`${plan.method}\` ${plan.url}\n`;
    formatted += `**Expected Status:** ${plan.expected_status}\n`;

    // ✅ FIX: Check for authentication requirements
    const authHeaders = ['authorization', 'bearer', 'x-api-key', 'x-auth-token', 'api-key'];
    const hasAuth = Object.keys(plan.headers).some(key =>
      authHeaders.some(auth => key.toLowerCase().includes(auth))
    );
    const needsAuth = plan.potential_issues.some(issue =>
      issue.toLowerCase().includes('401') ||
      issue.toLowerCase().includes('403') ||
      issue.toLowerCase().includes('authentication') ||
      issue.toLowerCase().includes('authorization')
    );

    if (hasAuth) {
      formatted += `🔐 **Auth:** Required (included in headers)\n`;
    } else if (needsAuth) {
      formatted += `⚠️ **Auth:** May be required (401/403 possible)\n`;
    }

    // Headers (only if non-standard and not auth)
    const standardHeaders = ['Content-Type'];
    const hasNonStandardHeaders = Object.keys(plan.headers).some(
      key => !standardHeaders.includes(key) &&
      !authHeaders.some(auth => key.toLowerCase().includes(auth)) &&
      (key === 'Content-Type' && plan.headers[key] !== 'application/json')
    );
    if (hasNonStandardHeaders && Object.keys(plan.headers).length > 0) {
      formatted += `**Headers:** ${JSON.stringify(plan.headers)}\n`;
    }

    // Body (only if present, show size for large bodies)
    if (plan.body && Object.keys(plan.body).length > 0) {
      const bodyStr = JSON.stringify(plan.body);
      if (bodyStr.length > 100) {
        formatted += `**Body:** ${bodyStr.substring(0, 80)}... (${bodyStr.length} chars)\n`;
      } else {
        formatted += `**Body:** ${bodyStr}\n`;
      }
    }

    // ✅ FIX: Show important method-specific info
    if (plan.method.toUpperCase() === 'POST' || plan.method.toUpperCase() === 'PUT' || plan.method.toUpperCase() === 'PATCH') {
      const hasBody = plan.body && Object.keys(plan.body).length > 0;
      if (!hasBody) {
        formatted += `⚠️ **Note:** ${plan.method} request without body\n`;
      }
    }

    formatted += `**Duration:** ${plan.estimated_duration}\n`;

    // What will be tested (compact - max 3 items)
    if (plan.what_will_be_tested.length > 0) {
      const items = plan.what_will_be_tested.slice(0, 3);
      formatted += `**Tests:** ${items.join(', ')}`;
      if (plan.what_will_be_tested.length > 3) {
        formatted += ` (+${plan.what_will_be_tested.length - 3} more)`;
      }
      formatted += '\n';
    }

    // ✅ FIX: Show critical risks (auth, CORS, rate limit)
    if (plan.potential_issues.length > 0) {
      const criticalIssues = plan.potential_issues
        .filter(issue => {
          const lower = issue.toLowerCase();
          return lower.includes('401') ||
                 lower.includes('403') ||
                 lower.includes('500') ||
                 lower.includes('timeout') ||
                 lower.includes('cors') ||
                 lower.includes('rate limit') ||
                 lower.includes('429');
        })
        .slice(0, 3); // Show up to 3 critical issues

      if (criticalIssues.length > 0) {
        formatted += `**Risks:** ${criticalIssues.join(' • ')}`;
        if (plan.potential_issues.length > criticalIssues.length) {
          formatted += ` (+${plan.potential_issues.length - criticalIssues.length} more)`;
        }
        formatted += '\n';
      }
    }

    formatted += `\n---\n`;
    formatted += `If this looks good, just reply and I'll start testing. If you want to change something, let me know.\n`;

    return formatted;
  }

  /**
   * Save API test plan to database
   */
  static async saveApiTestPlan(
    plan: ApiTestPlan,
    userId: string,
    projectId: string
  ): Promise<boolean> {
    try {
      // Note: API test plans are stored differently from UI test plans
      // They're stored in api_test_configs table

      logger.info('[API_TEST_PLAN] Test plan generated (not stored in DB yet)', {
        planId: plan.id,
        userId,
        projectId,
      });

      // For now, we don't store API test plans separately
      // They're executed immediately after approval

      return true;
    } catch (error) {
      logger.error('[API_TEST_PLAN] Error saving test plan', { error });
      return false;
    }
  }
}
