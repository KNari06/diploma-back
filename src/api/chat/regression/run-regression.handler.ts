/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RUN REGRESSION HANDLER - Regression Test Execution
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'run_regression' intent detected by AI intent parser.
 * Executes a saved test case.
 *
 * Flow:
 * 1. Extract savedTestCaseId from parsedIntent
 * 2. Validate an ID is provided
 * 3. Call RegressionRunService to execute test
 * 4. Return localized success message with run ID
 *
 * Triggered by commands like:
 * - "run saved test abc123"
 * - "execute the checkout regression"
 * - "запусти сохраненный тест"
 */

import { RegressionRunService } from '@/services/testing/regression/regression-run.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for run_regression intent
 * Runs a saved test case
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

    let result: { runId: string; testId?: string; testIds?: string[] };

    // Run saved test case
    if (savedTestCaseId) {
      result = await RegressionRunService.runSavedTestCase({
        savedTestCaseId,
        userId,
        trigger: 'chat',
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
