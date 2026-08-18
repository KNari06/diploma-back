/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression Doctor — Revert service
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Closes the Apply → "changed my mind" → Revert loop. Reads the snapshots
 * written during Apply and restores each test case's `steps_json` to
 * `steps_before` — the exact pre-apply state, byte for byte.
 *
 * Key correctness rules:
 *
 *  1. **Refuse to revert manual edits.** If the user edited a test case AFTER
 *     Apply (current `steps_json` !== `snapshot.steps_after`), restoring
 *     `steps_before` would discard their work. We skip with
 *     `modified_after_apply` and leave it to them.
 *
 *  2. **Optimistic concurrency.** Same `updated_at` gate as apply.
 *
 *  3. **Snapshot cleanup on success.** A reverted snapshot documents an apply
 *     that no longer exists, so the row is deleted. Skipped snapshots stay, so
 *     the audit trail still shows "we tried and couldn't".
 *
 *  4. **Finding state machine.** After revert the finding flips to `'open'` iff
 *     ≥1 test was reverted AND no snapshots remain. A partial revert stays
 *     `'applied'` so the UI can show "some tests are still patched".
 *
 *  5. **Same side effects as apply.** Restoring steps is a `steps_json` write
 *     like any other: negatives derived from this case go stale again, and the
 *     flow-tree cache must be dropped.
 *
 * Shares the per-test-case mutex with apply (imported, not re-declared) so an
 * Apply and a Revert on one test case serialise instead of racing.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { logger } from '@/utils/core/logger';
import { cache } from '@/utils/core/redis-cache';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import {
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
  withTestCaseMutex,
} from './apply.service';
import {
  countSnapshotsForFinding,
  deleteApplySnapshot,
  getFindingForRevert,
  getSnapshotsForFinding,
  getTestCaseForApply,
  markFindingOpen,
  markNegativesStaleForTestCase,
  updateStepsJsonIfUnchanged,
  type SnapshotRow,
} from './db/regression-doctor-apply.db';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RevertFindingInput {
  findingId: string;
  userId: string;
  /**
   * Optional subset of snapshot ids. When omitted, every snapshot attached to
   * the finding is attempted. Unknown ids are dropped by intersection.
   */
  snapshotIds?: string[];
}

export type RevertSkipReason =
  | 'concurrent_edit'       // updated_at changed between read and write
  | 'test_case_missing'     // row not found
  | 'access_denied'         // user doesn't own it
  | 'modified_after_apply'; // current steps_json !== snapshot.steps_after

export type PerSnapshotOutcome =
  | { snapshotId: string; testCaseId: string; status: 'reverted' }
  | { snapshotId: string; testCaseId: string; status: 'skipped'; reason: RevertSkipReason }
  | { snapshotId: string; testCaseId: string; status: 'error'; message: string };

export interface RevertFindingResult {
  findingId: string;
  totalRequested: number;
  results: PerSnapshotOutcome[];
  findingStatus: 'open' | 'applied';
  /** Snapshots still attached to the finding after the run. */
  remainingSnapshots: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function revertDoctorFinding(
  input: RevertFindingInput,
): Promise<RevertFindingResult> {
  const { findingId, userId, snapshotIds } = input;

  // ── 1. Load + validate the finding ────────────────────────────────────────
  const finding = await getFindingForRevert(findingId);

  if (!finding) {
    throw new ApplyNotFoundError('Finding not found');
  }
  if (finding.user_id !== userId) {
    throw new ApplyAccessError('Finding not owned by user');
  }
  if (finding.status !== 'applied') {
    // Only an applied finding has snapshots to act on.
    throw new ApplyConflictError(`Finding is ${finding.status}, not applied`);
  }

  // ── 2. Load snapshots ─────────────────────────────────────────────────────
  const snapshots = await getSnapshotsForFinding(findingId);
  if (snapshots.length === 0) {
    throw new ApplyConflictError(
      'Finding has no snapshots to revert (likely applied on an older version that did not track them)',
    );
  }

  const allIds = new Set(snapshots.map((s) => s.id));
  const requestedIds =
    Array.isArray(snapshotIds) && snapshotIds.length > 0
      ? snapshotIds.filter((id) => allIds.has(id))
      : Array.from(allIds);

  if (requestedIds.length === 0) {
    throw new ApplyConflictError('No snapshots selected for revert');
  }

  // ── 3. Revert each snapshot ───────────────────────────────────────────────
  const results: PerSnapshotOutcome[] = [];
  const byId = new Map(snapshots.map((s) => [s.id, s] as const));

  for (const snapshotId of requestedIds) {
    const snap = byId.get(snapshotId);
    if (!snap) continue; // defensive; cannot happen after the intersection

    try {
      const outcome = await withTestCaseMutex(snap.test_case_id, () =>
        revertOneSnapshot({ snapshot: snap, userId }),
      );
      results.push(outcome);
    } catch (err) {
      logger.warn('[DOCTOR_REVERT] Per-snapshot failure (non-fatal)', {
        findingId,
        snapshotId,
        testCaseId: snap.test_case_id,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push({
        snapshotId,
        testCaseId: snap.test_case_id,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 4. Re-count surviving snapshots + decide finding state ────────────────
  const { count, error: remainingErr } = await countSnapshotsForFinding(findingId);

  if (remainingErr) {
    // Non-fatal for the per-test outcomes the user sees. Assume partial so we
    // never falsely clear `applied_*`.
    logger.error('[DOCTOR_REVERT] Failed to re-count snapshots', {
      findingId,
      error: remainingErr,
    });
  }
  const remainingSnapshots = count ?? snapshots.length;

  const anyReverted = results.some((r) => r.status === 'reverted');
  let findingStatus: 'open' | 'applied' = 'applied';

  if (anyReverted && remainingSnapshots === 0) {
    const { error } = await markFindingOpen(findingId);
    if (error) {
      logger.error('[DOCTOR_REVERT] Failed to flip finding back to open', { findingId, error });
      // The rows DID get reverted; only the status is stale. Stay pessimistic
      // so the caller doesn't assume a clean state.
    } else {
      findingStatus = 'open';
    }
  }

  return { findingId, totalRequested: requestedIds.length, results, findingStatus, remainingSnapshots };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-snapshot work unit
// ─────────────────────────────────────────────────────────────────────────────

async function revertOneSnapshot(params: {
  snapshot: SnapshotRow;
  userId: string;
}): Promise<PerSnapshotOutcome> {
  const { snapshot, userId } = params;
  const { id: snapshotId, test_case_id: testCaseId } = snapshot;

  // ── Load current test state ───────────────────────────────────────────────
  const { row, error: readErr } = await getTestCaseForApply(testCaseId);

  if (readErr) {
    return { snapshotId, testCaseId, status: 'error', message: `read failed: ${readErr}` };
  }
  if (!row) {
    return { snapshotId, testCaseId, status: 'skipped', reason: 'test_case_missing' };
  }
  if (row.user_id !== userId) {
    return { snapshotId, testCaseId, status: 'skipped', reason: 'access_denied' };
  }

  // ── Refuse to revert over a manual edit ───────────────────────────────────
  // Byte-identical comparison against what Apply wrote. Anything else means the
  // user has since edited the case, and `steps_before` would destroy that.
  if (JSON.stringify(row.steps_json) !== JSON.stringify(snapshot.steps_after)) {
    return { snapshotId, testCaseId, status: 'skipped', reason: 'modified_after_apply' };
  }

  // ── Optimistic write: restore steps_before ────────────────────────────────
  const { written, error: updErr } = await updateStepsJsonIfUnchanged({
    testCaseId,
    steps: snapshot.steps_before as IntentStep[],
    expectedUpdatedAt: row.updated_at,
  });

  if (updErr) {
    return { snapshotId, testCaseId, status: 'error', message: `write failed: ${updErr}` };
  }
  if (written === 0) {
    // Race — someone wrote after our read. Don't delete the snapshot: we have
    // not actually reverted anything.
    return { snapshotId, testCaseId, status: 'skipped', reason: 'concurrent_edit' };
  }

  // ── Snapshot cleanup ──────────────────────────────────────────────────────
  const { error: delErr } = await deleteApplySnapshot(snapshotId);
  if (delErr) {
    // The revert itself succeeded — the write landed. An orphan snapshot row is
    // cosmetic, so the user still sees a successful revert.
    logger.warn('[DOCTOR_REVERT] Snapshot cleanup failed (non-fatal)', {
      snapshotId,
      error: delErr,
    });
  }

  await runPostRevertSideEffects({ testCaseId, flowId: row.flow_id });

  return { snapshotId, testCaseId, status: 'reverted' };
}

/**
 * Same best-effort side effects as apply — a revert is a `steps_json` write
 * like any other, and the negatives / flow cache do not care which direction
 * the steps moved.
 */
async function runPostRevertSideEffects(params: {
  testCaseId: string;
  flowId: string | null;
}): Promise<void> {
  const { testCaseId, flowId } = params;

  const { error } = await markNegativesStaleForTestCase(testCaseId).catch((err) => ({
    count: null,
    error: err instanceof Error ? err.message : String(err),
  }));
  if (error) {
    logger.warn('[DOCTOR_REVERT] Failed to mark negatives stale (non-fatal)', { testCaseId, error });
  }

  if (flowId) {
    await cache.delByPattern(`qait:cache:ptree:flow:${flowId}:*`).catch((err: unknown) => {
      logger.warn('[DOCTOR_REVERT] Flow cache invalidation failed (non-fatal)', {
        testCaseId,
        flowId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
