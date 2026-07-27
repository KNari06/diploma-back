/**
 * Honest QA status — pure derivation (no I/O, no LLM, no supabase).
 *
 * Separates "couldn't run" from "nothing to run" instead of collapsing both into
 * a vague pass/fail. Same discipline as release-verdict.util.ts: a versioned,
 * side-effect-free function that derives a higher-level status from data the
 * caller already has. NEVER widens the hot-path execution-status DB constraints.
 *
 * Status is derived TWICE across a task's lifecycle:
 *  - assess-time (before any run): from readiness + triage → ready | blocked
 *  - post-run: from real execution stats → ready | empty | skipped | blocked
 */

import type { JiraQaOutcome, QaHandoffStatus, TaskReadinessAssessment } from '@/types/testing.types';

export const HONEST_STATUS_RULESET_VERSION = 1;

export interface HonestStatusResult {
  status: QaHandoffStatus;
  reasonCode: string;
  reason: string;
}

/**
 * ASSESS-TIME status: before any run exists. Sourced from the readiness
 * assessment + triage outcome. Only `ready` or `blocked` are reachable here
 * (empty/skipped need real execution results; in_progress/done are set later).
 */
export function deriveHonestStatusFromReadiness(
  readiness: TaskReadinessAssessment | undefined,
  outcome: JiraQaOutcome,
): HonestStatusResult {
  if (outcome === 'NEEDS_REWORK' || (readiness && !readiness.readyToTest)) {
    return {
      status: 'blocked',
      reasonCode: 'READINESS_NOT_READY',
      reason: readiness?.summary || 'Task is not ready to test.',
    };
  }
  return {
    status: 'ready',
    reasonCode: 'READY',
    reason: readiness?.summary || 'Ready to test.',
  };
}

/**
 * POST-RUN status: maps real execution stats → honest status.
 *  - empty:   nothing to test (no executions / empty test set).
 *  - blocked: setup/environment failure, or one-plus executions failed.
 *  - skipped: all executions skipped (none actually ran).
 *  - ready:   everything passed.
 */
export function deriveHonestStatusFromRun(input: {
  totalExecutions: number;
  passed: number;
  failed: number;
  skipped: number;
  setupFailure?: boolean;
  emptyTestSet?: boolean;
}): HonestStatusResult {
  if (input.emptyTestSet || input.totalExecutions === 0) {
    return {
      status: 'empty',
      reasonCode: 'EMPTY_TEST_SET',
      reason: 'Nothing to test — no matching test cases or runnable steps.',
    };
  }
  if (input.setupFailure) {
    return {
      status: 'blocked',
      reasonCode: 'SETUP_FAILURE',
      reason: 'Test could not start (setup / environment failure).',
    };
  }
  if (input.passed === 0 && input.skipped === input.totalExecutions) {
    return {
      status: 'skipped',
      reasonCode: 'ALL_SKIPPED',
      reason: 'All executions were skipped.',
    };
  }
  if (input.failed > 0) {
    return {
      status: 'blocked',
      reasonCode: 'EXECUTION_FAILED',
      reason: `${input.failed}/${input.totalExecutions} execution(s) failed.`,
    };
  }
  return {
    status: 'ready',
    reasonCode: 'PASSED',
    reason: 'All executions passed.',
  };
}
