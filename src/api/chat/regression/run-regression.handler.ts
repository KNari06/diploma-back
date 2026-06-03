/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN REGRESSION HANDLER - Regression Test Execution
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'run_regression' intent detected by AI intent parser.
 * Executes a saved test case OR a regression plan.
 *
 * Flow:
 * 1. Extract savedTestCaseId from parsedIntent
 * 2. Validate an ID is provided
 * 3. Try running as intent_test_case first
 * 4. If not found → check if ID is a regression_plan and run as plan
 * 5. Return localized success message with run ID
 *
 * The intent parser sometimes classifies "run plan X" as run_regression
 * with savedTestCaseId=X (instead of run_plan with planId=X).
 * This handler gracefully handles both cases by auto-detecting the entity type.
 *
 * Triggered by commands like:
 * - "run saved test abc123"
 * - "execute the checkout regression"
 * - "запусти сохраненный тест"
 * - "вот это 60e7beb5-..." (after listing plans)
 */

import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for run_regression intent
 * Runs a saved test case or regression plan (auto-detected)
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param params - Handler parameters from routing system
 * @param params.parsedIntent - Parsed intent from AI (contains savedTestCaseId)
 * @param params.userId - User ID for running regression
 */
export async function handleRunRegressionIntent(
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

  // Get user language from parsed intent (defaults to neutral)
  const userLanguage = parsedIntent?.userLanguage || parsedIntent?.metadata?.userLanguage || 'neutral';
  const localized = getLocalizedMessages(userLanguage);

  try {
    logger.info('[RUN_REGRESSION_HANDLER] Processing run regression intent', {
      intent: parsedIntent,
      userId,
      userLanguage,
    });

    // Extract parameters from parsed intent
    const savedTestCaseId = parsedIntent?.savedTestCaseId;

    // Validate we have a test case ID
    if (!savedTestCaseId) {
      res.json({
        success: true,
        message: localized.runRegression.noId,
        data: {
          needsClarification: true,
          question: 'Which saved test would you like to run? Please provide a test case ID.',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    }

    let result: { runId: string; testId?: string; testIds?: string[]; totalTests?: number; executionIds?: string[] };

    // Try running as saved test case first
    try {
      result = await RegressionRunService.runSavedTestCase({
        savedTestCaseId,
        userId,
        trigger: 'chat',
        // Honor a browser override the user requested ("run it on firefox").
        // env/device/build modifiers are not yet plumbed into the runner.
        browserOverride: parsedIntent?.executionModifiers?.browser,
      });

      logger.info('[RUN_REGRESSION_HANDLER] Saved test case started', {
        runId: result.runId,
        testId: result.testId,
      });

      res.json({
        success: true,
        message: localized.runRegression.testStarted(result.runId, result.testId!),
        data: {
          runId: result.runId,
          testId: result.testId,
          type: 'saved_test_case',
        },
        timestamp: new Date().toISOString(),
        sessionId: params.chatSessionId,
      });
      return;
    } catch (testCaseError) {
      // If not found as test case → check if it's a regression plan
      if (testCaseError instanceof NotFoundError) {
        logger.info('[RUN_REGRESSION_HANDLER] ID not found as test case, trying as regression plan', {
          id: savedTestCaseId,
        });

        try {
          const planResult = await RegressionRunService.runPlan({
            planId: savedTestCaseId,
            userId,
            trigger: 'chat',
          });

          logger.info('[RUN_REGRESSION_HANDLER] Regression plan started (auto-detected from run_regression intent)', {
            runId: planResult.runId,
            totalTests: planResult.totalTests,
          });

          const planMsg = userLanguage === 'ru'
            ? `План запущен! Run ID: ${planResult.runId}. Всего тестов: ${planResult.totalTests}`
            : `Plan execution started! Run ID: ${planResult.runId}. Total tests: ${planResult.totalTests}`;

          res.json({
            success: true,
            message: planMsg,
            data: {
              runId: planResult.runId,
              executionIds: planResult.executionIds,
              totalTests: planResult.totalTests,
              type: 'plan',
            },
            timestamp: new Date().toISOString(),
            sessionId: params.chatSessionId,
          });
          return;
        } catch (planError) {
          // If also not found as plan → throw original NotFoundError with helpful message
          if (planError instanceof NotFoundError) {
            logger.warn('[RUN_REGRESSION_HANDLER] ID not found as test case or plan', {
              id: savedTestCaseId,
            });

            const notFoundMsg = userLanguage === 'ru'
              ? `Не найден тест-кейс или регрессионный план с ID ${savedTestCaseId}. Проверьте ID и попробуйте снова.`
              : `No test case or regression plan found with ID ${savedTestCaseId}. Please verify the ID and try again.`;

            res.status(404).json({
              success: false,
              error: notFoundMsg,
            });
            return;
          }
          // Other plan errors — re-throw to outer catch
          throw planError;
        }
      }
      // Non-NotFoundError from test case attempt — re-throw to outer catch
      throw testCaseError;
    }
  } catch (error) {
    logger.error('[RUN_REGRESSION_HANDLER] Error running regression', {
      error,
      userId,
      intent: parsedIntent,
    });

    if (error instanceof ValidationError) {
      res.status(400).json({
        success: false,
        error: error.message,
      });
      return;
    }

    if (error instanceof NotFoundError) {
      res.status(404).json({
        success: false,
        error: error.message,
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: localized.runRegression.error,
      details: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
    });
  }
}
