/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression Doctor — Revert service (Phase-2 Slice B, follow-up)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Closes the Apply → "changed my mind" → Revert loop. Reads the snapshots
 * written during the original Bulk Apply and restores each test case's
 * `steps_json` to `steps_before` — the exact pre-apply state, byte for
 * byte.
 *
 * Why a separate service (not inline in the controller):
 *   • Same per-test-case mutex as apply — SHARED (imported from
 *     apply.service) so an Apply+Revert race on the same test case
 *     serialises correctly.
 *   • Same per-test failure isolation + typed return shape as apply, so
 *     the UI can render a mixed summary ("Reverted 13 / Skipped 2").
 *   • Keeps controller thin.
 *
 * Key correctness rules:
 *
 *  1. **Refuse to revert manual edits.** If the user edited a test case
 *     AFTER Apply (i.e. `steps_json !== snapshot.steps_after`), we must
 *     NOT blindly overwrite with `steps_before` — that would discard the
 *     user's manual work. We skip with `modified_after_apply` and leave
 *     it to the user.
 *
 *  2. **Optimistic concurrency.** Same `updated_at` gate as apply. If
 *     something else is writing the test in parallel, we back off.
 *
 *  3. **Snapshot cleanup on success.** After a successful revert, the
 *     snapshot is semantically stale — it records an apply that no
 *     longer exists. We delete it. A future re-Apply of the finding will
 *     create fresh snapshots. Skipped snapshots stay intact so the
 *     audit trail reflects "we tried to revert but couldn't".
 *
 *  4. **Finding state machine.** After revert, the finding flips to
 *     `'open'` iff ≥1 test was reverted AND 0 snapshots remain. If some
 *     snapshots remain (partial revert), the finding stays `'applied'`
 *     so the user sees "partial — some tests still patched".
 *     `applied_at` / `applied_by` are cleared only on a full revert to
 *     keep semantics consistent ("no longer applied").
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import {
  ApplyAccessError,
  ApplyConflictError,
  ApplyNotFoundError,
  withTestCaseMutex,
} from './apply.service';

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RevertFindingInput {
  findingId: string;
  userId: string;
  /**
   * Optional subset of snapshot ids to revert. When omitted, every
   * snapshot attached to the finding is attempted. Unknown ids silently
   * dropped via intersection with the finding's snapshot list.
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
  /** Count of snapshots still attached to the finding after the run. */
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
  const { data: finding, error: findingErr } = await supabaseAdmin
    .from('regression_doctor_findings')
    .select('id, user_id, status, applied_at')
    .eq('id', findingId)
    .maybeSingle();

  if (findingErr) {
    throw new Error(`Failed to load finding: ${findingErr.message}`);
  }
  if (!finding) {
    throw new ApplyNotFoundError('Finding not found');
  }
  if (finding.user_id !== userId) {
    throw new ApplyAccessError('Finding not owned by user');
  }
  if (finding.status !== 'applied') {
    // Can only revert what was applied. Anything else (open / dismissed
    // / resolved) has no snapshots to act on.
    throw new ApplyConflictError(`Finding is ${finding.status}, not applied`);
  }

  // ── 2. Load snapshots ─────────────────────────────────────────────────────
  const { data: snapRows, error: snapErr } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .select('id, test_case_id, steps_before, steps_after')
    .eq('finding_id', findingId);

  if (snapErr) {
    throw new Error(`Failed to load snapshots: ${snapErr.message}`);
  }
  const snapshots = Array.isArray(snapRows) ? snapRows : [];
  if (snapshots.length === 0) {
    throw new ApplyConflictError(
      'Finding has no snapshots to revert (likely applied on an older version that did not track them)',
    );
  }

  // Intersect requested subset with the snapshots we actually have.
  const allIds = new Set(snapshots.map((s) => s.id as string));
  const requestedIds =
    Array.isArray(snapshotIds) && snapshotIds.length > 0
      ? snapshotIds.filter((id) => allIds.has(id))
      : Array.from(allIds);

  if (requestedIds.length === 0) {
    throw new ApplyConflictError('No snapshots selected for revert');
  }

  // ── 3. Revert each snapshot ───────────────────────────────────────────────
  const results: PerSnapshotOutcome[] = [];
  const byId = new Map(snapshots.map((s) => [s.id as string, s]));

  for (const snapshotId of requestedIds) {
    const snap = byId.get(snapshotId);
    if (!snap) continue; // defensive; can't happen after intersection

    try {
      const outcome = await withTestCaseMutex(snap.test_case_id as string, () =>
        revertOneSnapshot({
          snapshot: snap,
          userId,
        }),
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
        testCaseId: snap.test_case_id as string,
        status: 'error',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── 4. Re-count surviving snapshots + decide finding state ────────────────
  // Reverts delete the snapshot row. The finding goes back to 'open' ONLY
  // if every snapshot was reverted; a partial revert leaves the finding
  // marked 'applied' so the UI can signal "some tests still patched".
  const { data: remainingSnapRows, error: remainingErr } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .select('id')
    .eq('finding_id', findingId);

  if (remainingErr) {
    // Non-fatal for the per-test outcomes the user sees; log and assume
    // partial so we don't falsely clear applied_*.
    logger.error('[DOCTOR_REVERT] Failed to re-count snapshots', {
      findingId,
      error: remainingErr.message,
    });
  }
  const remainingSnapshots = Array.isArray(remainingSnapRows)
    ? remainingSnapRows.length
    : snapshots.length;

  const anyReverted = results.some((r) => r.status === 'reverted');
  let findingStatus: 'open' | 'applied' = 'applied';

  if (anyReverted && remainingSnapshots === 0) {
    const { error: updErr } = await supabaseAdmin
      .from('regression_doctor_findings')
      .update({
        status: 'open',
        applied_at: null,
        applied_by: null,
      })
      .eq('id', findingId)
      .eq('status', 'applied'); // only touch if nobody changed it mid-flight

    if (updErr) {
      logger.error('[DOCTOR_REVERT] Failed to flip finding back to open', {
        findingId,
        error: updErr.message,
      });
      // The per-test rows DID get reverted; the status is just stale.
      // We stay pessimistic and report 'applied' so the caller doesn't
      // assume a clean state.
    } else {
      findingStatus = 'open';
    }
  }

  return {
    findingId,
    totalRequested: requestedIds.length,
    results,
    findingStatus,
    remainingSnapshots,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-snapshot work unit
// ─────────────────────────────────────────────────────────────────────────────

async function revertOneSnapshot(params: {
  snapshot: { id: string; test_case_id: string; steps_before: unknown; steps_after: unknown };
  userId: string;
}): Promise<PerSnapshotOutcome> {
  const { snapshot, userId } = params;
  const testCaseId = snapshot.test_case_id;
  const snapshotId = snapshot.id;

  // ── Load current test state ───────────────────────────────────────────────
  const { data: row, error: readErr } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, user_id, steps_json, updated_at')
    .eq('id', testCaseId)
    .maybeSingle();

  if (readErr) {
    return {
      snapshotId,
      testCaseId,
      status: 'error',
      message: `read failed: ${readErr.message}`,
    };
  }
  if (!row) {
    return { snapshotId, testCaseId, status: 'skipped', reason: 'test_case_missing' };
  }
  if (row.user_id !== userId) {
    return { snapshotId, testCaseId, status: 'skipped', reason: 'access_denied' };
  }

  // ── Refuse to revert if the user has edited the test since apply ─────────
  // We compare the CURRENT steps_json against `steps_after`. If they
  // differ, the user modified the file after apply and blindly writing
  // `steps_before` would silently destroy their work.
  // Byte-identical JSON check — same technique as `applyToOneTestCase`
  // uses to detect `already_patched`.
  const currentJson = JSON.stringify(row.steps_json);
  const afterJson = JSON.stringify(snapshot.steps_after);
  if (currentJson !== afterJson) {
    return {
      snapshotId,
      testCaseId,
      status: 'skipped',
      reason: 'modified_after_apply',
    };
  }

  const beforeUpdatedAt = row.updated_at as string;
  const stepsBefore = snapshot.steps_before as IntentStep[];

  // ── Optimistic write: restore steps_before ────────────────────────────────
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('intent_test_cases')
    .update({ steps_json: stepsBefore })
    .eq('id', testCaseId)
    .eq('updated_at', beforeUpdatedAt)
    .select('id');

  if (updErr) {
    return {
      snapshotId,
      testCaseId,
      status: 'error',
      message: `write failed: ${updErr.message}`,
    };
  }
  if (!updated || updated.length === 0) {
    // Race — someone wrote to this row after our read. Bail; don't
    // delete the snapshot (we haven't actually reverted).
    return { snapshotId, testCaseId, status: 'skipped', reason: 'concurrent_edit' };
  }

  // ── Snapshot cleanup ──────────────────────────────────────────────────────
  // The apply-operation this snapshot documented no longer exists. We
  // drop the row so a future re-Apply doesn't see a stale "already
  // applied" record.
  const { error: delErr } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .delete()
    .eq('id', snapshotId);

  if (delErr) {
    // The revert ITSELF succeeded — the DB write landed. Snapshot
    // cleanup failure is cosmetic (orphan row). Log and carry on so
    // the user sees the revert as successful.
    logger.warn('[DOCTOR_REVERT] Snapshot cleanup failed (non-fatal)', {
      snapshotId,
      error: delErr.message,
    });
  }

  return { snapshotId, testCaseId, status: 'reverted' };
}
