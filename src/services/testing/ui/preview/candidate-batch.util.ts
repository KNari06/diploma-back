/**
 * Primary/overflow batch split for the LLM resolver — PURE, side-effect-free.
 *
 * The resolver caps the candidate list it sends to the LLM at
 * `maxCandidatesForLlm` (60). The cap is DOM-order, deliberately not
 * score-based (see element-resolver Step 6 rationale). That neutrality has a
 * failure mode measured on bi.group (July 2026): on a dense page (open
 * mega-menu, 90+ hard-allowed nodes) the target button — demoted to the tail
 * of `allAllowed` by the `stability.dynamic_id` penalty (Radix `radix-:rN:`
 * id) — fell OUT of the primary batch. The LLM cannot pick what it does not
 * see: one session answered `not_found` (rescued by the 6–19s extended
 * search), another confidently chose an unrelated element.
 *
 * The lexical anchor closes that hole: any candidate whose visible-label
 * channels overlap the intent text is guaranteed a seat in the primary batch,
 * regardless of penalties or DOM position. Same insurance principle as the
 * pruner's identity-rescue, applied one stage earlier.
 *
 * Design rules:
 *   - NO natural-language word lists (matches semantic-match.util contract).
 *   - DOM order is preserved inside both batches — anchoring changes batch
 *     MEMBERSHIP, never relative order.
 *   - When everything fits in one batch the split is the plain slice —
 *     behavior identical to the pre-anchor code.
 */

import type { InteractiveNode } from './preview.types';
import { cyrFold, semanticTokens } from './semantic-match.util';

/** Cap on anchored candidates so a broad intent word can't flood the batch. */
const MAX_ANCHORED_CANDIDATES = 12;

/** Fold + lowercase + collapse whitespace — one canonical comparison form. */
function foldForCompare(s: string): string {
  return cyrFold(s.toLowerCase()).replace(/\s+/g, ' ').trim();
}

/**
 * All label channels a user-facing description could refer to, joined.
 * Wider than `getEffectiveLabel` on purpose: that cascade returns the FIRST
 * non-empty channel, while an intent may reference a later one (e.g. node has
 * `labelText` but the user typed its `text`).
 */
function labelHaystack(node: InteractiveNode): string {
  return foldForCompare(
    [
      node.labelText,
      node.ariaLabel,
      node.title,
      node.alt,
      node.text,
      node.placeholder,
      node.iconLabel,
    ]
      .filter(Boolean)
      .join(' '),
  );
}

/** True when the node's labels lexically overlap the intent. */
export function matchesIntentLexically(node: InteractiveNode, intentText: string): boolean {
  const haystack = labelHaystack(node);
  if (!haystack) return false;

  const foldedIntent = foldForCompare(intentText);
  if (!foldedIntent) return false;

  // Whole-intent substring — catches short intents ("ОК") whose tokens fall
  // under the tokenizer's 3-char floor, and exact label matches.
  if (foldedIntent.length >= 2 && haystack.includes(foldedIntent)) return true;

  // Token overlap — any intent token contained in the haystack ("Войти" ⊂
  // "Войти или зарегистрироваться", "login" ⊂ "login button").
  for (const token of semanticTokens(intentText)) {
    if (haystack.includes(token)) return true;
  }
  return false;
}

export interface BatchSplit {
  primary: InteractiveNode[];
  overflow: InteractiveNode[];
  /** Refs pinned into primary that the plain DOM-order slice would have dropped. */
  rescuedRefs: string[];
}

/**
 * Split `nodes` into the LLM primary batch and the extended-search overflow,
 * guaranteeing lexically-matching candidates a place in primary.
 */
export function splitBatchesWithLexicalAnchor(params: {
  nodes: InteractiveNode[];
  intentText: string;
  maxPrimary: number;
  maxAnchors?: number;
}): BatchSplit {
  const { nodes, intentText, maxPrimary, maxAnchors = MAX_ANCHORED_CANDIDATES } = params;

  // Everything fits — keep the historical plain slice (zero behavior change).
  if (nodes.length <= maxPrimary) {
    return { primary: nodes.slice(), overflow: [], rescuedRefs: [] };
  }

  const anchorIdx = new Set<number>();
  for (let i = 0; i < nodes.length && anchorIdx.size < maxAnchors; i++) {
    if (matchesIntentLexically(nodes[i], intentText)) anchorIdx.add(i);
  }

  // No matches → plain slice, identical to the pre-anchor behavior.
  if (anchorIdx.size === 0) {
    return {
      primary: nodes.slice(0, maxPrimary),
      overflow: nodes.slice(maxPrimary),
      rescuedRefs: [],
    };
  }

  // Anchors take their seats first; remaining slots fill with non-anchors in
  // DOM order. Selection is by membership only — the final batches are
  // re-sorted into original DOM order.
  const selected = new Set<number>(anchorIdx);
  for (let i = 0; i < nodes.length && selected.size < maxPrimary; i++) {
    selected.add(i);
  }

  const primary: InteractiveNode[] = [];
  const overflow: InteractiveNode[] = [];
  const rescuedRefs: string[] = [];
  for (let i = 0; i < nodes.length; i++) {
    if (selected.has(i)) {
      primary.push(nodes[i]);
      const ref = nodes[i].ref;
      if (i >= maxPrimary && ref) rescuedRefs.push(ref);
    } else {
      overflow.push(nodes[i]);
    }
  }
  return { primary, overflow, rescuedRefs };
}
