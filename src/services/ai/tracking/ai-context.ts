/**
 * AI Tracking Context (AsyncLocalStorage)
 * Provides invisible context propagation for AI usage tracking.
 * No need to thread workspaceId through 20+ intermediate layers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export type AILogSource =
  | 'chat'
  | 'analysis'
  | 'explorer-web'
  | 'explorer-mobile'
  | 'ai-selector'
  | 'ai-check'
  | 'form-filler';

export type AILogEntityType =
  | 'regression_run'
  | 'test_execution'
  | 'chat_session'
  | 'exploration_run'
  | 'mobile_run';

export interface AITrackingContext {
  /** Workspace ID for billing attribution */
  workspaceId: string;
  /** Test ID (if within a test execution) */
  testId?: string;
  /** Regression run ID (if within a regression run). Correlates LLM calls to a run. */
  runId?: string;
  /** User who initiated the operation */
  userId?: string;
  /**
   * The id a caller passed to `AIUsageTracker.beginSession`, when that id is
   * not derivable from `testId`/`runId` — a chat session id, an analysis key.
   *
   * Without it the tracker computes its own synthetic key, which cannot match
   * the caller's id, so `record()` files calls under a different session than
   * `endSession` closes: the explicit session ends empty (returning null and
   * logging "no AI calls") while the real records wait for the sweep. Set this
   * wherever you call `beginSession` with an id of your own.
   */
  sessionId?: string;
  /** High-level operation category */
  operationType?: 'lite-test' | 'pro-test' | 'chat' | 'test-plan' | 'api-test' | 'analysis' | 'regression' | 'import';

  // ── AI action log fields (one row per LLM call) ─────────────────────────
  /** Logical source of the AI call. Defaults derived from operationType. */
  logSource?: AILogSource;
  /** Specific action this call performs ('plan', 'intent', 'reply', 'refine', 'assert', 'fill', ...). */
  logActionType?: string;
  /** What this call relates to. */
  logEntityType?: AILogEntityType;
  /** Stable id of the related entity. */
  logEntityId?: string;
  /** Monotonic step counter, populated by explorer agents. */
  logIteration?: number;
}

export const aiContextStorage = new AsyncLocalStorage<AITrackingContext>();

/**
 * Run a function with AI tracking context.
 * All AI calls within this execution scope will be attributed to this context.
 *
 * @example
 * ```typescript
 * await withAIContext(
 *   { workspaceId, testId, userId, operationType: 'lite-test' },
 *   async () => {
 *     // All OpenAI/Gemini calls here will be tracked
 *     const result = await liteEngine.execute();
 *     return result;
 *   }
 * );
 * ```
 */
export function withAIContext<T>(context: AITrackingContext, fn: () => T | Promise<T>): T | Promise<T> {
  return aiContextStorage.run(context, fn);
}

/**
 * Get current AI tracking context (returns undefined if not in a tracked scope).
 * Used internally by interceptors to determine attribution.
 */
export function getAIContext(): AITrackingContext | undefined {
  return aiContextStorage.getStore();
}

/**
 * Run `fn` with additional AI-log fields merged onto the current AITrackingContext.
 * If no parent context exists, this is a no-op pass-through to `fn`.
 *
 * Use this at the boundary of a specific AI call site to label what the call is
 * about (e.g. `withAILogFields({ logActionType: 'intent' }, () => parseIntent())`).
 */
export function withAILogFields<T>(
  fields: Partial<Pick<AITrackingContext, 'logSource' | 'logActionType' | 'logEntityType' | 'logEntityId' | 'logIteration'>>,
  fn: () => T | Promise<T>
): T | Promise<T> {
  const parent = aiContextStorage.getStore();
  if (!parent) return fn();
  return aiContextStorage.run({ ...parent, ...fields }, fn);
}

/**
 * Derive a default `logSource` from `operationType` when the call site didn't set one.
 * Keeps existing call sites working without changes.
 */
export function deriveLogSource(ctx: AITrackingContext | undefined): AILogSource {
  if (!ctx) return 'chat';
  if (ctx.logSource) return ctx.logSource;
  switch (ctx.operationType) {
    case 'chat':       return 'chat';
    case 'analysis':   return 'analysis';
    case 'lite-test':
    case 'pro-test':   return 'explorer-web';
    case 'api-test':
    case 'test-plan':
    case 'regression': return 'analysis';
    // Import (Allure/PDF/CSV) parses documents into test structure — closest
    // existing action-log source is 'analysis'.
    case 'import':     return 'analysis';
    default:           return 'chat';
  }
}

/**
 * Pick a sensible default entity (type + id) from the tracking context when
 * the call site didn't set one explicitly.
 */
export function deriveLogEntity(
  ctx: AITrackingContext | undefined
): { entityType?: AILogEntityType; entityId?: string } {
  if (!ctx) return {};
  if (ctx.logEntityType && ctx.logEntityId) {
    return { entityType: ctx.logEntityType, entityId: ctx.logEntityId };
  }
  if (ctx.testId) {
    return { entityType: 'test_execution', entityId: ctx.testId };
  }
  return {};
}
