/**
 * AI Tracking Context (AsyncLocalStorage)
 * Provides invisible context propagation for AI usage tracking.
 * No need to thread workspaceId through 20+ intermediate layers.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

export interface AITrackingContext {
  /** Workspace ID for billing attribution */
  workspaceId: string;
  /** Test ID (if within a test execution) */
  testId?: string;
  /** User who initiated the operation */
  userId?: string;
  /** High-level operation category */
  operationType?: 'lite-test' | 'pro-test' | 'chat' | 'test-plan' | 'api-test' | 'analysis' | 'regression';
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
