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
 * When the deterministic resolver is AMBIGUOUS and a user message is available,
 * a conditional second LLM call (ENRICH) narrows the candidates using the
 * message + session context. It only ever picks from the real candidate set
 * (never invents ids) and is fully best-effort.
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
  type QueryCandidate,
  type QuerySelectorType,
  type TestQueryResult,
} from '@/services/testing/resolver';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { buildEnrichPrompt, type EnrichSessionContext } from '@/ai/prompts';
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
  /** Raw user message — used by the ENRICH disambiguation step. */
  message?: string;
  /** Session context (last/recent/failed test ids) for referential grounding. */
  session?: EnrichSessionContext;
}

/**
 * The shape attached to `metadata.resolvedTargets`. Handlers should read it via
 * `getResolvedTargets()` rather than reaching into untyped metadata.
 */
export interface ResolvedTargets {
  selectorType: string;
  descriptor: string;
  resolution: 'unique' | 'ambiguous' | 'none';
  ids: string[];
  topId?: string;
  candidates: Array<{ id: string; name: string }>;
}

/** Typed accessor for the resolver output a handler may consume. */
export function getResolvedTargets(parsedIntent: IntentResult): ResolvedTargets | undefined {
  return parsedIntent.metadata?.resolvedTargets as ResolvedTargets | undefined;
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
  const { parsedIntent, projectId } = params;
  if (!shouldResolveTarget(parsedIntent, projectId)) return;

  const sel = parsedIntent.targetSelector!;

  let result: TestQueryResult;
  try {
    result = await TestQueryResolverService.resolve({
      descriptor: sel.value,
      selectorType: sel.type as QuerySelectorType,
      projectId: projectId!,
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

  // ENRICH: when the deterministic resolver is unsure, a second (conditional)
  // LLM call narrows the candidates using the message + session context
  // ("the last failing one", "those two"). Best-effort — on any failure we keep
  // the deterministic ambiguous result so the handler still has candidates.
  if (result.resolution === 'ambiguous' && params.message) {
    result = await enrichAmbiguous(params.message, sel.value, result, params.session);
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

/**
 * ENRICH disambiguation: ask the LLM to pick the intended candidate(s) from the
 * resolver's ambiguous set, grounded in the message + session context. Returns
 * a NARROWED TestQueryResult (resolution → 'unique' when exactly one survives),
 * or the original result on any failure / no narrowing.
 *
 * Hard invariants:
 *   - Never invents ids — the picked ids are intersected with the real
 *     candidate set, so a hallucinated id is dropped.
 *   - Best-effort — any error returns the original ambiguous result unchanged.
 */
async function enrichAmbiguous(
  message: string,
  descriptor: string,
  result: TestQueryResult,
  session?: EnrichSessionContext,
): Promise<TestQueryResult> {
  try {
    const prompt = buildEnrichPrompt({
      message,
      descriptor,
      candidates: result.candidates.map((c) => ({
        id: c.id,
        name: c.name,
        url: c.url,
        tags: c.tags,
      })),
      session: session ?? {},
    });

    const response = await getChatCompletionWithMessages(
      [{ role: 'user', content: prompt }],
      {
        model: AI_TASK_MODELS.testCaseResolution,
        temperature: 0.1,
        max_tokens: 200,
        response_format: { type: 'json_object' },
      },
    );

    const parsed = JSON.parse(response.content || '{}');
    const pickedIds: string[] = Array.isArray(parsed?.resolvedTargetIds)
      ? parsed.resolvedTargetIds.filter((x: unknown) => typeof x === 'string')
      : [];

    // Intersect with the real candidate set — never trust a hallucinated id.
    const byId = new Map(result.candidates.map((c) => [c.id, c]));
    const narrowed: QueryCandidate[] = pickedIds
      .map((id) => byId.get(id))
      .filter((c): c is QueryCandidate => !!c);

    if (narrowed.length === 0) {
      // ENRICH couldn't decide — keep the deterministic ambiguous candidates.
      return result;
    }

    logger.info('[INTENT_TARGET] ENRICH narrowed ambiguous candidates', {
      from: result.candidates.length,
      to: narrowed.length,
    });

    return {
      candidates: narrowed,
      resolution: narrowed.length === 1 ? 'unique' : 'ambiguous',
      topId: narrowed.length === 1 ? narrowed[0].id : undefined,
    };
  } catch (err) {
    logger.warn('[INTENT_TARGET] ENRICH failed, keeping deterministic result', {
      error: err instanceof Error ? err.message : String(err),
    });
    return result;
  }
}
