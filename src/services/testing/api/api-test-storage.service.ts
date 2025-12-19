import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { isValidUUID } from '@/utils/validation/validation';

/**
 * Service for storing API test results in database
 * Saves comprehensive test data to api_test_executions table for user access
 */
export class ApiTestStorageService {
  /**
   * Save API test execution to database
   * @param params - Test execution data
   * @returns Saved execution record or null if failed
   */
  static async saveApiTestExecution(params: {
    userId: string;
    testId: string;
    chatSessionId?: string;
    projectId?: string;
    request: {
      method: string;
      url: string;
      headers?: Record<string, string>;
      body?: any;
    };
    response: {
      status: number;
      statusText: string;
      headers?: Record<string, string>;
      body?: any;
      durationMs: number;
    };
    success: boolean;
    errorMessage?: string;
    fuzzingReport?: {
      summary: {
        totalTests: number;
        passed: number;
        failed: number;
        duration: number;
      };
      issues: any[];
      securityScore: number;
      metadata?: {
        hadFollowOn?: boolean;
        initialPhase?: any;
        followOnPhase?: any;
      };
    };
    metadata?: Record<string, any>;
  }): Promise<{
    id: string;
    success: boolean;
  } | null> {
    try {
      // Input validation
      if (!params.userId || typeof params.userId !== 'string' || params.userId.trim().length === 0) {
        logger.warn('[API_TEST_STORAGE] Invalid userId', { userId: params.userId });
        return null;
      }

      if (!params.testId || typeof params.testId !== 'string' || params.testId.trim().length === 0) {
        logger.warn('[API_TEST_STORAGE] Invalid testId', { testId: params.testId });
        return null;
      }

      if (!params.request || !params.request.url || !params.request.method) {
        logger.warn('[API_TEST_STORAGE] Invalid request data', { request: params.request });
        return null;
      }

      if (!params.response || typeof params.response.status !== 'number') {
        logger.warn('[API_TEST_STORAGE] Invalid response data', { response: params.response });
        return null;
      }

      // Validate URL format
      try {
        new URL(params.request.url);
      } catch {
        logger.warn('[API_TEST_STORAGE] Invalid URL format', { url: params.request.url });
        return null;
      }

      // Validate projectId if provided
      if (params.projectId && !isValidUUID(params.projectId)) {
        logger.warn('[API_TEST_STORAGE] Invalid projectId format', { projectId: params.projectId });
        // Don't fail, just log warning
      }

      logger.info('[API_TEST_STORAGE] Saving API test execution', {
        testId: params.testId,
        userId: params.userId.substring(0, 8) + '...',
        method: params.request.method,
        url: params.request.url.substring(0, 100),
        status: params.response.status,
        hasFuzzingReport: !!params.fuzzingReport,
      });

      // Prepare request_data
      const requestData = {
        method: params.request.method,
        url: params.request.url,
        headers: params.request.headers || {},
        body: params.request.body || null,
      };

      // Prepare response_data
      const responseData = {
        status: params.response.status,
        statusText: params.response.statusText || '',
        headers: params.response.headers || {},
        body: params.response.body || null,
        durationMs: params.response.durationMs,
      };

      // Prepare validation_results (extract from fuzzing report if available)
      const validationResults: Record<string, any> = {
        success: params.success,
        ...(params.metadata || {}),
      };

      // Add fuzzing report to validation_results if available
      if (params.fuzzingReport) {
        validationResults.fuzzing = {
          summary: params.fuzzingReport.summary,
          issuesCount: params.fuzzingReport.issues.length,
          securityScore: params.fuzzingReport.securityScore,
          hadFollowOn: params.fuzzingReport.metadata?.hadFollowOn || false,
          phases: params.fuzzingReport.metadata
            ? {
                initial: params.fuzzingReport.metadata.initialPhase,
                followOn: params.fuzzingReport.metadata.followOnPhase,
              }
            : undefined,
        };

        // Store full issues (limited to avoid huge JSONB)
        if (params.fuzzingReport.issues.length > 0) {
          validationResults.fuzzing.issues = params.fuzzingReport.issues.slice(0, 50); // Limit to 50 issues
        }
      }

      // Insert into api_test_executions
      const { data, error } = await supabaseAdmin
        .from('api_test_executions')
        .insert({
          user_id: params.userId,
          execution_type: 'chat', // API tests from chat are 'chat' type
          request_data: requestData,
          response_data: responseData,
          status_code: params.response.status,
          duration_ms: params.response.durationMs,
          success: params.success,
          validation_results: validationResults,
          error_message: params.errorMessage || null,
          chat_session_id: params.chatSessionId || null,
          user_agent: 'QAI-Backend',
          // Note: environment_id, endpoint_id, test_config_id are optional
          // and can be added later if we implement API configuration management
        })
        .select('id')
        .single();

      if (error) {
        logger.error('[API_TEST_STORAGE] Failed to save API test execution', {
          error: error.message,
          code: error.code,
          testId: params.testId,
          userId: params.userId.substring(0, 8) + '...',
        });
        return null;
      }

      if (!data || !data.id) {
        logger.warn('[API_TEST_STORAGE] No data returned from insert', { testId: params.testId });
        return null;
      }

      logger.info('[API_TEST_STORAGE] API test execution saved successfully', {
        executionId: data.id,
        testId: params.testId,
        hasFuzzing: !!params.fuzzingReport,
      });

      return {
        id: data.id,
        success: true,
      };
    } catch (error) {
      logger.error('[API_TEST_STORAGE] Critical error saving API test execution', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        testId: params.testId,
      });
      return null; // Don't fail the test if storage fails
    }
  }

  /**
   * Get API test execution by ID
   * @param executionId - Execution record ID
   * @param userId - User ID for access control
   * @returns Execution record or null
   */
  static async getApiTestExecution(
    executionId: string,
    userId: string
  ): Promise<any | null> {
    try {
      if (!isValidUUID(executionId)) {
        logger.warn('[API_TEST_STORAGE] Invalid executionId format', { executionId });
        return null;
      }

      const { data, error } = await supabaseAdmin
        .from('api_test_executions')
        .select('*')
        .eq('id', executionId)
        .eq('user_id', userId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // Not found
          return null;
        }
        logger.error('[API_TEST_STORAGE] Failed to get API test execution', {
          error: error.message,
          executionId,
        });
        return null;
      }

      return data;
    } catch (error) {
      logger.error('[API_TEST_STORAGE] Error getting API test execution', {
        error: error instanceof Error ? error.message : String(error),
        executionId,
      });
      return null;
    }
  }

  /**
   * Get API test executions for user
   * @param userId - User ID
   * @param options - Pagination and filter options
   * @returns List of executions
   */
  static async getApiTestExecutionsByUser(
    userId: string,
    options: {
      page?: number;
      limit?: number;
      projectId?: string;
      chatSessionId?: string;
    } = {}
  ): Promise<{
    data: any[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  }> {
    try {
      const page = Math.max(1, options.page || 1);
      const limit = Math.min(100, Math.max(1, options.limit || 20));
      const offset = (page - 1) * limit;

      let query = supabaseAdmin
        .from('api_test_executions')
        .select('*', { count: 'exact' })
        .eq('user_id', userId)
        .eq('execution_type', 'chat')
        .order('executed_at', { ascending: false });

      // Apply filters
      if (options.chatSessionId) {
        query = query.eq('chat_session_id', options.chatSessionId);
      }

      // Note: projectId filter would require project_id column in api_test_executions
      // For now, we can filter by chat_session_id which has project_id in chat_sessions

      const { data, error, count } = await query.range(offset, offset + limit - 1);

      if (error) {
        logger.error('[API_TEST_STORAGE] Failed to get API test executions', {
          error: error.message,
          userId: userId.substring(0, 8) + '...',
        });
        throw error;
      }

      const totalPages = Math.ceil((count || 0) / limit);

      return {
        data: data || [],
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages,
        },
      };
    } catch (error) {
      logger.error('[API_TEST_STORAGE] Error getting API test executions', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
      });
      throw error;
    }
  }
}
