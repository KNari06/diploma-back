import { saveTestPlan } from '@/services/testing/plans/exploration-cache.service';
import { formatTestPlanForConfirmation, generateIntelligentTestPlan, generateTestPlan } from '@/services/testing/plans/test-plan-generator.service';
import { logger } from '@/utils/core/logger';
import { getScopeStrategy } from './scope-strategy';
import { analyzeUrlContext } from './url-analysis';

/**
 * Generate test plan from exploration with context analysis
 *
 * Flow:
 * 1. Validate input parameters
 * 2. Analyze URL context (AI-powered)
 * 3. Get scope-specific testing strategy
 * 4. Determine test mode (Intelligent vs Standard)
 * 5. Generate test plan with enhanced context
 * 6. Save plan to database
 * 7. Format plan for user confirmation
 *
 * @returns Test plan and formatted message for user confirmation
 */
export async function generateTestPlanFromExploration(params: {
  exploration: any;
  userMessage: string;
  scope: string;
  url: string;
  userId: string;
  projectId: string;
  explorationId?: string;
  additionalInfo?: Record<string, any>;
  emitProgress: (step: string, message: string, progress: number) => void;
  mode?: 'lite' | 'pro'; // Test execution mode (default: 'lite')
}): Promise<{ testPlan: any; message: string }> {
  const {
    exploration,
    userMessage,
    scope,
    url,
    userId,
    projectId,
    explorationId,
    additionalInfo,
    emitProgress,
    mode,
  } = params;

  // ✅ FIX: Validate input parameters
  if (!exploration) {
    throw new Error('Exploration data is required to generate test plan');
  }

  if (!userMessage || typeof userMessage !== 'string' || userMessage.trim().length === 0) {
    throw new Error('User message is required and must be non-empty');
  }

  if (!url || typeof url !== 'string' || url.trim().length === 0) {
    throw new Error('URL is required and must be non-empty');
  }

  if (!userId || typeof userId !== 'string') {
    throw new Error('User ID is required');
  }

  if (!projectId || typeof projectId !== 'string') {
    throw new Error('Project ID is required');
  }

  logger.info('[AUTONOMOUS] Generating test plan', {
    url: url.substring(0, 100),
    scope,
    hasExploration: !!exploration,
    hasAdditionalInfo: !!additionalInfo,
  });

  emitProgress('generating_plan', '📋 Generating test plan with AI...', 55);

  try {
    // Step 1: Analyze URL context (AI-powered analysis)
    emitProgress('generating_plan', '🧠 Analyzing URL context with AI...', 58);
    let urlContext;
    try {
      urlContext = await analyzeUrlContext(url);

      // ✅ FIX: Validate urlContext structure
      if (!urlContext || typeof urlContext !== 'object') {
        logger.warn('[AUTONOMOUS] Invalid URL context structure, using fallback');
        urlContext = {
          insights: [],
          warnings: [],
          recommendations: [],
        };
      }

      // ✅ FIX: Ensure arrays exist
      urlContext.insights = Array.isArray(urlContext.insights) ? urlContext.insights : [];
      urlContext.warnings = Array.isArray(urlContext.warnings) ? urlContext.warnings : [];
      urlContext.recommendations = Array.isArray(urlContext.recommendations) ? urlContext.recommendations : [];
    } catch (urlError) {
      logger.error('[AUTONOMOUS] URL context analysis failed', {
        error: urlError instanceof Error ? urlError.message : String(urlError),
      });
      // Use fallback context
      urlContext = {
        insights: [],
        warnings: [],
        recommendations: [],
      };
    }

    // Step 2: Get scope-specific testing strategy
    const normalizedScope = (scope || 'general').trim().toLowerCase();
    let scopeStrategy;
    try {
      scopeStrategy = await getScopeStrategy(normalizedScope, urlContext);

      // ✅ FIX: Validate scopeStrategy structure
      if (!scopeStrategy || typeof scopeStrategy !== 'object') {
        throw new Error('Invalid scope strategy structure');
      }

      // ✅ FIX: Ensure required fields exist
      scopeStrategy.description = scopeStrategy.description || 'General testing';
      scopeStrategy.estimatedDuration = scopeStrategy.estimatedDuration || '5-10 minutes';
      scopeStrategy.focusAreas = Array.isArray(scopeStrategy.focusAreas) ? scopeStrategy.focusAreas : [];
      scopeStrategy.testTypes = Array.isArray(scopeStrategy.testTypes) ? scopeStrategy.testTypes : ['functional'];
    } catch (strategyError) {
      logger.error('[AUTONOMOUS] Scope strategy generation failed', {
        error: strategyError instanceof Error ? strategyError.message : String(strategyError),
        scope: normalizedScope,
      });
      // Use fallback strategy
      scopeStrategy = {
        description: 'General testing',
        estimatedDuration: '5-10 minutes',
        focusAreas: ['Basic functionality', 'User interactions'],
        testTypes: ['functional'],
      };
    }

    logger.info('[AUTONOMOUS] Context analysis completed', {
      insights: urlContext.insights.length,
      warnings: urlContext.warnings.length,
      scope: normalizedScope,
      strategy: scopeStrategy.description,
      focusAreasCount: scopeStrategy.focusAreas.length,
    });

    // Step 3: Determine test mode (Intelligent vs Standard)
    // ✅ FIX: Intelligent mode for 'full' or 'flow' scopes
    const shouldUseIntelligentMode = normalizedScope === 'full' || normalizedScope === 'flow';

    emitProgress(
      'generating_plan',
      shouldUseIntelligentMode
        ? '🤖 Generating intelligent test plan...'
        : '📝 Generating standard test plan...',
      62
    );

    // Step 4: Build enhanced context for test plan generation
    const enhancedContext = {
      message: userMessage,
      scope: normalizedScope,
      additionalInfo: {
        ...(additionalInfo || {}),
        // Add URL insights
        urlInsights: urlContext.insights,
        urlWarnings: urlContext.warnings,
        recommendations: urlContext.recommendations,
        // Add scope strategy
        scopeDescription: scopeStrategy.description,
        focusAreas: scopeStrategy.focusAreas,
        testTypes: scopeStrategy.testTypes,
        estimatedDuration: scopeStrategy.estimatedDuration,
        // Add test execution mode
        mode: mode || 'lite',
      },
    };

    // Step 5: Generate test plan (Intelligent or Standard mode)
    let testPlan;
    try {
      testPlan = shouldUseIntelligentMode
        ? await generateIntelligentTestPlan(exploration, enhancedContext)
        : await generateTestPlan(exploration, enhancedContext);

      // ✅ FIX: Validate test plan structure
      if (!testPlan || typeof testPlan !== 'object') {
        throw new Error('Test plan generation returned invalid result');
      }

      if (!testPlan.id || typeof testPlan.id !== 'string') {
        throw new Error('Test plan missing required ID field');
      }

      if (!Array.isArray(testPlan.steps)) {
        logger.warn('[AUTONOMOUS] Test plan missing steps array, initializing empty');
        testPlan.steps = [];
      }
    } catch (planError) {
      logger.error('[AUTONOMOUS] Test plan generation failed', {
        error: planError instanceof Error ? planError.message : String(planError),
        intelligentMode: shouldUseIntelligentMode,
      });
      throw new Error(`Failed to generate test plan: ${planError instanceof Error ? planError.message : String(planError)}`);
    }

    logger.info('[AUTONOMOUS] Test plan generated', {
      planId: testPlan.id,
      intelligentMode: testPlan.intelligentMode || false,
      stepsCount: testPlan.steps.length,
    });

    emitProgress('generating_plan', '✅ Test plan generated!', 75);

    // Step 6: Save test plan to database
    emitProgress('generating_plan', '💾 Saving test plan...', 80);
    try {
      const saveResult = await saveTestPlan(testPlan, userId, projectId, explorationId);

      if (!saveResult || !saveResult.success) {
        logger.error('[AUTONOMOUS] Failed to save test plan', {
          planId: testPlan.id,
          userId,
          projectId,
        });
        throw new Error('Failed to save test plan to database');
      }
    } catch (saveError) {
      logger.error('[AUTONOMOUS] Error saving test plan', {
        error: saveError instanceof Error ? saveError.message : String(saveError),
        planId: testPlan.id,
      });
      throw new Error(`Failed to save test plan: ${saveError instanceof Error ? saveError.message : String(saveError)}`);
    }

    // Step 7: Format plan for user confirmation
    emitProgress('generating_plan', '📄 Formatting plan for confirmation...', 85);

    // Detect user language for natural footer text (with timeout)
    let userLanguage: 'en' | 'ru' | 'neutral' = 'neutral';
    try {
      const { detectLanguage } = await import('@/services/kb/kb.service');
      // ✅ FIX: Add timeout for language detection (max 2 seconds)
      const languagePromise = detectLanguage(userMessage);
      const timeoutPromise = new Promise<'neutral'>((resolve) => {
        setTimeout(() => resolve('neutral'), 2000);
      });

      userLanguage = await Promise.race([languagePromise, timeoutPromise]).catch(() => 'neutral' as const);
    } catch (langError) {
      logger.debug('[AUTONOMOUS] Language detection failed, using neutral', {
        error: langError instanceof Error ? langError.message : String(langError),
      });
      // Use neutral as fallback
    }

    const formattedPlan = formatTestPlanForConfirmation(testPlan, userLanguage, userMessage);

    if (!formattedPlan || typeof formattedPlan !== 'string' || formattedPlan.trim().length === 0) {
      logger.warn('[AUTONOMOUS] Formatted plan is empty, using fallback');
      throw new Error('Failed to format test plan for confirmation');
    }

    logger.info('[AUTONOMOUS] Autonomous exploration completed', {
      planId: testPlan.id,
      stepsCount: testPlan.steps.length,
      intelligentMode: testPlan.intelligentMode || false,
    });

    emitProgress('generating_plan', '✅ All ready! Waiting for confirmation...', 100);

    return {
      testPlan,
      message: formattedPlan,
    };
  } catch (error) {
    logger.error('[AUTONOMOUS] Critical error in test plan generation', {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
      url,
      scope,
    });

    emitProgress('generating_plan', '❌ Failed to generate test plan', 100);
    throw error;
  }
}
