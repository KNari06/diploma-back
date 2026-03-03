import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { SUB_AGENT_CONFIG } from '../config';
import { raceWithTimeout } from '../tool-constants';
import { buildPlannerPrompt } from '../prompts/planner-prompt';
import { buildToolGroups, getValidCategories } from '../tool-groups';
import type { PlannerResult, PlanStep, ToolCategory } from '../types';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PLANNER AGENT
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Creates execution plan for multi-tool tasks.
 * Only called when Router classifies as multi_tool.
 * Uses gpt-4o for complex reasoning about tool orchestration.
 *
 * Also provides identifyParallelGroups() for topological grouping of steps
 * by dependency level — used by the spawner for parallel execution.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Identify groups of plan steps that can run in parallel.
 *
 * Performs a topological sort by dependency level:
 * - Steps with no unmet dependencies at the same level form a parallel group
 * - Groups are executed sequentially, steps within a group concurrently
 *
 * @example
 * Steps: 1(deps:[]), 2(deps:[]), 3(deps:[1,2])
 * Result: [[1, 2], [3]] — steps 1,2 are parallel, then step 3
 *
 * @example
 * Steps: 1(deps:[]), 2(deps:[1]), 3(deps:[2])
 * Result: [[1], [2], [3]] — all sequential, no parallelism
 */
export function identifyParallelGroups(steps: PlanStep[]): number[][] {
  if (steps.length === 0) return [];

  const groups: number[][] = [];
  const completed = new Set<number>();
  let remaining = [...steps];

  // Safety: max iterations = number of steps (prevents infinite loop on circular deps)
  let maxIterations = steps.length;

  while (remaining.length > 0 && maxIterations > 0) {
    maxIterations--;

    // Find all steps whose dependencies are met
    const ready = remaining.filter(s =>
      s.dependsOn.every(dep => completed.has(dep))
    );

    if (ready.length === 0) {
      // Circular dependency or broken deps — put all remaining in one group
      logger.warn('[PLANNER_AGENT] Circular/broken dependencies detected, grouping remaining steps', {
        remaining: remaining.map(s => s.stepNumber),
      });
      groups.push(remaining.map(s => s.stepNumber));
      break;
    }

    groups.push(ready.map(s => s.stepNumber));
    ready.forEach(s => completed.add(s.stepNumber));
    remaining = remaining.filter(s => !completed.has(s.stepNumber));
  }

  return groups;
}

/**
 * Create an execution plan for a multi-tool task.
 */
export async function createPlan(
  userMessage: string,
  toolCategories: ToolCategory[],
  abortSignal?: AbortSignal,
  availableToolNames?: Set<string>
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
    const aiPromise = getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: AI_TASK_MODELS.chatPlanner,
        temperature: SUB_AGENT_CONFIG.plannerTemperature,
        max_tokens: SUB_AGENT_CONFIG.plannerMaxTokens,
        response_format: { type: 'json_object' },
        abortSignal,
      }
    );

    const response = await raceWithTimeout(aiPromise, SUB_AGENT_CONFIG.agentTimeoutMs);

    if (!response || !response.content) {
      logger.warn('[PLANNER_AGENT] Timeout or empty response');
      return null;
    }

    const cleanContent = response.content.replace(/```json\s*|```\s*/g, '').trim();
    const parsed = JSON.parse(cleanContent);

    // Validate and sanitize LLM-generated plan steps
    const validCategories = getValidCategories(availableToolNames);
    const defaultCategory = toolCategories[0] || validCategories[0] || 'memory';

    /**
     * Sanitize a category from LLM output.
     * 1. Exact match → use as-is
     * 2. Prefix match → e.g. "qa" matches "qa_read" (pick first match)
     * 3. No match → fallback to the first router-selected category
     */
    const sanitizeCategory = (raw: string | undefined): ToolCategory => {
      if (!raw) return defaultCategory;
      if (validCategories.includes(raw)) return raw;
      // Prefix match: LLM said "qa" but valid is "qa_read"
      const prefixMatch = validCategories.find(vc => vc.startsWith(raw) || raw.startsWith(vc.replace(/_read$|_write$/, '')));
      if (prefixMatch) {
        logger.info('[PLANNER_AGENT] Fixed invalid category via prefix match', { raw, fixed: prefixMatch });
        return prefixMatch;
      }
      logger.warn('[PLANNER_AGENT] Unknown category from LLM, using fallback', { raw, fallback: defaultCategory });
      return defaultCategory;
    };

    // Parse steps and force unique sequential stepNumbers (LLM may return duplicates)
    const rawSteps = (parsed.steps || []).map((step: any, idx: number) => ({
      stepNumber: idx + 1, // Always re-number sequentially — prevents duplicates
      description: step.description || '',
      category: sanitizeCategory(step.category),
      expectedTool: step.expectedTool,
      // Remap dependsOn from LLM step numbers to our sequential numbers
      dependsOn: Array.isArray(step.dependsOn)
        ? (step.dependsOn as number[]).filter((d: number) => typeof d === 'number' && d >= 1 && d <= (parsed.steps || []).length)
        : [],
    }));

    const result: PlannerResult = {
      summary: parsed.summary || 'Multi-step task',
      steps: rawSteps,
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
