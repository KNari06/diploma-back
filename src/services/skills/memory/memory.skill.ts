/**
 * ═══════════════════════════════════════════════════════════════════════════
 * MEMORY SKILL
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Wraps the existing memory tools (remember_fact, search_memory, forget_fact)
 * as a SkillDefinition so they can be registered in SkillRegistry.
 *
 * This eliminates the separate code path for memory tools — they now go
 * through the same SkillRegistry.executeTool() pipeline as all other tools.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { MEMORY_TOOLS, executeMemoryTool } from '@/services/ai/memory/memory-tools';
import type { SkillDefinition } from '../types';

export const MemorySkill: SkillDefinition = {
  id: 'memory',
  name: 'Workspace Memory',
  provider: 'memory',
  description: 'Persistent workspace memory — remember facts, preferences, and patterns across conversations.',

  tools: MEMORY_TOOLS,

  /**
   * Memory tools are always available — they don't require external integration tokens.
   * Only require a workspaceId, which is validated at execution time.
   */
  isAvailable: async () => true,

  /**
   * Route to the existing executeMemoryTool dispatcher.
   * The workspaceId/userId come from the SkillContext.
   */
  execute: async (toolName, args, context) => {
    if (!context.workspaceId) {
      return {
        success: false,
        message: 'Workspace context required for memory tools.',
        displayToUser: false,
      };
    }
    return executeMemoryTool(toolName, args, context.workspaceId, context.userId);
  },
};
