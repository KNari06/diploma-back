import { Request, Response } from 'express';
import { logger } from '@/utils/logger';
import { CreditCostTrackerService } from '@/services/core/credit-cost-tracker.service';
import { getTestPlan } from '@/services/testing/plans/exploration-cache.service';
import { ChatService } from '@/services/utils/chat.service';
import { executeApiTestFlow } from '../api_test/execution';
import { executeUiTestFlow } from '../ai_test/execution';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: VALIDATE TEST PLAN
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function validateTestPlan(
  planId: string,
  userId: string,
  res: Response
): Promise<any | null> {
  const plan = await getTestPlan(planId, userId);

  if (!plan) {
    res.status(404).json({
      success: false,
      error: 'Test plan not found or expired',
      timestamp: new Date().toISOString(),
    });
    return null;
  }

  return plan;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: DETERMINE TEST TYPE
 * ═══════════════════════════════════════════════════════════════════════════
 * ✅ UPDATED: Standard mode removed - only API and Intelligent modes supported
 */
export function determineTestType(plan: any): 'api' | 'intelligent' {
  if (!plan) {
    logger.warn('[DETERMINE_TYPE] Plan is null/undefined, defaulting to intelligent');
    return 'intelligent';
  }

  // Check if API test (priority 1)
  const isApiTest = plan.scope === 'api_test' || (plan.metadata?.type === 'api_test');

  if (isApiTest) {
    logger.debug('[DETERMINE_TYPE] Detected API test', {
      scope: plan.scope,
      metadataType: plan.metadata?.type
    });
    return 'api';
  }

  // All UI tests are intelligent mode (Standard mode removed)
  logger.debug('[DETERMINE_TYPE] Detected intelligent test (default for UI tests)');
  return 'intelligent';
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: CHECK CREDITS BEFORE TEST
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function checkCreditsBeforeTest(
  userId: string,
  testType: 'api' | 'intelligent',
  res: Response
): Promise<boolean> {
  const creditCheck = await CreditCostTrackerService.checkCreditsForTest(userId, testType);

  if (!creditCheck.hasEnough) {
    logger.warn('[EXECUTE] Insufficient credits for test', {
      userId,
      testType,
      required: creditCheck.required,
      available: creditCheck.available,
      shortage: creditCheck.shortage,
    });

    res.status(402).json({
      success: false,
      error: 'Insufficient credits',
      message: `You need ${creditCheck.required} credits to run this test. You have ${creditCheck.available} credits. Please purchase ${creditCheck.shortage} more credits.`,
      required: creditCheck.required,
      available: creditCheck.available,
      shortage: creditCheck.shortage,
      timestamp: new Date().toISOString(),
    });
    return false;
  }

  logger.info('[EXECUTE] Credit check passed', {
    userId,
    testType,
    required: creditCheck.required,
    available: creditCheck.available,
  });

  return true;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: HANDLE EXECUTION ERROR
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function handleExecutionError(
  error: unknown,
  res: Response,
  params: { planId: string; chatSessionId?: string }
): Promise<void> {
  const { planId, chatSessionId } = params;

  logger.error('❌ [EXECUTE] CRITICAL ERROR executing test plan', {
    error,
    planId,
    errorMessage: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });

  const errorMessage = error instanceof Error && error.message
    ? error.message
    : (error ? String(error) : 'An unexpected error occurred');

  // Check if response already sent
  if (res.headersSent) {
    logger.warn('[EXECUTE] Response already sent, cannot send error response', {
      planId,
      errorMessage,
    });
    return;
  }

  // Save error to chat history (non-blocking)
  if (chatSessionId) {
    ChatService.saveChatMessages(chatSessionId, [
      { role: 'user', content: 'Approved test execution' },
      { role: 'ai', content: `❌ Error executing test: ${errorMessage}` },
    ]).catch(saveError => {
      logger.error('[EXECUTE] Failed to save error message to chat', {
        saveError: saveError instanceof Error ? saveError.message : String(saveError),
        planId,
      });
    });
  }

  // Send error response
  res.status(500).json({
    success: false,
    error: 'Failed to execute test plan',
    message: errorMessage,
    timestamp: new Date().toISOString(),
  });
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * HELPER: EXECUTE APPROVED TEST PLAN (REFACTORED)
 * ═══════════════════════════════════════════════════════════════════════════
 * Orchestrates test plan execution flow:
 * 1. Validate test plan
 * 2. Check credits
 * 3. Route to API or UI test flow
 * 4. Handle errors
 */
export async function executeApprovedTestPlan(
  req: Request,
  res: Response,
  params: {
    planId: string;
    userId: string;
    chatSessionId?: string;
    workspace_id: string;
    userMessage?: string; // FIX #14: Actual user message for chat history
  }
): Promise<void> {
  const { planId, userId, chatSessionId, workspace_id, userMessage } = params;

  logger.info('🚀 [EXECUTE] Test plan approved', {
    planId,
    userId,
    chatSessionId,
    timestamp: new Date().toISOString()
  });

  try {
    // STEP 1: Validate test plan
    const plan = await validateTestPlan(planId, userId, res);
    if (!plan) return; // Response already sent

    // STEP 2: Determine test type
    const testType = determineTestType(plan);
    const isApiTest = testType === 'api';

    // STEP 3: Check credits
    const creditCheckPassed = await checkCreditsBeforeTest(userId, testType, res);
    if (!creditCheckPassed) return; // Response already sent

    // STEP 4: Route to appropriate test flow
    if (isApiTest) {
      await executeApiTestFlow(res, {
        plan,
        planId,
        userId,
        chatSessionId,
        userMessage, // FIX #14: Pass user message
      });
    } else {
      await executeUiTestFlow(res, {
        plan,
        planId,
        userId,
        chatSessionId,
        workspace_id,
        userMessage, // FIX #14: Pass user message
      });
    }
  } catch (error) {
    await handleExecutionError(error, res, { planId, chatSessionId });
  }
}
