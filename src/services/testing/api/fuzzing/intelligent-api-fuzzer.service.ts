import { logger } from '@/utils/core/logger';
import { ApiTestRequest, ApiTestResponse, FuzzingScenario } from '@/types';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildApiFuzzingPrompt } from '@/ai/prompts';
import { FUZZING_CONFIG } from './fuzzing-config';

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
   * Generate follow-on scenarios based on previous fuzzing results
   * @param baseRequest - The original API request
   * @param previousResults - Results from initial fuzzing
   * @param foundIssues - Security issues found in initial fuzzing
   * @returns Array of targeted follow-on scenarios
   */
  static async generateFollowOnScenarios(
    baseRequest: ApiTestRequest,
    previousResults: { scenarios: any[]; issues: any[] },
    foundIssues: any[]
  ): Promise<FuzzingScenario[]> {
    const startTime = Date.now();

    try {
      // ═══════════════════════════════════════════════════════════════════
      // VALIDATION #1: Input validation
      // ═══════════════════════════════════════════════════════════════════
      if (!baseRequest || typeof baseRequest !== 'object' || Array.isArray(baseRequest)) {
        logger.warn('[API_FUZZER] Invalid baseRequest type for follow-on scenarios');
        return [];
      }

      if (!baseRequest.url || typeof baseRequest.url !== 'string' || baseRequest.url.trim().length === 0) {
        logger.warn('[API_FUZZER] Invalid or missing URL in baseRequest');
        return [];
      }

      if (!baseRequest.method || typeof baseRequest.method !== 'string' || baseRequest.method.trim().length === 0) {
        logger.warn('[API_FUZZER] Invalid or missing method in baseRequest');
        return [];
      }

      // Validate URL format
      try {
        new URL(baseRequest.url);
      } catch {
        logger.warn('[API_FUZZER] Invalid URL format in baseRequest', { url: baseRequest.url });
        return [];
      }

      // ═══════════════════════════════════════════════════════════════════
      // VALIDATION #2: Check if we have issues
      // ═══════════════════════════════════════════════════════════════════
      if (!foundIssues || !Array.isArray(foundIssues) || foundIssues.length === 0) {
        logger.info('[API_FUZZER] No issues found, skipping follow-on scenarios');
        return [];
      }

      // ═══════════════════════════════════════════════════════════════════
      // VALIDATION #3: Filter critical/high severity issues only
      // ═══════════════════════════════════════════════════════════════════
      const allowedSeverities = FUZZING_CONFIG.FOLLOW_ON.ALLOWED_SEVERITIES;
      const criticalIssues = foundIssues.filter(
        issue => issue && issue.severity && allowedSeverities.includes(issue.severity)
      );

      if (criticalIssues.length < FUZZING_CONFIG.FOLLOW_ON.MIN_CRITICAL_ISSUES) {
        logger.info('[API_FUZZER] Not enough critical/high issues for follow-on', {
          found: criticalIssues.length,
          required: FUZZING_CONFIG.FOLLOW_ON.MIN_CRITICAL_ISSUES,
        });
        return [];
      }

      // ═══════════════════════════════════════════════════════════════════
      // VALIDATION #4: Check previous results structure
      // ═══════════════════════════════════════════════════════════════════
      if (!previousResults || typeof previousResults !== 'object') {
        logger.warn('[API_FUZZER] Invalid previousResults structure');
        return [];
      }

      if (!Array.isArray(previousResults.scenarios)) {
        logger.warn('[API_FUZZER] previousResults.scenarios is not an array');
        previousResults.scenarios = [];
      }

      if (!Array.isArray(previousResults.issues)) {
        logger.warn('[API_FUZZER] previousResults.issues is not an array');
        previousResults.issues = [];
      }

      logger.info('[API_FUZZER] Generating follow-on scenarios', {
        method: baseRequest.method,
        url: baseRequest.url.substring(0, 100), // Truncate for logging
        criticalIssuesCount: criticalIssues.length,
        totalIssuesCount: foundIssues.length,
        allowedSeverities,
      });

      // ═══════════════════════════════════════════════════════════════════
      // GENERATION: Build prompt and call GPT
      // ═══════════════════════════════════════════════════════════════════
      const prompt = this.buildFollowOnPrompt(baseRequest, previousResults, criticalIssues);

      // Get follow-on scenarios from GPT with retry logic
      let scenarios: FuzzingScenario[] = [];
      let retries = 0;
      const maxRetries = FUZZING_CONFIG.FOLLOW_ON.MAX_RETRIES;

      while (retries <= maxRetries) {
        try {
          const response = await getChatCompletionWithMessages(
            [
              {
                role: 'system',
                content: 'You are a penetration testing expert. Generate targeted follow-on scenarios to deeply exploit discovered vulnerabilities.',
              },
              {
                role: 'user',
                content: prompt,
              },
            ],
            {
              temperature: 0.8, // Higher for creative exploit variations
              response_format: { type: 'json_object' },
            }
          );

          const parsed = JSON.parse(response.content);

          // ═══════════════════════════════════════════════════════════════
          // VALIDATION #5: Validate GPT response structure
          // ═══════════════════════════════════════════════════════════════
          if (!parsed.scenarios || !Array.isArray(parsed.scenarios)) {
            logger.warn('[API_FUZZER] Invalid follow-on response format from GPT', {
              hasScenarios: !!parsed.scenarios,
              isArray: Array.isArray(parsed.scenarios),
              retry: retries,
            });

            if (retries < maxRetries) {
              retries++;
              logger.info(`[API_FUZZER] Retrying follow-on generation (${retries}/${maxRetries})...`);
              continue; // Retry
            }
            return [];
          }

          // ═══════════════════════════════════════════════════════════════
          // VALIDATION #6: Check scenario count
          // ═══════════════════════════════════════════════════════════════
          if (parsed.scenarios.length < FUZZING_CONFIG.FOLLOW_ON.MIN_SCENARIOS) {
            logger.warn('[API_FUZZER] Too few follow-on scenarios from GPT', {
              received: parsed.scenarios.length,
              min: FUZZING_CONFIG.FOLLOW_ON.MIN_SCENARIOS,
              retry: retries,
            });

            if (retries < maxRetries) {
              retries++;
              logger.info(`[API_FUZZER] Retrying follow-on generation (${retries}/${maxRetries})...`);
              continue; // Retry
            }
            // Use what we got if we're out of retries
          }

          // Limit to max scenarios
          const limitedScenarios = parsed.scenarios.slice(0, FUZZING_CONFIG.FOLLOW_ON.MAX_SCENARIOS);

          // ═══════════════════════════════════════════════════════════════
          // NORMALIZATION: Normalize scenarios with follow-on prefix
          // ═══════════════════════════════════════════════════════════════
          scenarios = limitedScenarios.map((s: any, index: number) => {
            // Validate individual scenario fields
            if (!s || typeof s !== 'object') {
              logger.warn('[API_FUZZER] Invalid scenario object at index', { index });
              return null;
            }

            // Ensure request object is valid
            if (!s.request || typeof s.request !== 'object') {
              s.request = {};
            }

            return {
              id: s.id || `followon_${index + 1}`,
              type: s.type || 'security',
              description: `[FOLLOW-ON] ${s.description || 'Targeted security test'}`,
              request: {
                method: s.request.method || baseRequest.method,
                url: s.request.url || baseRequest.url,
                headers: s.request.headers && typeof s.request.headers === 'object'
                  ? s.request.headers
                  : {},
                body: s.request.body !== undefined ? s.request.body : undefined,
              },
              expectedStatus: typeof s.expectedStatus === 'number' ? s.expectedStatus : 400,
              expectedBehavior: s.expectedBehavior || 'Should handle securely',
              riskIfFails: s.riskIfFails || 'Security vulnerability',
            };
          }).filter((s: FuzzingScenario | null): s is FuzzingScenario => s !== null); // Filter out invalid scenarios

          // Successfully generated scenarios, break out of retry loop
          break;
        } catch (parseError) {
          logger.error('[API_FUZZER] Error parsing GPT response for follow-on', {
            error: parseError instanceof Error ? parseError.message : String(parseError),
            retry: retries,
          });

          if (retries < maxRetries) {
            retries++;
            logger.info(`[API_FUZZER] Retrying follow-on generation (${retries}/${maxRetries})...`);
            continue; // Retry
          }
          return []; // Out of retries
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // FINAL VALIDATION: Check if we got valid scenarios
      // ═══════════════════════════════════════════════════════════════════
      if (scenarios.length === 0) {
        logger.warn('[API_FUZZER] No valid follow-on scenarios after normalization');
        return [];
      }

      const duration = Date.now() - startTime;

      logger.info('[API_FUZZER] Generated follow-on scenarios successfully', {
        count: scenarios.length,
        types: this.countByType(scenarios),
        basedOnIssues: criticalIssues.map(i => i.type).join(', '),
        duration: `${duration}ms`,
        retries,
      });

      return scenarios;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('[API_FUZZER] Critical error generating follow-on scenarios', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        duration: `${duration}ms`,
      });
      return []; // Return empty on error, don't fail entire fuzzing
    }
  }

  /**
   * Build prompt for follow-on scenario generation
   */
  private static buildFollowOnPrompt(
    baseRequest: ApiTestRequest,
    previousResults: { scenarios: any[]; issues: any[] },
    criticalIssues: any[]
  ): string {
    const issuesSummary = criticalIssues.map((issue, idx) => {
      return `
${idx + 1}. TYPE: ${issue.type}
   SEVERITY: ${issue.severity}
   DESCRIPTION: ${issue.description}
   EVIDENCE: ${issue.evidence?.substring(0, 300) || 'N/A'}
   ATTACK VECTOR: ${this.extractAttackVector(issue)}`;
    }).join('\n');

    const failedScenarios = previousResults.scenarios
      .filter((s: any) => !s.passed)
      .map((s: any, idx: number) => {
        return `${idx + 1}. ${s.scenario.description} (${s.scenario.type}) → Got ${s.result?.status || 'ERROR'}`;
      })
      .join('\n');

    return `You are a penetration testing expert. Initial fuzzing found CRITICAL vulnerabilities.
Your task: Generate 5-10 TARGETED follow-on scenarios to deeply exploit these findings.

═══════════════════════════════════════════════════════════════════════════════
API ENDPOINT:
═══════════════════════════════════════════════════════════════════════════════
Method: ${baseRequest.method}
URL: ${baseRequest.url}
Headers: ${JSON.stringify(baseRequest.headers || {}, null, 2)}
Body: ${baseRequest.body ? JSON.stringify(baseRequest.body, null, 2) : 'None'}

═══════════════════════════════════════════════════════════════════════════════
CRITICAL ISSUES FOUND (${criticalIssues.length}):
═══════════════════════════════════════════════════════════════════════════════
${issuesSummary}

═══════════════════════════════════════════════════════════════════════════════
FAILED INITIAL TESTS:
═══════════════════════════════════════════════════════════════════════════════
${failedScenarios || 'None - all tests passed (unexpected!)'}

═══════════════════════════════════════════════════════════════════════════════
YOUR TASK:
═══════════════════════════════════════════════════════════════════════════════

Generate 5-10 ADVANCED follow-on scenarios that:

1️⃣ **EXPLOIT FOUND VULNERABILITIES DEEPER**:
   - If SQL injection works → Try UNION attacks, time-based blind SQL
   - If XSS works → Try DOM-based XSS, reflected XSS variations
   - If auth bypass works → Try privilege escalation, JWT manipulation
   - If input validation fails → Try boundary cases, encoding bypasses

2️⃣ **COMBINE ATTACK VECTORS**:
   - Combine multiple vulnerabilities (e.g., XSS + CSRF)
   - Chain attacks (e.g., auth bypass → access admin endpoint)
   - Try different encodings (URL encoding, base64, hex)

3️⃣ **TEST EDGE CASES**:
   - Extreme values (very large numbers, unicode, null bytes)
   - Race conditions (concurrent requests)
   - Resource exhaustion (huge payloads, nested objects)

4️⃣ **BE CREATIVE BUT REALISTIC**:
   - Think like a real attacker who found initial weakness
   - Focus on scenarios that can cause real damage
   - Prioritize critical/high severity exploits

═══════════════════════════════════════════════════════════════════════════════
RESPONSE FORMAT (JSON ONLY):
═══════════════════════════════════════════════════════════════════════════════

{
  "scenarios": [
    {
      "id": "followon_sql_union",
      "type": "security",
      "description": "UNION-based SQL injection to extract data",
      "request": {
        "method": "GET",
        "url": "https://api.example.com/users?id=1' UNION SELECT username,password FROM users--",
        "headers": {...},
        "body": null
      },
      "expectedStatus": 400,
      "expectedBehavior": "Should sanitize and block UNION queries",
      "riskIfFails": "Attacker can extract sensitive data from database",
      "severity": "critical",
      "basedOnIssue": "SQL injection vulnerability found in initial testing"
    }
    // ... 5-10 total scenarios
  ],
  "reasoning": "Brief explanation of why these follow-on tests are important"
}

CRITICAL RULES:
- Generate 5-10 scenarios (not more, not less)
- Each scenario MUST be based on findings from initial fuzzing
- Use unique IDs starting with "followon_"
- Focus on EXPLOITING found weaknesses, not repeating initial tests
- Include "basedOnIssue" field explaining connection to initial findings
- Set severity appropriately: "critical" or "high" only
- RETURN ONLY VALID JSON`;
  }

  /**
   * Extract attack vector from issue evidence
   */
  private static extractAttackVector(issue: any): string {
    if (!issue.evidence) return 'Unknown';

    const evidence = issue.evidence.toLowerCase();

    if (evidence.includes('sql') || evidence.includes('union') || evidence.includes("' or")) {
      return 'SQL Injection detected';
    }
    if (evidence.includes('<script>') || evidence.includes('alert(')) {
      return 'XSS vulnerability detected';
    }
    if (evidence.includes('unauthorized') || evidence.includes('401')) {
      return 'Authentication bypass detected';
    }
    if (evidence.includes('forbidden') || evidence.includes('403')) {
      return 'Authorization weakness detected';
    }
    if (evidence.includes('malformed') || evidence.includes('invalid')) {
      return 'Input validation missing';
    }

    return issue.type || 'Unknown attack vector';
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
