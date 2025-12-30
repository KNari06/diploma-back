/**
 * ═══════════════════════════════════════════════════════════════════════════
 * CREATE SUITE HANDLER - Regression Suite Creation
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Handles the 'create_suite' intent detected by AI intent parser.
 * Creates a regression suite from multiple saved test cases.
 *
 * Flow:
 * 1. Extract suiteName and testCaseIds from parsedIntent
 * 2. Validate test case IDs exist and belong to user
 * 3. Get project ID from first test case
 * 4. Call RegressionSaveService to create suite
 * 5. Return localized success message
 *
 * Triggered by commands like:
 * - "create suite from these tests"
 * - "make a regression suite"
 * - "создай набор из этих тестов"
 */

import { supabaseAdmin } from '@/db/supabase';
import { RegressionSaveService } from '@/services/testing/regression/regression-save.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';
import { getLocalizedMessages } from './localization';

/**
 * Handler for create_suite intent
 * Creates a regression suite from multiple saved test cases
 *
 * @param req - Express request object
 * @param res - Express response object
 * @param params - Handler parameters from routing system
 * @param params.parsedIntent - Parsed intent from AI (contains suiteName, testCaseIds)
 * @param params.userId - User ID for creating suite
 */
export async function handleCreateSuiteIntent(
  req: Request,
  res: Response,
  params: {
    message: string;
    parsedIntent?: {
      intent?: 'create_suite';
      suiteName?: string;
      testCaseIds?: string[];
      userLanguage?: string;
      metadata?: {
        userLanguage?: string;
      };
    };
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
    logger.info('[CREATE_SUITE_HANDLER] Processing create suite intent', {
      intent: parsedIntent,
      userId,
      userLanguage,
    });

    // Extract parameters from parsed intent
    const suiteName = parsedIntent?.suiteName;
    const testCaseIds = parsedIntent?.testCaseIds || [];

    // Deduplicate and limit test case IDs
    const MAX_TEST_CASES_PER_SUITE = 50;

    const uniqueTestCaseIds = Array.from(new Set(testCaseIds));

    if (uniqueTestCaseIds.length > MAX_TEST_CASES_PER_SUITE) {
      throw new ValidationError(
        `Too many test cases for a single suite (max ${MAX_TEST_CASES_PER_SUITE})`
      );
    }

    // Validate test case IDs - return clarification instead of throwing error
    if (!uniqueTestCaseIds || uniqueTestCaseIds.length === 0) {
      res.json({
        success: true,
        message: localized.createSuite.noTestCases,
        data: {
          needsClarification: true,
          question: 'Which saved test cases should be included in the suite? Please provide test case IDs.',
        },
      });
      return;
    }

    // Use supabaseAdmin to bypass RLS - handler already verified user auth
    const { data: testCases, error: testCasesError } = await supabaseAdmin
      .from('saved_test_cases')
      .select('id, project_id')
      .in('id', uniqueTestCaseIds)
      .eq('user_id', userId);

    if (testCasesError || !testCases || testCases.length !== uniqueTestCaseIds.length) {
      throw new ValidationError('One or more test cases are invalid or do not belong to the user');
    }

    const projectIds = Array.from(new Set(testCases.map(tc => tc.project_id)));

    if (projectIds.length !== 1) {
      throw new ValidationError('All test cases in a suite must belong to the same project');
    }

    const projectId = projectIds[0];

    // Generate suite name if not provided
    const suiteNameFinal = suiteName || `Suite created on ${new Date().toISOString().split('T')[0]}`;

    // Create suite
    const result = await RegressionSaveService.createSuite({
      projectId,
      userId,
      name: suiteNameFinal,
      testCaseIds: uniqueTestCaseIds,
    });

    logger.info('[CREATE_SUITE_HANDLER] Suite created successfully', {
      suiteId: result.suiteId,
      testCaseCount: uniqueTestCaseIds.length,
    });

    // Return success response
    res.json({
      success: true,
      message: localized.createSuite.success(suiteNameFinal, result.suiteId, uniqueTestCaseIds.length),
      data: {
        suiteId: result.suiteId,
        projectId,
        name: suiteNameFinal,
        testCaseCount: uniqueTestCaseIds.length,
        testCaseIds: uniqueTestCaseIds,
      },
    });
  } catch (error) {
    logger.error('[CREATE_SUITE_HANDLER] Error creating suite', {
      error,
      userId,
      suiteName: parsedIntent?.suiteName,
      testCaseCount: parsedIntent?.testCaseIds?.length,
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
      error: localized.createSuite.error,
      details: error instanceof Error ? error.message : 'Unknown error',
    });
  }
}
