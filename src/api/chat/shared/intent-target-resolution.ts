/**
 * Intent Target Resolution (post-parse enrichment stage)
 *
 * After the classifier returns an IntentResult carrying a `targetSelector`
 * descriptor (e.g. {type:'keyword', value:'payment tests'}), this stage
 * deterministically resolves it to concrete entity IDs via TestQueryResolver
 * and attaches them to `metadata.resolvedTargetIds` (+ `resolvedTargetTopId`).
 *
 * Handlers that previously required explicit IDs ("run by tag", "add to plan",
 * future manage_*) can read these instead of re-resolving — turning vague,
 * descriptor-style requests into actionable ones.
 *
 * Contract:
 *   - BEST-EFFORT: never throws into the request path. On any failure it leaves
 *     the intent untouched (the handler then asks for clarification as before).
 *   - SCOPE-SAFE: only runs against the caller's already-resolved projectId.
 *   - ADDITIVE: writes only to metadata.* — the 19 existing intents that don't
 *     emit a targetSelector are completely unaffected.
 */

import {
  TestQueryResolverService,
  type QuerySelectorType,
  type TestQueryResult,
} from '@/services/testing/resolver';
import { logger } from '@/utils/core/logger';
import type { IntentResult } from '@/types';

// Selector types that map to a resolvable test collection. 'url' and 'element'
// are not collection selectors (they're handled by the editor/replay paths).
const RESOLVABLE_TYPES: ReadonlySet<string> = new Set<QuerySelectorType>([
  'test_case', 'module', 'plan', 'flow', 'tag', 'keyword',
]);

export interface ResolveTargetParams {
  parsedIntent: IntentResult;
  projectId?: string;
  currentUrl?: string;
}

/**
 * Returns true when this intent carries a descriptor worth resolving.
 * Pure — safe to unit test.
 */
export function shouldResolveTarget(parsedIntent: IntentResult, projectId?: string): boolean {
  if (!projectId) return false;
  const sel = parsedIntent.targetSelector;
  return !!sel && RESOLVABLE_TYPES.has(sel.type) && sel.value.trim().length > 0;
}

/**
 * Resolve the intent's targetSelector to IDs and attach them to metadata.
 * Mutates `parsedIntent` in place (consistent with the existing guards in
 * intent-parsing.ts). No-op + return when there is nothing to resolve.
 */
export async function attachResolvedTargets(params: ResolveTargetParams): Promise<void> {
  const { parsedIntent, projectId, currentUrl } = params;
  if (!shouldResolveTarget(parsedIntent, projectId)) return;

  const sel = parsedIntent.targetSelector!;

  let result: TestQueryResult;
  try {
    result = await TestQueryResolverService.resolve({
      descriptor: sel.value,
      selectorType: sel.type as QuerySelectorType,
      projectId: projectId!,
      currentUrl,
    });
  } catch (err) {
    // Best-effort: a resolver failure must not break intent handling.
    logger.warn('[INTENT_TARGET] resolve failed, leaving intent unresolved', {
      selectorType: sel.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  if (result.resolution === 'none' || result.candidates.length === 0) {
    logger.info('[INTENT_TARGET] descriptor resolved to nothing', {
      selectorType: sel.type,
      descriptor: sel.value,
    });
    return;
  }

  if (!parsedIntent.metadata) parsedIntent.metadata = {};
  parsedIntent.metadata.resolvedTargets = {
    selectorType: sel.type,
    descriptor: sel.value,
    resolution: result.resolution,
    ids: result.candidates.map((c) => c.id),
    topId: result.topId,
    // Minimal display info for a handler that wants to confirm with the user.
    // Names/urls/tags only — never step bodies or secrets.
    candidates: result.candidates.map((c) => ({ id: c.id, name: c.name })),
  };

  logger.info('[INTENT_TARGET] attached resolved targets', {
    selectorType: sel.type,
    resolution: result.resolution,
    count: result.candidates.length,
  });
}
