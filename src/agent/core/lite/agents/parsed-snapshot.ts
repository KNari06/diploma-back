/**
 * ParsedSnapshot — pre-parsed structured snapshot for fast O(1) ref lookups.
 *
 * Built once per iteration in lite-engine.ts getAIDecision() and shared
 * across all multi-agent components (Critic, Orchestrator, Supervisor, Actor).
 *
 * Replaces six independent regex string-matching call sites with a single
 * O(1) Set lookup. The original LiteSnapshot is preserved on `source` for
 * future consumers that need richer element data.
 *
 * IMPORTANT: `allRefs` MUST be a superset of every ref that the formatted
 * snapshot string would contain — otherwise switching from regex matching
 * to Set lookup creates false negatives. See snapshot-collector.ts:format()
 * for the source of truth on which refs are emitted into the formatted text.
 *
 * Refs currently emitted by format() that are included here:
 *   - element own refs (snapshot.elements[].ref) — primary case
 *   - activeModalRef ("ACTIVE_MODAL: ${ref}")
 *   - transientState.ref ("LOADING_STATE: ... at ${ref}")
 *   - pageStructure.pagination.nextRef / prevRef
 *
 * Refs explicitly NOT included (not emitted by format()):
 *   - obstacleFacts refs (not rendered in formatted text)
 *   - pageStructure.tables/lists structural refs (t0, l0) — explicitly omitted
 *     by format() to prevent LLM from hallucinating them as targetRef values
 */

import type { LiteElement, LiteSnapshot } from '../lite-types';

export interface ParsedSnapshot {
  /** O(1) lookup: ref → element. Only own element refs (not modal/pagination). */
  elementsByRef: Map<string, LiteElement>;
  /**
   * O(1) existence check: superset of all refs that format() emits into
   * the formatted snapshot string. Includes element refs, activeModalRef,
   * transientState.ref, pagination refs.
   */
  allRefs: Set<string>;
  /** Original structured snapshot — preserved for richer downstream access */
  source: LiteSnapshot;
  /** Sugar wrapper around allRefs.has() for cleaner call sites */
  hasRef(ref: string): boolean;
}

/**
 * Build a ParsedSnapshot from a LiteSnapshot.
 *
 * Pure function. Idempotent. Safe to call once per iteration in the hot path
 * (typical work: ~80 elements, runs in <0.1ms).
 */
export function buildParsedSnapshot(snapshot: LiteSnapshot): ParsedSnapshot {
  const elementsByRef = new Map<string, LiteElement>();
  const allRefs = new Set<string>();

  // 1. Element own refs — the primary case
  // (every el.ref appears in format() output as "${ref}: \"${name}\" ...")
  for (const el of snapshot.elements) {
    elementsByRef.set(el.ref, el);
    allRefs.add(el.ref);
  }

  // 2. activeModalRef — emitted by format() as "ACTIVE_MODAL: ${ref}"
  // The regex `\b${ref}\b` would match this; allRefs must include it.
  if (snapshot.activeModalRef) {
    allRefs.add(snapshot.activeModalRef);
  }

  // 3. transientState.ref — emitted as "LOADING_STATE: ... at ${ref}"
  if (snapshot.transientState?.ref) {
    allRefs.add(snapshot.transientState.ref);
  }

  // 4. pagination refs — emitted as "PAGINATION: ... nextRef=${ref} prevRef=${ref}"
  if (snapshot.pageStructure?.pagination) {
    const { nextRef, prevRef } = snapshot.pageStructure.pagination;
    if (nextRef) allRefs.add(nextRef);
    if (prevRef) allRefs.add(prevRef);
  }

  return {
    elementsByRef,
    allRefs,
    source: snapshot,
    hasRef(ref: string): boolean {
      return allRefs.has(ref);
    },
  };
}
