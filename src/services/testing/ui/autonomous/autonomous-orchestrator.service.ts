import { retrieveCredentials, storeCredentials } from '@/services/api/credentials-manager.service';
import {
  confirmTestPlan as confirmPlanInDB,
  getCachedExploration,
  getTestPlan,
  rejectTestPlan as rejectPlanInDB,
  saveExplorationToCache,
  saveTestPlan
} from '@/services/testing/plans/exploration-cache.service';
import { formatTestPlanForConfirmation, generateIntelligentTestPlan, generateTestPlan } from '@/services/testing/plans/test-plan-generator.service';
import { exploreProduct } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { generateClarifyingQuestions, parseAnswers } from '@/services/utils/question-generator.service';
import { logger } from '@/utils/logger';
import { isValidUUID } from '@/utils/validation';
import { ChatProcessingStepPayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';

/**
 * Autonomous testing workflow orchestrator
 * Handles the full flow from user request to test execution
 *
 * ✅ ENHANCED: Integrates smart URL analysis and scope-specific guidance
 */

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS: Smart Context Analysis (from UiTestPlanService)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Analyze URL to provide context-specific insights
 * Helps generateTestPlan create more accurate plans
 */
function analyzeUrlContext(url: string): {
  insights: string[];
  warnings: string[];
  recommendations: string[];
} {
  const insights: string[] = [];
  const warnings: string[] = [];
  const recommendations: string[] = [];

  try {
    const parsedUrl = new URL(url);
    const hostname = parsedUrl.hostname.toLowerCase();
    const pathname = parsedUrl.pathname.toLowerCase();

    // Domain analysis
    if (hostname.includes('admin') || pathname.includes('admin')) {
      insights.push('Admin interface detected');
      recommendations.push('Focus on CRUD operations and permissions');
      recommendations.push('Test role-based access control');
    }

    if (hostname.includes('api') || pathname.includes('api')) {
      warnings.push('API endpoint detected - UI testing may not be appropriate');
      recommendations.push('Consider API testing instead');
    }

    if (hostname.includes('staging') || hostname.includes('dev') || hostname.includes('test')) {
      insights.push('Development environment detected');
      warnings.push('Expect potential instability or incomplete features');
    }

    if (hostname.includes('localhost') || hostname === '127.0.0.1') {
      insights.push('Local development environment');
      recommendations.push('Ensure services are running');
    }

    // Path analysis
    if (pathname.includes('login') || pathname.includes('auth') || pathname.includes('signin')) {
      insights.push('Authentication page detected');
      recommendations.push('Focus on login flows and security');
      recommendations.push('Test password validation and error messages');
    }

    if (pathname.includes('register') || pathname.includes('signup')) {
      insights.push('Registration page detected');
      recommendations.push('Test form validation thoroughly');
      recommendations.push('Verify email/username uniqueness checks');
    }

    if (pathname.includes('dashboard') || pathname.includes('profile')) {
      insights.push('User dashboard detected');
      recommendations.push('Test personalized content');
      recommendations.push('Verify user-specific data display');
    }

    if (pathname.includes('checkout') || pathname.includes('payment') || pathname.includes('cart')) {
      insights.push('E-commerce flow detected');
      warnings.push('Be cautious with financial transactions');
      recommendations.push('Use test payment credentials');
      recommendations.push('Test cart calculations and tax');
    }

    if (pathname.includes('search') || pathname.includes('filter')) {
      insights.push('Search/filter functionality detected');
      recommendations.push('Test various search queries');
      recommendations.push('Verify pagination and sorting');
    }

  } catch (error) {
    logger.warn('[URL_ANALYSIS] Failed to analyze URL', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return { insights, warnings, recommendations };
}

/**
 * Get scope-specific testing strategy
 * Provides detailed guidance for test plan generation
 */
function getScopeStrategy(scope: string): {
  description: string;
  estimatedDuration: string;
  focusAreas: string[];
  testTypes: string[];
} {
  const strategies: Record<string, any> = {
    'full': {
      description: 'Comprehensive site-wide testing',
      estimatedDuration: '10-20 minutes',
      focusAreas: [
        'All major user journeys',
        'Navigation across sections',
        'Responsive design (desktop/mobile)',
        'Accessibility compliance',
        'Performance on key pages',
        'Cross-browser compatibility',
      ],
      testTypes: ['functional', 'visual', 'accessibility', 'performance'],
    },
    'flow': {
      description: 'Specific user journey testing',
      estimatedDuration: '5-10 minutes',
      focusAreas: [
        'Complete user flow from start to finish',
        'Happy path validation',
        'Error handling scenarios',
        'State persistence across steps',
        'Flow interruption and recovery',
      ],
      testTypes: ['functional', 'integration', 'error-handling'],
    },
    'platform': {
      description: 'Platform-level testing with intelligent exploration',
      estimatedDuration: '10-20 minutes',
      focusAreas: [
        'Core platform functionality',
        'Critical user workflows',
        'Platform-specific features',
        'Integration points',
        'Platform stability',
      ],
      testTypes: ['functional', 'integration', 'smoke'],
    },
    'page': {
      description: 'Single page deep testing',
      estimatedDuration: '3-7 minutes',
      focusAreas: [
        'All interactive elements',
        'Page-specific functionality',
        'Responsive behavior',
        'Accessibility features',
        'Page load performance',
      ],
      testTypes: ['functional', 'visual', 'accessibility'],
    },
    'component': {
      description: 'Component-level focused testing',
      estimatedDuration: '2-5 minutes',
      focusAreas: [
        'Component in different states',
        'Component interactions',
        'Edge cases and error states',
        'Component accessibility',
        'Component responsiveness',
      ],
      testTypes: ['functional', 'unit', 'accessibility'],
    },
    'quick': {
      description: 'Quick smoke testing',
      estimatedDuration: '1-3 minutes',
      focusAreas: [
        'Basic functionality check',
        'Critical path validation',
        'Page load verification',
      ],
      testTypes: ['smoke', 'functional'],
    },
  };

  return strategies[scope] || {
    description: 'General testing',
    estimatedDuration: '5-10 minutes',
    focusAreas: ['Basic functionality', 'User interactions', 'Visual verification'],
    testTypes: ['functional'],
  };
}

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

  // ✅ FIX #4: Helper to emit WebSocket events (with fallback for missing sessionId)
  // ✅ FIX: Added error handling to prevent WebSocket errors from breaking HTTP request
  const emitProgress = (step: string, message: string, progress: number) => {
    if (!sessionId) {
      logger.warn('[AUTONOMOUS] No sessionId - skipping WebSocket event', { step, message });
      return;
    }

    try {
      const stepPayload: ChatProcessingStepPayload = {
        sessionId,
        step: step as any,
        message,
        progress,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitChatProcessingStep(sessionId, stepPayload);
    } catch (error) {
      // ✅ CRITICAL: Don't let WebSocket errors break the HTTP request
      // Log error but continue processing
      logger.warn('[AUTONOMOUS] Failed to emit WebSocket progress (non-critical)', {
        step,
        message,
        progress,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue execution - WebSocket is optional for progress updates
    }
  };

  try {
    logger.info('[AUTONOMOUS] Step 1: Starting exploration', { userId, projectId });
    emitProgress('analyzing', '🔍 Starting analysis...', 10);

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
    emitProgress('analyzing', '📦 Checking cache...', 15);

    // Check cache first
    logger.info('[AUTONOMOUS] Step 5: Checking cache');
    const cached = await getCachedExploration(parsedAnswers.url, projectId);
    logger.info('[AUTONOMOUS] Step 6: Cache result', { hasCached: !!cached });
    let exploration: any;
    let explorationId: string | undefined;

    if (cached) {
      logger.info('Using cached exploration', { url: parsedAnswers.url });
      emitProgress('analyzing', '✅ Using cached data', 20);
      exploration = cached;
    } else {
      // Run fresh exploration
      logger.info('[AUTONOMOUS] Step 7: Running fresh exploration');
      emitProgress('analyzing', '🚀 Launching browser...', 20);

      // ✅ FIX #5: Handle credentials with proper validation
      let credentials;
      logger.info('[AUTONOMOUS] Step 8: Handling credentials', {
        needsAuth: parsedAnswers.needsAuth,
        hasCredentials: !!parsedAnswers.credentials,
      });

      // ✅ FIX #2: Check if auth is needed but credentials are missing
      if (parsedAnswers.needsAuth) {
        if (!parsedAnswers.credentials) {
          // ❌ CRITICAL: Auth needed but no credentials provided
          logger.error('[AUTONOMOUS] Auth required but no credentials provided');
          throw new Error(
            'Authentication required but credentials not provided. Please provide login credentials.'
          );
        }

        // Store credentials securely
        emitProgress('analyzing', '🔐 Saving credentials...', 25);
        const stored = await storeCredentials({
          userId,
          projectId,
          ...parsedAnswers.credentials,
          urlPattern: parsedAnswers.url,
          label: `Auto-generated for ${parsedAnswers.url}`,
        });

        // Retrieve for immediate use
        const retrieved = await retrieveCredentials(stored.id, userId);
        if (!retrieved) {
          // ❌ CRITICAL: Failed to retrieve stored credentials
          logger.error('[AUTONOMOUS] Failed to retrieve stored credentials', {
            storedId: stored.id,
          });
          throw new Error(
            'Failed to retrieve credentials. Please try again or contact support.'
          );
        }
        credentials = retrieved;
        logger.info('[AUTONOMOUS] Credentials retrieved successfully');
      }

      // ✅ FIX #1: Add real-time WebSocket events during exploration
      emitProgress('analyzing', '🌐 Opening page...', 30);

      // Explore product
      logger.info('[AUTONOMOUS] Step 9: Launching browser and exploring product', {
        url: parsedAnswers.url,
        scope: parsedAnswers.scope,
      });

      // ✅ FIX #3: Add timeout for exploration (5 minutes max)
      const EXPLORATION_TIMEOUT = 5 * 60 * 1000; // 5 minutes
      const explorationPromise = exploreProduct({
        url: parsedAnswers.url,
        scope: parsedAnswers.scope || 'general',
        credentials: credentials || undefined,
        needsAuth: parsedAnswers.needsAuth,
        sessionId, // ✅ Pass sessionId for real-time WebSocket updates
      });

      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Exploration timeout after 5 minutes')),
          EXPLORATION_TIMEOUT
        )
      );

      emitProgress('analyzing', '🔍 Analyzing page (this may take 1-2 minutes)...', 35);

      exploration = await Promise.race([explorationPromise, timeoutPromise]);

      logger.info('[AUTONOMOUS] Step 10: Exploration completed successfully');
      emitProgress('analyzing', '✅ Analysis completed successfully!', 50);

      // Save to cache
      emitProgress('analyzing', '💾 Saving results to cache...', 52);
      const cacheResult = await saveExplorationToCache(exploration, userId, projectId);
      explorationId = cacheResult.id;
    }

    // Generate test plan from exploration
    logger.info('[AUTONOMOUS] Step 11: Generating test plan');
    emitProgress('generating_plan', '📋 Generating test plan with AI...', 55);

    // ✅ ENHANCED: Analyze URL context before generating plan
    emitProgress('generating_plan', '🧠 Analyzing URL context...', 58);
    const urlContext = analyzeUrlContext(parsedAnswers.url);
    const scopeStrategy = getScopeStrategy(parsedAnswers.scope || 'general');

    logger.info('[AUTONOMOUS] Context analysis completed', {
      insights: urlContext.insights.length,
      warnings: urlContext.warnings.length,
      scope: parsedAnswers.scope,
      strategy: scopeStrategy.description,
    });

    // Check if this should be intelligent test (for platform_test with scope 'full' or 'flow')
    const shouldUseIntelligentMode =
      parsedAnswers.scope === 'full' ||
      parsedAnswers.scope === 'flow' ||
      parsedAnswers.scope === 'platform';

      emitProgress(
      'generating_plan',
      shouldUseIntelligentMode
        ? '🤖 Generating intelligent test plan...'
        : '📝 Generating standard test plan...',
      62
    );

    // ✅ ENHANCED: Include context analysis in test plan generation
    const enhancedContext = {
      message: userMessage,
      scope: parsedAnswers.scope || 'general',
      additionalInfo: {
        ...parsedAnswers.additionalInfo,
        // Add URL insights
        urlInsights: urlContext.insights,
        urlWarnings: urlContext.warnings,
        recommendations: urlContext.recommendations,
        // Add scope strategy
        scopeDescription: scopeStrategy.description,
        focusAreas: scopeStrategy.focusAreas,
        testTypes: scopeStrategy.testTypes,
        estimatedDuration: scopeStrategy.estimatedDuration,
      },
    };

    const testPlan = shouldUseIntelligentMode
      ? await generateIntelligentTestPlan(exploration, enhancedContext)
      : await generateTestPlan(exploration, enhancedContext);

    logger.info('[AUTONOMOUS] Step 12: Test plan generated', {
      planId: testPlan.id,
      intelligentMode: testPlan.intelligentMode || false,
    });

    emitProgress('generating_plan', '✅ Test plan generated!', 75);

    // Save test plan
    emitProgress('generating_plan', '💾 Saving test plan...', 80);
    await saveTestPlan(testPlan, userId, projectId, explorationId);

    // Format for user confirmation
    emitProgress('generating_plan', '📄 Formatting plan for confirmation...', 85);

    // ✅ FIX: Detect user language for natural footer text
    const { detectLanguage } = await import('@/services/kb/kb.service');
    const userLanguage = await detectLanguage(userMessage).catch(() => 'neutral' as const);

    const formattedPlan = formatTestPlanForConfirmation(testPlan, userLanguage, userMessage);

    logger.info('Autonomous exploration completed', {
      planId: testPlan.id,
      stepsCount: testPlan.steps.length,
    });

    emitProgress('generating_plan', '✅ All ready! Waiting for confirmation...', 100);

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

// UUID validation is now centralized in @/utils/validation

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
