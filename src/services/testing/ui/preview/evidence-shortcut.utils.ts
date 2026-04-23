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
  /**
   * Action type for this step. When provided and set to a click-like action,
   * the shortcut rejects disabled nodes (prevents wasted 30s Playwright
   * stability wait on buttons turned disabled by A/B tests or form validation).
   * Non-click actions (type, hover, etc.) are unaffected — they have their
   * own validity semantics (e.g. a readonly input is still valid for hover).
   */
  actionType?: string;
  /**
   * Creation timestamp (ms since epoch) of the live preview session. When
   * passed, and the session was started AFTER the evidence was captured, we
   * reject the shortcut with `session_newer_than_evidence`.
   *
   * Rationale: `data-agent-ref` values are injected per browser context.
   * Closing and reopening the editor spawns a new Chromium, resetting
   * `window.__agentRefCounter` to 0, so the same numeric ref from an older
   * session points at an entirely unrelated element in the new session.
   * The existing TTL (60 min) catches most of these probabilistically, but
   * a user reopening in <60 min slips through. This check closes that hole
   * deterministically — ref validity is bounded by session lifetime, not
   * wall-clock time.
   *
   * Only meaningful for preview callers (browser per user session). Background/
   * regression callers fire up a fresh browser per run, so the lastSuccessRef
   * is never from a "previous session" of the same kind — they should leave
   * this undefined and keep the TTL-only semantics.
   */
  sessionCreatedAt?: number;
}

/** Reason a shortcut was rejected. Exposed for diagnostic logging at call sites. */
export type EvidenceShortcutSkipReason =
  | 'no_evidence'
  | 'no_cached_ref'
  | 'ttl_expired'
  | 'session_newer_than_evidence'
  | 'no_recorded_url'
  | 'url_mismatch'
  | 'ref_not_in_dom'
  | 'semantic_mismatch'
  | 'node_disabled';

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
  const { evidence, domNodes, currentUrl, description, bindingHints, compiledPageUrl, actionType, sessionCreatedAt } = input;

  if (!evidence) {
    return { ok: false, reason: 'no_evidence' };
  }

  const cachedRef = evidence.lastSuccessRef;
  if (!cachedRef) {
    return { ok: false, reason: 'no_cached_ref' };
  }

  // ─── 0. Session-lifetime check (preview-only) ────────────────────────────
  // If the live session was created AFTER the evidence was captured, the ref
  // namespace is fresh: window.__agentRefCounter started from 0 in this
  // browser, so the same numeric ref now points at an unrelated element.
  // Reject up front — this catches cross-session staleness deterministically
  // without relying on the 60-min TTL below.
  if (
    sessionCreatedAt !== undefined
    && evidence.capturedAt
    && Number.isFinite(sessionCreatedAt)
  ) {
    const evidenceMs = new Date(evidence.capturedAt).getTime();
    if (Number.isFinite(evidenceMs) && sessionCreatedAt > evidenceMs) {
      return {
        ok: false,
        reason: 'session_newer_than_evidence',
        details: {
          cachedRef,
          sessionCreatedAt,
          evidenceCapturedAt: evidenceMs,
        },
      };
    }
  }

  // ─── 1. TTL check ────────────────────────────────────────────────────────
  // Missing capturedAt = legacy record → skip this check (fallback to URL +
  // semantic below). `Number.isFinite` guards against invalid ISO strings
  // producing NaN and silently short-circuiting the comparison.
  //
  // Kept as a safety net even though session-lifetime check above covers the
  // common case: background/CI callers don't pass `sessionCreatedAt`, and
  // there are legacy records without a session boundary.
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

  // ─── STRICT GATE: recorded element text must still match ─────────────────
  // bindingHints.text captures the element's own innerText at record time
  // (80-char slice). We compare against nodeTexts which is the
  // accessible-name cascade on the live node (labelText, ariaLabel, name,
  // placeholder, text). This is asymmetric by construction — recording
  // gets raw innerText, replay gets computed name — so we use
  // bidirectional substring matching (either side may be a subset of the
  // other) rather than equality. Acceptable trade-off: catches the common
  // "ref shift to unrelated element" class, tolerant of minor text drift
  // (i18n capitalization, trailing punctuation).
  //
  // False-positive surface we intentionally keep: live node with a long
  // aria-label that happens to contain the recorded text as a substring
  // (e.g. recorded "Cancel" vs live "Cancel subscription"). We prefer
  // false-positive-accept here to false-positive-reject — the downstream
  // action will fail visibly if we picked wrong, but silent rejection of
  // a legitimate cached ref costs an LLM roundtrip per step.
  //
  // Testid gets the same treatment — it's the stablest identifier in the
  // DOM by design. A changed testId at the same ref means a different
  // component.
  //
  // Strictness:
  //   • minimum 3 chars: 2-char tokens like "OK"/"Go" substring-match too
  //     promiscuously (e.g. "OK" is inside "Booking"). 3 is low enough to
  //     still catch short CTAs like "Yes"/"No"/"Buy" but cuts the most common
  //     spurious-substring class;
  //   • falls through to the existing OR-match on partial similarity, so
  //     "Continue" → "Continue dialog" still matches; "Submit" → "Send" does
  //     not. Matches the same bidirectional-substring rule used below to
  //     keep behaviour consistent.
  const recordedText = bindingHints?.text?.toLowerCase().trim();
  if (recordedText && recordedText.length >= 3 && nodeTexts.length > 0) {
    const textMatch = nodeTexts.some(n => n.includes(recordedText) || recordedText.includes(n));
    if (!textMatch) {
      return {
        ok: false,
        reason: 'semantic_mismatch',
        details: {
          cachedRef,
          semanticSource: 'bindingHints_text_gate',
          recordedText: recordedText.slice(0, 80),
          nodeTexts: nodeTexts.slice(0, 3),
        },
      };
    }
  }
  // testId gate — only active in the background/CI pipeline today.
  //
  // WHY ONLY BACKGROUND: `InteractiveNode.testIdAttr` is populated by
  // `background-dom-collector.ts:396` but NOT by the preview-side DOM
  // extractor. Until that pipeline is unified, the check is a no-op for
  // preview callers — `nodeTestId` will be undefined, falsy check skips.
  // Removing the gate would lose protection in background; leaving it
  // costs nothing in preview. Revisit when `dom-analysis-extractor`
  // starts forwarding `data-testid`/`data-test`/`data-test-id`/`data-cy`.
  //
  // PIPELINE MISMATCH: recording reads 4 attrs (data-testid/data-test/
  // data-test-id/data-cy — recording-capture.service.ts:420-424),
  // background collector reads 2 (data-testid/data-test only). Projects
  // using `data-cy` (Cypress) or `data-test-id` will record a hint that
  // the live node never exposes, and the gate will silently skip. Fix
  // together with the preview pipeline alignment.
  const recordedTestId = bindingHints?.testId?.trim();
  if (recordedTestId && recordedTestId.length >= 2) {
    const nodeTestId = cachedNode.testIdAttr?.trim();
    if (nodeTestId && nodeTestId !== recordedTestId) {
      return {
        ok: false,
        reason: 'semantic_mismatch',
        details: {
          cachedRef,
          semanticSource: 'bindingHints_testId_gate',
          recordedTestId: recordedTestId.slice(0, 80),
          nodeTestId: nodeTestId.slice(0, 80),
        },
      };
    }
  }

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

  // ─── 5. Disabled check (click-like actions only) ─────────────────────────
  // A/B tests, form validation, loading states turn buttons disabled between
  // runs. Clicking a disabled element waits 30s in Playwright's auto-wait
  // before timing out — very expensive. We gate by actionType so non-click
  // actions (type, hover, etc.) still pass through with their own semantics.
  //
  // CLICK_LIKE_ACTIONS must match click-like values in IntentActionType
  // (preview.types.ts). Keep in sync if the union changes.
  if (actionType && CLICK_LIKE_ACTIONS.has(actionType) && cachedNode.isDisabled) {
    return {
      ok: false,
      reason: 'node_disabled',
      details: {
        cachedRef,
        actionType,
      },
    };
  }

  return { ok: true, node: cachedNode, ref: cachedRef, semanticSource };
}

/**
 * Click-like IntentActionTypes — for these, interacting with a disabled node
 * hits Playwright's auto-wait (30s default) before timing out. Rejecting such
 * a cached ref up front saves that time and triggers LLM re-resolution.
 */
const CLICK_LIKE_ACTIONS = new Set<string>([
  'click',
  'dblclick',
  'contextmenu',
  'toggle',
  'check',
  'uncheck',
  'open',
  'close',
]);
