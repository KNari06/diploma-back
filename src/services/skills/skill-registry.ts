import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from './types';
import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKILL REGISTRY (Singleton)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Central registry for all skills.
 * Manages skill registration, availability checking, and tool execution routing.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

class SkillRegistryClass {
  private skills: Map<string, SkillDefinition> = new Map();
  private toolNameToSkillId: Map<string, string> = new Map();

  /**
   * Register a skill
   */
  register(skill: SkillDefinition): void {
    if (this.skills.has(skill.id)) {
      logger.warn('[SKILL_REGISTRY] Skill already registered, overwriting', {
        skillId: skill.id,
      });
    }

    this.skills.set(skill.id, skill);

    // Map tool names to skill ID for routing
    skill.tools.forEach((tool) => {
      const toolName = tool.function.name;
      if (this.toolNameToSkillId.has(toolName)) {
        logger.warn('[SKILL_REGISTRY] Tool name conflict, overwriting', {
          toolName,
          oldSkillId: this.toolNameToSkillId.get(toolName),
          newSkillId: skill.id,
        });
      }
      this.toolNameToSkillId.set(toolName, skill.id);
    });

    logger.info('[SKILL_REGISTRY] Skill registered', {
      skillId: skill.id,
      skillName: skill.name,
      toolsCount: skill.tools.length,
      toolNames: skill.tools.map((t) => t.function.name),
    });
  }

  /**
   * Get all available tools for the given context
   * Filters by skill availability (e.g., user has connected integration)
   */
  async getAvailableTools(context: SkillContext): Promise<ChatCompletionTool[]> {
    const availableTools: ChatCompletionTool[] = [];

    for (const skill of this.skills.values()) {
      try {
        const isAvailable = await skill.isAvailable(context);
        if (isAvailable) {
          availableTools.push(...skill.tools);
          logger.debug('[SKILL_REGISTRY] Skill available', {
            skillId: skill.id,
            toolsCount: skill.tools.length,
          });
        } else {
          logger.debug('[SKILL_REGISTRY] Skill not available', {
            skillId: skill.id,
          });
        }
      } catch (error) {
        logger.error('[SKILL_REGISTRY] Error checking skill availability', {
          skillId: skill.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    logger.info('[SKILL_REGISTRY] Available tools collected', {
      totalTools: availableTools.length,
      context: {
        userId: context.userId,
        workspaceId: context.workspaceId,
      },
    });

    return availableTools;
  }

  /**
   * Get skill descriptions for system prompt injection
   * Returns formatted string describing available skills
   */
  async getSkillDescriptions(context: SkillContext): Promise<string> {
    const descriptions: string[] = [];

    for (const skill of this.skills.values()) {
      try {
        const isAvailable = await skill.isAvailable(context);
        if (isAvailable) {
          descriptions.push(`**${skill.name}**: ${skill.description}`);
        }
      } catch (error) {
        logger.error('[SKILL_REGISTRY] Error checking skill availability for descriptions', {
          skillId: skill.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (descriptions.length === 0) {
      return '';
    }

    return `\n\n--- AVAILABLE INTEGRATIONS ---\n\n${descriptions.join('\n\n')}`;
  }

  /**
   * Execute a tool by name
   * Routes tool call to the correct skill
   */
  async executeTool(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult> {
    logger.info('[SKILL_REGISTRY] Executing tool', {
      toolName,
      args: JSON.stringify(args),
      context: {
        userId: context.userId,
        workspaceId: context.workspaceId,
      },
    });

    // Find skill for this tool
    const skillId = this.toolNameToSkillId.get(toolName);
    if (!skillId) {
      logger.error('[SKILL_REGISTRY] Tool not found', { toolName });
      return {
        success: false,
        message: `Unknown tool: ${toolName}`,
        displayToUser: false,
      };
    }

    const skill = this.skills.get(skillId);
    if (!skill) {
      logger.error('[SKILL_REGISTRY] Skill not found for tool', {
        toolName,
        skillId,
      });
      return {
        success: false,
        message: `Skill not found for tool: ${toolName}`,
        displayToUser: false,
      };
    }

    // Check availability
    try {
      const isAvailable = await skill.isAvailable(context);
      if (!isAvailable) {
        logger.warn('[SKILL_REGISTRY] Skill not available for execution', {
          skillId,
          toolName,
        });
        return {
          success: false,
          message: `${skill.name} integration is not connected. Please connect it first.`,
          displayToUser: true, // Show to user
        };
      }
    } catch (error) {
      logger.error('[SKILL_REGISTRY] Error checking skill availability', {
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: `Failed to check ${skill.name} availability: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }

    // Execute tool
    try {
      const result = await skill.execute(toolName, args, context);
      logger.info('[SKILL_REGISTRY] Tool executed', {
        toolName,
        skillId,
        success: result.success,
      });
      return result;
    } catch (error) {
      logger.error('[SKILL_REGISTRY] Tool execution error', {
        toolName,
        skillId,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error instanceof Error ? error.message : String(error)}`,
        displayToUser: false,
      };
    }
  }

  /**
   * List all registered skills
   */
  listSkills(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }

  /**
   * Get a skill by ID
   */
  getSkill(skillId: string): SkillDefinition | undefined {
    return this.skills.get(skillId);
  }

  /**
   * Clear all skills (for testing)
   */
  clear(): void {
    this.skills.clear();
    this.toolNameToSkillId.clear();
    logger.info('[SKILL_REGISTRY] Registry cleared');
  }
}

// Export singleton instance
export const SkillRegistry = new SkillRegistryClass();
