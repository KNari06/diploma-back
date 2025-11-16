import { buildTestPlanPrompt } from '@/ai/prompts/index';
import { getChatCompletionWithMessages } from '@/services/ai/openai.service';
import { ExplorationResult } from '@/services/testing/autonomous-explorer.service';
import { PlaywrightCommand } from '@/types';
import { logger } from '@/utils/logger';

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
 * ВАЖНО: Plan требует подтверждения от юзера!
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

    // Generate unique ID
    const planId = `plan_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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
 */
export function formatTestPlanForConfirmation(plan: TestPlan): string {
  // ✅ UNIFIED: Support both AI-generated and standard test plans
  const isAiGenerated = plan.intelligentMode;

  // Header with appropriate mode indication
  let markdown = isAiGenerated
    ? `# 🧠 AI Test Plan for Confirmation\n\n`
    : `# 🧪 Test Plan для подтверждения\n\n`;

  // Basic info
  markdown += `**Plan ID:** \`${plan.id}\`\n`;
  markdown += `**URL:** ${plan.url}\n`;
  markdown += `**Scope:** ${plan.scope}\n`;

  if (isAiGenerated) {
    markdown += `**Mode:** 🤖 **AI-Generated Testing**\n`;
  }

  markdown += `**Estimated Duration:** ${plan.estimatedDuration}\n\n`;

  // Summary
  markdown += `## 📋 Summary\n\n${plan.summary}\n\n`;

  // AI-specific estimates (if available)
  if (isAiGenerated && (plan.estimatedPages || plan.estimatedCost)) {
    markdown += `## 📊 AI Estimates\n\n`;
    if (plan.estimatedPages) {
      markdown += `- **Pages to Test:** ${plan.estimatedPages}\n`;
    }
    if (plan.estimatedCost) {
      markdown += `- **Estimated Cost:** ${plan.estimatedCost}\n`;
    }
    markdown += '\n';
  }

  // AI explanation (for AI-generated plans)
  if (isAiGenerated) {
    markdown += `## 🤖 How AI Testing Works\n\n`;
    markdown += `This AI-generated test plan will:\n`;
    markdown += `1. **Execute pre-analyzed test steps** tailored to your specific site\n`;
    markdown += `2. **Adapt to page context** based on URL analysis and user intent\n`;
    markdown += `3. **Follow intelligent test scenarios** created by GPT-4o\n`;
    markdown += `4. **Provide detailed results** with actionable insights\n\n`;
  }

  // What will be tested
  markdown += `## ✅ What Will Be Tested\n\n`;
  for (const item of plan.whatWillBeTested) {
    markdown += `- ${item}\n`;
  }

  // What will NOT be tested
  if (plan.whatWillNotBeTested.length > 0) {
    markdown += `\n## ❌ What Will NOT Be Tested\n\n`;
    for (const item of plan.whatWillNotBeTested) {
      markdown += `- ${item}\n`;
    }
  }

  // Test Steps (show for non-AI or if steps are meaningful)
  if (!isAiGenerated || (plan.steps && plan.steps.length > 0 && plan.steps.some(s => s.action !== 'intelligent_explore'))) {
    markdown += `\n## 🔍 Test Steps\n\n`;
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
      markdown += `   - Expected: ${step.expectedOutcome}\n\n`;
    }
  } else if (isAiGenerated) {
    markdown += `\n## 🔍 Test Execution\n\n`;
    markdown += `⚠️ **Note:** Detailed test steps are AI-generated and will be executed automatically based on the analysis above.\n\n`;
  }

  // Risks
  if (plan.risks.length > 0) {
    markdown += `## 🚨 Potential Risks\n\n`;
    for (const risk of plan.risks) {
      markdown += `- ${risk}\n`;
    }
    markdown += '\n';
  }

  // Safety features (for AI plans)
  if (isAiGenerated) {
    markdown += `## 🛡️ Safety Features\n\n`;
    markdown += `- Real-time progress updates via WebSocket\n`;
    markdown += `- Automatic detection of dangerous actions (payment, delete, etc.)\n`;
    markdown += `- Intelligent timeout and error handling\n`;
    markdown += `- Safe execution with rollback capabilities\n\n`;
  }

  // Footer
  markdown += `---\n\n`;
  markdown += `**⏳ Plan expires at:** ${new Date(plan.expiresAt).toLocaleString()}\n\n`;
  markdown += `💬 **Подтвердить тест план?**\n\n`;
  markdown += `Напишите свой ответ (любыми словами):\n`;
  markdown += `- ✅ Да / Давай / Ок / Go / Запускай → Выполнить тест\n`;
  markdown += `- ❌ Нет / Отмена / Стоп / Cancel → Отклонить\n\n`;
  markdown += `AI поймёт ваш ответ на любом языке! 🤖\n`;

  return markdown;
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

    // Generate unique ID
    const planId = `intelligent_${Date.now()}_${Math.random().toString(36).substring(7)}`;

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
