import { formatTestPlanForConfirmation, generateIntelligentTestPlan, generateTestPlan } from '@/services/testing/plans/test-plan-generator.service';
import { saveTestPlan } from '@/services/testing/plans/exploration-cache.service';
import { analyzeUrlContext } from './url-analysis';
import { getScopeStrategy } from './scope-strategy';
import { logger } from '@/utils/logger';

/**
 * Generate test plan from exploration with context analysis
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
  } = params;

  logger.info('[AUTONOMOUS] Generating test plan');
  emitProgress('generating_plan', '📋 Generating test plan with AI...', 55);

  // Analyze URL context before generating plan
  emitProgress('generating_plan', '🧠 Analyzing URL context with AI...', 58);
  const urlContext = await analyzeUrlContext(url);

  // Get scope strategy adapted with URL context (AI-generated for invalid scopes)
  const scopeStrategy = await getScopeStrategy(scope || 'general', urlContext);

  logger.info('[AUTONOMOUS] Context analysis completed', {
    insights: urlContext.insights.length,
    warnings: urlContext.warnings.length,
    scope,
    strategy: scopeStrategy.description,
    focusAreasCount: scopeStrategy.focusAreas.length,
  });

  // Check if this should be intelligent test (for platform_test with scope 'full' or 'flow')
  const shouldUseIntelligentMode = scope === 'full' || scope === 'flow';

  emitProgress(
    'generating_plan',
    shouldUseIntelligentMode
      ? '🤖 Generating intelligent test plan...'
      : '📝 Generating standard test plan...',
    62
  );

  // Include context analysis in test plan generation
  const enhancedContext = {
    message: userMessage,
    scope: scope || 'general',
    additionalInfo: {
      ...additionalInfo,
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

  logger.info('[AUTONOMOUS] Test plan generated', {
    planId: testPlan.id,
    intelligentMode: testPlan.intelligentMode || false,
  });

  emitProgress('generating_plan', '✅ Test plan generated!', 75);

  // Save test plan
  emitProgress('generating_plan', '💾 Saving test plan...', 80);
  await saveTestPlan(testPlan, userId, projectId, explorationId);

  // Format for user confirmation
  emitProgress('generating_plan', '📄 Formatting plan for confirmation...', 85);

  // Detect user language for natural footer text
  const { detectLanguage } = await import('@/services/kb/kb.service');
  const userLanguage = await detectLanguage(userMessage).catch(() => 'neutral' as const);

  const formattedPlan = formatTestPlanForConfirmation(testPlan, userLanguage, userMessage);

  logger.info('Autonomous exploration completed', {
    planId: testPlan.id,
    stepsCount: testPlan.steps.length,
  });

  emitProgress('generating_plan', '✅ All ready! Waiting for confirmation...', 100);

  return {
    testPlan,
    message: formattedPlan,
  };
}
