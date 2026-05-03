/**
 * Deterministic Progress Evaluator (Stage 2 — de-weighting LiteEngine)
 *
 * Replaces the numeric-weight portion of HybridSemanticWeightCalculator
 * with deterministic boolean signals from `StateDiff`. This module is
 * the single source of truth for progress sentiment in LiteEngine —
 * no flag, no fallback to weighted path. HybridSemanticWeightCalculator
 * is still constructed for L2 keyword expansion / funnel phase tracking
 * but its `enrichWithAI` is no longer in the iteration loop.
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
import { isErrorElement, matchesKeyword } from './keyword-utils';

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
/**
 * Map a sentiment to its (meaningfulChange, significantChange) pair.
 *
 * Stage 2 audit C2/C3: state-diff.ts:formatForAI feeds these booleans
 * directly into the LLM prompt as `(Meaningful: false, Significant: false)`.
 * Leaving them at base defaults (always false) when the deweighted path
 * sets sentiment='Major Progress' poisons the prompt. This mapping
 * mirrors the legacy semantics:
 *   - meaningful = anything other than 'No Effect'
 *   - significant = 'Major Progress' or 'Significant Change'
 * Matches HybridSemanticWeightCalculator's behaviour (totalWeight >= 0.1
 * → meaningful, >= 0.5 → significant) at the categorical level.
 */
function flagsForSentiment(sentiment: ProgressSentiment): { meaningful: boolean; significant: boolean } {
  if (sentiment === 'No Effect') return { meaningful: false, significant: false };
  if (sentiment === 'Minor Change') return { meaningful: true, significant: false };
  // Major Progress / Significant Change / Negative Change all count
  // as significant — Negative because validators care that something
  // happened (even if bad), not just that the run failed silently.
  return { meaningful: true, significant: true };
}

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

  // 3a. Structural openings — new widget root just mounted. Detected
  //     by presence of the right tag/role in addedElements. NO scoring,
  //     NO LLM. The whitelist covers the practical universe of "widget
  //     opened" semantics across React UI stacks:
  //
  //       Native HTML:  form / dialog / input / textarea / select
  //       ARIA dialog:  role=dialog | alertdialog (Radix Dialog,
  //                     Headless UI Dialog, custom modals)
  //       ARIA menu:    role=menu | menuitem (Radix DropdownMenu,
  //                     ContextMenu — items mount via Portal so they
  //                     show up in addedElements, not changedElements)
  //       ARIA select:  role=combobox | listbox | option (Radix Select,
  //                     Headless UI Listbox, Combobox — option list
  //                     also Portal-rendered)
  //       ARIA tooltip: role=tooltip (HoverCard, Tooltip)
  //
  //     `el.visible !== false` filter (audit M5): hidden <input> /
  //     <form> injected by Stripe / reCaptcha / tracking scripts must
  //     NOT trigger Major Progress. Both undefined and true visible
  //     count as "real". Off-screen-but-visible is still real.
  const opensWidget = diff.addedElements.some((el) => {
    if (el.visible === false) return false;
    const tag = el.tag;
    const role = (el.role || '').toLowerCase();
    return tag === 'form'
      || tag === 'dialog'
      || tag === 'input'
      || tag === 'textarea'
      || tag === 'select'
      || role === 'dialog'
      || role === 'alertdialog'
      || role === 'menu'
      || role === 'menuitem'
      || role === 'combobox'
      || role === 'listbox'
      || role === 'option'
      || role === 'tooltip';
  });
  if (opensWidget) return 'Major Progress';

  // 3b. data-state flip on EXISTING element — Radix Dialog/Popover/
  //     DropdownMenu/Select toggle the trigger's data-state from
  //     'closed' → 'open' (or 'inactive' → 'active' for Tabs) WITHOUT
  //     mounting new widget roots in the same DOM region. The portal
  //     mounts (rule 3a) usually catches this, but some Radix
  //     primitives (Collapsible, AccordionTrigger) toggle inline
  //     content visibility instead — only data-state changes.
  //
  //     Symmetry with state-diff.ts:78 fieldsToCheck which now
  //     includes 'dataState'. Without rule 3b, those changes count as
  //     1 changedElements move → fall through to bulk gate at ≥3 →
  //     `consecutiveNoEffectCount` increments on a real "menu opened"
  //     event.
  //
  //     Recognise canonical "opening" transitions only. Going from
  //     'open' → 'closed' is a CLOSE, not progress; we don't elevate
  //     that to Major (it falls through to bulk-movement rule below).
  const dataStateOpened = diff.changedElements.some((change) => {
    if (change.field !== 'dataState') return false;
    const before = String(change.before ?? '').toLowerCase();
    const after = String(change.after ?? '').toLowerCase();
    // 'closed' → 'open': Radix Dialog, Popover, DropdownMenu, Select,
    //                    HoverCard, Collapsible, AccordionItem.
    // 'inactive' → 'active': Radix Tabs (clicking a tab).
    // 'off' → 'on': Radix Toggle / ToggleGroup item activation.
    // 'unchecked' → 'checked': Radix Checkbox / RadioGroup item.
    return (before === 'closed' && after === 'open')
      || (before === 'inactive' && after === 'active')
      || (before === 'off' && after === 'on')
      || (before === 'unchecked' && after === 'checked');
  });
  if (dataStateOpened) return 'Major Progress';

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
      // Audit Scenario 1 fix — content-keyword false-positive on Reviews.
      //
      // Naive text-match leaks: clicking "Reviews" tab on goal="buy
      // iPhone" floods 30 review-card divs, each containing the word
      // "iPhone" in its body — `isGoalRelevantElement` returns true
      // for every one → Fix 2 bypassed → bulk gate stays Minor Change
      // → agent thinks decorative section is progress.
      //
      // Stricter predicate for the bulk gate ONLY: require the matched
      // element to ALSO be interactive (clickable widget/role), not a
      // text-bearing layout div. The summary path (line ~290 below)
      // still uses the broad predicate because it's a hint string for
      // the LLM, not a control-flow gate.
      //
      // Interactive predicate matches snapshot-collector's Tier-1
      // selector intent: native interactive tags + ARIA roles that
      // indicate clickability. Skips `tooltip`/`option` because they
      // appear in dense lists where every option matches goal text
      // (same Reviews-style false-positive).
      const isActionableGoalRelevant = (el: LiteElement): boolean => {
        if (!isGoalRelevantElement(el, goal)) return false;
        const tag = el.tag;
        const role = (el.role || '').toLowerCase();
        return tag === 'button'
          || tag === 'a'
          || tag === 'input'
          || tag === 'textarea'
          || tag === 'select'
          || tag === 'form'
          || tag === 'dialog'
          || role === 'button'
          || role === 'link'
          || role === 'menuitem'
          || role === 'tab'
          || role === 'checkbox'
          || role === 'radio'
          || role === 'switch'
          || role === 'combobox'
          || role === 'searchbox'
          || role === 'textbox'
          || role === 'dialog'
          || role === 'alertdialog';
      };
      const anyActionableGoalRelevant = diff.addedElements.some(isActionableGoalRelevant);
      const anyError = diff.addedElements.some(isErrorElement);
      if (!anyActionableGoalRelevant && !anyError) {
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
 * Apply deweighted sentiment computation to a base StateDiff and return
 * a fully enriched diff with `progressSentiment`, `meaningfulChange`,
 * `significantChange` set consistently.
 *
 * Audit C2/C3 fix: legacy `enrichWithAI` updated all three fields
 * together — the deweighted path was only updating `progressSentiment`
 * leaving `meaningful`/`significant` at base `false`, which leaked into
 * `state-diff.ts:formatForAI` prompt section as `(Meaningful: false,
 * Significant: false)` even on Major Progress. This wrapper closes
 * that contract.
 *
 * Pure synchronous — same I/O profile as `computeProgressSentiment`.
 */
export function applyDeweightedSentiment(
  baseDiff: StateDiff,
  goal: ExpandedGoal | null = null,
): StateDiff {
  const sentiment = computeProgressSentiment(baseDiff, goal);
  const { meaningful, significant } = flagsForSentiment(sentiment);
  return {
    ...baseDiff,
    progressSentiment: sentiment,
    meaningfulChange: meaningful,
    significantChange: significant,
  };
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
  // Audit H3: include title / iconLabel / labelText / placeholder so
  // icon-only buttons (Element Plus toolbar, AntD IconButton, MUI
  // IconButton) and labelled inputs are recognised as goal-relevant.
  // Without these, an icon button whose only text is `title="Add to
  // cart"` lands in the wrong bucket and L4 audit can promote a
  // generic CTA over it.
  //
  // Skipped intentionally:
  //   - el.context (parent text — too broad, would over-trigger on
  //     row siblings)
  //   - el.nearText (deliberately picks UP context, opposite of what
  //     we want for "is THIS element relevant")
  const haystack = [
    el.name,
    el.ariaLabel,
    el.firstTextFragment,
    el.title,
    el.iconLabel,
    el.labelText,
    el.placeholder,
  ].filter(Boolean).join(' ').trim();
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
