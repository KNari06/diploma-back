import { exploreProduct } from '@/services/autonomous-explorer.service';
import { retrieveCredentials, storeCredentials } from '@/services/credentials-manager.service';
import {
  confirmTestPlan as confirmPlanInDB,
  getCachedExploration,
  getTestPlan,
  rejectTestPlan as rejectPlanInDB,
  saveExplorationToCache,
  saveTestPlan
} from '@/services/exploration-cache.service';
import { generateClarifyingQuestions, parseAnswers } from '@/services/question-generator.service';
import { formatTestPlanForConfirmation, generateTestPlan } from '@/services/test-plan-generator.service';
import { logger } from '@/utils/logger';

/**
 * Autonomous testing workflow orchestrator
 * Handles the full flow from user request to test execution
 */

/**
 * Step 1: Detect if autonomous mode is needed
 */
export function needsAutonomousMode(context: {
  hasUrl: boolean;
  hasTraces: boolean;
  hasDocumentation: boolean;
  intent: string;
}): boolean {
  logger.info('[AUTONOMOUS] Checking if autonomous mode needed', {
    hasUrl: context.hasUrl,
    hasTraces: context.hasTraces,
    hasDocumentation: context.hasDocumentation,
    intent: context.intent,
  });

  // Skip only for general chat and API testing (explicitly non-UI intents)
  const skipIntents = ['general_chat', 'api_test'];
  if (skipIntents.includes(context.intent)) {
    logger.info('[AUTONOMOUS] Skipping - intent is general_chat or api_test');
    return false;
  }

  // If we have no URL, definitely need it
  if (!context.hasUrl) {
    logger.info('[AUTONOMOUS] Activating - no URL provided');
    return true;
  }

  // If we have traces or documentation, we have enough context
  if (context.hasTraces || context.hasDocumentation) {
    logger.info('[AUTONOMOUS] Skipping - we have traces or documentation');
    return false;
  }

  // For ANY other intent with URL but no context → need autonomous mode
  // This is universal: custom, ui_test, check_element, login_flow, etc.
  logger.info('[AUTONOMOUS] Decision: Activating', {
    reason: `Intent '${context.intent}' needs UI testing but lacks context (no traces/docs)`,
  });

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
}): Promise<{
  exploration: any;
  testPlan: any;
  message: string;
}> {
  const { userMessage, answers, userId, projectId } = params;

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
    const testPlan = await generateTestPlan(exploration, {
      message: userMessage,
      scope: parsedAnswers.scope || 'general',
      additionalInfo: parsedAnswers.additionalInfo,
    });
    logger.info('[AUTONOMOUS] Step 12: Test plan generated', { planId: testPlan.id });

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
 * Step 4: Confirm and execute test plan
 */
export async function confirmAndExecuteTestPlan(
  planId: string,
  userId: string
): Promise<{
  success: boolean;
  testId?: string;
  message: string;
}> {
  try {
    // Get plan
    const plan = await getTestPlan(planId, userId);

    if (!plan) {
      return {
        success: false,
        message: 'Test plan not found or expired',
      };
    }

    if (plan.status !== 'pending_confirmation') {
      return {
        success: false,
        message: `Test plan already ${plan.status}`,
      };
    }

    // Confirm in database
    const confirmed = await confirmPlanInDB(planId, userId);

    if (!confirmed.success) {
      return {
        success: false,
        message: 'Failed to confirm test plan',
      };
    }

    logger.info('Test plan confirmed, ready for execution', { planId });

    // Return commands for execution
    // (Chat controller will create manual test with these commands)
    return {
      success: true,
      message: `✅ Test plan confirmed! Starting execution...\n\nTest ID will be generated.`,
    };
  } catch (error) {
    logger.error('Error confirming test plan', { error });
    return {
      success: false,
      message: 'Error confirming test plan',
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
