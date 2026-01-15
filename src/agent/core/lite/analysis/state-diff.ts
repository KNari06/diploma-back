/**
 * StateDiff
 * Computes difference between two snapshots to detect state changes
 */

import { logger } from '@/utils/core/logger';
import type { LiteSnapshot, StateDiff } from '../lite-types';

export class StateDiffComputer {
  /**
   * Compute difference between two snapshots
   * Detects URL changes, added/removed elements, and property changes
   *
   * @param before - Snapshot before action
   * @param after - Snapshot after action
   * @param pageErrorsBefore - Page errors before action
   * @param pageErrorsAfter - Page errors after action
   * @param consoleErrors - Console errors during action
   * @returns State diff
   */
  static compute(
    before: LiteSnapshot,
    after: LiteSnapshot,
    pageErrorsBefore: string[],
    pageErrorsAfter: string[],
    consoleErrors: string[],
    networkErrors: string[] = []
  ): StateDiff {
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

        // Check each property for changes
        const fieldsToCheck: Array<keyof typeof beforeEl> = [
          'name', 'value', 'checked', 'disabled', 'visible'
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

      // Determine if there's a visual change
      const hasVisualChange =
        urlChanged ||
        addedElements.length > 0 ||
        removedRefs.length > 0 ||
        changedElements.length > 0;

      // Find new page errors
      const newPageErrors = pageErrorsAfter.filter((err) => !pageErrorsBefore.includes(err));

      // Console errors are already filtered by time in ConsoleCollector

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
      };

      logger.debug('[STATE_DIFF] Computed state diff', {
        urlChanged,
        addedCount: addedElements.length,
        removedCount: removedRefs.length,
        changedCount: changedElements.length,
        hasVisualChange,
        newPageErrors: newPageErrors.length,
        newConsoleErrors: consoleErrors.length,
        newNetworkErrors: networkErrors.length,
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
   * Includes state drift reasoning to help AI understand what changed and what to do
   *
   * @param diff - State diff to format
   * @param action - Action that was taken
   * @returns Formatted string for AI with reasoning hints
   */
  static formatForAI(diff: StateDiff, action: string): string {
    const lines: string[] = [];

    // State Drift Analysis Header
    lines.push('📊 STATE DRIFT ANALYSIS (what changed after last action):');

    // URL Analysis
    if (diff.urlChanged) {
      lines.push(`✅ URL CHANGED: ${diff.urlBefore} → ${diff.urlAfter}`);
      lines.push(`   → Good! Navigation happened. Check if this brings you closer to goal.`);
    } else {
      lines.push(`⚠️  URL UNCHANGED: Still on ${diff.urlAfter}`);
      lines.push(`   → Action "${action}" did not navigate. If expected navigation, try different approach.`);
    }

    // DOM Changes Analysis
    const totalChanges = diff.addedElements.length + diff.removedRefs.length + diff.changedElements.length;

    if (totalChanges === 0 && !diff.urlChanged) {
      lines.push(`❌ NO DOM CHANGES: Page looks identical before/after action.`);
      lines.push(`   → This is a FAILURE. Action had NO EFFECT. Try different element or approach.`);
    } else if (totalChanges > 0) {
      lines.push(`✅ DOM CHANGED: +${diff.addedElements.length} added, -${diff.removedRefs.length} removed, ~${diff.changedElements.length} modified`);

      // Show key added elements (forms, buttons, inputs)
      const keyElements = diff.addedElements.filter(el =>
        el.tag === 'form' || el.tag === 'button' || el.tag === 'input' || el.type === 'password'
      ).slice(0, 3);

      if (keyElements.length > 0) {
        lines.push(`   Key new elements:`);
        keyElements.forEach(el => {
          const typeInfo = el.type ? ` type=${el.type}` : '';
          lines.push(`   + ${el.ref}: "${el.name}"${typeInfo}`);
        });
      }
    }

    // Error Analysis
    if (diff.newPageErrors.length > 0 || diff.newConsoleErrors.length > 0) {
      lines.push(`❌ NEW ERRORS DETECTED:`);
      [...diff.newPageErrors, ...diff.newConsoleErrors].slice(0, 2).forEach(err => {
        lines.push(`   ! ${err.slice(0, 100)}`);
      });
      lines.push(`   → These errors may indicate why action failed. Check error messages.`);
    }

    // Network Error Analysis
    if (diff.newNetworkErrors && diff.newNetworkErrors.length > 0) {
      lines.push(`⚠️  NETWORK ERRORS:`);
      diff.newNetworkErrors.slice(0, 2).forEach(err => {
        lines.push(`   ! ${err.slice(0, 120)}`);
      });
      if (diff.newNetworkErrors.some(e => e.includes('429') || e.toLowerCase().includes('rate limit'))) {
        lines.push(`   → Rate limiting detected. Use "wait" action to back off.`);
      }
    }

    // Conclusion
    lines.push('');
    if (!diff.urlChanged && totalChanges === 0 && !diff.hasVisualChange) {
      lines.push('🚨 CONCLUSION: Action had NO EFFECT. You MUST try a different approach or element.');
    } else if (diff.hasVisualChange || diff.urlChanged) {
      lines.push('✅ CONCLUSION: Action caused changes. Analyze new state and continue toward goal.');
    }

    return lines.join('\n');
  }
}
