/**
 * ═══════════════════════════════════════════════════════════════════════════
 * TOOL EXECUTOR — Central Tool Execution Pipeline
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Single entry point for ALL tool executions across the codebase.
 * Replaces duplicated logic in:
 *   - handler.ts (monolithic loop)
 *   - executor-agent.ts (sub-agent pipeline)
 *   - sub-executor.ts (parallel execution)
 *
 * Pipeline:
 *   1. Before hooks (loop detection, custom)
 *   2. Retry loop (per-skill config, exponential backoff + jitter)
 *      a. Timeout + abort signal (withToolTimeoutAndAbort)
 *      b. Execution via SkillRegistry
 *      c. On transient error → onError hook → retry or break
 *   3. After hooks (analytics, custom)
 *   4. Result normalization (screenshot special handling)
 *   5. Return ToolCallResult
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { logger } from '@/utils/core/logger';
import { withToolTimeoutAndAbort } from '@/api/chat/general/sub-agents/tool-constants';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import type { SkillContext, SkillResult, SkillErrorContext } from './types';
import type { ToolCallTracker } from './hooks/loop-detection.hook';
import { resolveRetryConfig, isRetryableError, calculateRetryDelay, sleep } from './retry';

// ── Types ────────────────────────────────────────────────────────────────

export interface ToolCallContext {
  toolName: string;
  toolCallId: string;
  args: Record<string, any>;
  skillContext: SkillContext;
  abortSignal?: AbortSignal;
  /** Optional loop tracker (per-pipeline, not global) */
  tracker?: ToolCallTracker;
}

export interface ToolExecutionRecord {
  toolName: string;
  args: Record<string, any>;
  result: SkillResult;
  durationMs: number;
}

export interface ToolCallResult {
  /** The raw tool result */
  toolResult: SkillResult;
  /** Messages to push to the conversation (tool_result + possible extras like screenshot) */
  messages: ChatCompletionMessageParam[];
  /** Execution record for tracking */
  record: ToolExecutionRecord;
}

// ── Hook System ──────────────────────────────────────────────────────────

export type BeforeHookResult =
  | { action: 'continue' }
  | { action: 'continue'; args: Record<string, any> }
  | { action: 'block'; reason: string };

export interface ToolHook {
  /** Human-readable hook name (for logging) */
  name: string;
  /** Execution priority — lower = earlier. Default hooks: loop-detection=10, analytics=900 */
  priority: number;
  /** Called before tool execution. Can modify args or block the call. */
  before?: (ctx: ToolCallContext) => Promise<BeforeHookResult> | BeforeHookResult;
  /** Called after tool execution (fire-and-forget, errors don't propagate). */
  after?: (ctx: ToolCallContext, result: SkillResult, durationMs: number) => void | Promise<void>;
}

// Hook registry (module-level singleton)
const hooks: ToolHook[] = [];

/**
 * Register a tool hook. Hooks are sorted by priority on each registration.
 */
export function registerToolHook(hook: ToolHook): void {
  hooks.push(hook);
  hooks.sort((a, b) => a.priority - b.priority);
  logger.info('[TOOL_EXECUTOR] Hook registered', {
    name: hook.name,
    priority: hook.priority,
    hasBefore: !!hook.before,
    hasAfter: !!hook.after,
  });
}

// ── Main Execution Function ──────────────────────────────────────────────

/**
 * Execute a tool call through the centralized pipeline.
 *
 * This is the ONLY function that should call SkillRegistry.executeTool().
 * All execution sites (handler.ts, executor-agent.ts, sub-executor.ts) delegate here.
 */
export async function executeTool(ctx: ToolCallContext): Promise<ToolCallResult> {
  const startMs = Date.now();

  // ── 1. Before Hooks ──────────────────────────────────────────────────
  let effectiveArgs = ctx.args;
  let loopWarning: string | undefined;

  // Loop detection (if tracker provided)
  if (ctx.tracker) {
    const loopCheck = ctx.tracker.check(ctx.toolName, ctx.args);
    if (loopCheck.severity === 'block') {
      const blockedResult: SkillResult = { success: false, message: loopCheck.message };
      return buildBlockedResult(ctx, blockedResult, startMs);
    }
    // Warn: save warning to inject into tool result so LLM can see it
    if (loopCheck.severity === 'warn') {
      loopWarning = loopCheck.message;
      logger.info('[TOOL_EXECUTOR] Loop detection warning, proceeding', {
        toolName: ctx.toolName,
        message: loopCheck.message,
      });
    }
  }

  // Custom before hooks
  for (const hook of hooks) {
    if (!hook.before) continue;
    try {
      const hookResult = await hook.before(ctx);
      if (hookResult.action === 'block') {
        logger.info('[TOOL_EXECUTOR] Blocked by hook', {
          hook: hook.name,
          toolName: ctx.toolName,
          reason: hookResult.reason,
        });
        const blockedResult: SkillResult = { success: false, message: hookResult.reason };
        return buildBlockedResult(ctx, blockedResult, startMs);
      }
      if ('args' in hookResult && hookResult.args) {
        effectiveArgs = hookResult.args;
      }
    } catch (hookError) {
      logger.warn('[TOOL_EXECUTOR] Before hook error, continuing', {
        hook: hook.name,
        error: hookError instanceof Error ? hookError.message : String(hookError),
      });
      // Hook errors don't block execution
    }
  }

  // ── 2. Execute Tool (with retry loop) ───────────────────────────────
  let toolResult: SkillResult;

  const { SkillRegistry } = await import('@/services/skills');
  const skill = SkillRegistry.getSkillForTool(ctx.toolName);
  const retryConfig = resolveRetryConfig(skill?.retryConfig);
  const maxAttempts = retryConfig.maxRetries + 1; // initial + retries

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    // Check abort before each attempt
    if (ctx.abortSignal?.aborted) {
      toolResult = { success: false, message: 'Request aborted before execution' };
      break;
    }

    // Wait before retry (not before first attempt)
    if (attempt > 0) {
      const delay = calculateRetryDelay(attempt - 1, retryConfig);
      logger.info('[TOOL_EXECUTOR] Retrying tool', {
        toolName: ctx.toolName,
        attempt,
        maxAttempts,
        delayMs: delay,
      });
      try {
        await sleep(delay, ctx.abortSignal);
      } catch {
        // Abort signal fired during sleep
        toolResult = { success: false, message: 'Request aborted during retry backoff' };
        break;
      }
    }

    try {
      // Each attempt gets its own timeout (from TOOL_TIMEOUTS via withToolTimeoutAndAbort)
      toolResult = await withToolTimeoutAndAbort(
        SkillRegistry.executeTool(ctx.toolName, effectiveArgs, ctx.skillContext),
        ctx.toolName,
        ctx.abortSignal,
      );

      // Success → done
      if (toolResult.success) break;

      // Failed result — check if the error message indicates a retryable condition
      const resultError = new Error(toolResult.message);
      if (attempt < retryConfig.maxRetries && isRetryableError(resultError)) {
        // Give skill a chance to handle (e.g., token refresh)
        const overrideResult = await callOnError(skill, resultError, ctx, attempt);
        if (overrideResult) {
          toolResult = overrideResult;
          break; // onError provided a resolution
        }
        continue; // retry
      }

      // Non-retryable failure or last attempt → break with current result
      break;

    } catch (toolError) {
      const error = toolError instanceof Error ? toolError : new Error(String(toolError));

      if (attempt < retryConfig.maxRetries && isRetryableError(error)) {
        // Give skill a chance to handle before retrying
        const overrideResult = await callOnError(skill, error, ctx, attempt);
        if (overrideResult) {
          toolResult = overrideResult;
          break;
        }
        continue; // retry
      }

      // Last attempt or non-retryable → call onError for final chance, then fail
      const overrideResult = await callOnError(skill, error, ctx, attempt);
      if (overrideResult) {
        toolResult = overrideResult;
        break;
      }

      logger.error('[TOOL_EXECUTOR] Tool execution error (final)', {
        toolName: ctx.toolName,
        attempt,
        error: error.message,
      });
      toolResult = {
        success: false,
        message: `Tool execution failed: ${error.message}`,
      };
      break;
    }
  }

  // Safety: ensure toolResult is always set
  toolResult ??= { success: false, message: 'Tool execution failed: no result produced' };

  const durationMs = Date.now() - startMs;

  // ── 3. Inject loop warning into result so LLM sees it ─────────────
  if (loopWarning && toolResult.message) {
    toolResult = { ...toolResult, message: `${toolResult.message}\n\n⚠️ WARNING: ${loopWarning}` };
  } else if (loopWarning) {
    toolResult = { ...toolResult, message: `⚠️ WARNING: ${loopWarning}` };
  }

  // ── 4. Record in loop tracker (use effectiveArgs for consistency) ──
  if (ctx.tracker) {
    ctx.tracker.record(ctx.toolName, effectiveArgs);
  }

  // ── 5. After Hooks (fire-and-forget) ─────────────────────────────────
  for (const hook of hooks) {
    if (!hook.after) continue;
    try {
      // Don't await — after hooks should not slow down the response
      const maybePromise = hook.after(ctx, toolResult, durationMs);
      if (maybePromise && typeof (maybePromise as any).catch === 'function') {
        (maybePromise as Promise<void>).catch(err => {
          logger.warn('[TOOL_EXECUTOR] After hook error', {
            hook: hook.name,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (hookError) {
      logger.warn('[TOOL_EXECUTOR] After hook sync error', {
        hook: hook.name,
        error: hookError instanceof Error ? hookError.message : String(hookError),
      });
    }
  }

  // ── 6. Build Messages ────────────────────────────────────────────────
  const messages: ChatCompletionMessageParam[] = [];

  // Screenshot special handling: strip blob from tool message, inject multimodal image
  const isScreenshot = ctx.toolName === 'qa_screenshot'
    && toolResult.success
    && toolResult.data?.screenshot;

  const toolResultForMessage = isScreenshot
    ? { success: true, message: toolResult.message, url: toolResult.data?.url }
    : toolResult;

  messages.push({
    role: 'tool',
    tool_call_id: ctx.toolCallId,
    content: JSON.stringify(toolResultForMessage),
  } as any);

  // Inject screenshot as multimodal user message for vision model
  if (isScreenshot) {
    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Here is the screenshot I just captured from the live preview. Analyze it and describe what you see.',
        },
        {
          type: 'image_url',
          image_url: {
            url: `data:image/jpeg;base64,${toolResult.data.screenshot}`,
            detail: 'low',
          },
        },
      ],
    } as any);
  }

  // ── 7. Build Record (use effectiveArgs — may be modified by hooks) ──
  const record: ToolExecutionRecord = {
    toolName: ctx.toolName,
    args: effectiveArgs,
    result: toolResult,
    durationMs,
  };

  logger.info('[TOOL_EXECUTOR] Tool executed', {
    toolName: ctx.toolName,
    success: toolResult.success,
    durationMs,
  });

  return { toolResult, messages, record };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildBlockedResult(
  ctx: ToolCallContext,
  result: SkillResult,
  startMs: number,
): ToolCallResult {
  const durationMs = Date.now() - startMs;
  return {
    toolResult: result,
    messages: [
      {
        role: 'tool',
        tool_call_id: ctx.toolCallId,
        content: JSON.stringify(result),
      } as any,
    ],
    record: {
      toolName: ctx.toolName,
      args: ctx.args,
      result,
      durationMs,
    },
  };
}

/**
 * Call skill.onError() lifecycle hook if defined.
 * Returns override SkillResult if the hook provides one, undefined otherwise.
 * Never throws — buggy hooks are caught and logged.
 */
async function callOnError(
  skill: import('./types').SkillDefinition | undefined,
  error: Error,
  ctx: ToolCallContext,
  attempt: number,
): Promise<SkillResult | undefined> {
  if (!skill?.onError) return undefined;

  const errorCtx: SkillErrorContext = {
    error,
    toolName: ctx.toolName,
    context: ctx.skillContext,
    attempt,
  };

  try {
    const overrideResult = await skill.onError(errorCtx);
    if (overrideResult) {
      logger.info('[TOOL_EXECUTOR] onError returned override result', {
        toolName: ctx.toolName,
        attempt,
        overrideSuccess: overrideResult.success,
      });
      return overrideResult;
    }
  } catch (hookError) {
    // Buggy onError hook must NOT crash the retry loop
    logger.warn('[TOOL_EXECUTOR] onError hook threw', {
      toolName: ctx.toolName,
      hookError: hookError instanceof Error ? hookError.message : String(hookError),
    });
  }

  return undefined;
}
