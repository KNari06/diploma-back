/**
 * Regression Doctor — evidence collection.
 *
 * Turns a finished regression run into a list of "this step of this test case
 * broke, and here is everything we know about it". Deterministic: no LLM, no
 * classifier verdict, no cross-test grouping. Anything ambiguous is dropped
 * with a logged reason rather than guessed at — a wrong finding costs more
 * trust than a missing one.
 *
 * Two traps this file exists to handle:
 *
 *  1. **The evidence is written after the job is enqueued.** The run completion
 *     hook fires from inside the job's `try`; `TestExecutedStepsRedisService
 *     .finalizeToDb` drains Redis → Postgres in the `finally`. Reading
 *     `tests.executed_steps` immediately can legitimately return nothing. Same
 *     race that `services/kb/auto-learn.service.ts:327` already retries around.
 *
 *  2. **A runtime step id is not always an authored step id.** Resource
 *     prologue steps are injected by the mobile job and have no counterpart in
 *     `steps_json`; inlined preconditions are rewritten to `pre_<src>_<id>`;
 *     linked test cases to `link_<tc>_<id>` — and linking runs on mobile. Only
 *     an exact `steps_json[].id` match is accepted. There is deliberately NO
 *     positional fallback: an index from one test case addresses a different
 *     step in another, so "close enough" here means patching the wrong step.
 */

import { logger } from '@/utils/core/logger';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { FailedStepEvidence } from './types';
import {
  getAiSummaries,
  getExecutedSteps,
  getFailedTestIdsForRun,
  getTestCasesByIds,
  getTestsByIds,
  type TestCaseRow,
  type TestRunRow,
} from './db/regression-doctor.db';

/**
 * Retry schedule for the finalize race. Total worst case ~6s, matching the
 * precedent in auto-learn — well inside the job's budget and invisible to the
 * user, who is watching a run that just finished.
 */
const EVIDENCE_RETRY_DELAYS_MS = [2000, 4000];

/** Steps of context handed to the agent before the failing one. */
const PRECEDING_STEP_COUNT = 2;

/** Why a failed test produced no evidence. Logged, and surfaced in the job result. */
export type SkipReason =
  | 'no_test_run'            // execution failed before a `tests` row existed at all
  | 'no_executed_steps'      // run died before/at setup, or the trace never landed
  | 'no_failed_step'         // trace exists but no step is marked failed
  | 'no_test_case'           // ad-hoc run with no authored test case behind it
  | 'test_case_missing'      // the case was deleted between run and analysis
  | 'negative_test'          // fails by design; regenerated wholesale
  | 'no_steps_json'          // authored case has no steps to patch
  | 'injected_step'          // prologue / precondition / linked-case step
  | 'step_not_in_test_case'; // id doesn't resolve — never guess by position

export interface CollectionSkip {
  testId: string;
  testCaseId: string | null;
  reason: SkipReason;
  detail?: string;
}

export interface CollectionResult {
  evidence: FailedStepEvidence[];
  skipped: CollectionSkip[];
}

/** Shape of one `step_completed` entry inside `tests.executed_steps`. */
interface StepEvent {
  type?: string;
  data?: {
    step?: number;
    action?: string;
    success?: boolean;
    stepDescription?: string;
    runtimeMeta?: {
      stepId?: string;
      runtimeStatus?: string;
      failedReason?: string;
      failureExplanation?: string;
      stepScreenshotUrl?: string;
      scratchpadSnapshot?: { current_app?: string };
    };
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export interface CollectOptions {
  /**
   * Seam for tests: the retry schedule below is real wall-clock time, and a
   * suite that exercises the "trace never arrived" path should not spend six
   * seconds proving it. Production always uses the default.
   */
  sleep?: (ms: number) => Promise<void>;
}

export async function collectFailedSteps(
  runId: string,
  options: CollectOptions = {},
): Promise<CollectionResult> {
  const allFailed = await getFailedTestIdsForRun(runId);
  if (allFailed.length === 0) {
    return { evidence: [], skipped: [] };
  }

  const skipped: CollectionSkip[] = [];

  // An execution with no `testId` never produced a `tests` row — a test case
  // saved with no steps, or a validation error before dispatch. There is no
  // trace to read and nothing to fix, but it IS a failure the user can see in
  // the report, so it is accounted for rather than dropped silently: without
  // this the run's failed count could never be reconciled with what the panel
  // explained.
  const failedExecutions = allFailed.filter((e) => Boolean(e.testId));
  for (const e of allFailed) {
    if (!e.testId) {
      skipped.push({
        testId: '',
        testCaseId: e.testCaseId,
        reason: 'no_test_run',
        detail: e.errorMessage ?? undefined,
      });
    }
  }

  const testIds = failedExecutions.map((e) => e.testId);
  const tests = failedExecutions.length
    ? await withEvidenceRetry(testIds, runId, options.sleep ?? sleep)
    : [];

  // `test_executions` is what carries the run → authored-case link; `tests`
  // has no reference back to `intent_test_cases` at all.
  const executionByTestId = new Map(failedExecutions.map((e) => [e.testId, e] as const));

  // Resolve the authored test cases in one batch — never per test (N+1).
  const testCaseIds = Array.from(
    new Set(
      failedExecutions.map((e) => e.testCaseId).filter((id): id is string => Boolean(id)),
    ),
  );
  const testCases = new Map(
    (await getTestCasesByIds(testCaseIds)).map((tc) => [tc.id, tc] as const),
  );

  const aiSummaries = await getAiSummaries(testIds).catch(() => new Map());

  const evidence: FailedStepEvidence[] = [];

  for (const test of tests) {
    const execution = executionByTestId.get(test.id);
    const testCaseId = execution?.testCaseId ?? null;
    const skip = (reason: SkipReason, detail?: string) => {
      skipped.push({ testId: test.id, testCaseId, reason, detail });
    };

    if (!testCaseId) {
      skip('no_test_case');
      continue;
    }

    const testCase = testCases.get(testCaseId);
    if (!testCase) {
      skip('test_case_missing');
      continue;
    }
    // Negatives fail on purpose — they assert that bad input IS rejected — and
    // any patch is wiped by the next regeneration of the source.
    if (testCase.is_negative) {
      skip('negative_test');
      continue;
    }

    const steps = Array.isArray(testCase.steps_json) ? testCase.steps_json : [];
    if (steps.length === 0) {
      skip('no_steps_json');
      continue;
    }

    const events = toStepEvents(test.executed_steps);
    if (events.length === 0) {
      // The common shape: the run died acquiring a session, installing the app,
      // or compiling resources — before any step ran. There is no step to fix.
      skip('no_executed_steps', execution?.errorMessage ?? undefined);
      continue;
    }

    const failure = findFirstFailure(events);
    if (!failure) {
      skip('no_failed_step');
      continue;
    }

    const runtimeStepId = failure.event.data?.runtimeMeta?.stepId;
    if (!runtimeStepId) {
      skip('step_not_in_test_case', 'runtime step carried no stepId');
      continue;
    }
    if (isInjectedStepId(runtimeStepId)) {
      skip('injected_step', runtimeStepId);
      continue;
    }

    const stepIndex = steps.findIndex((s) => s?.id === runtimeStepId);
    if (stepIndex < 0) {
      skip('step_not_in_test_case', runtimeStepId);
      continue;
    }

    const meta = failure.event.data?.runtimeMeta ?? {};
    const summary = aiSummaries.get(test.id);

    evidence.push({
      testId: test.id,
      testCaseId: testCase.id,
      testCaseName: testCase.name ?? 'Untitled test case',
      platform: testCase.platform ?? 'web',
      projectId: testCase.project_id ?? '',
      step: steps[stepIndex] as IntentStep,
      stepId: runtimeStepId,
      stepIndex,
      precedingSteps: steps.slice(Math.max(0, stepIndex - PRECEDING_STEP_COUNT), stepIndex),
      followingStep: stepIndex + 1 < steps.length ? (steps[stepIndex + 1] as IntentStep) : null,
      action: failure.event.data?.action,
      failedReason: meta.failedReason,
      failureExplanation: meta.failureExplanation,
      failScreenshotUrl: meta.stepScreenshotUrl,
      priorScreenshotUrl: failure.priorScreenshotUrl,
      currentApp: meta.scratchpadSnapshot?.current_app,
      aiClassification: summary?.classification ?? null,
      aiSummary: summary?.summary ?? null,
    });
  }

  if (skipped.length > 0) {
    logger.info('[REGRESSION_DOCTOR] Some failed tests produced no evidence', {
      runId,
      skipped: skipped.map((s) => ({ testId: s.testId, reason: s.reason })),
    });
  }

  return { evidence, skipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// The finalize race
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Load the tests, then re-poll only those whose `executed_steps` is still empty.
 *
 * Re-polling only the empty ones matters: a run of 10 tests where one genuinely
 * died at setup must not cost three full round-trips for the other nine.
 * A test that is still empty after the last attempt is reported as-is — some
 * failures really do have no steps (see `no_executed_steps`).
 */
async function withEvidenceRetry(
  testIds: string[],
  runId: string,
  wait: (ms: number) => Promise<void>,
): Promise<TestRunRow[]> {
  const tests = await getTestsByIds(testIds);

  for (const delay of EVIDENCE_RETRY_DELAYS_MS) {
    const pending = tests.filter((t) => toStepEvents(t.executed_steps).length === 0);
    if (pending.length === 0) break;

    logger.debug('[REGRESSION_DOCTOR] Waiting for executed_steps to land', {
      runId,
      pendingTests: pending.length,
      delayMs: delay,
    });
    await wait(delay);

    for (const test of pending) {
      const refreshed = await getExecutedSteps(test.id);
      if (toStepEvents(refreshed).length > 0) {
        test.executed_steps = refreshed;
      }
    }
  }

  return tests;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─────────────────────────────────────────────────────────────────────────────
// Trace parsing
// ─────────────────────────────────────────────────────────────────────────────

function toStepEvents(raw: unknown): StepEvent[] {
  if (!Array.isArray(raw)) return [];
  return (raw as StepEvent[]).filter(
    (e) => e && typeof e === 'object' && e.type === 'step_completed' && e.data,
  );
}

/**
 * The FIRST failed step, plus the screenshot of the last step that succeeded
 * before it.
 *
 * First, not last: once a step fails, everything after it is usually failing
 * for a downstream reason (wrong screen, missing state). The first failure is
 * the one worth diagnosing, and fixing it is what unblocks the rest.
 */
function findFirstFailure(
  events: StepEvent[],
): { event: StepEvent; priorScreenshotUrl?: string } | null {
  let priorScreenshotUrl: string | undefined;

  for (const event of events) {
    const data = event.data!;
    const failed = data.success === false || data.runtimeMeta?.runtimeStatus === 'failed';
    if (failed) {
      return { event, priorScreenshotUrl };
    }
    if (data.runtimeMeta?.stepScreenshotUrl) {
      priorScreenshotUrl = data.runtimeMeta.stepScreenshotUrl;
    }
  }

  return null;
}

/**
 * Runtime ids the backend rewrites or injects, which therefore cannot address
 * a step in the target's own `steps_json`.
 *
 *   `pre_<sourceTestCaseId>_<originalStepId>`   inlined precondition (web)
 *   `link_<linkedTestCaseId>_<originalStepId>`  linked test case (runs on mobile)
 *
 * Both belong to a DIFFERENT test case. Patching them would mean editing a
 * case the user did not run, so they are skipped rather than redirected —
 * following the chain is a feature, not a silent side effect.
 *
 * Resource-prologue steps (login / install / permissions, prepended by
 * `mobile-test-run.job.ts`) carry runner-side ids that simply won't be found in
 * `steps_json`; they fall out at the id lookup.
 */
function isInjectedStepId(stepId: string): boolean {
  return stepId.startsWith('pre_') || stepId.startsWith('link_');
}

/** @internal — exported for unit tests only. */
export const __testing = { findFirstFailure, isInjectedStepId, toStepEvents };
