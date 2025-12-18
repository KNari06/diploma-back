import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import {
  ApiEnvironment,
  ApiEndpoint,
  ApiTestConfig,
  ApiTestExecution,
  ApiTestExecutionRequest,
} from '@/types';

/**
 * Service for managing API configurations
 */
export class ApiConfigService {

  // ========== API Environments ==========

  /**
   * Get all API environments for a user and project
   */
  static async getEnvironments(userId: string, projectId: string): Promise<ApiEnvironment[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('api_environments')
        .select('*')
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .eq('is_active', true)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('Failed to get API environments', { error, userId, projectId });
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('Error getting API environments', { error, userId, projectId });
      throw error;
    }
  }

  /**
   * Get default API environment for a user and project
   */
  static async getDefaultEnvironment(userId: string, projectId: string): Promise<ApiEnvironment | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('api_environments')
        .select('*')
        .eq('user_id', userId)
        .eq('project_id', projectId)
        .eq('is_default', true)
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') { // PGRST116 = no rows returned
        logger.error('Failed to get default API environment', { error, userId, projectId });
        throw error;
      }

      return data || null;
    } catch (error) {
      logger.error('Error getting default API environment', { error, userId, projectId });
      throw error;
    }
  }

  /**
   * Create or update API environment
   */
  static async upsertEnvironment(
    userId: string,
    projectId: string,
    environment: Partial<ApiEnvironment>
  ): Promise<ApiEnvironment> {
    try {
      // If setting as default, unset other defaults first
      if (environment.is_default) {
        await supabaseAdmin
          .from('api_environments')
          .update({ is_default: false })
          .eq('user_id', userId)
          .eq('project_id', projectId);
      }

      const environmentData = {
        user_id: userId,
        project_id: projectId,
        name: environment.name || 'Default Environment',
        base_url: environment.base_url || '',
        description: environment.description,
        default_headers: environment.default_headers || {},
        auth_type: environment.auth_type || 'none',
        auth_config: environment.auth_config || {},
        variables: environment.variables || {},
        is_active: environment.is_active ?? true,
        is_default: environment.is_default ?? false,
      };

      let result;
      if (environment.id) {
        // Update existing
        const { data, error } = await supabaseAdmin
          .from('api_environments')
          .update(environmentData)
          .eq('id', environment.id)
          .eq('user_id', userId)
          .select()
          .single();

        if (error) throw error;
        result = data;
      } else {
        // Create new
        const { data, error } = await supabaseAdmin
          .from('api_environments')
          .insert(environmentData)
          .select()
          .single();

        if (error) throw error;
        result = data;
      }

      logger.info('API environment upserted', {
        environmentId: result.id,
        userId,
        projectId,
        isDefault: result.is_default
      });

      return result;
    } catch (error: any) {
      logger.error('Error upserting API environment', {
        error,
        errorMessage: error?.message,
        errorDetails: error?.details,
        errorHint: error?.hint,
        userId,
        projectId,
        environment: JSON.stringify(environment),
      });
      throw error;
    }
  }

  // ========== API Endpoints ==========

  /**
   * Get API endpoints for an environment
   */
  static async getEndpoints(environmentId: string, userId: string): Promise<ApiEndpoint[]> {
    try {
      const { data, error } = await supabaseAdmin
        .from('api_endpoints')
        .select('*')
        .eq('environment_id', environmentId)
        .eq('user_id', userId)
        .eq('is_active', true)
        .order('category')
        .order('name');

      if (error) {
        logger.error('Failed to get API endpoints', { error, environmentId, userId });
        throw error;
      }

      return data || [];
    } catch (error) {
      logger.error('Error getting API endpoints', { error, environmentId, userId });
      throw error;
    }
  }

  /**
   * Find endpoint by method and path
   */
  static async findEndpoint(
    environmentId: string,
    method: string,
    path: string,
    userId: string
  ): Promise<ApiEndpoint | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('api_endpoints')
        .select('*')
        .eq('environment_id', environmentId)
        .eq('method', method.toUpperCase())
        .eq('path', path)
        .eq('user_id', userId)
        .eq('is_active', true)
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.error('Failed to find API endpoint', { error, environmentId, method, path, userId });
        throw error;
      }

      return data || null;
    } catch (error) {
      logger.error('Error finding API endpoint', { error, environmentId, method, path, userId });
      throw error;
    }
  }

  /**
   * Create or update API endpoint
   */
  static async upsertEndpoint(
    userId: string,
    endpoint: Partial<ApiEndpoint>
  ): Promise<ApiEndpoint> {
    try {
      const endpointData = {
        environment_id: endpoint.environment_id!,
        user_id: userId,
        name: endpoint.name || `${endpoint.method} ${endpoint.path}`,
        method: endpoint.method!.toUpperCase(),
        path: endpoint.path!,
        description: endpoint.description,
        headers: endpoint.headers || {},
        query_params: endpoint.query_params || {},
        path_params: endpoint.path_params || {},
        body_template: endpoint.body_template,
        expected_responses: endpoint.expected_responses || [],
        timeout_ms: endpoint.timeout_ms || 10000,
        retry_count: endpoint.retry_count || 0,
        tags: endpoint.tags || [],
        category: endpoint.category,
        is_active: endpoint.is_active ?? true,
      };

      let result;
      if (endpoint.id) {
        // Update existing
        const { data, error } = await supabaseAdmin
          .from('api_endpoints')
          .update(endpointData)
          .eq('id', endpoint.id)
          .eq('user_id', userId)
          .select()
          .single();

        if (error) throw error;
        result = data;
      } else {
        // Create new
        const { data, error } = await supabaseAdmin
          .from('api_endpoints')
          .insert(endpointData)
          .select()
          .single();

        if (error) throw error;
        result = data;
      }

      logger.info('API endpoint upserted', {
        endpointId: result.id,
        method: result.method,
        path: result.path,
        userId
      });

      return result;
    } catch (error) {
      logger.error('Error upserting API endpoint', { error, userId });
      throw error;
    }
  }

  // ========== Smart Configuration Detection ==========

  /**
   * Analyze user's API request and suggest/create configuration
   */
  static async analyzeAndSuggestConfig(
    userId: string,
    projectId: string,
    apiUrl: string,
    method: string = 'GET',
    headers?: Record<string, string>,
    body?: any
  ): Promise<{
    environment: ApiEnvironment;
    endpoint: ApiEndpoint;
    isNew: boolean;
  }> {
    try {
      // Parse URL to extract base URL and path
      const url = new URL(apiUrl);
      const baseUrl = `${url.protocol}//${url.host}`;
      const path = url.pathname;

      // Try to find existing environment with this base URL
      let environment = await this.findEnvironmentByBaseUrl(userId, projectId, baseUrl);

      if (!environment) {
        // Create new environment
        const envName = this.generateEnvironmentName(baseUrl);
        environment = await this.upsertEnvironment(userId, projectId, {
          name: envName,
          base_url: baseUrl,
          description: `Auto-created from ${apiUrl}`,
          default_headers: this.extractCommonHeaders(headers),
          auth_type: this.detectAuthType(headers),
          auth_config: this.extractAuthConfig(headers),
          is_default: false, // Don't auto-set as default
        });

        logger.info('Auto-created API environment', {
          environmentId: environment.id,
          baseUrl,
          userId,
          projectId
        });
      }

      // Try to find existing endpoint
      let endpoint = await this.findEndpoint(environment.id, method, path, userId);
      const isNew = !endpoint;

      if (!endpoint) {
        // Create new endpoint
        endpoint = await this.upsertEndpoint(userId, {
          environment_id: environment.id,
          name: this.generateEndpointName(method, path),
          method: method.toUpperCase() as any,
          path,
          description: `Auto-created from chat request`,
          headers: this.extractEndpointHeaders(headers),
          body_template: body,
          expected_responses: [
            { status: 200, description: 'Success' },
            { status: 404, description: 'Not Found' },
            { status: 500, description: 'Server Error' }
          ],
          tags: ['auto-generated'],
          category: this.detectCategory(path),
        });

        logger.info('Auto-created API endpoint', {
          endpointId: endpoint.id,
          method,
          path,
          userId
        });
      }

      return { environment, endpoint, isNew };
    } catch (error) {
      logger.error('Error analyzing and suggesting API config', {
        error,
        userId,
        projectId,
        apiUrl,
        method
      });
      throw error;
    }
  }

  // ========== Test Execution with Configuration ==========

  /**
   * Execute API test using stored configuration
   */
  static async executeWithConfig(
    userId: string,
    request: ApiTestExecutionRequest
  ): Promise<ApiTestExecution> {
    try {
      let environment: ApiEnvironment | null = null;
      let endpoint: ApiEndpoint | null = null;
      let testConfig: ApiTestConfig | null = null;

      // Load configuration data
      if (request.environment_id) {
        const { data } = await supabaseAdmin
          .from('api_environments')
          .select('*')
          .eq('id', request.environment_id)
          .eq('user_id', userId)
          .single();
        environment = data;
      }

      if (request.endpoint_id) {
        const { data } = await supabaseAdmin
          .from('api_endpoints')
          .select('*')
          .eq('id', request.endpoint_id)
          .eq('user_id', userId)
          .single();
        endpoint = data;
      }

      if (request.test_config_id) {
        const { data } = await supabaseAdmin
          .from('api_test_configs')
          .select('*')
          .eq('id', request.test_config_id)
          .eq('user_id', userId)
          .single();
        testConfig = data;
      }

      // Build request from configuration
      const fullUrl = environment && endpoint
        ? `${environment.base_url}${endpoint.path}`
        : '';

      const requestHeaders = {
        ...environment?.default_headers,
        ...endpoint?.headers,
      };

      // Add authentication
      if (environment?.auth_type && environment.auth_type !== 'none') {
        this.addAuthHeaders(requestHeaders, environment.auth_type, environment.auth_config);
      }

      const requestData = {
        method: endpoint?.method || 'GET',
        url: fullUrl,
        headers: requestHeaders,
        body: request.custom_data || testConfig?.test_data || endpoint?.body_template,
        timeout: endpoint?.timeout_ms || 10000,
      };

      // Execute the request (using existing executeApiTest)
      const { executeApiTest } = await import('../testing/api/apiTest.service');
      const result = await executeApiTest(requestData);

      // Store execution record
      const execution = await this.recordExecution(userId, {
        user_id: userId,
        environment_id: environment?.id,
        endpoint_id: endpoint?.id,
        test_config_id: testConfig?.id,
        execution_type: request.execution_context?.chat_session_id ? 'chat' : 'manual',
        request_data: requestData,
        response_data: result,
        status_code: result.status,
        duration_ms: result.durationMs,
        success: result.success,
        validation_results: {},
        chat_session_id: request.execution_context?.chat_session_id,
        user_agent: 'QAIT-Backend',
      });

      logger.info('API test executed with configuration', {
        executionId: execution.id,
        environmentId: environment?.id,
        endpointId: endpoint?.id,
        success: result.success,
        userId
      });

      return execution;
    } catch (error) {
      logger.error('Error executing API test with configuration', { error, userId, request });
      throw error;
    }
  }

  // ========== Helper Methods ==========

  private static async findEnvironmentByBaseUrl(
    userId: string,
    projectId: string,
    baseUrl: string
  ): Promise<ApiEnvironment | null> {
    const { data } = await supabaseAdmin
      .from('api_environments')
      .select('*')
      .eq('user_id', userId)
      .eq('project_id', projectId)
      .eq('base_url', baseUrl)
      .eq('is_active', true)
      .single();

    return data || null;
  }

  private static generateEnvironmentName(baseUrl: string): string {
    try {
      const url = new URL(baseUrl);
      const hostname = url.hostname;

      // Extract meaningful name from hostname
      if (hostname.includes('localhost') || hostname.includes('127.0.0.1')) {
        return 'Local Development';
      } else if (hostname.includes('dev') || hostname.includes('development')) {
        return 'Development';
      } else if (hostname.includes('staging') || hostname.includes('stage')) {
        return 'Staging';
      } else if (hostname.includes('test')) {
        return 'Testing';
      } else {
        return hostname.replace('api.', '').replace('www.', '');
      }
    } catch {
      return 'API Environment';
    }
  }

  private static generateEndpointName(method: string, path: string): string {
    const cleanPath = path.replace(/^\//, '').replace(/\/$/, '');
    const pathParts = cleanPath.split('/');

    // Generate readable name
    if (pathParts.length === 1) {
      return `${method} ${pathParts[0]}`;
    } else {
      const resource = pathParts[pathParts.length - 1];
      return `${method} ${resource}`;
    }
  }

  private static extractCommonHeaders(headers?: Record<string, string>): Record<string, string> {
    if (!headers) return { 'Content-Type': 'application/json' };

    const commonHeaders: Record<string, string> = {};

    // Extract non-auth headers that are likely to be reused
    const commonHeaderNames = ['content-type', 'accept', 'user-agent'];

    for (const [key, value] of Object.entries(headers)) {
      if (commonHeaderNames.includes(key.toLowerCase())) {
        commonHeaders[key] = value;
      }
    }

    return Object.keys(commonHeaders).length > 0
      ? commonHeaders
      : { 'Content-Type': 'application/json' };
  }

  private static extractEndpointHeaders(headers?: Record<string, string>): Record<string, string> {
    if (!headers) return {};

    const endpointHeaders: Record<string, string> = {};

    // Extract headers that are specific to this endpoint
    const excludeHeaders = ['authorization', 'x-api-key', 'content-type', 'accept'];

    for (const [key, value] of Object.entries(headers)) {
      if (!excludeHeaders.includes(key.toLowerCase())) {
        endpointHeaders[key] = value;
      }
    }

    return endpointHeaders;
  }

  private static detectAuthType(headers?: Record<string, string>): 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2' {
    if (!headers) return 'none';

    const authHeader = headers['Authorization'] || headers['authorization'];
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) return 'bearer';
      if (authHeader.startsWith('Basic ')) return 'basic';
      return 'oauth2';
    }

    // Check for API key patterns
    const apiKeyHeaders = ['x-api-key', 'api-key', 'apikey'];
    for (const header of apiKeyHeaders) {
      if (headers[header] || headers[header.toLowerCase()]) {
        return 'api_key';
      }
    }

    return 'none';
  }

  private static extractAuthConfig(headers?: Record<string, string>): Record<string, any> {
    if (!headers) return {};

    const config: Record<string, any> = {};

    const authHeader = headers['Authorization'] || headers['authorization'];
    if (authHeader) {
      if (authHeader.startsWith('Bearer ')) {
        config.token_placeholder = '{{BEARER_TOKEN}}';
      } else if (authHeader.startsWith('Basic ')) {
        config.credentials_placeholder = '{{BASIC_CREDENTIALS}}';
      }
    }

    // API key configuration
    const apiKeyHeaders = ['x-api-key', 'api-key', 'apikey'];
    for (const header of apiKeyHeaders) {
      if (headers[header] || headers[header.toLowerCase()]) {
        config.api_key_header = header;
        config.api_key_placeholder = '{{API_KEY}}';
        break;
      }
    }

    return config;
  }

  private static detectCategory(path: string): string {
    const pathLower = path.toLowerCase();

    if (pathLower.includes('auth') || pathLower.includes('login') || pathLower.includes('token')) {
      return 'authentication';
    } else if (pathLower.includes('user')) {
      return 'user-management';
    } else if (pathLower.includes('order') || pathLower.includes('payment')) {
      return 'commerce';
    } else if (pathLower.includes('post') || pathLower.includes('article') || pathLower.includes('content')) {
      return 'content';
    } else {
      return 'general';
    }
  }

  private static addAuthHeaders(
    headers: Record<string, string>,
    authType: string,
    authConfig: Record<string, any>
  ): void {
    // This would be implemented based on stored auth configuration
    // For now, just add placeholder logic
    switch (authType) {
      case 'bearer':
        if (authConfig.token_placeholder) {
          headers['Authorization'] = `Bearer ${authConfig.token_placeholder}`;
        }
        break;
      case 'api_key':
        if (authConfig.api_key_header && authConfig.api_key_placeholder) {
          headers[authConfig.api_key_header] = authConfig.api_key_placeholder;
        }
        break;
      case 'basic':
        if (authConfig.credentials_placeholder) {
          headers['Authorization'] = `Basic ${authConfig.credentials_placeholder}`;
        }
        break;
    }
  }

  private static async recordExecution(
    userId: string,
    execution: Omit<ApiTestExecution, 'id' | 'executed_at'>
  ): Promise<ApiTestExecution> {
    const { data, error } = await supabaseAdmin
      .from('api_test_executions')
      .insert({
        ...execution,
        user_id: userId,
        user_agent: 'QAIT-Backend',
      })
      .select()
      .single();

    if (error) {
      logger.error('Failed to record API test execution', { error, userId });
      throw error;
    }

    return data;
  }
}
