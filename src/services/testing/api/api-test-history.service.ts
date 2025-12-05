import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/logger';

export interface ApiTestHistoryItem {
  id: string; // testId from metadata
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
   * Get all API tests for a user (from chat messages)
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

      // Get all chat sessions for user
      const { data: sessions, error: sessionsError } = await supabaseAdmin
        .from('chat_sessions')
        .select('id')
        .eq('user_id', userId);

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

      // Get total count of API test messages
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

      // Get API test messages with pagination
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

      // Transform messages to API test history items
      const apiTests: ApiTestHistoryItem[] = (messages || [])
        .filter((msg: any) => {
          // Validate that message has required metadata
          return msg.metadata?.testResult && msg.metadata?.testId;
        })
        .map((msg: any) => {
          const testResult = msg.metadata.testResult;
          const testId = msg.metadata.testId || `api_${msg.id}`;

          // Extract request details from testResult
          const method = testResult.method || 'GET';
          const url = testResult.url || '';

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

      logger.info('[API_TEST_HISTORY] Retrieved API tests for user', {
        userId: userId.substring(0, 8) + '...',
        count: apiTests.length,
        total: count || 0,
        page,
      });

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
      logger.error('[API_TEST_HISTORY] Failed to get API tests for user', {
        error: error instanceof Error ? error.message : String(error),
        userId: userId.substring(0, 8) + '...',
      });
      throw error;
    }
  }

  /**
   * Get API test details by testId
   */
  static async getApiTestById(
    testId: string,
    userId: string
  ): Promise<{
    success: boolean;
    data: ApiTestDetails | null;
  }> {
    try {
      // Find test-chat mapping
      const { data: mapping, error: mappingError } = await supabaseAdmin
        .from('test_chat_mappings')
        .select('chat_session_id, user_id')
        .eq('test_id', testId)
        .eq('user_id', userId)
        .maybeSingle();

      if (mappingError && mappingError.code !== 'PGRST116') {
        throw new Error(`Failed to find test mapping: ${mappingError.message}`);
      }

      if (!mapping) {
        // Fallback: search in chat_messages directly
        const { data: sessions } = await supabaseAdmin
          .from('chat_sessions')
          .select('id')
          .eq('user_id', userId);

        if (!sessions || sessions.length === 0) {
          return { success: true, data: null };
        }

        const sessionIds = sessions.map(s => s.id);

        const { data: messages } = await supabaseAdmin
          .from('chat_messages')
          .select('id, session_id, content, metadata, created_at')
          .in('session_id', sessionIds)
          .eq('role', 'ai')
          .eq('metadata->>testId', testId)
          .eq('metadata->>testType', 'api')
          .limit(1)
          .maybeSingle();

        if (!messages) {
          return { success: true, data: null };
        }

        return this.formatTestDetails(messages, userId);
      }

      // Get message from chat session
      const { data: message, error: messageError } = await supabaseAdmin
        .from('chat_messages')
        .select('id, session_id, content, metadata, created_at')
        .eq('session_id', mapping.chat_session_id)
        .eq('role', 'ai')
        .eq('metadata->>testId', testId)
        .eq('metadata->>testType', 'api')
        .limit(1)
        .maybeSingle();

      if (messageError && messageError.code !== 'PGRST116') {
        throw new Error(`Failed to get test message: ${messageError.message}`);
      }

      if (!message) {
        return { success: true, data: null };
      }

      return this.formatTestDetails(message, userId);
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
    const url = testResult.url || '';

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
          const url = testResult.url || '';

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
