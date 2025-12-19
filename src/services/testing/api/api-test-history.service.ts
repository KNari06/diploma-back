import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { ApiTestStorageService } from './api-test-storage.service';

export interface ApiTestHistoryItem {
  id: string; // testId from metadata or execution ID
  testId: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  durationMs: number;
  success: boolean;
  executedAt: string;
  chatSessionId: string;
  fuzzingReport?: {
    totalTests: number;
    passed: number;
    failed: number;
    issuesFound: number;
    securityScore: number;
    hadFollowOn?: boolean; // NEW: Indicates if follow-on phase was executed
    phases?: {
      initial?: { tests: number; issues: number };
      followOn?: { tests: number; issues: number };
    };
  };
  // NEW: Additional fields from api_test_executions
  executionId?: string; // ID from api_test_executions table
  request?: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  };
  response?: {
    status: number;
    statusText: string;
    headers?: Record<string, string>;
    body?: any;
  };
}

export interface ApiTestDetails extends ApiTestHistoryItem {
  request: {
    method: string;
    url: string;
    headers?: Record<string, string>;
    body?: any;
  };
  response: {
    status: number;
    statusText: string;
    headers: Record<string, string>;
    body: any;
  };
  metadata: {
    testType: string;
    is_test_runned: boolean;
    fuzzingReport?: any;
  };
  chatMessage: {
    id: string;
    content: string;
    created_at: string;
  };
}

/**
 * Service for retrieving API test history
 */
export class ApiTestHistoryService {
  /**
   * Get all API tests for a user (merged from api_test_executions + chat_messages)
   * NEW: Combines data from both tables for complete information
   */
  static async getApiTestsByUser(
    userId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{
    success: boolean;
    data: ApiTestHistoryItem[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    timestamp: Date;
  }> {
    try {
      const offset = (page - 1) * limit;

      // ═══════════════════════════════════════════════════════════════════
      // STEP 1: Get data from api_test_executions (primary source)
      // ═══════════════════════════════════════════════════════════════════
      let executionsData: any[] = [];
      let executionsCount = 0;

      try {
        const executionsResult = await ApiTestStorageService.getApiTestExecutionsByUser(userId, {
          page,
          limit,
        });
        executionsData = executionsResult.data || [];
        executionsCount = executionsResult.pagination.total;
      } catch (executionsError) {
        logger.warn('[API_TEST_HISTORY] Failed to get executions, falling back to chat_messages', {
          error: executionsError instanceof Error ? executionsError.message : String(executionsError),
        });
        // Continue with chat_messages fallback
      }

      // ═══════════════════════════════════════════════════════════════════
      // STEP 2: Get data from chat_messages (fallback + additional info)
      // ═══════════════════════════════════════════════════════════════════
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId);

      if (sessionsError) {
        throw new Error(`Failed to get chat sessions: ${sessionsError.message}`);
      }

      let messagesData: any[] = [];
      let messagesCount = 0;

      if (sessions && sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);

        // Get count
        const { count, error: countError } = await supabaseAdmin
          .from('chat_messages')
          .select('*', { count: 'exact', head: true })
          .in('session_id', sessionIds)
          .eq('role', 'ai')
          .not('metadata->testType', 'is', null)
          .eq('metadata->>testType', 'api')
          .not('metadata->testResult', 'is', null);

        if (!countError) {
          messagesCount = count || 0;
        }

        // Get messages
        const { data: messages, error: messagesError } = await supabaseAdmin
          .from('chat_messages')
          .select('id, session_id, content, metadata, created_at')
          .in('session_id', sessionIds)
          .eq('role', 'ai')
          .not('metadata->testType', 'is', null)
          .eq('metadata->>testType', 'api')
          .not('metadata->testResult', 'is', null)
          .order('created_at', { ascending: false })
          .range(offset, offset + limit - 1);

        if (!messagesError && messages) {
          messagesData = messages;
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // STEP 3: Merge data from both sources
      // ═══════════════════════════════════════════════════════════════════
      const mergedTests = new Map<string, ApiTestHistoryItem>();

      // Process executions (primary source - has full structured data)
      for (const execution of executionsData) {
        const testId = execution.chat_session_id
          ? `api_${execution.chat_session_id}_${new Date(execution.executed_at).getTime()}`
          : execution.id;

        const fuzzingData = execution.validation_results?.fuzzing;

        mergedTests.set(testId, {
          id: execution.id, // Use execution ID
          testId,
          method: execution.request_data?.method || 'GET',
          url: execution.request_data?.url || '',
          status: execution.status_code || 0,
          statusText: execution.response_data?.statusText || '',
          durationMs: execution.duration_ms || 0,
          success: execution.success !== false,
          executedAt: execution.executed_at,
          chatSessionId: execution.chat_session_id || '',
          executionId: execution.id, // NEW: Store execution ID
          request: execution.request_data
            ? {
                method: execution.request_data.method,
                url: execution.request_data.url,
                headers: execution.request_data.headers || {},
                body: execution.request_data.body,
              }
            : undefined,
          response: execution.response_data
            ? {
                status: execution.response_data.status,
                statusText: execution.response_data.statusText || '',
                headers: execution.response_data.headers || {},
                body: execution.response_data.body,
              }
            : undefined,
          fuzzingReport: fuzzingData
            ? {
                totalTests: fuzzingData.summary?.totalTests || 0,
                passed: fuzzingData.summary?.passed || 0,
                failed: fuzzingData.summary?.failed || 0,
                issuesFound: fuzzingData.issuesCount || 0,
                securityScore: fuzzingData.securityScore || 0,
                hadFollowOn: fuzzingData.hadFollowOn || false, // NEW
                phases: fuzzingData.phases, // NEW: Initial + Follow-on phases
              }
            : undefined,
        });
      }

      // Process chat messages (fallback + additional info for items not in executions)
      for (const msg of messagesData) {
        if (!msg.metadata?.testResult || !msg.metadata?.testId) continue;

        const testResult = msg.metadata.testResult;
        const testId = msg.metadata.testId || `api_${msg.id}`;

        // If already in mergedTests, skip (executions data is more complete)
        if (mergedTests.has(testId)) {
          continue;
        }

        // Extract URL
        let url = testResult.url || '';
        if (!url && msg.content) {
          const urlMatch = msg.content.match(/(?:URL|url):\s*(https?:\/\/[^\s\n]+)/i);
          if (urlMatch && urlMatch[1]) {
            url = urlMatch[1].trim();
          } else {
            const anyUrlMatch = msg.content.match(/(https?:\/\/[^\s\n\)]+)/i);
            if (anyUrlMatch && anyUrlMatch[1]) {
              url = anyUrlMatch[1].trim();
            }
          }
        }

        // Add from chat_messages (fallback for older tests)
        mergedTests.set(testId, {
          id: testId,
          testId,
          method: testResult.method || 'GET',
          url,
          status: testResult.status || 0,
          statusText: testResult.statusText || '',
          durationMs: testResult.durationMs || 0,
          success: testResult.success !== false,
          executedAt: msg.created_at,
          chatSessionId: msg.session_id,
          fuzzingReport: msg.metadata.fuzzingReport || undefined,
        });
      }

      // Convert to array and sort by executedAt (newest first)
      const apiTests = Array.from(mergedTests.values()).sort((a, b) => {
        return new Date(b.executedAt).getTime() - new Date(a.executedAt).getTime();
      });

      // Use max count from both sources
      const totalCount = Math.max(executionsCount, messagesCount);
      const totalPages = Math.ceil(totalCount / limit);

      logger.info('[API_TEST_HISTORY] Retrieved API tests for user (merged)', {
        userId: userId.substring(0, 8) + '...',
        count: apiTests.length,
        fromExecutions: executionsData.length,
        fromMessages: messagesData.length,
        total: totalCount,
        page,
      });

      return {
        success: true,
        data: apiTests,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error('[API_TEST_HISTORY] Failed to get API tests for user', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
      });
      throw error;
    }
  }

  /**
   * Get API test details by testId (merged from api_test_executions + chat_messages)
   * NEW: Combines data from both tables for complete information
   */
  static async getApiTestById(
    testId: string,
    userId: string
  ): Promise<{
    success: boolean;
    data: ApiTestDetails | null;
  }> {
    try {
      // ═══════════════════════════════════════════════════════════════════
      // STEP 1: Try to find in api_test_executions by chat_session_id + testId pattern
      // ═══════════════════════════════════════════════════════════════════
      let execution: any = null;

      // Extract session ID from testId if possible (format: api_planId_timestamp or api_sessionId_timestamp)
      const testIdParts = testId.split('_');
      if (testIdParts.length >= 3) {
        // Try to find by chat_session_id (testId might contain session info)
        const { data: sessions } = await supabaseAdmin
          .from('chat_sessions')
          .select('id')
          .eq('user_id', userId);

        if (sessions && sessions.length > 0) {
          const sessionIds = sessions.map(s => s.id);

          // Search in executions by chat_session_id
          const { data: executions } = await supabaseAdmin
            .from('api_test_executions')
            .select('*')
            .eq('user_id', userId)
            .eq('execution_type', 'chat')
            .in('chat_session_id', sessionIds)
            .order('executed_at', { ascending: false })
            .limit(100); // Get recent executions to match by timestamp

          if (executions && executions.length > 0) {
            // Try to match by timestamp in testId
            const timestampMatch = testId.match(/_(\d+)$/);
            if (timestampMatch) {
              const testTimestamp = parseInt(timestampMatch[1], 10);
              execution = executions.find((e: any) => {
                const execTimestamp = new Date(e.executed_at).getTime();
                // Match if timestamps are close (within 1 minute)
                return Math.abs(execTimestamp - testTimestamp) < 60000;
              });
            }

            // If no match by timestamp, try to match by session_id pattern
            if (!execution && testIdParts[1]) {
              execution = executions.find((e: any) => {
                return e.chat_session_id && testId.includes(e.chat_session_id.substring(0, 8));
              });
            }
          }
        }
      }

      // ═══════════════════════════════════════════════════════════════════
      // STEP 2: Get from chat_messages (fallback + additional info)
      // ═══════════════════════════════════════════════════════════════════
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId);

      if (sessionsError) {
        throw new Error(`Failed to get chat sessions: ${sessionsError.message}`);
      }

      let message: any = null;

      if (sessions && sessions.length > 0) {
        const sessionIds = sessions.map(s => s.id);

        // Search for API test message by testId in metadata
        const { data: msg, error: messageError } = await supabaseAdmin
          .from('chat_messages')
          .select('id, session_id, content, metadata, created_at')
          .in('session_id', sessionIds)
          .eq('role', 'ai')
          .eq('metadata->>testId', testId)
          .eq('metadata->>testType', 'api')
          .limit(1)
          .maybeSingle();

        if (messageError && messageError.code !== 'PGRST116') {
          throw new Error(`Failed to get test message: ${messageError.message}`);
        }

        message = msg;
      }

      // ═══════════════════════════════════════════════════════════════════
      // STEP 3: Merge data from both sources
      // ═══════════════════════════════════════════════════════════════════
      if (!execution && !message) {
        return { success: true, data: null };
      }

      // If we have execution, use it as primary source
      if (execution) {
        const fuzzingData = execution.validation_results?.fuzzing;

        const details: ApiTestDetails = {
          id: execution.id,
          testId,
          method: execution.request_data?.method || 'GET',
          url: execution.request_data?.url || '',
          status: execution.status_code || 0,
          statusText: execution.response_data?.statusText || '',
          durationMs: execution.duration_ms || 0,
          success: execution.success !== false,
          executedAt: execution.executed_at,
          chatSessionId: execution.chat_session_id || '',
          request: {
            method: execution.request_data?.method || 'GET',
            url: execution.request_data?.url || '',
            headers: execution.request_data?.headers || {},
            body: execution.request_data?.body,
          },
          response: {
            status: execution.response_data?.status || 0,
            statusText: execution.response_data?.statusText || '',
            headers: execution.response_data?.headers || {},
            body: execution.response_data?.body,
          },
          metadata: {
            testType: 'api',
            is_test_runned: execution.success !== false,
            fuzzingReport: fuzzingData
              ? {
                  summary: fuzzingData.summary,
                  issues: fuzzingData.issues || [],
                  securityScore: fuzzingData.securityScore,
                  hadFollowOn: fuzzingData.hadFollowOn,
                  phases: fuzzingData.phases,
                }
              : undefined,
          },
          chatMessage: message
            ? {
                id: message.id,
                content: message.content,
                created_at: message.created_at,
              }
            : {
                id: '',
                content: '',
                created_at: execution.executed_at,
              },
        };

        return { success: true, data: details };
      }

      // Fallback to chat_messages format
      if (message) {
        return this.formatTestDetails(message, userId);
      }

      return { success: true, data: null };
    } catch (error) {
      logger.error('[API_TEST_HISTORY] Failed to get API test by ID', {
        error: error instanceof Error ? error.message : String(error),
        testId,
        userId: userId.substring(0, 8) + '...',
      });
      throw error;
    }
  }

  /**
   * Format message to ApiTestDetails
   */
  private static formatTestDetails(
    message: any,
    userId: string
  ): {
    success: boolean;
    data: ApiTestDetails | null;
  } {
    if (!message.metadata?.testResult) {
      return { success: true, data: null };
    }

    const testResult = message.metadata.testResult;
    const testId = message.metadata.testId || `api_${message.id}`;

    // Extract request details
    const method = testResult.method || 'GET';

    // ✅ FIX: Extract URL from testResult, or fallback to parsing from chatMessage.content
    let url = testResult.url || '';

    // If URL is empty, try to extract from chatMessage.content
    if (!url && message.content) {
      // Look for URL pattern in content (e.g., "• URL: https://example.com" or "**URL:** https://example.com")
      const urlMatch = message.content.match(/(?:URL|url):\s*(https?:\/\/[^\s\n]+)/i);
      if (urlMatch && urlMatch[1]) {
        url = urlMatch[1].trim();
      } else {
        // Try to find any URL in the content
        const anyUrlMatch = message.content.match(/(https?:\/\/[^\s\n\)]+)/i);
        if (anyUrlMatch && anyUrlMatch[1]) {
          url = anyUrlMatch[1].trim();
        }
      }
    }

    const details: ApiTestDetails = {
      id: testId,
      testId,
      method,
      url,
      status: testResult.status || 0,
      statusText: testResult.statusText || '',
      durationMs: testResult.durationMs || 0,
      success: testResult.success !== false,
      executedAt: message.created_at,
      chatSessionId: message.session_id,
      fuzzingReport: message.metadata.fuzzingReport || undefined,
      request: {
        method,
        url,
        headers: testResult.requestHeaders || {},
        body: testResult.requestBody,
      },
      response: {
        status: testResult.status || 0,
        statusText: testResult.statusText || '',
        headers: testResult.responseHeaders || {},
        body: testResult.responseBody,
      },
      metadata: {
        testType: message.metadata.testType || 'api',
        is_test_runned: message.metadata.is_test_runned || false,
        fuzzingReport: message.metadata.fuzzingReport,
      },
      chatMessage: {
        id: message.id,
        content: message.content,
        created_at: message.created_at,
      },
    };

    return { success: true, data: details };
  }

  /**
   * Get API tests by project
   */
  static async getApiTestsByProject(
    projectId: string,
    userId: string,
    page: number = 1,
    limit: number = 20
  ): Promise<{
    success: boolean;
    data: ApiTestHistoryItem[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
    timestamp: Date;
  }> {
    try {
      // Get project's chat sessions (if project_id is stored in chat_sessions)
      // For now, get all user sessions and filter by project context
      // This is a simplified version - can be improved if project_id is added to chat_sessions

      const offset = (page - 1) * limit;

      // Get all chat sessions for user
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id, project_id')
        .eq('user_id', userId)
        .eq('project_id', projectId);

      if (sessionsError) {
        throw new Error(`Failed to get chat sessions: ${sessionsError.message}`);
      }

      if (!sessions || sessions.length === 0) {
        return {
          success: true,
          data: [],
          pagination: {
            page,
            limit,
            total: 0,
            totalPages: 0,
          },
          timestamp: new Date(),
        };
      }

      const sessionIds = sessions.map(s => s.id);

      // Get total count
      const { count, error: countError } = await supabaseAdmin
        .from('chat_messages')
        .select('*', { count: 'exact', head: true })
        .in('session_id', sessionIds)
        .eq('role', 'ai')
        .not('metadata->testType', 'is', null)
        .eq('metadata->>testType', 'api')
        .not('metadata->testResult', 'is', null);

      if (countError) {
        throw new Error(`Failed to get API test count: ${countError.message}`);
      }

      // Get API test messages
      const { data: messages, error: messagesError } = await supabaseAdmin
        .from('chat_messages')
        .select('id, session_id, content, metadata, created_at')
        .in('session_id', sessionIds)
        .eq('role', 'ai')
        .not('metadata->testType', 'is', null)
        .eq('metadata->>testType', 'api')
        .not('metadata->testResult', 'is', null)
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1);

      if (messagesError) {
        throw new Error(`Failed to get API test messages: ${messagesError.message}`);
      }

      // Transform to API test history items (same as getApiTestsByUser)
      const apiTests: ApiTestHistoryItem[] = (messages || [])
        .filter((msg: any) => msg.metadata?.testResult && msg.metadata?.testId)
        .map((msg: any) => {
          const testResult = msg.metadata.testResult;
          const testId = msg.metadata.testId || `api_${msg.id}`;
          const method = testResult.method || 'GET';

          // ✅ FIX: Extract URL from testResult, or fallback to parsing from content
          let url = testResult.url || '';
          if (!url && msg.content) {
            const urlMatch = msg.content.match(/(?:URL|url):\s*(https?:\/\/[^\s\n]+)/i);
            if (urlMatch && urlMatch[1]) {
              url = urlMatch[1].trim();
            } else {
              const anyUrlMatch = msg.content.match(/(https?:\/\/[^\s\n\)]+)/i);
              if (anyUrlMatch && anyUrlMatch[1]) {
                url = anyUrlMatch[1].trim();
              }
            }
          }

          return {
            id: testId,
            testId,
            method,
            url,
            status: testResult.status || 0,
            statusText: testResult.statusText || '',
            durationMs: testResult.durationMs || 0,
            success: testResult.success !== false,
            executedAt: msg.created_at,
            chatSessionId: msg.session_id,
            fuzzingReport: msg.metadata.fuzzingReport || undefined,
          };
        });

      const totalPages = Math.ceil((count || 0) / limit);

      return {
        success: true,
        data: apiTests,
        pagination: {
          page,
          limit,
          total: count || 0,
          totalPages,
        },
        timestamp: new Date(),
      };
    } catch (error) {
      logger.error('[API_TEST_HISTORY] Failed to get API tests by project', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        userId: userId.substring(0, 8) + '...',
      });
      throw error;
    }
  }
}
