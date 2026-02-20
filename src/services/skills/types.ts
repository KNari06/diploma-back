import type { ChatCompletionTool } from 'openai/resources/chat/completions';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * SKILLS/TOOLS PLATFORM TYPES
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Type definitions for the extensible skills platform.
 * Allows adding new integration skills (Jira, GitHub, Notion, etc.) easily.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Integration provider identifier
 */
export type IntegrationProvider =
  | 'jira'
  | 'github'
  | 'gitlab'
  | 'notion'
  | 'trello'
  | 'slack'
  | 'telegram'
  | 'qa';

/**
 * Context provided to skills during execution
 */
export interface SkillContext {
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
  projectId?: string;
}

/**
 * Result returned by skill execution
 */
export interface SkillResult {
  success: boolean;
  data?: any;
  message: string;
  displayToUser?: boolean; // Whether to show this result to the user
}

/**
 * A skill definition
 * Represents an integration that provides tools to the agent
 */
export interface SkillDefinition {
  /**
   * Unique skill identifier (e.g., 'jira', 'github')
   */
  id: string;

  /**
   * Human-readable name
   */
  name: string;

  /**
   * Provider this skill belongs to
   */
  provider: IntegrationProvider;

  /**
   * Description for system prompt injection
   * Tells the agent what this skill can do
   */
  description: string;

  /**
   * OpenAI function calling tool definitions
   * These are registered with the OpenAI API
   */
  tools: ChatCompletionTool[];

  /**
   * Check if this skill is available for the given context
   * (e.g., check if user has connected this integration)
   */
  isAvailable(context: SkillContext): Promise<boolean>;

  /**
   * Execute a tool from this skill
   * @param toolName - The function name to execute
   * @param args - Arguments from OpenAI function call
   * @param context - Execution context (user, workspace, session)
   * @returns Result of execution
   */
  execute(
    toolName: string,
    args: Record<string, any>,
    context: SkillContext
  ): Promise<SkillResult>;
}
