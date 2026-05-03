/**
 * Deterministic Progress Evaluator (Stage 2 — de-weighting LiteEngine)
 *
 * Replaces the numeric-weight portion of HybridSemanticWeightCalculator
 * with deterministic boolean signals from `StateDiff`. The legacy
 * calculator is kept side-by-side and selected via
 * `LITE_ENGINE_FLAGS.enableDeweightedProgress` so rollout can be flagged
 * and reverted without touching call-sites.
 *
 * Why this module exists:
 *   - HybridSemanticWeightCalculator made decisions based on totalWeight
 *     thresholds (>= 0.5, >= 0.1) computed from 13 hand-tuned heuristic
 *     rules + funnel multipliers (0.6 / 1.0 / 1.2) + goal-keyword boost
 *     (1.5×) + percentile-based z-index multiplier. Outcomes hinged on
 *     constants, not on stable signals.
 *   - It also called gemini-flash-lite EVERY iteration to "audit" gray-
 *     zone elements (5s timeout, 1.5s internal), even when StateDiff
 *     already had decisive evidence (URL changed, errors raised, API
 *     responses succeeded).
 *
 * Design:
 *   - `computeProgressSentiment(diff)` returns the same `ProgressSentiment`
 *     enum but reads only `urlChanged` / `newPageErrors` /
 *     `newConsoleErrors` / `newNetworkErrors` / `validationApiErrors` /
 *     `successfulApiResponses` / `addedElements` / `changedElements`.
 *     Pure function, no LLM, no goal-keyword scoring.
 *   - `buildDeterministicSummary(diff, goal)` constructs the same
 *     "📊 WHAT CHANGED" prompt section using the same input — but does
 *     NOT need per-element AI category enrichment; instead it labels
 *     elements via simple deterministic predicates (tag === 'form',
 *     `isErrorElement`, etc.).
 *   - `rankCandidatesForAudit` returns RankedCandidate[] using a 3-bucket
 *     boolean rank (action-eligible — already filtered upstream — plus
 *     `isTopMostAtCenter` AND goal-keyword match). The LLM auditor
 *     (`TargetAudit.audit`) does the actual ranking.
 *
 * Contract guarantees:
 *   - Pure synchronous functions (no I/O, no LLM). Cheap to call every
 *     iteration without timeout protection.
 *   - Output shape (`ProgressSentiment`, summary string) matches the
 *     legacy calculator so down-stream consumers (`lite-engine.ts:4046`,
 *     `lite-prompt-builder.ts:217`) read it identically.
 *   - All numeric constants here are STRUCTURAL (e.g. "≥ 1 added input
 *     element = Major Progress"), not WEIGHT-DERIVED.
 */

import type { LiteElement, ProgressSentiment, StateDiff } from '../lite-types';
import type { ExpandedGoal } from './goal-expander';
import { isErrorElement, matchesKeyword } from './hybrid-semantic-weight';

// Threshold: count of added+removed+changed elements that promotes a
// "did something" to 'Minor Change'. Hand-picked from observation:
//   1 = animation / observer noop
//   2 = often noise (input + label re-render, hover state)
//   3 = first count where the change is reliably user-meaningful
// Not a magic *score* — just a count gate. Calibrate from telemetry.
const BULK_MOVE_THRESHOLD = 3;

/**
 * Compute progress sentiment from raw StateDiff signals.
 *
 * Order matters — first matching rule wins. Negative outranks positive
 * because a click that simultaneously navigates AND raises an error is
 * still a regression for the test author.
 *
 * Why these specific buckets:
 *   - 'Negative Change': any error signal — page exception, console error,
 *     network error, or 4xx-with-validation-body. These are unambiguous
 *     bad outcomes.
 *   - 'Major Progress': URL/route change (highest-confidence positive
 *     signal in any web app), OR a new <form> / <dialog> / [role=dialog]
 *     appeared, OR new <input> appeared (form opened in-place — the
 *     user's goal of "fill X" can now proceed).
 *   - 'Significant Change': successful mutating API response — server
 *     accepted the action even if the client UI did not visibly change
 *     (common in SPA flows that update background state).
 *   - 'Minor Change': structural DOM movement (≥ 3 added or removed
 *     elements). Captures menu opens, list expansions, modal mounts that
 *     don't fall into Major buckets above.
 *   - 'No Effect': nothing else moved. Drives consecutiveNoEffectCount
 *     in lite-engine.ts:4046.
 */
export function computeProgressSentiment(
  diff: StateDiff,
  goal: ExpandedGoal | null = null
): ProgressSentiment {
  // 1. Errors — highest priority. Any of the four error sources fails the step.
  const hasErrors =
    (diff.newPageErrors && diff.newPageErrors.length > 0) ||
    (diff.newConsoleErrors && diff.newConsoleErrors.length > 0) ||
    (diff.newNetworkErrors && diff.newNetworkErrors.length > 0) ||
    (diff.validationApiErrors && diff.validationApiErrors.length > 0);
  if (hasErrors) return 'Negative Change';

  // 2. URL change — highest-confidence positive. Any nav = Major.
  if (diff.urlChanged) return 'Major Progress';

  // 3. Structural openings (form / dialog / new input). Detected by
  //    presence — no scoring. Replaces the legacy "totalWeight >= 0.5
  //    AND tag === 'input'" branch with the broader, more accurate
  //    "any of these widget types just appeared" predicate.
  const opensWidget = diff.addedElements.some((el) => {
    const tag = el.tag;
    const role = (el.role || '').toLowerCase();
    return tag === 'form'
      || tag === 'dialog'
      || tag === 'input'
      || tag === 'textarea'
      || tag === 'select'
      || role === 'dialog'
      || role === 'alertdialog';
  });
  if (opensWidget) return 'Major Progress';

  // 4. Successful mutating API call — server confirmed even without UI.
  if (diff.successfulApiResponses && diff.successfulApiResponses.length > 0) {
    return 'Significant Change';
  }

  // 5. Bulk DOM movement — captures menus / popovers / list refreshes
  //    that didn't trip rules 2-4. Threshold of 3 mirrors the implicit
  //    "non-trivial change" gate in HybridSemanticWeightCalculator
  //    (totalWeight >= 0.1 typically meant 2-3 mid-relevance elements).
  const totalMoves = diff.addedElements.length + diff.removedRefs.length + diff.changedElements.length;
  if (totalMoves >= BULK_MOVE_THRESHOLD) {
    // Fix 2 — decorative bulk gate. Without this, clicking "Reviews"
    // / "FAQ" / "Help" on a goal="buy iPhone" run lights up dozens
    // of div/span/p elements → totalMoves >= 3 → 'Minor Change' →
    // consecutiveNoEffectCount stays at 0 → agent thinks it's
    // making progress in the wrong direction. Legacy compensated
    // through totalWeight: decorative penalty kept weight under
    // 0.1 → 'No Effect' fired. We replicate that behaviour
    // structurally: a flood of NEW elements where ZERO are
    // goal-relevant AND ZERO are errors is decorative noise.
    //
    // Gates:
    //   - only check the ADDED set (removed/changed are reactive,
    //     not signals of "what new content appeared")
    //   - require at least 3 added (matches threshold above) — for
    //     a 2-added flood the totalMoves rule wouldn't fire anyway,
    //     no point checking goals
    //   - require BOTH conditions: any goal-relevant OR any error
    //     stays as 'Minor Change'. Pure decorative falls through
    //     to 'No Effect'.
    if (goal && diff.addedElements.length >= BULK_MOVE_THRESHOLD) {
      const anyGoalRelevant = diff.addedElements.some((el) => isGoalRelevantElement(el, goal));
      const anyError = diff.addedElements.some(isErrorElement);
      if (!anyGoalRelevant && !anyError) {
        // Decorative-only bulk → treat as no-effect. This drives
        // consecutiveNoEffectCount and the 5-strike abort that
        // protects the user from runaway iterations on the wrong
        // page section.
        return 'No Effect';
      }
    }
    return 'Minor Change';
  }

  return 'No Effect';
}

/**
 * Detect "this is a goal-relevant element" deterministically.
 *
 * Used by both buildDeterministicSummary and rankCandidatesForAudit.
 * Tokenises the element's name/aria-label/text and tests against the
 * expanded goal's keyword set. Pure function, no LLM.
 */
export function isGoalRelevantElement(el: LiteElement, goal: ExpandedGoal | null): boolean {
  if (!goal) return false;
  const haystack = `${el.name || ''} ${el.ariaLabel || ''} ${el.firstTextFragment || ''}`.trim();
  if (!haystack) return false;
  // Stop on first match — set is small (typically 5-15 keywords).
  for (const kw of goal.allKeywords) {
    if (matchesKeyword(haystack, kw, true)) return true;
  }
  return false;
}

/**
 * Build the "📊 WHAT CHANGED" prompt section without LLM enrichment.
 *
 * Mirrors the format of HybridSemanticWeightCalculator.buildGoalOriented
 * Summary so the LLM prompt template (lite-prompt-builder.ts:217) is
 * identical char-for-char in shape — only the source of category labels
 * changes from "AI batch audit" to "tag + role + isErrorElement +
 * isGoalRelevantElement".
 */
export function buildDeterministicSummary(diff: StateDiff, goal: ExpandedGoal | null): string {
  const lines: string[] = [];
  const added = diff.addedElements;
  const removedCount = diff.removedRefs.length;

  // 1. Errors first (highest priority). Same predicate as legacy.
  const errorEls = added.filter(isErrorElement);
  if (errorEls.length > 0) {
    const names = errorEls.map((e) => (e.name || '').slice(0, 30)).filter(Boolean).slice(0, 3).join(', ');
    if (names) lines.push(`⚠️ Errors appeared: ${names}`);
    else lines.push(`⚠️ ${errorEls.length} error element(s) appeared`);
  }

  // 2. Validation API errors — same as legacy.
  if (diff.validationApiErrors && diff.validationApiErrors.length > 0) {
    const first = diff.validationApiErrors[0];
    const msg = first.message || (first.errors && first.errors.join(', ')) || 'validation failed';
    lines.push(`⚠️ API validation: ${msg.slice(0, 50)}`);
  }

  // 3. New forms — direct tag match (no AI category needed).
  const forms = added.filter((el) => el.tag === 'form');
  if (forms.length > 0) {
    const formName = forms[0].name || forms[0].ariaLabel || 'unnamed';
    lines.push(`📝 New form: ${formName.slice(0, 30)}`);
  }

  // 4. New dialogs / modals — heuristic-free, role-based.
  const dialogs = added.filter((el) => {
    const role = (el.role || '').toLowerCase();
    return el.tag === 'dialog' || role === 'dialog' || role === 'alertdialog';
  });
  if (dialogs.length > 0) {
    const name = dialogs[0].name || dialogs[0].ariaLabel || 'unnamed';
    lines.push(`🪟 Dialog opened: ${name.slice(0, 30)}`);
  }

  // 5. Goal-relevant additions — replaces legacy 'goal-action' /
  //    'goal-form' / 'primary-action' AI categories with a deterministic
  //    keyword-match predicate.
  if (goal) {
    const goalRelevant = added.filter((el) => isGoalRelevantElement(el, goal));
    if (goalRelevant.length > 0) {
      const names = goalRelevant
        .map((e) => (e.name || e.ariaLabel || '').slice(0, 20))
        .filter(Boolean)
        .slice(0, 3)
        .join(', ');
      if (names) lines.push(`🎯 Goal-relevant: ${names}`);
    }
  }

  // 6. URL change.
  if (diff.urlChanged) {
    lines.push(`🔗 Navigated to: ${(diff.urlAfter || '').slice(0, 50)}`);
  }

  // 7. API success.
  if (diff.successfulApiResponses && diff.successfulApiResponses.length > 0) {
    lines.push(`✅ API success: Server confirmed action`);
  }

  // 8. Significant removals — threshold mirrors legacy "removed.length > 3"
  //    but drops the semanticWeight gate. Removals that big are inherently
  //    significant regardless of element importance.
  if (removedCount >= 3) {
    lines.push(`➖ Removed: ${removedCount} elements`);
  }

  // 9. Sentiment line — only when not 'No Effect' (matches legacy).
  const sentiment = diff.progressSentiment;
  if (sentiment !== 'No Effect') {
    lines.push(`${sentimentEmoji(sentiment)} Progress: ${sentiment}`);
  }

  if (lines.length === 0) return 'Minimal changes detected.';
  return lines.join('\n');
}

function sentimentEmoji(s: ProgressSentiment): string {
  switch (s) {
    case 'Major Progress': return '🎯';
    case 'Significant Change': return '✅';
    case 'Minor Change': return '↗️';
    case 'Negative Change': return '⚠️';
    case 'No Effect': return '❌';
    default: return '•';
  }
}
