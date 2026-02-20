/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TEST RECOMMENDATIONS HANDLER - AI-Powered Test Suggestions
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'test_recommendations' intent detected by AI intent parser.
 * Analyzes project test history and suggests what to test next.
 *
 * Triggered by commands like:
 * - "what should I test?"
 * - "suggest tests"
 * - "что протестировать?"
 * - "рекомендации по тестам"
 */

import { supabaseAdmin } from '@/db/supabase';
import { TestRecommendationService } from '@/services/testing/analysis/test-recommendation.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for test_recommendations intent
 * Returns AI-powered test recommendations for the user's project
 */
export async function handleTestRecommendationsIntent(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: any;
    userId: string;
    workspace_id: string;
    chatSessionId?: string;
    conversationId?: string;
    answers?: Record<string, any>;
    context?: any;
    abortSignal?: AbortSignal;
  }
): Promise<void> {
  const { parsedIntent, userId } = params;

  const userLanguage = parsedIntent?.userLanguage || parsedIntent?.metadata?.userLanguage || 'neutral';
  const localized = getLocalizedMessages(userLanguage);

  try {
    logger.info('[TEST_RECOMMENDATIONS_HANDLER] Processing recommendations intent', {
      intent: parsedIntent,
      userId,
      userLanguage,
    });

    // Get project ID: try frontend context, then parsedIntent, then look up from chat session
    let projectId = params.context?.projectId || parsedIntent?.projectId;

    if (!projectId && params.chatSessionId) {
      projectId = await getProjectIdFromSession(params.chatSessionId);
    }

    if (!projectId) {
      res.json({
        success: true,
        message: localized.testRecommendations.noProject,
        data: {
          needsClarification: true,
          question: localized.testRecommendations.noProject,
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    // Get recommendations
    const recommendations = await TestRecommendationService.getRecommendations(
      projectId,
      userId,
      params.workspace_id,
    );

    // Format as numbered markdown list
    const formattedList = recommendations
      .map((r, i) => {
        const priorityBadge = r.priority === 'high' ? '🔴' : r.priority === 'medium' ? '🟡' : '🟢';
        const urlPart = r.url ? `\n   URL: ${r.url}` : '';
        return `${i + 1}. ${priorityBadge} **${r.title}**\n   ${r.reason}${urlPart}`;
      })
      .join('\n\n');

    const message = localized.testRecommendations.success(formattedList);

    logger.info('[TEST_RECOMMENDATIONS_HANDLER] Recommendations generated', {
      projectId,
      count: recommendations.length,
    });

    res.json({
      success: true,
      message,
      data: {
        recommendations,
      },
      metadata: {
        recommendations: recommendations.map(r => ({
          type: r.type,
          priority: r.priority,
          relatedTestCaseId: r.relatedTestCaseId,
        })),
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[TEST_RECOMMENDATIONS_HANDLER] Error generating recommendations', {
      error,
      userId,
      intent: parsedIntent,
    });

    res.status(500).json({
      success: false,
      error: localized.testRecommendations.error,
      details: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Fallback: get project_id from chat session record.
 * The intent parsing logic fetches this but doesn't pass it to handlers,
 * so we look it up independently.
 */
async function getProjectIdFromSession(chatSessionId: string): Promise<string | null> {
  try {
    const { data } = await supabaseAdmin
      .from('chat_sessions')
      .select('project_id')
      .eq('id', chatSessionId)
      .maybeSingle();

    return data?.project_id || null;
  } catch (error) {
    logger.warn('[TEST_RECOMMENDATIONS_HANDLER] Failed to get projectId from session', { error });
    return null;
  }
}
