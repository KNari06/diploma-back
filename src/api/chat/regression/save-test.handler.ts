/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SAVE TEST HANDLER - Regression Test Saving
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'save_test' intent detected by AI intent parser.
 * Saves a completed test flow as a reusable regression test case.
 *
 * Flow:
 * 1. Extract sourceTestId from parsedIntent (from context or user message)
 * 2. Extract or generate test name
 * 3. Call RegressionSaveService to save test case
 * 4. Return localized success message
 *
 * Triggered by commands like:
 * - "save this flow"
 * - "save as checkout test"
 * - "сохрани этот тест"
 */

import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for save_test intent
 * Saves current/last test flow for replay as a regression test case
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param params - Handler parameters from routing system
 * @param params.parsedIntent - Parsed intent from AI (contains sourceTestId, suggestedName)
 * @param params.userId - User ID for saving test case
 */
export async function handleSaveTestIntent(
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
    logger.info('[SAVE_TEST_HANDLER] Processing save test intent', {
      intent: parsedIntent,
      userId,
      userLanguage,
    });

    // Extract parameters from parsed intent
    const sourceTestId = parsedIntent?.sourceTestId;
    const suggestedName = parsedIntent?.suggestedName;

    // Validate source test ID
    if (!sourceTestId) {
      res.json({
        success: true,
        message: localized.saveTest.noTestId,
        data: {
          needsClarification: true,
          question: 'Which test would you like to save? Please run a test first or provide a test ID.',
        },
      });
      return;
    }

    // Generate name if not provided
    const testName = suggestedName || `Test saved on ${new Date().toISOString().split('T')[0]}`;

    // Save test case
    const result = await RegressionSaveService.saveTestCase({
      sourceTestId,
      userId,
      name: testName,
      kind: 'standalone',
    });

    logger.info('[SAVE_TEST_HANDLER] Test saved successfully', {
      savedTestCaseId: result.savedTestCaseId,
      projectId: result.projectId,
    });

    // Return success response
    res.json({
      success: true,
      message: localized.saveTest.success(testName, result.savedTestCaseId, result.parametersCount),
      data: {
        savedTestCaseId: result.savedTestCaseId,
        projectId: result.projectId,
        name: testName,
        replayStrategy: result.replayStrategy,
        parametersCount: result.parametersCount,
      },
    });
  } catch (error) {
    logger.error('[SAVE_TEST_HANDLER] Error saving test', {
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
      error: localized.saveTest.error,
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
