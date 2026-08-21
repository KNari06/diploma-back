/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression Doctor — Apply service
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Applies a finding's proposed patch to the test case it came from (or, when
 * the caller passes a subset, to the affected cases it selected), writing a
 * pre-apply snapshot per test so the change is auditable and revertible.
 *
 * The patch itself is built in `patch-applier.ts`; this file owns persistence:
 *
 *  1. **Only `test_fix` findings are appliable.** `app_bug` and `unclear`
 *     carry no patch by construction, and refusing them here means a stale
 *     client that still shows an Apply button gets a 409 instead of a no-op.
 *
 *  2. **The step is located by id, never by position** — see
 *     `locateStepById`. A miss is a skip with a reason, not a guess.
 *
 *  3. **Optimistic concurrency via `updated_at`.** We snapshot `updated_at` at
 *     read time and gate the write on it. If the user edited the case in
 *     between, the write hits 0 rows and we skip with `concurrent_edit` rather
 *     than overwriting their work.
 *
 *  4. **Per-test-case failure isolation.** Each case is processed inside its
 *     own try/catch, so an RLS deny or a missing row on one never blocks the
 *     rest. The return shape carries per-test status for a mixed summary.
 *
 *  5. **The finding flips to `applied` iff at least one case was patched.** All
 *     skipped (e.g. every case concurrently edited) leaves it `open` to retry.
 *
 *  6. **Steps are written directly, not through `IntentTestCaseService`** —
 *     deliberately, because that service's V16 merge would re-hydrate the
 *     `compiled` plan the patch just dropped. The side effects that write path
 *     normally performs are reproduced here: negatives are marked stale and the
 *     flow-tree cache is invalidated.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import {
  getFindingForApply,
  getTestCaseForApply,
  insertApplySnapshot,
  markFindingApplied,
  updateStepsJsonIfUnchanged,
  deleteApplySnapshot,
  markNegativesStaleForTestCase,
  type FindingForApplyRow,
} from './db/regression-doctor-apply.db';
import {
  applyStepPatch,
  StepNotFoundError,
  UnsupportedPatchError,
} from './patch-applier';
import type { StepPatch } from './types';
import { canActOnDoctorRow } from './doctor-access.service';

// Per-test-case in-memory mutex — same pattern as intent-test-case.service.ts.
// Exported so the revert service reuses the SAME map: an Apply and a Revert on
// one test case must serialise, not race.
const applyMutexes = new Map<string, Promise<void>>();

/** @internal — exported for the revert service. */
export function withTestCaseMutex<T>(testCaseId: string, fn: () => Promise<T>): Promise<T> {
  const prev = applyMutexes.get(testCaseId) || Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  applyMutexes.set(testCaseId, next);
  return prev.then(fn).finally(() => {
    resolve!();
    if (applyMutexes.get(testCaseId) === next) {
      applyMutexes.delete(testCaseId);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface ApplyFindingInput {
  findingId: string;
  userId: string;
  /**
   * Optional subset of test case ids. When omitted we use the finding's
   * `affected_test_ids`. When provided, the server intersects with that list —
   * unknown ids are dropped silently so stale client state cannot reach an
   * unrelated test.
   */
  testCaseIds?: string[];
}

export type PerTestOutcome =
  | { testCaseId: string; status: 'applied'; snapshotId: string; changeDescription: string }
  | { testCaseId: string; status: 'skipped'; reason: SkipReason }
  | { testCaseId: string; status: 'error'; message: string };

export type SkipReason =
  | 'concurrent_edit'       // updated_at changed between read and write
  | 'test_case_missing'     // row not found
  | 'access_denied'         // not the owner and not a member of the project's workspace
  | 'no_step_matched'       // the finding's step id is not in this test case
  | 'patch_not_applicable'  // e.g. assertion patch on a non-ai_check step
  | 'already_patched';      // resulting steps are byte-identical

export interface ApplyFindingResult {
  findingId: string;
  proposedPatch: StepPatch;
  totalRequested: number;
  results: PerTestOutcome[];
  findingStatus: 'open' | 'applied';
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function applyDoctorFinding(input: ApplyFindingInput): Promise<ApplyFindingResult> {
  const { findingId, userId, testCaseIds } = input;

  // ─── 1. Load + validate the finding ───────────────────────────────────────
  const finding = await getFindingForApply(findingId);

  if (!finding) {
    throw new ApplyNotFoundError('Finding not found');
  }
  if (!(await canActOnDoctorRow(finding, userId))) {
    throw new ApplyAccessError('Finding not accessible to user');
  }
  if (finding.status !== 'open') {
    throw new ApplyConflictError(`Finding is ${finding.status}`);
  }
  // A finding that blames the application has no patch, and must not acquire
  // one: applying "a fix" to a real bug is how the bug stops being reported.
  if (finding.verdict && finding.verdict !== 'test_fix') {
    throw new ApplyConflictError(`Finding verdict is ${finding.verdict} — nothing to apply`);
  }
  if (!finding.proposed_patch) {
    throw new ApplyConflictError('Finding has no proposed patch');
  }
  if (!finding.step_id) {
    throw new ApplyConflictError('Finding does not identify a step to patch');
  }

  const patch = finding.proposed_patch as StepPatch;
  const affectedIds = resolveAffectedIds(finding);

  if (affectedIds.length === 0) {
    throw new ApplyConflictError('Finding has no affected test cases');
  }

  const affectedSet = new Set(affectedIds);
  const requestedIds =
    Array.isArray(testCaseIds) && testCaseIds.length > 0
      ? testCaseIds.filter((id) => affectedSet.has(id))
      : affectedIds;

  if (requestedIds.length === 0) {
    throw new ApplyConflictError('No test cases selected for apply');
  }

  // ─── 2. Process each test case ────────────────────────────────────────────
  // Sequential on purpose: the bulk apply is not on a hot path, and serialising
  // keeps error messages attributable to the test that produced them.
  const results: PerTestOutcome[] = [];

  for (const testCaseId of requestedIds) {
    try {
      const outcome = await withTestCaseMutex(testCaseId, () =>
        applyToOneTestCase({
          testCaseId,
          userId,
          findingId,
          stepId: finding.step_id!,
          patch,
        }),
      );
      results.push(outcome);
    } catch (err) {
      logger.warn('[DOCTOR_APPLY] Per-test failure (non-fatal)', {
        findingId,
        testCaseId,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({
        testCaseId,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ─── 3. Flip finding state iff at least one apply succeeded ───────────────
  const anyApplied = results.some((r) => r.status === 'applied');
  let findingStatus: 'open' | 'applied' = 'open';

  if (anyApplied) {
    const { written, error } = await markFindingApplied({ findingId, userId });
    if (error) {
      logger.error('[DOCTOR_APPLY] Failed to mark finding applied', { findingId, error });
      // Not fatal — the patches are in place. The next apply/dismiss attempt
      // surfaces the stale state via the `status !== open` check.
    } else if (written === 0) {
      // A concurrent request flipped it first. The patches landed either way,
      // but this request did not perform the transition, so it must not claim
      // it did.
      logger.info('[DOCTOR_APPLY] Finding was already flipped by a concurrent apply', {
        findingId,
      });
    } else {
      findingStatus = 'applied';
    }
  }

  return {
    findingId,
    proposedPatch: patch,
    totalRequested: requestedIds.length,
    results,
    findingStatus,
  };
}

/**
 * The authoritative apply list.
 *
 * `affected_test_ids` is the column the UI's subset selection is validated
 * against. `test_case_id` is where the evidence came from and is always part of
 * the list — a finding written before the column existed, or one whose array
 * was never populated, must still be appliable to its own test case.
 *
 * **Fan-out beyond that one case does not work yet, by construction.** The
 * patch is located by `step_id`, and a step id belongs to exactly one test
 * case, so every extra id here resolves to `no_step_matched`. Today the writer
 * only ever stores the evidence's own case, so nothing is broken; whoever
 * widens this (the cross-test dedupe) has to give the finding a way to address
 * the equivalent step in another case first.
 */
function resolveAffectedIds(finding: FindingForApplyRow): string[] {
  const ids = new Set<string>(
    Array.isArray(finding.affected_test_ids) ? finding.affected_test_ids : [],
  );
  if (finding.test_case_id) ids.add(finding.test_case_id);
  return Array.from(ids);
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-test-case work unit
// ─────────────────────────────────────────────────────────────────────────────

async function applyToOneTestCase(params: {
  testCaseId: string;
  userId: string;
  findingId: string;
  stepId: string;
  patch: StepPatch;
}): Promise<PerTestOutcome> {
  const { testCaseId, userId, findingId, stepId, patch } = params;

  // ── Load ──────────────────────────────────────────────────────────────────
  const { row, error: readErr } = await getTestCaseForApply(testCaseId);

  if (readErr) {
    return { testCaseId, status: 'error', message: `read failed: ${readErr}` };
  }
  if (!row) {
    return { testCaseId, status: 'skipped', reason: 'test_case_missing' };
  }
  if (!(await canActOnDoctorRow(row, userId))) {
    return { testCaseId, status: 'skipped', reason: 'access_denied' };
  }

  const before = Array.isArray(row.steps_json) ? (row.steps_json as IntentStep[]) : [];
  const beforeUpdatedAt = row.updated_at;

  // ── Build the patched array ───────────────────────────────────────────────
  let after: IntentStep[];
  let changeDescription: string;
  try {
    const result = applyStepPatch(before, stepId, patch);
    after = result.steps;
    changeDescription = result.description;
  } catch (err) {
    if (err instanceof StepNotFoundError) {
      return { testCaseId, status: 'skipped', reason: 'no_step_matched' };
    }
    if (err instanceof UnsupportedPatchError) {
      logger.warn('[DOCTOR_APPLY] Patch not applicable to this test case', {
        findingId,
        testCaseId,
        reason: err.message,
      });
      return { testCaseId, status: 'skipped', reason: 'patch_not_applicable' };
    }
    throw err;
  }

  // No-op detection: this patch is already present. Reporting it as skipped
  // avoids writing a meaningless snapshot and bumping `updated_at`.
  if (JSON.stringify(after) === JSON.stringify(before)) {
    return { testCaseId, status: 'skipped', reason: 'already_patched' };
  }

  // ── Snapshot first, so a failed write still leaves an audit trail ─────────
  const { id: snapshotId, error: snapErr } = await insertApplySnapshot({
    finding_id: findingId,
    test_case_id: testCaseId,
    user_id: userId,
    project_id: row.project_id,
    steps_before: before,
    before_updated_at: beforeUpdatedAt,
    steps_after: after,
    change_description: changeDescription,
  });

  if (snapErr || !snapshotId) {
    return { testCaseId, status: 'error', message: `snapshot failed: ${snapErr ?? 'unknown'}` };
  }

  // ── Optimistic write ──────────────────────────────────────────────────────
  const { written, error: updErr } = await updateStepsJsonIfUnchanged({
    testCaseId,
    steps: after,
    expectedUpdatedAt: beforeUpdatedAt,
  });

  if (updErr) {
    return { testCaseId, status: 'error', message: `write failed: ${updErr}` };
  }
  if (written === 0) {
    // Someone updated this row after our read. The snapshot we wrote documents
    // an apply that never happened — drop it so the audit trail stays honest.
    await deleteApplySnapshot(snapshotId);
    return { testCaseId, status: 'skipped', reason: 'concurrent_edit' };
  }

  await runPostWriteSideEffects({ testCaseId, flowId: row.flow_id });

  return { testCaseId, status: 'applied', snapshotId, changeDescription };
}

/**
 * The two side effects every other `steps_json` writer performs.
 *
 * Both are best-effort and neither may fail the apply: the patch has already
 * landed, and a stale cache or an un-marked negative is a smaller problem than
 * telling the user their applied fix errored.
 *
 * - **Negatives:** a negative test is generated by mutating a parent's steps.
 *   Patch the parent without marking them stale and they keep running against
 *   a mutation of the step that no longer exists.
 * - **Flow-tree cache:** the editor's flow view is cached per flow id and would
 *   otherwise serve the pre-patch steps.
 */
async function runPostWriteSideEffects(params: {
  testCaseId: string;
  flowId: string | null;
}): Promise<void> {
  const { testCaseId, flowId } = params;

  const { count, error } = await markNegativesStaleForTestCase(testCaseId).catch((err) => ({
    count: null,
    error: err instanceof Error ? err.message : String(err),
  }));

  if (error) {
    logger.warn('[DOCTOR_APPLY] Failed to mark negatives stale (non-fatal)', { testCaseId, error });
  } else if (count && count > 0) {
    logger.info('[DOCTOR_APPLY] Marked negatives as stale', { testCaseId, staleCount: count });
  }

  if (flowId) {
    await cache
      .delByPattern(`qait:cache:ptree:flow:${flowId}:*`)
      .catch((err: unknown) => {
        logger.warn('[DOCTOR_APPLY] Flow cache invalidation failed (non-fatal)', {
          testCaseId,
          flowId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed errors so the controller can map cleanly to HTTP codes.
// Named `Apply*` to avoid colliding with the common `NotFoundError` exported
// from `@/types` (already imported by the regression controller).
// ─────────────────────────────────────────────────────────────────────────────

export class ApplyNotFoundError extends Error {
  constructor(message: string) { super(message); this.name = 'ApplyNotFoundError'; }
}
export class ApplyAccessError extends Error {
  constructor(message: string) { super(message); this.name = 'ApplyAccessError'; }
}
export class ApplyConflictError extends Error {
  constructor(message: string) { super(message); this.name = 'ApplyConflictError'; }
}
