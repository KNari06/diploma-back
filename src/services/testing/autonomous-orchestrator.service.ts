import { retrieveCredentials, storeCredentials } from '@/services/api/credentials-manager.service';
import { exploreProduct } from '@/services/testing/autonomous-explorer.service';
import {
    confirmTestPlan as confirmPlanInDB,
    getCachedExploration,
    getTestPlan,
    rejectTestPlan as rejectPlanInDB,
    saveExplorationToCache,
    saveTestPlan
} from '@/services/testing/exploration-cache.service';
import { formatTestPlanForConfirmation, generateIntelligentTestPlan, generateTestPlan } from '@/services/testing/test-plan-generator.service';
import { generateClarifyingQuestions, parseAnswers } from '@/services/utils/question-generator.service';
import { logger } from '@/utils/logger';
import { ChatProcessingStepPayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';

/**
 * Autonomous testing workflow orchestrator
 * Handles the full flow from user request to test execution
 */

/**
 * Step 1: Detect if autonomous mode is needed
 * SIMPLIFIED: Now based purely on intent type
 */
export function needsAutonomousMode(intent: string): boolean {
  logger.info('[AUTONOMOUS] Checking if autonomous mode needed', { intent });

  // SIMPLIFIED LOGIC:
  // - platform_test → ALWAYS autonomous (with test plan approval)
  // - api_test → ALWAYS autonomous (with test plan approval)
  // - general_chat → NEVER autonomous

  // NEW intents
  if (intent === 'platform_test') {
    logger.info('[AUTONOMOUS] Activating - platform_test intent');
    return true;
  }

  if (intent === 'api_test') {
    logger.info('[AUTONOMOUS] Activating - api_test intent (will generate test plan)');
    return true;
  }

  if (intent === 'general_chat') {
    logger.info('[AUTONOMOUS] Skipping - general_chat intent');
    return false;
  }

  // LEGACY intents (for backward compatibility)
  const legacyUiIntents = ['check_element', 'fill_form', 'login_flow', 'assert_ui', 'navigate'];
  if (legacyUiIntents.includes(intent)) {
    logger.info('[AUTONOMOUS] Activating - legacy UI intent (migrating to platform_test)');
    return true;
  }

  if (intent === 'api_test_comprehensive') {
    logger.info('[AUTONOMOUS] Activating - legacy api_test_comprehensive');
    return true;
  }

  // Default: activate autonomous for unknown intents (safe approach)
  logger.info('[AUTONOMOUS] Activating - unknown intent, defaulting to autonomous', { intent });
  return true;
}

/**
 * Step 2: Generate questions for missing information
 */
export async function requestMissingInformation(
  userMessage: string,
  currentContext: {
    hasUrl?: boolean;
    hasScope?: boolean;
    hasCredentials?: boolean;
    intent?: string;
    userProjects?: Array<{ id: string; name: string; settings?: { main_url?: string } }>;
  }
): Promise<{
  needsMoreInfo: boolean;
  questions: any[];
  conversationId: string;
}> {
  return await generateClarifyingQuestions(userMessage, currentContext);
}

/**
 * Step 3: Run autonomous exploration
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
    logger.info('[AUTONOMOUS] Step 1: Starting exploration', { userId, projectId });

    // Parse answers
    logger.info('[AUTONOMOUS] Step 2: Parsing answers', { answers });
    const parsedAnswers = parseAnswers(answers);
    logger.info('[AUTONOMOUS] Step 3: Parsed answers', { parsedAnswers });

    if (!parsedAnswers.url) {
      logger.error('[AUTONOMOUS] ERROR: URL is missing in parsed answers');
      throw new Error('URL is required for autonomous exploration');
    }

    logger.info('[AUTONOMOUS] Step 4: Starting workflow', {
      url: parsedAnswers.url,
      scope: parsedAnswers.scope,
      needsAuth: parsedAnswers.needsAuth,
    });

    // Check cache first
    logger.info('[AUTONOMOUS] Step 5: Checking cache');
    const cached = await getCachedExploration(parsedAnswers.url, projectId);
    logger.info('[AUTONOMOUS] Step 6: Cache result', { hasCached: !!cached });
    let exploration: any;
    let explorationId: string | undefined;

    if (cached) {
      logger.info('Using cached exploration', { url: parsedAnswers.url });
      exploration = cached;
    } else {
      // Run fresh exploration
      logger.info('[AUTONOMOUS] Step 7: Running fresh exploration');

      // Retrieve credentials if needed
      let credentials;
      logger.info('[AUTONOMOUS] Step 8: Handling credentials', {
        needsAuth: parsedAnswers.needsAuth,
        hasCredentials: !!parsedAnswers.credentials,
      });

      if (parsedAnswers.needsAuth && parsedAnswers.credentials) {
        // Store credentials securely
        const stored = await storeCredentials({
          userId,
          projectId,
          ...parsedAnswers.credentials,
          urlPattern: parsedAnswers.url,
          label: `Auto-generated for ${parsedAnswers.url}`,
        });

        // Retrieve for immediate use
        const retrieved = await retrieveCredentials(stored.id, userId);
        if (retrieved) {
          credentials = retrieved;
        }
      }

      // Explore product
      logger.info('[AUTONOMOUS] Step 9: Launching browser and exploring product', {
        url: parsedAnswers.url,
        scope: parsedAnswers.scope,
      });

      exploration = await exploreProduct({
        url: parsedAnswers.url,
        scope: parsedAnswers.scope || 'general',
        credentials: credentials || undefined,
        needsAuth: parsedAnswers.needsAuth,
      });

      logger.info('[AUTONOMOUS] Step 10: Exploration completed successfully');

      // Save to cache
      const cacheResult = await saveExplorationToCache(exploration, userId, projectId);
      explorationId = cacheResult.id;
    }

    // Generate test plan from exploration
    logger.info('[AUTONOMOUS] Step 11: Generating test plan');

    // Emit WebSocket: generating plan
    if (sessionId) {
      const stepPayload: ChatProcessingStepPayload = {
        sessionId,
        step: 'generating_plan',
        message: '📋 Генерирую план тестирования с помощью AI...',
        progress: 60,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitChatProcessingStep(sessionId, stepPayload);
    }

    // Check if this should be intelligent test (for platform_test with scope 'full' or 'flow')
    const shouldUseIntelligentMode =
      parsedAnswers.scope === 'full' ||
      parsedAnswers.scope === 'flow' ||
      parsedAnswers.scope === 'platform';

    const testPlan = shouldUseIntelligentMode
      ? await generateIntelligentTestPlan(exploration, {
          message: userMessage,
          scope: parsedAnswers.scope || 'general',
          additionalInfo: parsedAnswers.additionalInfo,
        })
      : await generateTestPlan(exploration, {
          message: userMessage,
          scope: parsedAnswers.scope || 'general',
          additionalInfo: parsedAnswers.additionalInfo,
        });

    logger.info('[AUTONOMOUS] Step 12: Test plan generated', {
      planId: testPlan.id,
      intelligentMode: testPlan.intelligentMode || false,
    });

    // Save test plan
    await saveTestPlan(testPlan, userId, projectId, explorationId);

    // Format for user confirmation
    const formattedPlan = formatTestPlanForConfirmation(testPlan);

    logger.info('Autonomous exploration completed', {
      planId: testPlan.id,
      stepsCount: testPlan.steps.length,
    });

    return {
      exploration,
      testPlan,
      message: formattedPlan,
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
 * Step 4: Confirm test plan (prepare for execution)
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
    // FIX #5: Validate input parameters
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

    // FIX #4: Atomic confirmation in database (prevents race conditions)
    const confirmed = await confirmPlanInDB(planId, userId);

    if (!confirmed.success) {
      logger.error('[CONFIRM_PLAN] Failed to confirm in database', {
        planId,
        userId,
        error: 'Plan may already be confirmed or not found'
      });

      // FIX #3: Return detailed error message
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

    // FIX #6: Updated comment to reflect actual behavior
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
 * UUID validation helper (centralized)
 */
function isValidUUID(uuid: string): boolean {
  if (!uuid || typeof uuid !== 'string') return false;
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return UUID_REGEX.test(uuid);
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
