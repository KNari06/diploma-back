/**
 * Deterministic release-readiness verdict — ADR-0012.
 *
 * Pure function, no I/O, no LLM. The verdict is ALWAYS decided here, never
 * by an LLM — see `release-narrative.service.ts` for the separate, optional
 * LLM layer that explains/prioritizes the reasons this function already
 * computed, without ever being able to override the status itself.
 *
 * `healthSummary.findings[].severity` is `'pass' | 'warning' | 'fail'`
 * (confirmed against `health-check-aggregator.service.ts`'s
 * `buildHealthSummary` switch) — NOT a `.status` field on `HealthSummary`
 * itself and NOT `'critical'` on the finding. Get this wrong and every
 * health-check failure silently stops affecting the verdict.
 *
 * CAUGHT BY LIVE TESTING (2026-07-08), not by unit tests: the first version
 * of this function only looked at AI-detected bugs + health checks. A run
 * whose `regression_runs.status` was 'failed' — with zero AI-detected bugs,
 * because `test_executions` never got populated for that dispatch path —
 * still showed a green "ready to release" banner directly under a red
 * "FAILED" run-status banner on the same page. AI-detected "bugs" are not
 * the same signal as "did the run actually complete/pass" — a real test
 * failure (assertion failure, environment/setup failure) does not always
 * produce an ai_summary bug, so the verdict MUST also look at the run's own
 * outcome, not only at what the bug-detector characterized as a bug.
 */
import type {
  EnrichedBug,
  HealthSummary,
  ReleaseVerdict,
  ReleaseVerdictReason,
  ReleaseVerdictStatus,
  RunReportSummary,
} from '@/types/testing.types';

/**
 * Bump when the rule changes. Persisted alongside `releaseVerdictAtCompletion`
 * so an audit snapshot can be told apart from a live recompute under a newer
 * ruleset (see `release-narrative.service.ts`).
 */
export const RELEASE_VERDICT_RULESET_VERSION = 2;

export function computeReleaseVerdict(
  bugs: EnrichedBug[],
  healthSummary: HealthSummary | undefined,
  runStatus: string,
  summary: RunReportSummary,
): ReleaseVerdict {
  const reasons: ReleaseVerdictReason[] = [];

  const criticalOrHigh = bugs.filter((b) => b.severity === 'critical' || b.severity === 'high');
  for (const bug of criticalOrHigh) {
    reasons.push({
      code: bug.severity === 'critical' ? 'CRITICAL_BUG' : 'HIGH_BUG',
      label: `${bug.severity} bug: ${bug.title}`,
      refType: 'bug',
      refId: bug.id,
    });
  }

  for (const finding of healthSummary?.findings ?? []) {
    if (finding.severity !== 'fail') continue;
    reasons.push({
      code: 'HEALTH_CHECK_FAILED',
      label: finding.message,
      refType: 'health_check',
      refId: finding.category,
    });
  }

  // The run's own outcome — independent of whether the AI bug-detector
  // characterized anything as a "bug". Covers both a normal run with failed
  // executions (summary.failed > 0) AND the degenerate case where the run's
  // terminal status is 'failed'/'cancelled' but summary counts are still
  // zero (e.g. execution stats never got populated for this run) — a run
  // that didn't complete successfully can never be "ready" just because
  // nothing was there to count.
  const runDidNotComplete = runStatus === 'failed' || runStatus === 'cancelled';
  if (summary.failed > 0) {
    reasons.push({
      code: 'TEST_EXECUTION_FAILED',
      label: `${summary.failed} of ${summary.total} test execution(s) failed`,
      refType: 'execution',
      refId: 'run',
    });
  } else if (runDidNotComplete) {
    reasons.push({
      code: 'RUN_DID_NOT_COMPLETE',
      label: `Run status: ${runStatus}`,
      refType: 'execution',
      refId: 'run',
    });
  }

  const hasMediumLow = bugs.some((b) => b.severity === 'medium' || b.severity === 'low');
  const status: ReleaseVerdictStatus =
    reasons.length > 0 ? 'not_ready' : hasMediumLow ? 'ready_with_warnings' : 'ready';

  return { status, rulesetVersion: RELEASE_VERDICT_RULESET_VERSION, reasons };
}

/**
 * Softens (never hardens) a verdict already computed by `computeReleaseVerdict`
 * with a surfaced visual-anomaly finding — ADR-0012's explicit rule: a visual
 * anomaly, even after clearing the cross-run recurrence gate, can only ever
 * push `ready` → `ready_with_warnings`. It can never produce `not_ready` on
 * its own, and it never touches an already-`not_ready` verdict.
 */
export function applyVisualAnomalySoftening(
  verdict: ReleaseVerdict,
  anomalies: Array<{ id: string; category: string; description: string; confidence: number }>,
): ReleaseVerdict {
  const qualifying = anomalies.filter((a) => a.category !== 'other' && a.confidence >= 0.7);
  if (qualifying.length === 0 || verdict.status !== 'ready') return verdict;

  const reasons = [
    ...verdict.reasons,
    ...qualifying.map((a) => ({
      code: 'VISUAL_ANOMALY',
      label: a.description,
      refType: 'visual_anomaly' as const,
      refId: a.id,
    })),
  ];
  return { ...verdict, status: 'ready_with_warnings', reasons };
}
