/**
 * Evidence Shortcut Validation (V15.7)
 *
 * Shared decision logic for deciding whether a cached `evidence.lastSuccessRef`
 * can be trusted to skip full LLM resolution.
 *
 * HISTORICAL CONTEXT
 * ─────────────────
 * Previously, this validation was duplicated in two places:
 *   • `intent-step-lint.service.ts` (preview pipeline, during lint phase)
 *   • `command-executor.ts` (background pipeline, during execute phase)
 *
 * Both copies evolved the same set of checks (TTL + URL + semantic fallback to
 * description) but did so independently — same bug, patched twice, with a
 * delay between patches that created a window of divergent behavior.
 *
 * This module consolidates the POLICY (what makes a cached ref trustworthy)
 * while leaving the PLACEMENT (when it fires in each pipeline's lifecycle) up
 * to each caller. Preview calls it during lint; background during execute.
 * That's an intentional architectural divergence (preview has a separate lint
 * phase, background doesn't), not a policy divergence.
 *
 * WHAT'S VALIDATED
 * ───────────────
 *   1. TTL — evidence older than 60 minutes is rejected. `data-agent-ref`
 *      values are DOM-counter-based and unstable across page reloads / server
 *      restarts. Missing `capturedAt` (legacy records) skips this check for
 *      backward compatibility; URL + semantic still run.
 *   2. URL — the ref must have been recorded on the same URL we're currently
 *      on. Prevents cross-page ref collisions in SPAs.
 *   3. Semantic — the cached node's visible text/labels must substring-match
 *      the step's bindingHints OR (fallback) the step's description. This
 *      catches ref-shift bugs where the same ref now points at a completely
 *      different element.
 *
 * WHAT'S NOT VALIDATED HERE
 * ────────────────────────
 *   • Action-type compatibility (e.g. "type requires <input>"). Preview has
 *     a nuanced version of this via `isEvidenceShortcutNodeCompatible`;
 *     background uses a simple `isVisible !== false` check. They're left in
 *     their respective callers because they have different needs.
 *   • Visibility at action time. Caller must do their own `waitFor` before
 *     using the returned locator.
 */

import type { BindingHints, InteractiveNode, StepEvidence } from './preview.types';
import { normalizeUrlForComparison } from './auto-wait-for.utils';

/** 60 minutes — generous for active runs, catches cross-session staleness. */
export const EVIDENCE_REF_TTL_MS = 60 * 60 * 1000;

export interface EvidenceShortcutInput {
  /** The recorded evidence from a prior successful run. */
  evidence: StepEvidence | undefined;
  /** Current DOM snapshot — we look up the cached ref here. */
  domNodes: InteractiveNode[];
  /** URL the page is currently at. Compared against evidence.pageUrl. */
  currentUrl: string;
  /** Step description (user intent). Used as semantic fallback when hints are empty. */
  description?: string;
  /** Optional bindingHints captured at recording time. Preferred over description. */
  bindingHints?: BindingHints;
  /**
   * Optional URL the plan was compiled against — checked in addition to
   * `evidence.pageUrl`. Preview passes `compiled.context.pageUrl` here; background
   * can leave this undefined and rely on evidence.pageUrl.
   */
  compiledPageUrl?: string;
}

/** Reason a shortcut was rejected. Exposed for diagnostic logging at call sites. */
export type EvidenceShortcutSkipReason =
  | 'no_evidence'
  | 'no_cached_ref'
  | 'ttl_expired'
  | 'no_recorded_url'
  | 'url_mismatch'
  | 'ref_not_in_dom'
  | 'semantic_mismatch';

export type EvidenceShortcutResult =
  | {
      ok: true;
      /** The DOM node the cached ref resolves to, confirmed visible and semantically valid. */
      node: InteractiveNode;
      /** Copy of the input ref for convenience. */
      ref: string;
      /** Whether the semantic match used bindingHints (preferred) or fell back to description. */
      semanticSource: 'bindingHints' | 'description' | 'skipped';
    }
  | {
      ok: false;
      reason: EvidenceShortcutSkipReason;
      /** Present when reason indicates it was detected past the basic presence checks. */
      details?: Record<string, any>;
    };

/**
 * Evaluate whether the cached evidence ref is safe to reuse.
 *
 * Pure function — no side effects, no I/O. Safe to call from either the
 * preview lint phase or the background execute phase.
 */
export function evaluateEvidenceShortcut(
  input: EvidenceShortcutInput,
): EvidenceShortcutResult {
  const { evidence, domNodes, currentUrl, description, bindingHints, compiledPageUrl } = input;

  if (!evidence) {
    return { ok: false, reason: 'no_evidence' };
  }

  const cachedRef = evidence.lastSuccessRef;
  if (!cachedRef) {
    return { ok: false, reason: 'no_cached_ref' };
  }

  // ─── 1. TTL check ────────────────────────────────────────────────────────
  // Missing capturedAt = legacy record → skip this check (fallback to URL +
  // semantic below). `Number.isFinite` guards against invalid ISO strings
  // producing NaN and silently short-circuiting the comparison.
  if (evidence.capturedAt) {
    const ageMs = Date.now() - new Date(evidence.capturedAt).getTime();
    if (Number.isFinite(ageMs) && ageMs > EVIDENCE_REF_TTL_MS) {
      return {
        ok: false,
        reason: 'ttl_expired',
        details: { cachedRef, ageMs, ttlMs: EVIDENCE_REF_TTL_MS },
      };
    }
  }

  // ─── 2. URL check ────────────────────────────────────────────────────────
  // Prefer compiled plan's URL when present (it's more authoritative); fall
  // back to the evidence's recorded URL. If neither is available, reject —
  // silently accepting an unknown-origin ref is the root cause of cross-page
  // false positives we've seen historically.
  const evidenceUrl = compiledPageUrl || evidence.pageUrl;
  if (!evidenceUrl) {
    return {
      ok: false,
      reason: 'no_recorded_url',
      details: { cachedRef },
    };
  }
  const normalizedEvidenceUrl = normalizeUrlForComparison(evidenceUrl);
  const normalizedCurrentUrl = normalizeUrlForComparison(currentUrl);
  if (normalizedEvidenceUrl !== normalizedCurrentUrl) {
    return {
      ok: false,
      reason: 'url_mismatch',
      details: {
        cachedRef,
        evidenceUrl: normalizedEvidenceUrl.slice(0, 120),
        currentUrl: normalizedCurrentUrl.slice(0, 120),
      },
    };
  }

  // ─── 3. Ref must exist in current DOM ────────────────────────────────────
  const cachedNode = domNodes.find(n => n.ref === cachedRef);
  if (!cachedNode) {
    return {
      ok: false,
      reason: 'ref_not_in_dom',
      details: { cachedRef },
    };
  }

  // ─── 4. Semantic check ───────────────────────────────────────────────────
  // Substring-either-way match between the step's expected phrase(s) and the
  // node's visible text. Uses bindingHints when available (precise, recorded
  // at capture time), else falls back to description (coarser but catches the
  // common case when hints weren't captured). If neither is available we
  // can't validate → skip the check (ok=true) rather than reject — the URL
  // check already ensures we're on the right page.
  //
  // V15.2/V15.5 fix history: the fallback to description was added after a
  // real-world bug on the JUZ40 site where a ref-shifted click landed on
  // "Менің тапсырмаларым 0" instead of "IT бөлімі", reported success
  // permissively, and produced a false-passing test. This fallback guarantees
  // the semantic check runs even when bindingHints are empty.
  const nodeTexts = [
    cachedNode.labelText,
    cachedNode.ariaLabel,
    cachedNode.name,
    cachedNode.placeholder,
    cachedNode.text,
  ]
    .filter(Boolean)
    .map(t => t!.toLowerCase().trim())
    .filter(t => t.length > 0);

  const hintValues = [bindingHints?.label, bindingHints?.nearText, bindingHints?.autocomplete]
    .filter(Boolean)
    .map(t => t!.toLowerCase().trim())
    .filter(t => t.length >= 2);

  const descriptionTokens: string[] = [];
  const desc = description?.toLowerCase().trim();
  if (desc && desc.length >= 2) descriptionTokens.push(desc);

  const phrasesToMatch = hintValues.length > 0 ? hintValues : descriptionTokens;
  const semanticSource: 'bindingHints' | 'description' | 'skipped' =
    hintValues.length > 0 ? 'bindingHints' : (descriptionTokens.length > 0 ? 'description' : 'skipped');

  if (phrasesToMatch.length > 0 && nodeTexts.length > 0) {
    const hasMatch = phrasesToMatch.some(h => nodeTexts.some(n => n.includes(h) || h.includes(n)));
    if (!hasMatch) {
      return {
        ok: false,
        reason: 'semantic_mismatch',
        details: {
          cachedRef,
          semanticSource,
          phrases: phrasesToMatch.slice(0, 3),
          nodeTexts: nodeTexts.slice(0, 3),
        },
      };
    }
  }

  return { ok: true, node: cachedNode, ref: cachedRef, semanticSource };
}
