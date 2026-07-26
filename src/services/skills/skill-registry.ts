import { createHash } from 'crypto';
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

  /**
   * Tracks the last confirm=true call that was ALLOWED through.
   * Key: `chatSessionId:toolName:<args fingerprint>`, Value: timestamp (ms).
   * Used to recognise a duplicate call for an action that already ran, so the
   * model is told "already done" instead of being sent back to ask for
   * approval a second time.
   *
   * Keyed on the ARGUMENTS too, unlike `confirmPreviews`. Scoping it to
   * (session, tool) alone would swallow a genuinely new request: "author a
   * login test" → approved → runs, then "now author a checkout test" 30s later
   * would match the window and come back "already executed" without ever
   * running. The real duplicate is one assistant message emitting the same
   * tool_call twice, so the arguments are identical and this still catches it.
   */
  private confirmAllowed: Map<string, number> = new Map();

  /** Preview entries expire after 5 minutes */
  private static readonly CONFIRM_TTL_MS = 5 * 60 * 1000;

  /**
   * How long after an approved run a further confirm=true still reads as a
   * duplicate of it rather than a fresh, unapproved request. Long enough to
   * cover a slow tool (iterative authoring runs ~20-60s) plus the model's
   * follow-up turn; short enough that a genuine second request minutes later
   * is still gated normally.
   */
  private static readonly DUPLICATE_WINDOW_MS = 2 * 60 * 1000;

  /**
   * Stable fingerprint of a tool call's arguments, ignoring `confirm` (which
   * differs between the preview turn and the approved one). Hashed so a call
   * carrying a large `steps` array doesn't become a multi-KB map key.
   * Fingerprinting failures degrade to '' — that only makes duplicate
   * detection coarser, never wrong in the unsafe direction, because a
   * non-duplicate then falls through to the normal approval gate.
   */
  private static argsFingerprint(args: Record<string, any>): string {
    try {
      const { confirm: _confirm, ...rest } = args ?? {};
      const canonical = JSON.stringify(
        Object.keys(rest)
          .sort()
          .map((k) => [k, rest[k]]),
      );
      return createHash('sha1').update(canonical).digest('hex').slice(0, 16);
    } catch {
      return '';
    }
  }

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
        // User approval is enforced by the SYSTEM, not the prompt — including in
        // editor mode. A confirm=true is only honoured when a prior confirm=false
        // preview turn was recorded for this (session, tool); otherwise it is
        // overridden to false so the handler returns its preview and the LLM must
        // describe the steps and wait for the user's "yes" first. The editor
        // previously bypassed this (live preview treated as implicit consent),
        // which let the LLM run generated steps on turn 1 with no explicit user
        // approval — removed so "confirmed by user" is a guarantee, not best-effort.
        if (sessionId) {
          const previewKey = `${sessionId}:${toolName}`;
          const previewTs = this.confirmPreviews.get(previewKey);

          const allowedKey = `${previewKey}:${SkillRegistryClass.argsFingerprint(args)}`;
          const allowedTs = this.confirmAllowed.get(allowedKey);
          const isDuplicateOfApproved =
            !previewTs &&
            allowedTs !== undefined &&
            Date.now() - allowedTs <= SkillRegistryClass.DUPLICATE_WINDOW_MS;

          if (isDuplicateOfApproved) {
            // A SECOND confirm=true for an action that was just approved and
            // run. The model emits these (two tool_calls in one assistant
            // message, or a retry while the first is still executing). Treating
            // it as unapproved was actively misleading: the duplicate's
            // "requires confirmation" reply is the LAST tool result the model
            // sees, so it told the user the test "was not executed yet" — right
            // after it had authored five steps and logged in for real. Answer
            // with the truth instead, and do NOT re-enter the handler (that
            // would author the whole test a second time).
            logger.info('[SKILL_REGISTRY] Confirm guard: duplicate confirm=true for an already-approved call', {
              toolName,
              chatSessionId: sessionId,
            });
            return {
              success: true,
              message:
                'This action was already approved and executed earlier in this turn — this is a duplicate call and was not run again. ' +
                'Report the result of the earlier call to the user. Do NOT ask them to approve it again.',
              displayToUser: false,
            };
          }

          if (!previewTs || Date.now() - previewTs > SkillRegistryClass.CONFIRM_TTL_MS) {
            // No prior preview or expired — override to false so handler returns preview message
            logger.warn('[SKILL_REGISTRY] Confirm guard: overriding confirm=true (no prior preview)', {
              toolName,
              chatSessionId: sessionId,
              mode: context.mode,
            });
            args.confirm = false;
            // The downgraded call IS the preview turn, so record it. Without
            // this the guard never advances: the prompts tell the model to
            // describe the action in prose and then call with confirm=true, so
            // an explicit confirm=false call — the only thing that used to
            // register a preview — never happens. Every subsequent confirm=true
            // then found no preview and was downgraded again, and the user got
            // asked to approve the same action forever (observed on
            // qa_author_test_iteratively: five identical approval requests, each
            // answered "yes"). Recording here keeps the security property
            // intact — the user still has to answer the question this turn
            // produces before the next confirm=true is honoured.
            this.confirmPreviews.set(previewKey, Date.now());
          } else {
            // Valid preview exists — allow through and consume it
            this.confirmPreviews.delete(previewKey);
            this.confirmAllowed.set(allowedKey, Date.now());
            // Prune HERE, not on the confirm=false path: with the deadlock fix
            // an explicit confirm=false call is rare, so pruning there would
            // almost never run and this map would grow for the process's life.
            if (this.confirmAllowed.size > 100) {
              const now = Date.now();
              for (const [key, ts] of this.confirmAllowed) {
                if (now - ts > SkillRegistryClass.DUPLICATE_WINDOW_MS) {
                  this.confirmAllowed.delete(key);
                }
              }
            }
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
    this.confirmAllowed.clear();
    logger.info('[SKILL_REGISTRY] Registry cleared');
  }
}

// Export singleton instance
export const SkillRegistry = new SkillRegistryClass();
