import { logger } from '@/utils/logger';
import { ApiTestRequest, ApiTestResponse, FuzzingScenario } from '@/types';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { buildApiFuzzingPrompt } from '@/ai/prompts';

/**
 * Intelligent API Fuzzer Service
 * Generates negative test scenarios using GPT to find vulnerabilities
 */
export class IntelligentApiFuzzerService {
  /**
   * Generate fuzzing scenarios for an API endpoint
   * @param baseRequest - The original API request that passed
   * @param happyPathResult - Result from the successful test
   * @returns Array of fuzzing scenarios to execute
   */
  static async generateFuzzingScenarios(
    baseRequest: ApiTestRequest,
    happyPathResult: ApiTestResponse
  ): Promise<FuzzingScenario[]> {
    try {
      logger.info('[API_FUZZER] Generating fuzzing scenarios', {
        method: baseRequest.method,
        url: baseRequest.url,
        happyPathStatus: happyPathResult.status,
      });

      // Build prompt for GPT
      const prompt = buildApiFuzzingPrompt({
        method: baseRequest.method,
        url: baseRequest.url,
        headers: baseRequest.headers,
        body: baseRequest.body,
        happyPathResult: {
          status: happyPathResult.status,
          durationMs: happyPathResult.durationMs,
          responseBody: happyPathResult.responseBody,
        },
      });

      // Get scenarios from GPT
      const response = await getChatCompletionWithMessages(
        [
          {
            role: 'system',
            content: 'You are a security testing expert. Generate comprehensive fuzzing scenarios in JSON format.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        {
          temperature: 0.7, // Bit higher for creativity
          response_format: { type: 'json_object' },
        }
      );

      const parsed = JSON.parse(response.content);

      if (!parsed.scenarios || !Array.isArray(parsed.scenarios)) {
        logger.warn('[API_FUZZER] Invalid response format from GPT', { parsed });
        return this.createFallbackScenarios(baseRequest);
      }

      // Normalize scenarios
      const scenarios: FuzzingScenario[] = parsed.scenarios.map((s: any, index: number) => ({
        id: s.id || `scenario_${index + 1}`,
        type: s.type || 'security',
        description: s.description || 'Security test',
        request: {
          method: s.request?.method || baseRequest.method,
          url: s.request?.url || baseRequest.url,
          headers: s.request?.headers || {},
          body: s.request?.body,
        },
        expectedStatus: s.expectedStatus || 400,
        expectedBehavior: s.expectedBehavior || 'Should handle securely',
        riskIfFails: s.riskIfFails || 'Security vulnerability',
      }));

      logger.info('[API_FUZZER] Generated fuzzing scenarios', {
        count: scenarios.length,
        types: this.countByType(scenarios),
      });

      return scenarios;
    } catch (error) {
      logger.error('[API_FUZZER] Error generating fuzzing scenarios', { error });
      // Fallback to basic scenarios
      return this.createFallbackScenarios(baseRequest);
    }
  }

  /**
   * Create basic fallback scenarios if GPT fails
   */
  private static createFallbackScenarios(baseRequest: ApiTestRequest): FuzzingScenario[] {
    const scenarios: FuzzingScenario[] = [];

    // 1. Authentication test - no auth
    scenarios.push({
      id: 'auth_no_token',
      type: 'authentication',
      description: 'Request without Authorization header',
      request: {
        method: baseRequest.method,
        url: baseRequest.url,
        headers: {}, // No auth
        body: baseRequest.body,
      },
      expectedStatus: 401,
      expectedBehavior: 'Should return 401 Unauthorized',
      riskIfFails: 'Unauthenticated users can access protected resources',
    });

    // 2. Method validation - wrong method
    scenarios.push({
      id: 'method_wrong',
      type: 'method_validation',
      description: `POST request on ${baseRequest.method} endpoint`,
      request: {
        method: baseRequest.method === 'GET' ? 'POST' : 'GET',
        url: baseRequest.url,
        headers: baseRequest.headers,
        body: baseRequest.body,
      },
      expectedStatus: 405,
      expectedBehavior: 'Should return 405 Method Not Allowed',
      riskIfFails: 'API does not validate HTTP methods properly',
    });

    // 3. SQL Injection
    const sqlInjectionUrl = this.injectSqlPayload(baseRequest.url);
    scenarios.push({
      id: 'security_sql_injection',
      type: 'security',
      description: 'SQL injection in URL parameters',
      request: {
        method: baseRequest.method,
        url: sqlInjectionUrl,
        headers: baseRequest.headers,
        body: baseRequest.body,
      },
      expectedStatus: 400,
      expectedBehavior: 'Should sanitize input and return 400 or safe response',
      riskIfFails: 'Database can be compromised via SQL injection',
    });

    // 4. XSS Attack
    const xssUrl = this.injectXssPayload(baseRequest.url);
    scenarios.push({
      id: 'security_xss',
      type: 'security',
      description: 'XSS injection in URL parameters',
      request: {
        method: baseRequest.method,
        url: xssUrl,
        headers: baseRequest.headers,
        body: baseRequest.body,
      },
      expectedStatus: 400,
      expectedBehavior: 'Should escape HTML and return safe response',
      riskIfFails: 'Users vulnerable to cross-site scripting attacks',
    });

    // 5. Malformed JSON (for POST/PUT)
    if (['POST', 'PUT', 'PATCH'].includes(baseRequest.method.toUpperCase())) {
      scenarios.push({
        id: 'payload_malformed_json',
        type: 'payload_validation',
        description: 'Malformed JSON body',
        request: {
          method: baseRequest.method,
          url: baseRequest.url,
          headers: baseRequest.headers,
          body: '{invalid json,,,',
        },
        expectedStatus: 400,
        expectedBehavior: 'Should return 400 Bad Request',
        riskIfFails: 'API does not validate request format',
      });
    }

    logger.info('[API_FUZZER] Created fallback scenarios', { count: scenarios.length });
    return scenarios;
  }

  /**
   * Inject SQL injection payload into URL
   */
  private static injectSqlPayload(url: string): string {
    try {
      const urlObj = new URL(url);
      // Add SQL injection to first query parameter or create one
      const firstParamIter = urlObj.searchParams.keys().next();
      if (!firstParamIter.done && firstParamIter.value) {
        urlObj.searchParams.set(firstParamIter.value, `1' OR '1'='1`);
      } else {
        urlObj.searchParams.set('id', `1' OR '1'='1`);
      }
      return urlObj.toString();
    } catch {
      // If URL parsing fails, append to end
      return `${url}${url.includes('?') ? '&' : '?'}id=1' OR '1'='1`;
    }
  }

  /**
   * Inject XSS payload into URL
   */
  private static injectXssPayload(url: string): string {
    try {
      const urlObj = new URL(url);
      const firstParamIter = urlObj.searchParams.keys().next();
      if (!firstParamIter.done && firstParamIter.value) {
        urlObj.searchParams.set(firstParamIter.value, '<script>alert(1)</script>');
      } else {
        urlObj.searchParams.set('q', '<script>alert(1)</script>');
      }
      return urlObj.toString();
    } catch {
      return `${url}${url.includes('?') ? '&' : '?'}q=<script>alert(1)</script>`;
    }
  }

  /**
   * Count scenarios by type for logging
   */
  private static countByType(scenarios: FuzzingScenario[]): Record<string, number> {
    const counts: Record<string, number> = {};
    scenarios.forEach(s => {
      counts[s.type] = (counts[s.type] || 0) + 1;
    });
    return counts;
  }
}
