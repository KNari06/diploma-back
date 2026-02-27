import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { buildPlannerPrompt } from '../prompts/planner-prompt';
import { buildToolGroups } from '../tool-groups';
import type { PlannerResult, ToolCategory } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLANNER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Creates execution plan for multi-tool tasks.
 * Only called when Router classifies as multi_tool.
 * Uses gpt-4o for complex reasoning about tool orchestration.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Create an execution plan for a multi-tool task.
 */
export async function createPlan(
  userMessage: string,
  toolCategories: ToolCategory[],
  abortSignal?: AbortSignal
): Promise<PlannerResult | null> {
  const startMs = Date.now();

  // Build tool descriptions for the planner (markdown, not schemas)
  const groups = buildToolGroups();
  const toolDescriptions = toolCategories
    .map(cat => {
      const group = groups.find(g => g.category === cat);
      if (!group) return null;
      return `- **${group.category}**: ${group.description} (tools: ${group.toolNames.join(', ')})`;
    })
    .filter(Boolean)
    .join('\n');

  const prompt = buildPlannerPrompt(userMessage, toolDescriptions);

  try {
    const timeoutPromise = new Promise<null>((resolve) => {
      setTimeout(() => resolve(null), SUB_AGENT_CONFIG.agentTimeoutMs);
    });

    const aiPromise = getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: AI_TASK_MODELS.chatPlanner,
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: 'json_object' },
        abortSignal,
      }
    );

    const response = await Promise.race([aiPromise, timeoutPromise]);

    if (!response || !response.content) {
      logger.warn('[PLANNER_AGENT] Timeout or empty response');
      return null;
    }

    const cleanContent = response.content.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    const result: PlannerResult = {
      summary: parsed.summary || 'Multi-step task',
      steps: (parsed.steps || []).map((step: any, idx: number) => ({
        stepNumber: step.stepNumber || idx + 1,
        description: step.description || '',
        category: step.category || toolCategories[0],
        expectedTool: step.expectedTool,
        dependsOn: step.dependsOn || [],
      })),
    };

    logger.info('[PLANNER_AGENT] Plan created', {
      summary: result.summary,
      stepsCount: result.steps.length,
      durationMs: Date.now() - startMs,
    });

    return result;
  } catch (error) {
    logger.error('[PLANNER_AGENT] Planning failed', {
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startMs,
    });
    return null;
  }
}
