/**
 * RUN BY TAG HANDLER - Tag-based Test Execution
 *
 * Handles the 'run_by_tag' intent detected by AI intent parser.
 * Runs all tests with a specific tag.
 *
 * Triggered by:
 * - "run critical tests"
 * - "execute smoke tests"
 * - "запусти критические тесты"
 */

import { supabaseAdmin } from '@/db/supabase';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for run_by_tag intent
 * Runs all tests with a specific tag
 */
export async function handleRunByTagIntent(
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
  const { parsedIntent, userId, workspace_id } = params;

  const userLanguage = parsedIntent?.userLanguage || 'neutral';
  const localized = getLocalizedMessages(userLanguage);

  try {
    logger.info('[RUN_BY_TAG_HANDLER] Processing run by tag intent', {
      intent: parsedIntent,
      userId,
    });

    const tag = parsedIntent?.tag || parsedIntent?.target;

    if (!tag) {
      res.json({
        success: true,
        message: userLanguage === 'ru'
          ? 'Укажите тег для запуска. Какой тег?'
          : 'Please specify a tag to run. Which tag?',
        data: {
          needsClarification: true,
          question: 'Which tag would you like to run tests for?',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    // Get project from workspace
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('id')
      .eq('workspace_id', workspace_id)
      .eq('user_id', userId)
      .limit(1)
      .single();

    if (!project) {
      throw new NotFoundError('Project', workspace_id);
    }

    const result = await RegressionRunService.runByTag({
      projectId: project.id,
      tag,
      userId,
      trigger: 'chat',
    });

    logger.info('[RUN_BY_TAG_HANDLER] Tag execution started', {
      runId: result.runId,
      totalTests: result.totalTests,
      tag,
    });

    res.json({
      success: true,
      message: userLanguage === 'ru'
        ? `Тесты с тегом "${tag}" запущены. Run ID: ${result.runId}. Всего: ${result.totalTests}`
        : `Tests with tag "${tag}" started. Run ID: ${result.runId}. Total: ${result.totalTests}`,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        tag,
        type: 'tag',
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[RUN_BY_TAG_HANDLER] Error running by tag', { error, userId });

    if (error instanceof ValidationError || error instanceof NotFoundError) {
      res.status(error instanceof NotFoundError ? 404 : 400).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: localized.runRegression?.error || 'Failed to run by tag',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
