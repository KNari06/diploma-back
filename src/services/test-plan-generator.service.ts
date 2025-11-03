import { logger } from '@/utils/logger';
import { PlaywrightCommand } from '@/types';
import { ExplorationResult } from '@/services/autonomous-explorer.service';
import { getChatCompletionWithMessages } from '@/services/openai.service';

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

    const aiPlan = JSON.parse(response);

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
 * Build prompt for test plan generation
 */
function buildTestPlanPrompt(
  exploration: ExplorationResult,
  userRequest: { message: string; scope: string; additionalInfo?: any }
): string {
  return `Generate a comprehensive test plan based on the following exploration data.

USER REQUEST:
"${userRequest.message}"

SCOPE:
${userRequest.scope}

PAGE INFORMATION:
- URL: ${exploration.url}
- Title: ${exploration.pageInfo.title}

VISUAL ANALYSIS (from GPT-4o Vision):
${JSON.stringify(exploration.visualAnalysis, null, 2)}

DOM ANALYSIS:
- Forms: ${exploration.domAnalysis.forms.length}
${exploration.domAnalysis.forms.map((f, i) => `  Form ${i + 1}: ${f.fields.length} fields (${f.fields.map(field => field.name || field.type).join(', ')})`).join('\n')}

- Buttons: ${exploration.domAnalysis.buttons.length}
${exploration.domAnalysis.buttons.map(b => `  - ${b.text || b.type} (${b.selector})`).join('\n')}

- Inputs: ${exploration.domAnalysis.inputs.length}
${exploration.domAnalysis.inputs.map(i => `  - ${i.type} ${i.name || ''} ${i.required ? '(required)' : ''}`).join('\n')}

RECOMMENDATIONS:
${exploration.recommendations.map(r => `- ${r}`).join('\n')}

---

Generate a test plan in this EXACT JSON format:

{
  "summary": "Brief summary of what this test plan will do (2-3 sentences)",

  "steps": [
    {
      "id": "step_1",
      "description": "Human-readable step description",
      "action": "goto|fill|click|assertVisible|etc",
      "selector": "CSS selector if applicable",
      "value": "Value to input if applicable",
      "expectedOutcome": "What should happen after this step"
    }
  ],

  "commands": [
    {
      "action": "goto",
      "url": "${exploration.url}",
      "description": "Navigate to page"
    },
    {
      "action": "fill",
      "selector": "actual_selector_from_dom_analysis",
      "value": "test@example.com",
      "description": "Fill email field"
    }
  ],

  "estimatedDuration": "~30 seconds",

  "whatWillBeTested": [
    "Specific functionality 1",
    "Specific functionality 2"
  ],

  "whatWillNotBeTested": [
    "Out of scope functionality 1",
    "Out of scope functionality 2"
  ],

  "risks": [
    "Potential issue or limitation of this test"
  ]
}

IMPORTANT:
- Use REAL selectors from DOM analysis
- Create 5-10 specific test steps
- Generate matching Playwright commands
- Be specific about expected outcomes
- Estimate realistic duration
- List what WILL and WILL NOT be tested
- Identify potential risks or limitations

Focus on: ${userRequest.scope}`;
}

/**
 * Format test plan for user confirmation
 * Returns markdown formatted plan
 */
export function formatTestPlanForConfirmation(plan: TestPlan): string {
  let markdown = `# 🧪 Test Plan для подтверждения\n\n`;
  markdown += `**URL:** ${plan.url}\n`;
  markdown += `**Scope:** ${plan.scope}\n`;
  markdown += `**Estimated duration:** ${plan.estimatedDuration}\n\n`;

  markdown += `## 📋 Summary\n\n${plan.summary}\n\n`;

  markdown += `## ✅ Что будет протестировано:\n\n`;
  for (const item of plan.whatWillBeTested) {
    markdown += `- ${item}\n`;
  }

  if (plan.whatWillNotBeTested.length > 0) {
    markdown += `\n## ❌ Что НЕ будет протестировано:\n\n`;
    for (const item of plan.whatWillNotBeTested) {
      markdown += `- ${item}\n`;
    }
  }

  markdown += `\n## 🔍 Test Steps:\n\n`;
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

  if (plan.risks.length > 0) {
    markdown += `## ⚠️ Potential Risks:\n\n`;
    for (const risk of plan.risks) {
      markdown += `- ${risk}\n`;
    }
  }

  markdown += `\n---\n\n`;
  markdown += `**Plan ID:** \`${plan.id}\`\n`;
  markdown += `**Expires:** ${new Date(plan.expiresAt).toLocaleString()}\n\n`;
  markdown += `✅ **Чтобы продолжить, подтвердите этот plan:**\n`;
  markdown += `\`/confirm ${plan.id}\`\n\n`;
  markdown += `❌ **Чтобы отменить:**\n`;
  markdown += `\`/reject ${plan.id}\` с указанием причины\n`;

  return markdown;
}

/**
 * Confirm test plan
 */
export async function confirmTestPlan(planId: string): Promise<boolean> {
  // Implementation will be in cache/storage service
  logger.info('Test plan confirmed', { planId });
  return true;
}

/**
 * Reject test plan
 */
export async function rejectTestPlan(planId: string, reason?: string): Promise<boolean> {
  logger.info('Test plan rejected', { planId, reason });
  return true;
}
