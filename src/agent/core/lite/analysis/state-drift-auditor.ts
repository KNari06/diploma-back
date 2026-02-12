/**
 * StateDriftAuditor
 * Adds confidence scoring, change attribution, repetition detection,
 * anomaly detection, and diff quality metrics to state diffs.
 *
 * All computations are from existing data — no extra AI calls, <5ms total.
 */

import { logger } from '@/utils/core/logger';
import type { LiteState } from '../lite-state';
import type {
  AnomalyDetection,
  ChangeAttribution,
  DiffQualityMetrics,
  DriftConfidence,
  LiteSnapshot,
  RepetitionDetection,
  StateDiff,
  StateDriftAuditResult,
} from '../lite-types';

export class StateDriftAuditor {
  /**
   * Audit a state diff and return enriched analysis
   * All 5 dimensions computed synchronously from existing data
   */
  static audit(
    diff: StateDiff,
    snapshotBefore: LiteSnapshot,
    snapshotAfter: LiteSnapshot,
    state: LiteState,
  ): StateDriftAuditResult {
    const start = Date.now();

    const confidence = StateDriftAuditor.computeConfidence(diff, snapshotAfter);
    const attribution = StateDriftAuditor.computeAttribution(diff);
    const repetition = StateDriftAuditor.computeRepetition(state);
    const anomalies = StateDriftAuditor.computeAnomalies(diff, snapshotBefore, state);
    const diffQuality = StateDriftAuditor.computeDiffQuality(snapshotAfter);

    const elapsed = Date.now() - start;
    logger.debug('[STATE_DRIFT_AUDITOR] Audit complete', {
      confidence: confidence.score,
      loopDetected: repetition.loopDetected,
      anomalyCount: anomalies.flickeringElements.length + anomalies.lostFormFields.length,
      elapsed: `${elapsed}ms`,
    });

    return { confidence, attribution, repetition, anomalies, diffQuality };
  }

  /**
   * Dimension 1: Confidence Scoring
   * How reliable is this diff?
   */
  private static computeConfidence(diff: StateDiff, snapshotAfter: LiteSnapshot): DriftConfidence {
    let score = 1.0;
    const degradationReasons: string[] = [];

    // Degrade for loading indicators
    if (snapshotAfter.transientState?.isTransient) {
      score -= 0.2;
      degradationReasons.push('loading indicator detected');
    }

    // Degrade for few visible elements (might be mid-load)
    const visibleElements = snapshotAfter.elements.filter(el => el.visible);
    if (visibleElements.length < 5) {
      score -= 0.15;
      degradationReasons.push(`only ${visibleElements.length} visible elements`);
    }

    // Degrade for gray-zone elements (elements without clear role)
    const grayZoneCount = snapshotAfter.elements.filter(
      el => el.visible && !el.role && el.tag === 'div'
    ).length;
    if (grayZoneCount > 10) {
      score -= 0.1;
      degradationReasons.push(`${grayZoneCount} gray-zone elements`);
    }

    // Degrade for network errors (state may be inconsistent)
    if (diff.newNetworkErrors && diff.newNetworkErrors.length > 0) {
      score -= 0.1;
      degradationReasons.push('network errors detected');
    }

    // Boost for URL change (strong signal)
    if (diff.urlChanged) {
      score = Math.min(1.0, score + 0.1);
    }

    score = Math.max(0, Math.min(1.0, score));

    let suggestedBehavior: 'conservative' | 'normal' | 'aggressive';
    if (score >= 0.7) {
      suggestedBehavior = 'normal';
    } else if (score >= 0.4) {
      suggestedBehavior = 'conservative';
    } else {
      suggestedBehavior = 'aggressive'; // Low confidence → try bold actions
    }

    return { score, suggestedBehavior, degradationReasons };
  }

  /**
   * Dimension 2: Change Attribution
   * WHY did we assess progress this way?
   */
  private static computeAttribution(diff: StateDiff): ChangeAttribution {
    const contributors: Array<{ factor: string; percentage: number }> = [];
    let totalWeight = 0;

    // URL change
    if (diff.urlChanged) {
      const urlWeight = 50;
      contributors.push({ factor: `URL→${StateDriftAuditor.shortenUrl(diff.urlAfter)}`, percentage: urlWeight });
      totalWeight += urlWeight;
    }

    // New form elements
    const newForms = diff.addedElements.filter(
      el => el.tag === 'form' || el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select'
    );
    if (newForms.length > 0) {
      const formWeight = 30;
      const formName = newForms[0]?.name || newForms[0]?.tag || 'form';
      contributors.push({ factor: `new form "${formName}"`, percentage: formWeight });
      totalWeight += formWeight;
    }

    // API success
    if (diff.successfulApiResponses && diff.successfulApiResponses.length > 0) {
      const apiWeight = 20;
      contributors.push({ factor: 'API success', percentage: apiWeight });
      totalWeight += apiWeight;
    }

    // DOM changes
    const domChanges = diff.addedElements.length + diff.removedRefs.length + diff.changedElements.length;
    if (domChanges > 0 && totalWeight < 100) {
      const domWeight = Math.min(30, 100 - totalWeight);
      contributors.push({ factor: `${domChanges} DOM changes`, percentage: domWeight });
      totalWeight += domWeight;
    }

    // Errors (negative)
    const errorCount = diff.newPageErrors.length + diff.newConsoleErrors.length;
    if (errorCount > 0) {
      const errorWeight = -10 * errorCount;
      contributors.push({ factor: `${errorCount} errors`, percentage: errorWeight });
      totalWeight += errorWeight;
    }

    // Normalize to 100% (handle zero/negative totalWeight from error-only scenarios)
    const absTotal = contributors.reduce((sum, c) => sum + Math.abs(c.percentage), 0);
    if (absTotal > 0 && absTotal !== 100) {
      const scale = 100 / absTotal;
      for (const c of contributors) {
        c.percentage = Math.round(c.percentage * scale);
      }
    }

    // Sort by absolute percentage descending
    contributors.sort((a, b) => Math.abs(b.percentage) - Math.abs(a.percentage));

    // Build summary from top 3
    const top3 = contributors.slice(0, 3);
    const summary = top3.map(c => `${Math.abs(c.percentage)}% ${c.factor}`).join(', ');

    return { contributors: top3, summary };
  }

  /**
   * Dimension 3: Repetition Detection
   * Historical patterns — loops and repeated errors
   */
  private static computeRepetition(state: LiteState): RepetitionDetection {
    let loopDetected = false;
    let loopDescription: string | undefined;
    const urlVisitCounts: Record<string, number> = {};
    const repeatedErrors: Array<{ message: string; count: number }> = [];

    // Check URL visit counts for loops
    const visitCounts = state.getUrlVisitCounts();
    for (const [path, count] of visitCounts) {
      if (count >= 4) {
        loopDetected = true;
        loopDescription = `${path} visited ${count} times — possible navigation loop`;
        urlVisitCounts[path] = count;
      }
    }

    // Check error repetition
    const errorCounts = state.getErrorOccurrenceCounts();
    for (const [msg, count] of errorCounts) {
      if (count >= 3) {
        repeatedErrors.push({ message: msg, count });
      }
    }

    return { loopDetected, loopDescription, urlVisitCounts, repeatedErrors };
  }

  /**
   * Dimension 4: Anomaly Detection
   * Unusual changes — flickering, lost fields, error trends
   */
  private static computeAnomalies(
    diff: StateDiff,
    snapshotBefore: LiteSnapshot,
    state: LiteState,
  ): AnomalyDetection {
    const flickeringElements: string[] = [];
    const lostFormFields: string[] = [];

    // Flicker detection: element present in iteration N, absent in N+1, present in N+2
    const refSets = state.getRecentElementRefSets();
    if (refSets.length >= 3) {
      const current = refSets[refSets.length - 1];
      const previous = refSets[refSets.length - 2];
      const beforePrevious = refSets[refSets.length - 3];

      for (const ref of current) {
        if (!previous.has(ref) && beforePrevious.has(ref)) {
          flickeringElements.push(ref);
        }
      }
    }

    // Lost form fields: inputs/selects/textareas removed
    const formFieldTags = new Set(['input', 'select', 'textarea']);
    for (const removedRef of diff.removedRefs) {
      const element = snapshotBefore.elements.find(el => el.ref === removedRef);
      if (element && formFieldTags.has(element.tag)) {
        const name = element.name || element.placeholder || element.ref;
        lostFormFields.push(name);
      }
    }

    // Error trend
    const errorHistory = state.getErrorCountHistory();
    let errorTrend: 'increasing' | 'decreasing' | 'stable' = 'stable';
    if (errorHistory.length >= 3) {
      const recent = errorHistory.slice(-3);
      if (recent[2] > recent[1] && recent[1] > recent[0]) {
        errorTrend = 'increasing';
      } else if (recent[2] < recent[1] && recent[1] < recent[0]) {
        errorTrend = 'decreasing';
      }
    }

    return { flickeringElements: flickeringElements.slice(0, 5), lostFormFields, errorTrend };
  }

  /**
   * Dimension 5: Diff Quality Metrics
   * Is the diff itself reliable?
   */
  private static computeDiffQuality(snapshotAfter: LiteSnapshot): DiffQualityMetrics {
    const loadingDetected = snapshotAfter.transientState?.isTransient || false;

    // Pending network requests — check for loading text signals
    const pendingNetworkRequests = snapshotAfter.elements.some(
      el => el.visible && /loading|spinner|please wait/i.test(el.name)
    );

    // Gray zone elements — visible divs without clear role
    const grayZoneElementCount = snapshotAfter.elements.filter(
      el => el.visible && !el.role && el.tag === 'div'
    ).length;

    return { loadingDetected, pendingNetworkRequests, grayZoneElementCount };
  }

  /**
   * Shorten a URL for display
   */
  private static shortenUrl(url: string): string {
    try {
      const urlObj = new URL(url);
      return urlObj.pathname.slice(0, 40);
    } catch {
      return url.slice(0, 40);
    }
  }
}
