/**
 * ═══════════════════════════════════════════════════════════════════════════
 * ANALYZE FAILURE HANDLER - AI-Powered Failure Root-Cause Analysis
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'analyze_failure' intent detected by AI intent parser.
 * Fetches test error data and produces structured root-cause analysis
 * with fix suggestions using LLM.
 *
 * Triggered by commands like:
 * - "why did it fail?"
 * - "analyze the last failure"
 * - "почему упал тест?"
 * - "что пошло не так?"
 */

import { supabaseAdmin } from '@/db/supabase';
import { FailureAnalysisService } from '@/services/testing/analysis/failure-analysis.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for analyze_failure intent
 * Produces structured failure analysis for a test
 */
export async function handleAnalyzeFailureIntent(
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
    logger.info('[ANALYZE_FAILURE_HANDLER] Processing analyze failure intent', {
      intent: parsedIntent,
      userId,
      userLanguage,
    });

    // Extract test ID from intent (GPT populates from regression context in prompt)
    // Note: params.context is the frontend request body, NOT regression context.
    // Regression context only lives in the intent prompt — GPT extracts IDs from there.
    let sourceTestId = parsedIntent?.sourceTestId || parsedIntent?.testId;

    // Fallback: if GPT didn't populate sourceTestId, try finding last failed test
    // from this chat session directly
    if (!sourceTestId && params.chatSessionId) {
      sourceTestId = await findLastFailedTestFromSession(params.chatSessionId, userId);
    }

    if (!sourceTestId) {
      res.json({
        success: true,
        message: localized.analyzeFailure.noTestId,
        data: {
          needsClarification: true,
          question: localized.analyzeFailure.noTestId,
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    // Run analysis
    const analysis = await FailureAnalysisService.analyze(sourceTestId, userId);

    // Format response
    const suggestionsFormatted = analysis.suggestions
      .map((s, i) => `${i + 1}. ${s}`)
      .join('\n');

    const message = localized.analyzeFailure.success(
      analysis.rootCause,
      analysis.category,
      analysis.severity,
      suggestionsFormatted,
    );

    logger.info('[ANALYZE_FAILURE_HANDLER] Analysis complete', {
      testId: sourceTestId,
      category: analysis.category,
      severity: analysis.severity,
    });

    res.json({
      success: true,
      message,
      data: {
        failureAnalysis: analysis,
        testId: sourceTestId,
      },
      metadata: {
        failureAnalysis: {
          category: analysis.category,
          severity: analysis.severity,
          affectedStep: analysis.affectedStep,
        },
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[ANALYZE_FAILURE_HANDLER] Error analyzing failure', {
      error,
      userId,
      intent: parsedIntent,
    });

    res.status(500).json({
      success: false,
      error: localized.analyzeFailure.error,
      details: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Fallback: find last test with failed status from chat session messages.
 * Used when GPT didn't populate sourceTestId from the prompt context.
 */
async function findLastFailedTestFromSession(
  chatSessionId: string,
  userId: string,
): Promise<string | null> {
  try {
    const { data: messages } = await supabaseAdmin
      .from('chat_messages')
      .select('metadata')
      .eq('session_id', chatSessionId)
      .order('created_at', { ascending: false })
      .limit(30);

    if (!messages) return null;

    for (const msg of messages) {
      const meta = msg.metadata;
      if (!meta) continue;

      const isFailed =
        meta.testResult?.status === 'failed' ||
        meta.testStatus === 'failed' ||
        meta.status === 'failed';

      if (isFailed) {
        const testId = meta.testId || meta.test_id || meta.testResult?.testId;
        if (testId) return testId;
      }
    }

    // Also fall back to any last test (user might say "why did it fail" about any test)
    for (const msg of messages) {
      const meta = msg.metadata;
      if (!meta) continue;
      const testId = meta.testId || meta.test_id;
      if (testId) return testId;
    }

    return null;
  } catch (error) {
    logger.warn('[ANALYZE_FAILURE_HANDLER] Failed to find test from session', { error });
    return null;
  }
}
