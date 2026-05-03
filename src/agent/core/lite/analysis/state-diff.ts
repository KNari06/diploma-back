/**
 * StateDiff
 * Computes structural difference between two snapshots to detect state changes
 *
 * NOTE: Semantic weights, progress sentiment, and goal-aware logic are computed
 * by HybridSemanticWeightCalculator.enrichWithAI() AFTER this structural diff.
 * This module is intentionally kept structural-only to avoid duplication.
 */

import { logger } from '@/utils/core/logger';
import type { LiteElement, LiteSnapshot, NetworkSuccess, NetworkValidationError, StateDiff } from '../lite-types';

export class StateDiffComputer {
  /**
   * Compute structural difference between two snapshots
   * Detects URL changes, added/removed elements, and property changes
   *
   * Semantic fields (semanticWeight, meaningfulChange, significantChange, progressSentiment)
   * are set to safe defaults here. They will be enriched by HybridSemanticWeightCalculator.
   *
   * @param before - Snapshot before action
   * @param after - Snapshot after action
   * @param pageErrorsBefore - Page errors before action
   * @param pageErrorsAfter - Page errors after action
   * @param consoleErrors - Console errors during action
   * @param networkErrors - Network errors during action (already time-filtered)
   * @param successfulResponses - Successful API responses (fetch/xhr, 200-299)
   * @param validationErrors - Validation errors from API (400-499 with parsed body)
   * @param goal - Unused here; kept for API compatibility (goal used by enrichWithAI)
   * @returns Structural state diff with safe semantic defaults
   */
  static compute(
    before: LiteSnapshot,
    after: LiteSnapshot,
    pageErrorsBefore: string[],
    pageErrorsAfter: string[],
    consoleErrors: string[],
    networkErrors: string[] = [],
    successfulResponses: NetworkSuccess[] = [],
    validationErrors: NetworkValidationError[] = [],
    goal?: string
  ): StateDiff {
    // Goal is unused here; semantic weight calculation moved to HybridSemanticWeightCalculator
    void goal;
    try {
      // Check URL change
      const urlChanged = before.url !== after.url;

      // Build ref maps for efficient lookup
      const beforeRefs = new Set(before.elements.map((el) => el.ref));
      const afterRefs = new Set(after.elements.map((el) => el.ref));

      // Find added elements
      const addedElements = after.elements.filter((el) => !beforeRefs.has(el.ref));

      // Find removed refs
      const removedRefs: string[] = [];
      before.elements.forEach((el) => {
        if (!afterRefs.has(el.ref)) {
          removedRefs.push(el.ref);
        }
      });

      // Find changed elements (same ref, different properties)
      const changedElements: Array<{ ref: string; field: string; before: unknown; after: unknown }> = [];

      before.elements.forEach((beforeEl) => {
        const afterEl = after.elements.find((el) => el.ref === beforeEl.ref);
        if (!afterEl) return;

        // Check each property for changes — covers native state + ARIA state
        const fieldsToCheck: Array<keyof LiteElement> = [
          'name', 'value', 'checked', 'disabled', 'visible',
          // ARIA states: toggle switches, custom checkboxes, accordions, tabs
          'ariaChecked', 'ariaExpanded', 'ariaPressed', 'ariaSelected',
          // Validation state changes
          'invalid', 'required', 'readOnly',
          // Stage 1 wiring: Radix UI / shadcn / Vaul / Headless UI all
          // encode toggle state as data-state. Many primitives (Dialog,
          // Popover, DropdownMenu, Collapsible) do NOT mirror to
          // aria-expanded — without tracking data-state here, StateDiff
          // misses widget transitions on the entire shadcn ecosystem.
          // Caught by Stage 2 audit C1: collected in snapshot but invisible
          // to LiteEngine progress logic. Symmetric with the ARIA list.
          'dataState',
        ];

        fieldsToCheck.forEach((field) => {
          if (beforeEl[field] !== afterEl[field]) {
            changedElements.push({
              ref: beforeEl.ref,
              field,
              before: beforeEl[field],
              after: afterEl[field],
            });
          }
        });
      });

      // Find new page errors
      const newPageErrors = pageErrorsAfter.filter((err) => !pageErrorsBefore.includes(err));

      // Determine if there's a structural visual change
      const hasVisualChange =
        urlChanged ||
        addedElements.length > 0 ||
        removedRefs.length > 0 ||
        changedElements.length > 0;

      // Build diff with safe semantic defaults
      // These will be enriched by HybridSemanticWeightCalculator.enrichWithAI()
      const diff: StateDiff = {
        urlChanged,
        urlBefore: before.url,
        urlAfter: after.url,
        addedElements,
        removedRefs,
        changedElements,
        hasVisualChange,
        newPageErrors,
        newConsoleErrors: consoleErrors,
        newNetworkErrors: networkErrors,
        // Safe semantic defaults (enriched later by HybridSemanticWeightCalculator)
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect',
        successfulApiResponses: successfulResponses.length > 0 ? successfulResponses : undefined,
        validationApiErrors: validationErrors.length > 0 ? validationErrors : undefined,
      };

      logger.debug('[STATE_DIFF] Computed structural diff', {
        urlChanged,
        addedCount: addedElements.length,
        removedCount: removedRefs.length,
        changedCount: changedElements.length,
        hasVisualChange,
        newPageErrors: newPageErrors.length,
        newConsoleErrors: consoleErrors.length,
        newNetworkErrors: networkErrors.length,
        successfulApiCount: successfulResponses.length,
        validationErrorCount: validationErrors.length,
      });

      return diff;
    } catch (error) {
      logger.error('[STATE_DIFF] Failed to compute state diff', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return minimal diff on error
      return {
        urlChanged: false,
        urlBefore: before.url,
        urlAfter: after.url,
        addedElements: [],
        removedRefs: [],
        changedElements: [],
        hasVisualChange: false,
        newPageErrors: [],
        newConsoleErrors: [],
        newNetworkErrors: [],
        semanticWeight: 0,
        meaningfulChange: false,
        significantChange: false,
        progressSentiment: 'No Effect',
        successfulApiResponses: undefined,
        validationApiErrors: undefined,
      };
    }
  }

  /**
   * Format diff for logging or AI context
   *
   * @param diff - State diff to format
   * @returns Human-readable string
   */
  static format(diff: StateDiff): string {
    const lines: string[] = [];

    if (diff.urlChanged) {
      lines.push(`URL changed: ${diff.urlBefore} → ${diff.urlAfter}`);
    }

    if (diff.addedElements.length > 0) {
      lines.push(`Added ${diff.addedElements.length} elements:`);
      diff.addedElements.slice(0, 5).forEach((el) => {
        lines.push(`  + ${el.ref}: ${el.name}`);
      });
      if (diff.addedElements.length > 5) {
        lines.push(`  ... and ${diff.addedElements.length - 5} more`);
      }
    }

    if (diff.removedRefs.length > 0) {
      lines.push(`Removed ${diff.removedRefs.length} elements: ${diff.removedRefs.slice(0, 5).join(', ')}`);
    }

    if (diff.changedElements.length > 0) {
      lines.push(`Changed ${diff.changedElements.length} elements:`);
      diff.changedElements.slice(0, 5).forEach((change) => {
        lines.push(`  ~ ${change.ref}.${change.field}: ${change.before} → ${change.after}`);
      });
    }

    if (diff.newPageErrors.length > 0) {
      lines.push(`New page errors: ${diff.newPageErrors.length}`);
      diff.newPageErrors.slice(0, 2).forEach((err) => {
        lines.push(`  ! ${err.slice(0, 100)}`);
      });
    }

    if (diff.newConsoleErrors.length > 0) {
      lines.push(`New console errors: ${diff.newConsoleErrors.length}`);
      diff.newConsoleErrors.slice(0, 2).forEach((err) => {
        lines.push(`  ! ${err.slice(0, 100)}`);
      });
    }

    if (diff.newNetworkErrors && diff.newNetworkErrors.length > 0) {
      lines.push(`New network errors: ${diff.newNetworkErrors.length}`);
      diff.newNetworkErrors.slice(0, 2).forEach((err) => {
        lines.push(`  ! ${err.slice(0, 120)}`);
      });
    }

    if (lines.length === 0) {
      return 'No changes detected';
    }

    return lines.join('\n');
  }

  /**
   * Format diff for AI prompt with actionable analysis
   * Uses semantic weights, progress sentiment, and network-awareness
   * (these fields are enriched by HybridSemanticWeightCalculator before this is called)
   *
   * @param diff - Enriched state diff to format
   * @param action - Action that was taken
   * @returns Formatted string for AI with reasoning hints
   */
  static formatForAI(diff: StateDiff, action: string): string {
    const lines: string[] = [];

    // State Drift Analysis Header
    lines.push('📊 STATE DRIFT ANALYSIS (what changed after last action):');
    lines.push('');

    // Progress Sentiment
    const sentimentEmoji: Record<string, string> = {
      'Major Progress': '🎯',
      'Significant Change': '✅',
      'Minor Change': '↗️',
      'No Effect': '❌',
      'Negative Change': '⚠️',
    };
    lines.push(`${sentimentEmoji[diff.progressSentiment] || '❓'} PROGRESS SENTIMENT: ${diff.progressSentiment}`);
    lines.push(`   Semantic Weight: ${diff.semanticWeight.toFixed(2)} (Meaningful: ${diff.meaningfulChange}, Significant: ${diff.significantChange})`);
    lines.push('');

    // URL Analysis
    if (diff.urlChanged) {
      lines.push(`✅ URL CHANGED: ${diff.urlBefore} → ${diff.urlAfter}`);
      lines.push(`   → Good! Navigation happened. Check if this brings you closer to goal.`);
    } else {
      lines.push(`⚠️  URL UNCHANGED: Still on ${diff.urlAfter}`);
      lines.push(`   → Action "${action}" did not navigate. If expected navigation, try different approach.`);
    }
    lines.push('');

    // DOM Changes Analysis
    const totalChanges = diff.addedElements.length + diff.removedRefs.length + diff.changedElements.length;

    if (totalChanges === 0 && !diff.urlChanged && !diff.meaningfulChange) {
      lines.push(`❌ NO DOM CHANGES: Page looks identical before/after action.`);
      lines.push(`   → This is a FAILURE. Action had NO EFFECT. Try different element or approach.`);
    } else if (totalChanges > 0 || diff.meaningfulChange) {
      lines.push(`✅ DOM CHANGED: +${diff.addedElements.length} added, -${diff.removedRefs.length} removed, ~${diff.changedElements.length} modified`);

      // Show key added elements (interactive elements with high semantic weight)
      const KEY_TAGS = new Set(['form', 'button', 'input', 'textarea', 'select', 'dialog', 'details', 'nav']);
      const KEY_ROLES = new Set(['button', 'textbox', 'switch', 'slider', 'checkbox', 'radio', 'dialog', 'alertdialog', 'combobox']);
      const keyElements = diff.addedElements
        .filter(el =>
          KEY_TAGS.has(el.tag) || KEY_ROLES.has(el.role || '') || el.type === 'password'
        )
        .slice(0, 3);

      if (keyElements.length > 0) {
        lines.push(`   Key new elements (high semantic weight):`);
        keyElements.forEach(el => {
          const typeInfo = el.type ? ` type=${el.type}` : '';
          lines.push(`   + ${el.ref}: "${el.name}"${typeInfo}`);
        });
      }

      if (diff.meaningfulChange) {
        lines.push(`   → Meaningful change detected (weight >= 0.1). Not just noise/ads.`);
      }
      if (diff.significantChange) {
        lines.push(`   → Significant change detected (weight >= 0.5). Successful state shift!`);
      }
    }
    lines.push('');

    // Network Success
    if (diff.successfulApiResponses && diff.successfulApiResponses.length > 0) {
      lines.push(`✅ API SUCCESS: Server confirmed action.`);
      diff.successfulApiResponses.slice(0, 2).forEach(resp => {
        lines.push(`   ✓ ${resp.method} ${resp.status} ${resp.url}`);
      });
      if (diff.successfulApiResponses.length > 2) {
        lines.push(`   ... and ${diff.successfulApiResponses.length - 2} more`);
      }
      lines.push(`   → Server responded successfully. If page hasn't updated yet — just wait.`);
      lines.push('');
    }

    // Validation Errors
    if (diff.validationApiErrors && diff.validationApiErrors.length > 0) {
      lines.push(`⚠️  VALIDATION ERRORS: Server rejected action.`);
      diff.validationApiErrors.slice(0, 2).forEach(err => {
        lines.push(`   ! ${err.method} ${err.status} ${err.url}`);
        if (err.message) {
          lines.push(`     Message: ${err.message}`);
        }
        if (err.errors && err.errors.length > 0) {
          lines.push(`     Errors: ${err.errors.slice(0, 3).join(', ')}`);
        }
      });
      lines.push(`   → These validation errors explain why action failed. Check error messages.`);
      lines.push('');
    }

    // Error Analysis
    if (diff.newPageErrors.length > 0 || diff.newConsoleErrors.length > 0) {
      lines.push(`❌ NEW ERRORS DETECTED:`);
      [...diff.newPageErrors, ...diff.newConsoleErrors].slice(0, 2).forEach(err => {
        lines.push(`   ! ${err.slice(0, 100)}`);
      });
      lines.push(`   → These errors may indicate why action failed. Check error messages.`);
      lines.push('');
    }

    // Network Error Analysis
    if (diff.newNetworkErrors && diff.newNetworkErrors.length > 0) {
      lines.push(`🔴 NETWORK ERRORS:`);
      diff.newNetworkErrors.slice(0, 2).forEach(err => {
        lines.push(`   ! ${err.slice(0, 120)}`);
      });
      if (diff.newNetworkErrors.some(e => e.includes('429') || e.toLowerCase().includes('rate limit'))) {
        lines.push(`   → Rate limiting detected. Use "wait" action to back off.`);
      } else if (diff.newNetworkErrors.some(e => e.includes('500') || e.includes('502') || e.includes('503'))) {
        lines.push(`   → SERVER ERROR. Critical blocker — stop and report.`);
      }
      lines.push('');
    }

    // Conclusion based on Progress Sentiment
    lines.push('');
    switch (diff.progressSentiment) {
      case 'Major Progress':
        lines.push('🎯 CONCLUSION: MAJOR PROGRESS! Form appeared or navigation happened. You are on the right track.');
        break;
      case 'Significant Change':
        lines.push('✅ CONCLUSION: SIGNIFICANT CHANGE detected. Analyze new state and continue toward goal.');
        break;
      case 'Minor Change':
        lines.push('↗️ CONCLUSION: Minor change detected. Some progress, but not significant yet.');
        break;
      case 'No Effect':
        lines.push('❌ CONCLUSION: Action had NO EFFECT. You MUST try a different approach or element.');
        break;
      case 'Negative Change':
        lines.push('⚠️ CONCLUSION: ERRORS detected. Check error messages and adjust strategy.');
        break;
    }

    return lines.join('\n');
  }
}
