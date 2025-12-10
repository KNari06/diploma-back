import {
  confirmTestPlan as confirmPlanInDB,
  getTestPlan,
  rejectTestPlan as rejectPlanInDB,
} from '@/services/testing/plans/exploration-cache.service';
import { logger } from '@/utils/logger';
import { isValidUUID } from '@/utils/validation';
import { handleCredentialsForExploration } from './helpers/credentials-handler';
import { createProgressEmitter } from './helpers/exploration-progress';
import { runExploration } from './helpers/exploration-runner';
import { generateTestPlanFromExploration } from './helpers/test-plan-generator';

/**
 * Autonomous testing workflow orchestrator
 * Handles the full flow from user request to test execution
 *
 * ✅ ENHANCED: Integrates smart URL analysis and scope-specific guidance
 * ✅ REFACTORED: Split into smaller, readable helper modules
 */

// Re-export helper functions for external use
export { needsAutonomousMode } from './helpers/autonomous-mode';
export { requestMissingInformation } from './helpers/missing-info';

/**
 * Run autonomous exploration
 * ✅ REFACTORED: Split into smaller, readable helper functions
 */
export async function runAutonomousExploration(params: {
  userMessage: string;
  answers: Record<string, any>;
  userId: string;
  projectId: string;
  sessionId?: string;
}): Promise<{
  exploration: any;
  testPlan: any;
  message: string;
}> {
  const { userMessage, answers, userId, projectId, sessionId } = params;

  try {
    logger.info('[AUTONOMOUS] Starting exploration', { userId, projectId });

    // Create progress emitter
    const emitProgress = createProgressEmitter(sessionId);
    emitProgress('analyzing', '🔍 Starting analysis...', 10);

    // Parse and validate answers
    const parsedAnswers = answers as {
      url: string;
      scope?: string;
      needsAuth?: boolean;
      credentials?: { email?: string; username?: string; password: string };
      additionalInfo?: Record<string, any>;
    };

    if (!parsedAnswers.url || typeof parsedAnswers.url !== 'string') {
      logger.error('[AUTONOMOUS] URL is missing or invalid', { url: parsedAnswers.url });
      throw new Error('URL is required for autonomous exploration');
    }

    logger.info('[AUTONOMOUS] Using pre-parsed answers', {
      hasUrl: !!parsedAnswers.url,
      hasScope: !!parsedAnswers.scope,
      hasCredentials: !!parsedAnswers.credentials,
    });

    // Handle credentials if needed
    emitProgress('analyzing', '🔐 Processing credentials...', 25);
    const credentials = await handleCredentialsForExploration({
      needsAuth: parsedAnswers.needsAuth || false,
      credentials: parsedAnswers.credentials,
      userId,
      projectId,
      url: parsedAnswers.url,
    });

    // Run exploration (from cache or fresh)
    const { exploration, explorationId } = await runExploration({
      url: parsedAnswers.url,
      scope: parsedAnswers.scope || 'general',
      credentials,
      needsAuth: parsedAnswers.needsAuth,
      sessionId,
      userMessage,
      userId,
      projectId,
      emitProgress,
    });

    // Generate test plan from exploration
    const { testPlan, message } = await generateTestPlanFromExploration({
      exploration,
      userMessage,
      scope: parsedAnswers.scope || 'general',
      url: parsedAnswers.url,
      userId,
      projectId,
      explorationId,
      additionalInfo: parsedAnswers.additionalInfo,
      emitProgress,
    });

    return {
      exploration,
      testPlan,
      message,
    };
  } catch (error) {
    logger.error('[AUTONOMOUS] ERROR: Workflow failed', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    throw error;
  }
}

/**
 * Confirm test plan (prepare for execution)
 * FIX: Renamed from confirmAndExecuteTestPlan - function only confirms, doesn't execute
 */
export async function confirmTestPlan(
  planId: string,
  userId: string
): Promise<{
  success: boolean;
  message: string;
}> {
  try {
    // Validate input parameters
    if (!isValidUUID(planId)) {
      logger.warn('[CONFIRM_PLAN] Invalid planId format', { planId });
      return {
        success: false,
        message: 'Invalid plan ID format',
      };
    }

    if (!isValidUUID(userId)) {
      logger.warn('[CONFIRM_PLAN] Invalid userId format', { userId });
      return {
        success: false,
        message: 'Invalid user ID format',
      };
    }

    // Get plan
    const plan = await getTestPlan(planId, userId);

    if (!plan) {
      logger.info('[CONFIRM_PLAN] Plan not found', { planId, userId });
      return {
        success: false,
        message: 'Test plan not found or expired',
      };
    }

    if (plan.status !== 'pending_confirmation') {
      logger.warn('[CONFIRM_PLAN] Plan not in pending status', {
        planId,
        currentStatus: plan.status
      });
      return {
        success: false,
        message: `Test plan already ${plan.status}`,
      };
    }

    // Atomic confirmation in database (prevents race conditions)
    const confirmed = await confirmPlanInDB(planId, userId);

    if (!confirmed.success) {
      logger.error('[CONFIRM_PLAN] Failed to confirm in database', {
        planId,
        userId,
        error: 'Plan may already be confirmed or not found'
      });

      // Return detailed error message
      return {
        success: false,
        message: 'Failed to confirm test plan - it may already be confirmed or not found',
      };
    }

    logger.info('[CONFIRM_PLAN] Test plan confirmed successfully', {
      planId,
      userId,
      confirmedAt: new Date().toISOString()
    });

    // Plan is now confirmed and ready for execution by chat controller
    return {
      success: true,
      message: `✅ Test plan confirmed! Ready for execution.`,
    };
  } catch (error) {
    logger.error('[CONFIRM_PLAN] Critical error confirming test plan', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      planId,
      userId
    });

    return {
      success: false,
      message: error instanceof Error ? error.message : 'Error confirming test plan',
    };
  }
}

/**
 * Reject test plan
 */
export async function rejectPlan(
  planId: string,
  userId: string,
  reason?: string
): Promise<{
  success: boolean;
  message: string;
}> {
  const result = await rejectPlanInDB(planId, userId, reason);

  return {
    success: result.success,
    message: result.success
      ? 'Test plan rejected. You can start over with a new request.'
      : 'Failed to reject test plan',
  };
}
