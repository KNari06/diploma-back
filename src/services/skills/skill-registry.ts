import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { SkillDefinition, SkillContext, SkillResult } from './types';
import { logger } from '@/utils/core/logger';
import { supabaseAdmin } from '@/db/supabase';

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

  /** Tools whose schema includes a `confirm` parameter */
  private toolsWithConfirm: Set<string> = new Set();

  /**
   * Tracks confirm=false (preview) calls.
   * Key: `chatSessionId:toolName`, Value: timestamp (ms).
   * A confirm=true call is only allowed if a preview exists for this key.
   */
  private confirmPreviews: Map<string, number> = new Map();

  /** Preview entries expire after 5 minutes */
  private static readonly CONFIRM_TTL_MS = 5 * 60 * 1000;

  /**
   * Register a skill
   */
  register(skill: SkillDefinition): void {
    // Validate: unique skill ID
    if (this.skills.has(skill.id)) {
      throw new Error(`[SKILL_REGISTRY] Skill '${skill.id}' already registered. Duplicate registration is not allowed.`);
    }

    // Validate: no tool name conflicts across skills
    for (const tool of skill.tools) {
      const existingSkillId = this.toolNameToSkillId.get(tool.function.name);
      if (existingSkillId) {
        throw new Error(
          `[SKILL_REGISTRY] Tool '${tool.function.name}' from skill '${skill.id}' conflicts with skill '${existingSkillId}'.`
        );
      }
    }

    this.skills.set(skill.id, skill);

    // Map tool names to skill ID for routing, detect confirm-bearing tools
    skill.tools.forEach((tool) => {
      const toolName = tool.function.name;
      this.toolNameToSkillId.set(toolName, skill.id);

      // Track tools that have a `confirm` parameter in their schema
      const props = (tool.function.parameters as any)?.properties;
      if (props && 'confirm' in props) {
        this.toolsWithConfirm.add(toolName);
      }
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

    // ── Confirm guard: prevent LLM from bypassing user approval ──
    if (this.toolsWithConfirm.has(toolName)) {
      const sessionId = context.chatSessionId;

      if (args.confirm === true) {
        // Exception: qa_run_test in editor mode — user explicitly runs from editor
        const isEditorPreview = toolName === 'qa_run_test' && !!context.previewSessionId;

        if (!isEditorPreview && sessionId) {
          const previewKey = `${sessionId}:${toolName}`;
          const previewTs = this.confirmPreviews.get(previewKey);

          if (!previewTs || Date.now() - previewTs > SkillRegistryClass.CONFIRM_TTL_MS) {
            // No prior preview or expired — override to false so handler returns preview message
            logger.warn('[SKILL_REGISTRY] Confirm guard: overriding confirm=true (no prior preview)', {
              toolName,
              chatSessionId: sessionId,
            });
            args.confirm = false;
          } else {
            // Valid preview exists — allow through and consume it
            this.confirmPreviews.delete(previewKey);
            logger.info('[SKILL_REGISTRY] Confirm guard: allowing confirm=true (preview found)', {
              toolName,
              chatSessionId: sessionId,
            });
          }
        }
      } else if (args.confirm === false && sessionId) {
        // Record the preview call
        const previewKey = `${sessionId}:${toolName}`;
        this.confirmPreviews.set(previewKey, Date.now());

        // Periodic cleanup: evict expired entries every 100 records
        if (this.confirmPreviews.size > 100) {
          const now = Date.now();
          for (const [key, ts] of this.confirmPreviews) {
            if (now - ts > SkillRegistryClass.CONFIRM_TTL_MS) {
              this.confirmPreviews.delete(key);
            }
          }
        }
      }
    }

    // Execute tool with enhanced error boundary
    const executeStart = Date.now();

    try {
      const result = await skill.execute(toolName, args, context);
      const durationMs = Date.now() - executeStart;

      logger.info('[SKILL_REGISTRY] Tool executed', {
        toolName,
        skillId,
        success: result.success,
        durationMs,
      });
      return result;
    } catch (rawError) {
      const durationMs = Date.now() - executeStart;
      const error = rawError instanceof Error ? rawError : new Error(String(rawError));

      // Structured error logging with args snapshot and truncated stack
      const argsSnapshot = (() => {
        try {
          const json = JSON.stringify(args);
          return json.length > 500 ? json.slice(0, 500) + '…' : json;
        } catch {
          return '[unserializable]';
        }
      })();

      const stackLines = error.stack?.split('\n').slice(0, 5).join('\n') ?? 'no stack';

      logger.error('[SKILL_REGISTRY] Tool execution error', {
        toolName,
        skillId,
        durationMs,
        error: error.message,
        argsSnapshot,
        stack: stackLines,
      });

      return {
        success: false,
        message: `Failed to execute ${toolName}: ${error.message}`,
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
   * Get the skill that owns a given tool name.
   * Used by tool-executor.ts to access retryConfig and onError.
   */
  getSkillForTool(toolName: string): SkillDefinition | undefined {
    const skillId = this.toolNameToSkillId.get(toolName);
    return skillId ? this.skills.get(skillId) : undefined;
  }

  /**
   * Read per-workspace skill configuration from workspaces.settings JSONB.
   * Path: `settings.skills[skillId]`
   *
   * Returns empty object if no config exists (never throws).
   * No cache — queries are infrequent and use PK lookup (fast).
   */
  async getSkillConfig(workspaceId: string, skillId: string): Promise<Record<string, any>> {
    try {
      const { data, error } = await supabaseAdmin
        .from('workspaces')
        .select('settings')
        .eq('id', workspaceId)
        .single();

      if (error || !data?.settings) {
        return {};
      }

      const settings = data.settings as Record<string, any>;
      return settings?.skills?.[skillId] ?? {};
    } catch (err) {
      logger.warn('[SKILL_REGISTRY] Failed to read workspace skill config', {
        workspaceId,
        skillId,
        error: err instanceof Error ? err.message : String(err),
      });
      return {};
    }
  }

  /**
   * Clear all skills (for testing)
   */
  clear(): void {
    this.skills.clear();
    this.toolNameToSkillId.clear();
    this.toolsWithConfirm.clear();
    this.confirmPreviews.clear();
    logger.info('[SKILL_REGISTRY] Registry cleared');
  }
}

// Export singleton instance
export const SkillRegistry = new SkillRegistryClass();
