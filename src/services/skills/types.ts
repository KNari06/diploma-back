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
  | 'qa'
  | 'memory';

/**
 * Context provided to skills during execution
 */
export interface SkillContext {
  userId: string;
  workspaceId: string;
  chatSessionId?: string;
  projectId?: string;
  previewSessionId?: string; // Active editor preview session (for live preview execution)
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
 * Retry configuration for a skill's tool executions.
 * Used by tool-executor.ts to determine retry strategy for transient errors.
 */
export interface SkillRetryConfig {
  /** Max retry attempts after initial failure (default: 2) */
  maxRetries?: number;
  /** Initial delay in ms before first retry (default: 500) */
  initialDelayMs?: number;
  /** Multiplier for exponential backoff (default: 2) */
  backoffMultiplier?: number;
}

/**
 * Error context passed to skill's onError lifecycle hook.
 */
export interface SkillErrorContext {
  /** The error that occurred */
  error: Error;
  /** The tool that was being executed */
  toolName: string;
  /** Execution context (user, workspace, session) */
  context: SkillContext;
  /** Which attempt this is (0 = first call, 1 = first retry, etc.) */
  attempt: number;
}

/**
 * Per-workspace skill configuration shape.
 * Stored in workspaces.settings JSONB: `settings.skills[skillId]`
 */
export interface WorkspaceSkillConfig {
  [skillId: string]: Record<string, any>;
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

  // ── Optional Lifecycle Hooks ───────────────────────────────────────

  /**
   * Called once during registerAllSkills() at server startup.
   * Use for warm-up, cache preloading, or connection validation.
   * If it throws, the skill is still registered but a warning is logged (non-fatal).
   */
  onInit?(): Promise<void>;

  /**
   * Called when tool execution fails (transient or permanent error).
   * Can return a SkillResult to override the default error result (e.g., after token refresh + retry).
   * If it returns void/undefined, the default error handling continues.
   */
  onError?(errorCtx: SkillErrorContext): Promise<SkillResult | void>;

  /**
   * Per-skill retry configuration for transient errors (429, 5xx, timeout).
   * If not provided, global defaults are used: { maxRetries: 2, initialDelayMs: 500, backoffMultiplier: 2 }
   */
  retryConfig?: SkillRetryConfig;
}
