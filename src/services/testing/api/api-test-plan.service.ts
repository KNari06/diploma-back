import { buildApiTestPlanPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { logger } from '@/utils/logger';
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
   * Format test plan for user confirmation
   */
  static formatApiTestPlanForConfirmation(plan: ApiTestPlan): string {
    let formatted = `📋 **API Test Plan**\n\n`;
    formatted += `**Summary:** ${plan.summary}\n\n`;
    formatted += `**Request Details:**\n`;
    formatted += `• Method: \`${plan.method}\`\n`;
    formatted += `• URL: \`${plan.url}\`\n`;
    formatted += `• Expected Status: ${plan.expected_status}\n\n`;

    // Headers
    if (Object.keys(plan.headers).length > 0) {
      formatted += `**Headers:**\n`;
      formatted += '```json\n';
      formatted += JSON.stringify(plan.headers, null, 2);
      formatted += '\n```\n\n';
    }

    // Body
    if (plan.body) {
      formatted += `**Request Body:**\n`;
      formatted += '```json\n';
      formatted += JSON.stringify(plan.body, null, 2);
      formatted += '\n```\n\n';
    }

    // Validation steps
    if (plan.validation_steps.length > 0) {
      formatted += `**Validation Steps:**\n`;
      plan.validation_steps.forEach((step, i) => {
        formatted += `${i + 1}. ${step}\n`;
      });
      formatted += '\n';
    }

    // What will be tested
    if (plan.what_will_be_tested.length > 0) {
      formatted += `**What Will Be Tested:**\n`;
      plan.what_will_be_tested.forEach(item => {
        formatted += `✓ ${item}\n`;
      });
      formatted += '\n';
    }

    // Potential issues
    if (plan.potential_issues.length > 0) {
      formatted += `**Potential Issues:**\n`;
      plan.potential_issues.forEach(issue => {
        formatted += `⚠️ ${issue}\n`;
      });
      formatted += '\n';
    }

    formatted += `**Estimated Duration:** ${plan.estimated_duration}\n\n`;
    formatted += `─────────────────────────────────\n\n`;
    formatted += `Let me know if you'd like to proceed with this test plan, or if you want me to adjust anything.\n`;

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
