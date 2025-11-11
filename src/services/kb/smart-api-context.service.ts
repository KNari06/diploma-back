import { logger } from '@/utils/logger';
import { ApiConfigService } from '../api/api-config.service';
import { UrlResolverService } from '../utils/url-resolver.service';
import { ApiEnvironment, ApiEndpoint, IntentResult } from '@/types';

/**
 * Context analysis result for API testing
 */
export interface ApiTestContext {
  // What we have
  hasBaseUrl: boolean;
  hasAuthentication: boolean;
  hasHeaders: boolean;
  hasEndpointConfig: boolean;
  hasTestHistory: boolean;

  // What we found
  environment?: ApiEnvironment;
  endpoint?: ApiEndpoint;
  fullUrl?: string;
  suggestedHeaders?: Record<string, string>;

  // What we need
  missingInfo: {
    baseUrl?: boolean;
    authToken?: boolean;
    customHeaders?: boolean;
    requestBody?: boolean;
  };

  // Test strategy
  testStrategy: 'comprehensive' | 'basic' | 'targeted';
  recommendedScenarios: string[];

  // Confidence level
  confidence: number; // 0-1, how confident we are about testing this API
}

/**
 * Smart API Context Service
 * Analyzes what we know about an API and what we need to test it properly
 */
export class SmartApiContextService {

  /**
   * Analyze API testing context and determine what information we need
   */
  static async analyzeApiContext(
    intent: IntentResult,
    userId: string,
    projectId: string
  ): Promise<ApiTestContext> {
    try {
      logger.info('[SMART_CONTEXT] Analyzing API context', {
        intent: intent.intent,
        apiUrl: intent.apiUrl,
        apiMethod: intent.apiMethod,
        userId,
        projectId,
      });

      const context: ApiTestContext = {
        hasBaseUrl: false,
        hasAuthentication: false,
        hasHeaders: false,
        hasEndpointConfig: false,
        hasTestHistory: false,
        missingInfo: {},
        testStrategy: 'basic',
        recommendedScenarios: [],
        confidence: 0,
      };

      // 1. Analyze URL completeness
      const urlAnalysis = await this.analyzeUrl(intent.apiUrl!, userId, projectId, intent.apiMethod || 'GET');
      context.hasBaseUrl = urlAnalysis.hasBaseUrl;
      context.environment = urlAnalysis.environment;
      context.fullUrl = urlAnalysis.fullUrl;

      if (!context.hasBaseUrl) {
        context.missingInfo.baseUrl = true;
        context.confidence = 0.2;
        return context; // Can't proceed without base URL
      }

      // 2. Analyze endpoint configuration
      const endpointAnalysis = await this.analyzeEndpoint(urlAnalysis.fullUrl!, intent.apiMethod || 'GET', userId);
      context.hasEndpointConfig = endpointAnalysis.hasConfig;
      context.endpoint = endpointAnalysis.endpoint;
      context.hasTestHistory = endpointAnalysis.hasHistory;

      // 3. Analyze authentication requirements
      const authAnalysis = await this.analyzeAuthentication(context.environment, context.endpoint, urlAnalysis.fullUrl!);
      context.hasAuthentication = authAnalysis.hasAuth;
      context.suggestedHeaders = authAnalysis.suggestedHeaders;

      if (authAnalysis.needsAuth && !context.hasAuthentication) {
        context.missingInfo.authToken = true;
      }

      // 4. Analyze headers and body requirements
      const requestAnalysis = this.analyzeRequestRequirements(intent.apiMethod || 'GET', urlAnalysis.fullUrl!);
      context.hasHeaders = Object.keys(context.suggestedHeaders || {}).length > 0;

      if (requestAnalysis.needsBody && !intent.apiBody) {
        context.missingInfo.requestBody = true;
      }

      if (requestAnalysis.needsCustomHeaders) {
        context.missingInfo.customHeaders = true;
      }

      // 5. Determine test strategy
      context.testStrategy = this.determineTestStrategy(context);
      context.recommendedScenarios = this.getRecommendedScenarios(
        intent.apiMethod || 'GET',
        urlAnalysis.fullUrl!,
        context
      );

      // 6. Calculate confidence
      context.confidence = this.calculateConfidence(context);

      logger.info('[SMART_CONTEXT] Context analysis completed', {
        hasBaseUrl: context.hasBaseUrl,
        hasAuth: context.hasAuthentication,
        hasConfig: context.hasEndpointConfig,
        strategy: context.testStrategy,
        confidence: context.confidence,
        missingInfo: Object.keys(context.missingInfo).length,
      });

      return context;

    } catch (error) {
      logger.error('[SMART_CONTEXT] Error analyzing API context', { error, intent, userId, projectId });

      // Return minimal context on error
      return {
        hasBaseUrl: false,
        hasAuthentication: false,
        hasHeaders: false,
        hasEndpointConfig: false,
        hasTestHistory: false,
        missingInfo: { baseUrl: true },
        testStrategy: 'basic',
        recommendedScenarios: ['Happy Path'],
        confidence: 0.1,
      };
    }
  }

  /**
   * Analyze URL completeness and resolve if needed
   */
  private static async analyzeUrl(
    apiUrl: string,
    userId: string,
    projectId: string,
    method: string
  ): Promise<{
    hasBaseUrl: boolean;
    fullUrl?: string;
    environment?: ApiEnvironment;
  }> {
    // Check if URL is complete
    if (!UrlResolverService.isRelativeUrl(apiUrl)) {
      return {
        hasBaseUrl: true,
        fullUrl: apiUrl,
      };
    }

    // Try to resolve relative URL
    const resolveResult = await UrlResolverService.resolveApiUrl(apiUrl, userId, projectId, method);

    if (resolveResult.source === 'user_input_required') {
      return { hasBaseUrl: false };
    }

    return {
      hasBaseUrl: true,
      fullUrl: resolveResult.fullUrl,
      environment: resolveResult.environment,
    };
  }

  /**
   * Analyze endpoint configuration
   */
  private static async analyzeEndpoint(
    fullUrl: string,
    method: string,
    userId: string
  ): Promise<{
    hasConfig: boolean;
    hasHistory: boolean;
    endpoint?: ApiEndpoint;
  }> {
    try {
      const baseUrl = UrlResolverService.extractBaseUrl(fullUrl);
      const path = UrlResolverService.extractPath(fullUrl);

      // Find environment by base URL
      const environments = await ApiConfigService.getEnvironments(userId, 'default');
      const environment = environments.find(env => env.base_url === baseUrl);

      if (!environment) {
        return { hasConfig: false, hasHistory: false };
      }

      // Find endpoint
      const endpoint = await ApiConfigService.findEndpoint(environment.id, method, path, userId);

      return {
        hasConfig: !!endpoint,
        hasHistory: !!endpoint, // If we have config, we likely have history
        endpoint: endpoint || undefined,
      };
    } catch (error) {
      logger.error('[SMART_CONTEXT] Error analyzing endpoint', { error, fullUrl, method });
      return { hasConfig: false, hasHistory: false };
    }
  }

  /**
   * Analyze authentication requirements
   */
  private static async analyzeAuthentication(
    environment?: ApiEnvironment,
    endpoint?: ApiEndpoint,
    fullUrl?: string
  ): Promise<{
    hasAuth: boolean;
    needsAuth: boolean;
    suggestedHeaders: Record<string, string>;
  }> {
    const suggestedHeaders: Record<string, string> = {};
    let hasAuth = false;
    let needsAuth = false;

    // Check environment auth
    if (environment && environment.auth_type !== 'none') {
      hasAuth = true;

      // Add auth headers based on type
      switch (environment.auth_type) {
        case 'bearer':
          if (environment.auth_config.token_placeholder) {
            suggestedHeaders['Authorization'] = `Bearer ${environment.auth_config.token_placeholder}`;
          } else {
            needsAuth = true;
          }
          break;
        case 'api_key':
          if (environment.auth_config.api_key_header && environment.auth_config.api_key_placeholder) {
            suggestedHeaders[environment.auth_config.api_key_header] = environment.auth_config.api_key_placeholder;
          } else {
            needsAuth = true;
          }
          break;
      }
    }

    // Add environment default headers
    if (environment?.default_headers) {
      Object.assign(suggestedHeaders, environment.default_headers);
    }

    // Add endpoint specific headers
    if (endpoint?.headers) {
      Object.assign(suggestedHeaders, endpoint.headers);
    }

    // Heuristic: if URL contains certain patterns, likely needs auth
    if (fullUrl && !hasAuth) {
      const authPatterns = ['/api/', '/v1/', '/admin/', '/user/', '/auth/'];
      if (authPatterns.some(pattern => fullUrl.includes(pattern))) {
        needsAuth = true;
      }
    }

    return {
      hasAuth,
      needsAuth,
      suggestedHeaders,
    };
  }

  /**
   * Analyze request requirements based on method and URL
   */
  private static analyzeRequestRequirements(method: string, fullUrl: string): {
    needsBody: boolean;
    needsCustomHeaders: boolean;
  } {
    const needsBody = ['POST', 'PUT', 'PATCH'].includes(method.toUpperCase());

    // Heuristic: certain endpoints might need custom headers
    const needsCustomHeaders = fullUrl.includes('/upload/') ||
                              fullUrl.includes('/file/') ||
                              fullUrl.includes('/webhook/');

    return { needsBody, needsCustomHeaders };
  }

  /**
   * Determine optimal test strategy
   */
  private static determineTestStrategy(context: ApiTestContext): 'comprehensive' | 'basic' | 'targeted' {
    // If we have full context and history, do comprehensive testing
    if (context.hasEndpointConfig && context.hasTestHistory && context.hasAuthentication) {
      return 'comprehensive';
    }

    // If we have some context, do targeted testing
    if (context.hasBaseUrl && (context.hasAuthentication || context.hasHeaders)) {
      return 'targeted';
    }

    // Otherwise, basic testing
    return 'basic';
  }

  /**
   * Get recommended test scenarios based on context
   */
  private static getRecommendedScenarios(
    method: string,
    fullUrl: string,
    context: ApiTestContext
  ): string[] {
    const scenarios: string[] = ['Happy Path'];

    // Always test response time
    scenarios.push('Response Time');

    // Method-specific scenarios
    if (method === 'GET') {
      scenarios.push('Query Parameters', 'Headers Validation');

      if (fullUrl.includes('/user') || fullUrl.includes('/profile')) {
        scenarios.push('Authentication Required');
      }
    }

    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      scenarios.push('Valid JSON Body', 'Invalid JSON', 'Empty Body');

      if (context.hasAuthentication) {
        scenarios.push('Authentication Required');
      }
    }

    if (method === 'DELETE') {
      scenarios.push('Delete Existing', 'Delete Non-existent');
    }

    // URL-specific scenarios
    if (fullUrl.includes('/admin/')) {
      scenarios.push('Admin Authorization');
    }

    if (fullUrl.includes('/upload/') || fullUrl.includes('/file/')) {
      scenarios.push('File Upload', 'Large Payload');
    }

    // Error scenarios
    scenarios.push('Invalid URL', 'Error Handling');

    return scenarios;
  }

  /**
   * Calculate confidence level for testing
   */
  private static calculateConfidence(context: ApiTestContext): number {
    let confidence = 0;

    // Base URL is essential
    if (context.hasBaseUrl) confidence += 0.3;

    // Authentication adds confidence
    if (context.hasAuthentication) confidence += 0.2;

    // Endpoint configuration adds confidence
    if (context.hasEndpointConfig) confidence += 0.2;

    // Test history adds confidence
    if (context.hasTestHistory) confidence += 0.1;

    // Headers add confidence
    if (context.hasHeaders) confidence += 0.1;

    // Missing info reduces confidence
    const missingCount = Object.keys(context.missingInfo).length;
    confidence -= missingCount * 0.1;

    return Math.max(0, Math.min(1, confidence));
  }

  /**
   * Generate questions for missing information
   */
  static generateContextQuestions(
    context: ApiTestContext,
    intent: IntentResult
  ): Array<{
    id: string;
    question: string;
    type: string;
    required: boolean;
    suggestions?: string[];
  }> {
    const questions: Array<{
      id: string;
      question: string;
      type: string;
      required: boolean;
      suggestions?: string[];
    }> = [];

    if (context.missingInfo.baseUrl) {
      questions.push({
        id: 'base_url',
        question: `Базовый URL для тестирования ${intent.apiUrl}`,
        type: 'url',
        required: true,
        suggestions: UrlResolverService.generateBaseUrlSuggestions(intent.apiUrl || ''),
      });
    }

    if (context.missingInfo.authToken) {
      const authType = context.environment?.auth_type || 'bearer';
      questions.push({
        id: 'auth_token',
        question: `Токен авторизации (${authType})`,
        type: 'text',
        required: true,
        suggestions: authType === 'bearer' ? ['Bearer your-token-here'] : ['your-api-key-here'],
      });
    }

    if (context.missingInfo.requestBody && ['POST', 'PUT', 'PATCH'].includes(intent.apiMethod || '')) {
      questions.push({
        id: 'request_body',
        question: 'Пример тела запроса (JSON)',
        type: 'json',
        required: false,
        suggestions: ['{"name": "test", "active": true}'],
      });
    }

    if (context.missingInfo.customHeaders) {
      questions.push({
        id: 'custom_headers',
        question: 'Дополнительные заголовки (JSON)',
        type: 'json',
        required: false,
        suggestions: ['{"X-Custom-Header": "value"}'],
      });
    }

    return questions;
  }

  /**
   * Process user responses and update context
   */
  static async processUserResponses(
    context: ApiTestContext,
    responses: Record<string, any>,
    userId: string,
    projectId: string,
    intent: IntentResult
  ): Promise<{
    success: boolean;
    updatedContext: ApiTestContext;
    environment?: ApiEnvironment;
    endpoint?: ApiEndpoint;
    error?: string;
  }> {
    try {
      let environment = context.environment;
      let endpoint = context.endpoint;

      // Process base URL
      if (responses.base_url && context.missingInfo.baseUrl) {
        const baseUrl = responses.base_url.replace(/\/$/, '');
        const path = UrlResolverService.extractPath(intent.apiUrl || '');

        // Create or update environment
        environment = await ApiConfigService.upsertEnvironment(userId, projectId, {
          name: UrlResolverService.generateEnvironmentName(baseUrl),
          base_url: baseUrl,
          description: `Auto-created from chat request`,
          default_headers: { 'Content-Type': 'application/json' },
          auth_type: responses.auth_token ? 'bearer' : 'none',
          is_default: true,
        });

        context.fullUrl = `${baseUrl}${path}`;
        context.hasBaseUrl = true;
      }

      // Process authentication
      if (responses.auth_token && environment) {
        const authConfig: Record<string, any> = {};

        if (responses.auth_token.startsWith('Bearer ')) {
          authConfig.token_placeholder = responses.auth_token;
          environment.auth_type = 'bearer';
        } else if (responses.auth_token.includes('api')) {
          authConfig.api_key_placeholder = responses.auth_token;
          authConfig.api_key_header = 'X-API-Key';
          environment.auth_type = 'api_key';
        } else {
          authConfig.token_placeholder = `Bearer ${responses.auth_token}`;
          environment.auth_type = 'bearer';
        }

        environment = await ApiConfigService.upsertEnvironment(userId, projectId, {
          ...environment,
          auth_config: authConfig,
        });

        context.hasAuthentication = true;
      }

      // Create endpoint if we have environment
      if (environment && context.fullUrl) {
        const path = UrlResolverService.extractPath(context.fullUrl);
        const headers: Record<string, string> = {};

        // Add custom headers
        if (responses.custom_headers) {
          try {
            const customHeaders = typeof responses.custom_headers === 'string'
              ? JSON.parse(responses.custom_headers)
              : responses.custom_headers;
            Object.assign(headers, customHeaders);
          } catch (error) {
            logger.warn('[SMART_CONTEXT] Failed to parse custom headers', { error });
          }
        }

        endpoint = await ApiConfigService.upsertEndpoint(userId, {
          environment_id: environment.id,
          name: `${intent.apiMethod || 'GET'} ${path}`,
          method: (intent.apiMethod || 'GET').toUpperCase() as any,
          path,
          description: 'Auto-created from chat request',
          headers,
          body_template: responses.request_body,
          expected_responses: [
            { status: 200, description: 'Success' },
            { status: 404, description: 'Not Found' },
          ],
          tags: ['auto-generated'],
        });

        context.hasEndpointConfig = true;
      }

      // Update context
      const updatedContext = {
        ...context,
        environment,
        endpoint,
        missingInfo: {}, // Clear missing info
        confidence: 0.9, // High confidence after user input
      };

      return {
        success: true,
        updatedContext,
        environment,
        endpoint,
      };

    } catch (error) {
      logger.error('[SMART_CONTEXT] Error processing user responses', { error, responses });
      return {
        success: false,
        updatedContext: context,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
