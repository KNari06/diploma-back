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
   * Memory tools don't need external tokens, but they operate at WORKSPACE
   * scope (writeMemory/searchMemory/forgetMemory key on workspace_id only).
   * There is no per-test-case memory partition, so exposing them inside the
   * per-test-case editor chat would let facts/deletes from one test case bleed
   * into global chat and every other test case. Keep them to global chat until
   * a test-case-scoped memory store exists. (Reads via getMemoryForContext are
   * unaffected — workspace memory is intentionally injected everywhere.)
   */
  isAvailable: async (context) => context.storeKind !== 'testcase',

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

export default MemorySkill;
