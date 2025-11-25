import { buildTestPlanPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { ExplorationResult } from '@/services/testing/ui/autonomous/autonomous-explorer.service';
import { PlaywrightCommand } from '@/types';
import { logger } from '@/utils/logger';
import { randomUUID } from 'crypto';

/**
 * Test plan with user confirmation
 */
export interface TestPlan {
  id: string;
  status: 'pending_confirmation' | 'confirmed' | 'rejected';
  url: string;
  scope: string;
  summary: string;
  steps: Array<{
    id: string;
    description: string;
    action: string;
    selector?: string;
    value?: string;
    expectedOutcome: string;
  }>;
  commands: PlaywrightCommand[];
  estimatedDuration: string;
  whatWillBeTested: string[];
  whatWillNotBeTested: string[];
  risks: string[];
  createdAt: string;
  expiresAt: string; // Plan expires after 1 hour

  // Intelligent testing mode
  intelligentMode?: boolean; // NEW: Flag for intelligent testing
  estimatedPages?: string; // NEW: Estimated pages for intelligent mode
  estimatedCost?: string; // NEW: Estimated cost for intelligent mode
}

/**
 * Generate test plan from exploration results
 * IMPORTANT: Plan requires user confirmation!
 */
export async function generateTestPlan(
  explorationResult: ExplorationResult,
  userRequest: {
    message: string;
    scope: string;
    additionalInfo?: Record<string, any>;
  }
): Promise<TestPlan> {
  try {
    logger.info('Generating test plan from exploration', {
      url: explorationResult.url,
      scope: userRequest.scope,
    });

    // Build comprehensive prompt for AI
    const prompt = buildTestPlanPrompt(explorationResult, userRequest);

    // Generate plan using AI
    const response = await getChatCompletionWithMessages([
      {
        role: 'system',
        content: 'You are an expert QA engineer creating comprehensive test plans. Always be specific and actionable.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ], {
      temperature: 0.4,
      max_tokens: 3000,
      response_format: { type: 'json_object' },
    });

    // Extract content from new response format
    const aiPlan = JSON.parse(response.content);

    // Log token usage for tracking
    logger.debug('[TEST_PLAN_GENERATOR] AI tokens used', {
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      totalTokens: response.usage.totalTokens,
      model: response.usage.model,
    });

    // Generate unique ID - IMPORTANT: Use UUID format for database compatibility
    const planId = randomUUID();

    // Create structured test plan
    const testPlan: TestPlan = {
      id: planId,
      status: 'pending_confirmation',
      url: explorationResult.url,
      scope: userRequest.scope,
      summary: aiPlan.summary || 'Automated test plan',
      steps: aiPlan.steps || [],
      commands: aiPlan.commands || [],
      estimatedDuration: aiPlan.estimatedDuration || 'Unknown',
      whatWillBeTested: aiPlan.whatWillBeTested || [],
      whatWillNotBeTested: aiPlan.whatWillNotBeTested || [],
      risks: aiPlan.risks || [],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    };

    logger.info('Test plan generated', {
      planId,
      stepsCount: testPlan.steps.length,
      commandsCount: testPlan.commands.length,
    });

    return testPlan;
  } catch (error) {
    logger.error('Failed to generate test plan', { error });
    throw error;
  }
}


/**
 * Format test plan for user confirmation
 * Returns markdown formatted plan
 * @param plan - Test plan to format
 * @param userLanguage - Optional user language for localized footer ('en' | 'ru' | 'neutral')
 * @param userMessage - Optional user message to detect language from
 */
export function formatTestPlanForConfirmation(
  plan: TestPlan,
  userLanguage?: 'en' | 'ru' | 'neutral',
  userMessage?: string
): string {
  // ✅ UNIFIED: Support both AI-generated and standard test plans
  const isAiGenerated = plan.intelligentMode;

  // Header with appropriate mode indication
  let markdown = isAiGenerated
    ? `# 🧠 AI Test Plan for Confirmation\n`
    : `# 🧪 Test Plan for Confirmation\n`;

  // Basic info
  markdown += `**Plan ID:** \`${plan.id}\`\n`;
  markdown += `**URL:** ${plan.url}\n`;
  markdown += `**Scope:** ${plan.scope}\n`;

  if (isAiGenerated) {
    markdown += `**Mode:** 🤖 **AI-Generated Testing**\n`;
  }

  markdown += `**Estimated Duration:** ${plan.estimatedDuration}\n`;

  // Summary
  markdown += `## 📋 Summary\n${plan.summary}\n`;

  // AI-specific estimates (if available)
  if (isAiGenerated && (plan.estimatedPages || plan.estimatedCost)) {
    markdown += `## 📊 AI Estimates\n`;
    if (plan.estimatedPages) {
      markdown += `- **Pages to Test:** ${plan.estimatedPages}\n`;
    }
    // if (plan.estimatedCost) {
    //   markdown += `- **Estimated Cost:** ${plan.estimatedCost}\n`;
    // }
    markdown += '\n';
  }

  // AI explanation (for AI-generated plans)
  if (isAiGenerated) {
    markdown += `## 🤖 How AI Testing Works\n`;
    markdown += `This AI-generated test plan will:\n`;
    markdown += `1. **Execute pre-analyzed test steps** tailored to your specific site\n`;
    markdown += `2. **Adapt to page context** based on URL analysis and user intent\n`;
    markdown += `3. **Follow intelligent test scenarios** created by GPT-4o\n`;
    markdown += `4. **Provide detailed results** with actionable insights\n`;
  }

  // What will be tested
  markdown += `## ✅ What Will Be Tested\n`;
  for (const item of plan.whatWillBeTested) {
    markdown += `- ${item}\n`;
  }

  // What will NOT be tested
  if (plan.whatWillNotBeTested.length > 0) {
    markdown += `## ❌ What Will NOT Be Tested\n`;
    for (const item of plan.whatWillNotBeTested) {
      markdown += `- ${item}\n`;
    }
  }

  // Test Steps (show for non-AI or if steps are meaningful)
  if (!isAiGenerated || (plan.steps && plan.steps.length > 0 && plan.steps.some(s => s.action !== 'intelligent_explore'))) {
    markdown += `\n## 🔍 Test Steps\n`;
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      markdown += `**${i + 1}. ${step.description}**\n`;
      markdown += `   - Action: \`${step.action}\`\n`;
      if (step.selector) {
        markdown += `   - Selector: \`${step.selector}\`\n`;
      }
      if (step.value) {
        markdown += `   - Value: \`${step.value}\`\n`;
      }
      markdown += `   - Expected: ${step.expectedOutcome}\n`;
    }
  } else if (isAiGenerated) {
    markdown += `\n## 🔍 Test Execution\n\n`;
    markdown += `⚠️ **Note:** Detailed test steps are AI-generated and will be executed automatically based on the analysis above.\n`;
  }

  // Risks
  if (plan.risks.length > 0) {
    markdown += `## 🚨 Potential Risks\n`;
    for (const risk of plan.risks) {
      markdown += `- ${risk}\n`;
    }
    // markdown += '\n';
  }

  // Safety features (for AI plans)
  if (isAiGenerated) {
    markdown += `## 🛡️ Safety Features\n`;
    markdown += `- Real-time progress updates via WebSocket\n`;
    markdown += `- Automatic detection of dangerous actions (payment, delete, etc.)\n`;
    markdown += `- Intelligent timeout and error handling\n`;
    markdown += `- Safe execution with rollback capabilities\n`;
  }

  // Footer
  markdown += `---\n`;

  // ✅ FIX: Generate natural, language-aware footer
  const footer = generateFooter(plan, userLanguage, userMessage);
  markdown += footer;

  return markdown;
}

/**
 * Generate natural footer text based on user language
 * More natural, less bot-like formatting that adapts to user's language
 */
function generateFooter(
  plan: TestPlan,
  userLanguage?: 'en' | 'ru' | 'neutral',
  userMessage?: string
): string {
  // Auto-detect language from user message if not provided
  let detectedLang = userLanguage;
  if (!detectedLang && userMessage) {
    // Simple detection: if message contains Cyrillic → ru, else → en
    const hasCyrillic = /[а-яА-ЯёЁ]/.test(userMessage);
    detectedLang = hasCyrillic ? 'ru' : 'en';
  }

  // Default to English if no language detected
  const lang = detectedLang === 'ru' ? 'ru' : 'en';

  // Natural, conversational footer - sounds like AI, not a bot
  if (lang === 'ru') {
    return `Дайте знать, если хотите продолжить с этим тестом, или если нужно что-то изменить.\n`;
  }
  return `Let me know if you want to proceed with this test, or if you'd like to adjust anything.\n`;
}


// ═══════════════════════════════════════════════════════════════════════════
// INTELLIGENT TEST PLAN GENERATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Generate intelligent test plan (surface-level for user approval)
 * Details will be determined dynamically during execution
 */
export async function generateIntelligentTestPlan(
  explorationResult: ExplorationResult,
  userRequest: {
    message: string;
    scope: string;
    additionalInfo?: Record<string, any>;
  }
): Promise<TestPlan> {
  try {
    logger.info('Generating intelligent test plan', {
      url: explorationResult.url,
      scope: userRequest.scope,
    });

    // Generate unique ID - IMPORTANT: Use UUID format for database compatibility
    const planId = randomUUID();

    // Build surface-level plan for approval
    const testPlan: TestPlan = {
      id: planId,
      status: 'pending_confirmation',
      url: explorationResult.url,
      scope: userRequest.scope,
      summary: `Intelligent testing of ${explorationResult.url}. The AI agent will autonomously explore and test the site, adapting to each page dynamically.`,
      steps: [
        {
          id: 'step_1',
          description: 'Analyze and explore the site',
          action: 'intelligent_explore',
          expectedOutcome: 'Understanding of site structure and key pages',
        },
        {
          id: 'step_2',
          description: 'Execute contextual testing on each page',
          action: 'intelligent_test',
          expectedOutcome: 'Comprehensive testing adapted to page context',
        },
        {
          id: 'step_3',
          description: 'Validate logical dependencies and user flows',
          action: 'intelligent_validate',
          expectedOutcome: 'Verification of UX logic and workflows',
        },
      ],
      commands: [], // No static commands - will be generated dynamically
      estimatedDuration: '1-3 minutes',
      whatWillBeTested: [
        'Page navigation and routing',
        'Interactive elements (buttons, forms, inputs)',
        'Logical dependencies between elements',
        'User journey flows',
        'Visual elements and layouts',
        'Dynamic content and state changes',
      ],
      whatWillNotBeTested: [
        'Payment processing (requires manual approval)',
        'Account deletion (safety restriction)',
        'Email/SMS sending (external systems)',
        'Third-party integrations',
      ],
      risks: [
        'CAPTCHA may require manual intervention',
        'Authentication may be needed for protected pages',
        'Dynamic content may cause unpredictable behavior',
        'Popups and modals may block automation',
      ],
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),

      // Intelligent mode flags
      intelligentMode: true,
      estimatedPages: '5-10 pages',
      estimatedCost: '$0.10-0.20',
    };

    logger.info('Intelligent test plan generated', {
      planId,
      intelligentMode: true,
    });

    return testPlan;
  } catch (error) {
    logger.error('Failed to generate intelligent test plan', { error });
    throw error;
  }
}
