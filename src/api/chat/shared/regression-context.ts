/**
 * ═══════════════════════════════════════════════════════════════════════════
 * REGRESSION CONTEXT BUILDER
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Builds context about recent tests, saved test cases, and regression suites
 * to help AI intent parser understand user's regression-related requests.
 *
 * This context is injected into the intent parsing prompt so AI can:
 * - Know which test to save when user says "save this"
 * - Understand available saved cases and suites
 * - Provide better intent detection for regression commands
 */

import { IntentParserContext } from '@/ai/prompts';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

/**
 * Build regression context for intent parsing
 * Collects information about recent tests, saved cases, and suites
 * to help AI determine if user wants to save/run tests
 *
 * @param params - Context building parameters
 * @param params.chatSessionId - Optional chat session ID to get recent tests
 * @param params.userId - User ID for filtering saved cases/suites
 * @param params.projectId - Optional project ID for filtering
 * @returns Partial IntentParserContext with regression-related fields
 */
export async function buildRegressionContext(params: {
  chatSessionId?: string;
  userId: string;
  projectId?: string;
}): Promise<Partial<IntentParserContext>> {
  const { chatSessionId, userId, projectId } = params;

  try {
    // Run all DB queries in parallel for ~4x speedup
    const [lastTest, savedCasesCount, suitesCount, recentTestIds] = await Promise.all([
      chatSessionId ? getLastTestFromSession(chatSessionId, userId, projectId) : null,
      projectId ? getSavedCasesCount(projectId, userId) : 0,
      projectId ? getSuitesCount(projectId, userId) : 0,
      chatSessionId ? getRecentTestIds(chatSessionId) : [],
    ]);

    return {
      lastTestId: lastTest?.id,
      lastTestGoal: lastTest?.goal,
      savedCasesCount,
      suitesCount,
      recentTestIds,
    };
  } catch (error) {
    logger.error('[REGRESSION_CONTEXT] Error building context', { error });
    // Return empty context on error (graceful degradation)
    return {};
  }
}

/**
 * Get last test from chat session
 * Searches recent chat messages for test IDs in metadata or content
 * Used to determine which test user wants to save when they say "save this"
 *
 * @param chatSessionId - Chat session ID to search
 * @param userId - User ID for ownership verification
 * @param projectId - Optional project ID for additional filtering
 * @returns Test ID and goal if found, null otherwise
 */
async function getLastTestFromSession(
  chatSessionId: string,
  userId: string,
  projectId?: string
): Promise<{ id: string; goal?: string } | null> {
  try {
    // Get recent messages from this chat session
    // Note: chat_messages table uses 'session_id' not 'chat_session_id'
    // Use supabaseAdmin to bypass RLS - context building is server-side only
    const { data: messages, error } = await supabaseAdmin
      .from('chat_messages')
      .select('content, metadata')
      .eq('session_id', chatSessionId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    if (!messages || messages.length === 0) return null;

    // Look for test IDs in messages (in metadata or content)
    for (const msg of messages) {
      // Check metadata for testId
      if (msg.metadata?.testId) {
        return {
          id: msg.metadata.testId,
          goal: msg.metadata.testGoal || msg.metadata.goal,
        };
      }

      // Check metadata for test_id
      if (msg.metadata?.test_id) {
        return {
          id: msg.metadata.test_id,
          goal: msg.metadata.test_goal || msg.metadata.goal,
        };
      }

      // Check content for UUID pattern (test ID)
      const uuidRegex = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
      const match = msg.content?.match(uuidRegex);
      if (match) {
        // Verify it's actually a test ID AND belongs to the user
        // Join with projects to verify ownership
        const { data: test } = await supabaseAdmin
          .from('tests')
          .select('id, goal, project_id, projects!inner(user_id)')
          .eq('id', match[0])
          .single();

        // Check ownership (projects is returned as an object when using single())
        if (test && (test.projects as any)?.user_id === userId) {
          // Optional: Also verify project_id matches if provided
          if (projectId && test.project_id !== projectId) {
            logger.warn('[REGRESSION_CONTEXT] Test belongs to different project', {
              testId: test.id,
              testProjectId: test.project_id,
              expectedProjectId: projectId,
            });
            continue; // Skip this test, it's from a different project
          }

          return { id: test.id, goal: test.goal };
        }
      }
    }

    return null;
  } catch (error) {
    logger.warn('[REGRESSION_CONTEXT] Error getting last test from session', { error });
    return null;
  }
}

/**
 * Get count of intent test cases for a project
 * Now counts from intent_test_cases (unified table).
 * Used to provide context about available tests.
 *
 * @param projectId - Project ID to count intent cases for
 * @param userId - User ID for filtering
 * @returns Number of intent test cases (0 on error)
 */
async function getSavedCasesCount(
  projectId: string,
  userId: string
): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from('intent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (error) throw error;
    return count || 0;
  } catch (error) {
    logger.warn('[REGRESSION_CONTEXT] Error getting intent test cases count', { error });
    return 0;
  }
}

/**
 * Get count of regression suites for a project
 * Used to provide context about available suites
 *
 * @param projectId - Project ID to count suites for
 * @param userId - User ID for filtering
 * @returns Number of regression suites (0 on error)
 */
async function getSuitesCount(projectId: string, userId: string): Promise<number> {
  try {
    const { count, error } = await supabaseAdmin
      .from('regression_suites')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('user_id', userId);

    if (error) throw error;
    return count || 0;
  } catch (error) {
    logger.warn('[REGRESSION_CONTEXT] Error getting suites count', { error });
    return 0;
  }
}

/**
 * Get recent test IDs from chat session
 * Extracts test IDs from recent messages metadata
 * Used to provide context about which tests user has been working with
 *
 * @param chatSessionId - Chat session ID to search
 * @param userId - User ID (for future filtering if needed)
 * @returns Array of up to 5 most recent test IDs
 */
async function getRecentTestIds(
  chatSessionId: string
): Promise<string[]> {
  try {
    // Note: chat_messages table uses 'session_id' not 'chat_session_id'
    const { data: messages, error } = await supabaseAdmin
      .from('chat_messages')
      .select('metadata')
      .eq('session_id', chatSessionId)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) throw error;
    if (!messages) return [];

    const testIds = new Set<string>();

    for (const msg of messages) {
      if (msg.metadata?.testId) testIds.add(msg.metadata.testId);
      if (msg.metadata?.test_id) testIds.add(msg.metadata.test_id);

      if (testIds.size >= 5) break; // Limit to 5 most recent
    }

    return Array.from(testIds);
  } catch (error) {
    logger.warn('[REGRESSION_CONTEXT] Error getting recent test IDs', { error });
    return [];
  }
}
