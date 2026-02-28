import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { ToolCategory, ToolGroup } from './types';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DYNAMIC TOOL GROUPS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Auto-generates tool categories from SkillRegistry at runtime.
 * New skills are picked up automatically — no manual edits needed.
 *
 * Logic:
 * 1. Reads all registered skills from SkillRegistry.listSkills()
 * 2. Skills with many tools (like QA) are split into read/write categories
 *    based on whether tools have a `confirm` parameter
 * 3. Everything else (including MemorySkill) becomes a single category per skill
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Threshold: split skill into read/write if it has more than this many tools */
const SPLIT_THRESHOLD = 15;

/** Cache for built tool groups (rebuilt when skills change) */
let cachedGroups: ToolGroup[] | null = null;
let cachedSkillCount = 0;

/**
 * Check if a tool has a `confirm` parameter (indicates a write/destructive tool).
 */
function toolHasConfirmParam(tool: ChatCompletionTool): boolean {
  const params = tool.function.parameters as any;
  if (!params?.properties) return false;
  return 'confirm' in params.properties;
}

/**
 * Build tool groups dynamically from SkillRegistry.
 * Caches result — rebuilds only when skill count changes.
 */
export function buildToolGroups(): ToolGroup[] {
  // Lazy import to avoid circular dependency
  const { SkillRegistry } = require('@/services/skills');
  const skills = SkillRegistry.listSkills();

  // Return cache if skill count hasn't changed
  if (cachedGroups && cachedSkillCount === skills.length) {
    return cachedGroups;
  }

  const groups: ToolGroup[] = [];

  for (const skill of skills) {
    const toolNames = skill.tools.map((t: ChatCompletionTool) => t.function.name);

    // Large skills (like QA) → split into read/write
    if (toolNames.length > SPLIT_THRESHOLD) {
      const readTools: string[] = [];
      const writeTools: string[] = [];

      for (const tool of skill.tools) {
        if (toolHasConfirmParam(tool)) {
          writeTools.push(tool.function.name);
        } else {
          readTools.push(tool.function.name);
        }
      }

      if (readTools.length > 0) {
        groups.push({
          category: `${skill.id}_read`,
          description: `${skill.name} (read): ${skill.description}`,
          keywords: [skill.id, skill.provider, 'list', 'get', 'search', 'show', 'analytics'],
          readOnly: true,
          toolNames: readTools,
        });
      }

      if (writeTools.length > 0) {
        groups.push({
          category: `${skill.id}_write`,
          description: `${skill.name} (write): create, update, delete, run, manage operations`,
          keywords: [skill.id, 'create', 'update', 'delete', 'run', 'manage'],
          readOnly: false,
          toolNames: writeTools,
        });
      }
    } else {
      // Normal skills → one category per skill
      groups.push({
        category: skill.id,
        description: `${skill.name}: ${skill.description}`,
        keywords: [skill.id, skill.provider, ...skill.name.toLowerCase().split(/\s+/)],
        readOnly: false,
        toolNames: toolNames,
      });
    }
  }

  // Note: Memory tools are now auto-discovered from MemorySkill in SkillRegistry
  // (no hardcoded memory category needed — MemorySkill has 3 tools < SPLIT_THRESHOLD,
  //  so it becomes a single "memory" group via the else branch above)

  cachedGroups = groups;
  cachedSkillCount = skills.length;

  logger.info('[TOOL_GROUPS] Built dynamic tool groups', {
    groupCount: groups.length,
    categories: groups.map(g => `${g.category}(${g.toolNames.length})`),
    totalTools: groups.reduce((sum, g) => sum + g.toolNames.length, 0),
  });

  return groups;
}

/**
 * Filter available tools by selected categories.
 * Returns only tools whose names belong to the selected categories.
 */
export function getToolsForCategories(
  allTools: ChatCompletionTool[],
  categories: ToolCategory[]
): ChatCompletionTool[] {
  const groups = buildToolGroups();
  const allowedToolNames = new Set<string>();

  for (const category of categories) {
    const group = groups.find(g => g.category === category);
    if (group) {
      group.toolNames.forEach(name => allowedToolNames.add(name));
    }
  }

  return allTools.filter(tool => allowedToolNames.has(tool.function.name));
}

/**
 * Get a compact summary of tool groups for the router prompt.
 * Only includes groups that have at least one available tool.
 */
export function getToolGroupSummary(availableToolNames: Set<string>): string {
  const groups = buildToolGroups();
  const lines: string[] = [];

  for (const group of groups) {
    const availableInGroup = group.toolNames.filter(name => availableToolNames.has(name));
    if (availableInGroup.length > 0) {
      lines.push(`- **${group.category}** (${availableInGroup.length} tools): ${group.description}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get all valid category names (for router validation).
 */
export function getValidCategories(): string[] {
  return buildToolGroups().map(g => g.category);
}
