/**
 * Regression Doctor — grouping logic
 *
 * Pure, deterministic, no DB / no LLM — easy to unit-test in isolation.
 *
 * The Doctor handler fetches every failed test_result in a regression run,
 * filters by `ai_summary.failureClassification === 'test_drift'`, and
 * passes the resulting list here. We bucket them by `patternKey` (a
 * deterministic hash of the three drift-signal primitives) so that one
 * product change affecting 15 tests collapses into one group, not 15.
 *
 * Why SHA-1 and not SHA-256 / MD5 / base64-JSON:
 *   • SHA-1 hex (40 chars) is short enough to store in a TEXT column
 *     without blowing up indexes. Cryptographic strength is irrelevant —
 *     we're bucketing, not authenticating.
 *   • `base64(JSON.stringify(...))` would work too but reads worse in
 *     logs and varies with key ordering. Hex hash is stable.
 */

import { createHash } from 'crypto';
import type { DriftSignals } from '@/types';

/**
 * Minimal shape the grouping logic needs per failure.
 * Kept narrow so unit tests don't need to construct a full TestResult row.
 */
export interface DriftFailureInput {
  /** test_results row id */
  testResultId: string;
  /** tests.id of the underlying test */
  testId: string;
  /** intent_test_cases.id (the authored test case) — may be null for ad-hoc runs */
  testCaseId: string | null;
  driftSignals: DriftSignals;
}

export interface DriftGroup {
  patternKey: string;
  urlPattern: string;
  targetElementKey: string;
  errorShape: DriftSignals['errorShape'];
  /** Every failure that matched this pattern in the run. */
  failures: DriftFailureInput[];
}

/**
 * Compute the stable pattern key for a single driftSignals object.
 *
 * Exported so the handler can recompute the key in other contexts
 * (e.g. "has this exact pattern been seen in a previous run of this
 * project?" lookups against regression_doctor_findings.pattern_key).
 *
 * Format: `sha1("<urlPattern>\u0000<targetElementKey>\u0000<errorShape>")` hex.
 * Uses the NUL byte (`\u0000`) as the separator because it's legal in a
 * JavaScript string but can NEVER appear in a URL, element key, or our
 * errorShape enum — so the three-field boundary is unambiguous and
 * cross-field bleed (`"a||b"+"c"` vs `"a"+"||b||c"`) is impossible.
 */
export function computePatternKey(signals: DriftSignals): string {
  // Normalize whitespace in element key — the LLM sometimes returns
  // trailing spaces from JSON parsing; "button:Submit" and
  // "button:Submit " are the SAME pattern and must hash identically.
  const SEP = '\u0000';
  const canonical = [
    signals.urlPattern.trim(),
    signals.targetElementKey.trim(),
    signals.errorShape,
  ].join(SEP);
  return createHash('sha1').update(canonical).digest('hex');
}

/**
 * Bucket drift failures by patternKey.
 *
 * Stable order: groups are returned sorted by failure count DESC (biggest
 * impact first) and then by patternKey (alphabetical) for determinism.
 * Two runs with the same inputs produce the same group order — important
 * for snapshot-style tests.
 */
export function groupByPattern(failures: DriftFailureInput[]): DriftGroup[] {
  const buckets = new Map<string, DriftGroup>();

  for (const f of failures) {
    const key = computePatternKey(f.driftSignals);
    const existing = buckets.get(key);
    if (existing) {
      existing.failures.push(f);
      continue;
    }
    buckets.set(key, {
      patternKey: key,
      urlPattern: f.driftSignals.urlPattern.trim(),
      targetElementKey: f.driftSignals.targetElementKey.trim(),
      errorShape: f.driftSignals.errorShape,
      failures: [f],
    });
  }

  return Array.from(buckets.values()).sort((a, b) => {
    // Biggest groups first — they're the most impactful patterns.
    if (a.failures.length !== b.failures.length) {
      return b.failures.length - a.failures.length;
    }
    return a.patternKey.localeCompare(b.patternKey);
  });
}
