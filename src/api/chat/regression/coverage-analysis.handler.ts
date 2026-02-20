/**
 * ═══════════════════════════════════════════════════════════════════════════
 * COVERAGE ANALYSIS HANDLER - DB-based Coverage Gap Detection
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'coverage_analysis' intent detected by AI intent parser.
 * Analyzes project test coverage (no test execution) and reports gaps.
 *
 * Triggered by commands like:
 * - "what's not covered?"
 * - "coverage analysis"
 * - "покажи покрытие"
 * - "что не покрыто?"
 */

import { supabaseAdmin } from '@/db/supabase';
import { CoverageAnalysisService } from '@/services/testing/analysis/coverage-analysis.service';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for coverage_analysis intent
 * Returns a coverage report with score, gaps, and LLM summary
 */
export async function handleCoverageAnalysisIntent(
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
    logger.info('[COVERAGE_ANALYSIS_HANDLER] Processing coverage analysis intent', {
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
        message: localized.coverageAnalysis.noProject,
        data: {
          needsClarification: true,
          question: localized.coverageAnalysis.noProject,
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    // Run coverage analysis
    const report = await CoverageAnalysisService.analyze(
      projectId,
      userId,
      params.workspace_id,
    );

    // Format gaps as markdown list
    const gapList = report.gaps.length > 0
      ? report.gaps.slice(0, 10).map((g, i) => {
          const badge = g.priority === 'high' ? '🔴' : g.priority === 'medium' ? '🟡' : '🟢';
          const urlPart = g.url ? `\n   URL: ${g.url}` : '';
          return `${i + 1}. ${badge} **${g.title}**\n   ${g.description}${urlPart}`;
        }).join('\n\n')
      : 'No coverage gaps found — great job!';

    const scoreBadge = report.score >= 80 ? '🟢' : report.score >= 50 ? '🟡' : '🔴';

    const message = localized.coverageAnalysis.success(
      scoreBadge,
      report.score,
      report.coveredUrls,
      report.totalUrls,
      report.totalTestCases,
      report.staleTestCases,
      gapList,
      report.summary,
    );

    logger.info('[COVERAGE_ANALYSIS_HANDLER] Coverage report generated', {
      projectId,
      score: report.score,
      gapCount: report.gaps.length,
    });

    res.json({
      success: true,
      message,
      data: {
        coverageAnalysis: report,
      },
      metadata: {
        coverageScore: report.score,
        totalUrls: report.totalUrls,
        coveredUrls: report.coveredUrls,
        gapCount: report.gaps.length,
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[COVERAGE_ANALYSIS_HANDLER] Error generating coverage report', {
      error,
      userId,
      intent: parsedIntent,
    });

    res.status(500).json({
      success: false,
      error: localized.coverageAnalysis.error,
      details: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Fallback: get project_id from chat session record
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
    logger.warn('[COVERAGE_ANALYSIS_HANDLER] Failed to get projectId from session', { error });
    return null;
  }
}
