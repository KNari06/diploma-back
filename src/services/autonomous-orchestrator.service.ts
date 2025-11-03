import { logger } from '@/utils/logger';
import { generateClarifyingQuestions, parseAnswers } from '@/services/question-generator.service';
import { exploreProduct } from '@/services/autonomous-explorer.service';
import { generateTestPlan, formatTestPlanForConfirmation } from '@/services/test-plan-generator.service';
import {
  saveExplorationToCache,
  getCachedExploration,
  saveTestPlan,
  confirmTestPlan as confirmPlanInDB,
  rejectTestPlan as rejectPlanInDB,
  getTestPlan
} from '@/services/exploration-cache.service';
import { storeCredentials, retrieveCredentials } from '@/services/credentials-manager.service';

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
  // If intent is general_chat or api_test, not needed
  if (context.intent === 'general_chat' || context.intent === 'api_test') {
    return false;
  }

  // If we have no URL, definitely need it
  if (!context.hasUrl) {
    return true;
  }

  // If we have traces or documentation, we have enough context
  if (context.hasTraces || context.hasDocumentation) {
    return false;
  }

  // If UI testing intent but no context, need autonomous mode
  const uiTestIntents = ['check_element', 'fill_form', 'login_flow', 'assert_ui', 'navigate'];
  return uiTestIntents.includes(context.intent);
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
    // Parse answers
    const parsedAnswers = parseAnswers(answers);

    if (!parsedAnswers.url) {
      throw new Error('URL is required for autonomous exploration');
    }

    logger.info('Starting autonomous exploration workflow', {
      url: parsedAnswers.url,
      scope: parsedAnswers.scope,
      needsAuth: parsedAnswers.needsAuth,
    });

    // Check cache first
    const cached = await getCachedExploration(parsedAnswers.url, projectId);
    let exploration: any;
    let explorationId: string | undefined;

    if (cached) {
      logger.info('Using cached exploration', { url: parsedAnswers.url });
      exploration = cached;
    } else {
      // Run fresh exploration
      logger.info('Running fresh autonomous exploration');

      // Retrieve credentials if needed
      let credentials;
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
      exploration = await exploreProduct({
        url: parsedAnswers.url,
        scope: parsedAnswers.scope || 'general',
        credentials: credentials || undefined,
        needsAuth: parsedAnswers.needsAuth,
      });

      // Save to cache
      const cacheResult = await saveExplorationToCache(exploration, userId, projectId);
      explorationId = cacheResult.id;
    }

    // Generate test plan from exploration
    logger.info('Generating test plan from exploration');
    const testPlan = await generateTestPlan(exploration, {
      message: userMessage,
      scope: parsedAnswers.scope || 'general',
      additionalInfo: parsedAnswers.additionalInfo,
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
    logger.error('Autonomous exploration workflow failed', { error });
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
