/**
 * RUN MODULE HANDLER - Module Test Execution
 *
 * Handles the 'run_module' intent detected by AI intent parser.
 * Runs all tests in a module.
 *
 * Triggered by:
 * - "run module Auth"
 * - "execute Auth module tests"
 * - "запусти модуль Auth"
 */

import { supabaseAdmin } from '@/db/supabase';
import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for run_module intent
 * Runs all tests in a module by name or ID
 */
export async function handleRunModuleIntent(
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
    logger.info('[RUN_MODULE_HANDLER] Processing run module intent', {
      intent: parsedIntent,
      userId,
    });

    const moduleId = parsedIntent?.moduleId;
    const moduleName = parsedIntent?.moduleName || parsedIntent?.target;

    let targetModuleId = moduleId;

    // Find module by name if no ID
    if (!targetModuleId && moduleName) {
      const { data: project } = await supabaseAdmin
        .from('projects')
        .select('id')
        .eq('workspace_id', workspace_id)
        .eq('user_id', userId)
        .limit(1)
        .single();

      if (project) {
        const { data: mod } = await supabaseAdmin
          .from('test_modules')
          .select('id')
          .eq('project_id', project.id)
          .ilike('name', moduleName)
          .limit(1)
          .single();

        if (mod) {
          targetModuleId = mod.id;
        }
      }
    }

    if (!targetModuleId) {
      res.json({
        success: true,
        message: userLanguage === 'ru'
          ? 'Укажите модуль для запуска. Какой модуль вы хотите запустить?'
          : 'Please specify a module to run. Which module would you like to execute?',
        data: {
          needsClarification: true,
          question: 'Which module would you like to run?',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    const result = await RegressionRunService.runModule({
      moduleId: targetModuleId,
      userId,
      trigger: 'chat',
      parameters: parsedIntent?.parameters || {},
    });

    logger.info('[RUN_MODULE_HANDLER] Module execution started', {
      runId: result.runId,
      totalTests: result.totalTests,
    });

    res.json({
      success: true,
      message: userLanguage === 'ru'
        ? `Модуль запущен. Run ID: ${result.runId}. Всего тестов: ${result.totalTests}`
        : `Module execution started. Run ID: ${result.runId}. Total tests: ${result.totalTests}`,
      data: {
        runId: result.runId,
        executionIds: result.executionIds,
        totalTests: result.totalTests,
        type: 'module',
      },
      timestamp: new Date().toISOString(),
      sessionId: params.chatSessionId,
    });
  } catch (error) {
    logger.error('[RUN_MODULE_HANDLER] Error running module', { error, userId });

    if (error instanceof ValidationError || error instanceof NotFoundError) {
      res.status(error instanceof NotFoundError ? 404 : 400).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: localized.runRegression?.error || 'Failed to run module',
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
