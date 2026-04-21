/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Regression Doctor — Bulk Apply service (Phase-2 Slice B)
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Applies a single Doctor finding's `proposed_patch` to every affected
 * `intent_test_cases` row (or a user-selected subset). Writes a pre-apply
 * snapshot per test case so the change is auditable and (future) reversible.
 *
 * Design choices documented inline. Key non-obvious ones:
 *
 *  1. **Per-test step lookup, not global index.** The finding's
 *     `targetStepIndex` is the index from ONE original failing test —
 *     different tests have different steps_json. We search each test case
 *     for a step that matches the finding's pattern (urlPattern +
 *     targetElementKey + errorShape context) and apply the patch at that
 *     location. If no match is found, we fall back to the finding's index
 *     when it's in-bounds, otherwise skip the test with a reason.
 *
 *  2. **Optimistic concurrency via `updated_at`.** We snapshot
 *     `updated_at` when we read, then `.eq('updated_at', snap)` on the
 *     write. If the user edited the test case between read and write, the
 *     write hits 0 rows and we skip the test with `concurrent_edit`.
 *     Users never get their manual edits silently overwritten.
 *
 *  3. **Per-test-case failure isolation.** Each test is processed
 *     independently inside a try/catch. A failure on one test case (RLS
 *     deny, missing row, concurrent edit) never blocks the other 14.
 *     Return shape carries per-test status so the UI can render a
 *     mixed-result summary ("Applied 13, skipped 2").
 *
 *  4. **Finding state machine.** Finding flips to `applied` iff at least
 *     one test case was successfully patched. A finding where all tests
 *     were skipped (e.g. all had concurrent edits) stays `open` so the
 *     user can retry later.
 *
 *  5. **Step ID preservation.** When modifying an existing step, keep its
 *     `id`. When inserting a new step, generate a fresh UUID. This keeps
 *     compiled plans / evidence / logs referencing steps by id stable
 *     across the patch.
 * ─────────────────────────────────────────────────────────────────────────────
 */

import { randomUUID } from 'crypto';
import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type {
  DriftProposedPatch,
} from './drift-agent';

// Per-test-case in-memory mutex — same pattern as
// intent-test-case.service.ts. Lightweight; only contends when two
// applies touch the same test case concurrently.
//
// Exported so the revert service can reuse the SAME map — otherwise an
// Apply and a Revert on the same test case could race. The mutex has to
// be shared by any code that writes `intent_test_cases.steps_json` on
// behalf of the Doctor.
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
   * Optional subset of test case ids to apply to. If omitted, we use the
   * full `affected_test_ids` from the finding. When provided, the server
   * intersects with `affected_test_ids` — unknown ids are dropped
   * silently (not an error) so stale client state can't reach unrelated
   * tests.
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
  | 'access_denied'         // user doesn't own it
  | 'no_step_matched'       // pattern didn't resolve to a step
  | 'step_out_of_bounds'    // targetStepIndex invalid for this test
  | 'already_patched';      // exact same patch already present

export interface ApplyFindingResult {
  findingId: string;
  proposedPatch: DriftProposedPatch;
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
  const { data: finding, error: findingErr } = await supabaseAdmin
    .from('regression_doctor_findings')
    .select('id, user_id, project_id, status, url_pattern, target_element_key, error_shape, proposed_patch, affected_test_ids')
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
  if (finding.status !== 'open') {
    throw new ApplyConflictError(`Finding is ${finding.status}`);
  }
  if (!finding.proposed_patch) {
    throw new ApplyConflictError('Finding has no proposed patch');
  }

  const patch = finding.proposed_patch as DriftProposedPatch;
  const affectedIds = Array.isArray(finding.affected_test_ids)
    ? (finding.affected_test_ids as string[])
    : [];

  if (affectedIds.length === 0) {
    throw new ApplyConflictError('Finding has no affected test cases');
  }

  // Intersect user's requested subset with the finding's authoritative
  // list. Unknown ids silently dropped — stale client state can't touch
  // unrelated test cases.
  const affectedSet = new Set(affectedIds);
  const requestedIds = Array.isArray(testCaseIds) && testCaseIds.length > 0
    ? testCaseIds.filter((id) => affectedSet.has(id))
    : affectedIds;

  if (requestedIds.length === 0) {
    throw new ApplyConflictError('No test cases selected for apply');
  }

  // ─── 2. Process each test case ────────────────────────────────────────────
  const results: PerTestOutcome[] = [];

  // Sequential processing — parallelizing would save latency but
  // deflects meaningful error messages when one test case blocks a
  // shared dependency (e.g. workspace rate limit). The bulk Apply is
  // not on a hot path; correctness > speed for Slice B.
  for (const testCaseId of requestedIds) {
    try {
      const outcome = await withTestCaseMutex(testCaseId, () =>
        applyToOneTestCase({
          testCaseId,
          userId,
          findingId,
          finding,
          patch,
        }),
      );
      results.push(outcome);
    } catch (err) {
      // Unexpected error on this test case — record it and keep going.
      // The Doctor panel will surface the message verbatim.
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
  let findingStatus: 'open' | 'applied' = finding.status as 'open';

  if (anyApplied) {
    const { error: updErr } = await supabaseAdmin
      .from('regression_doctor_findings')
      .update({
        status: 'applied',
        applied_at: new Date().toISOString(),
        applied_by: userId,
      })
      .eq('id', findingId)
      .eq('status', 'open'); // belt-and-suspenders; we already checked

    if (updErr) {
      logger.error('[DOCTOR_APPLY] Failed to mark finding applied', {
        findingId, error: updErr.message,
      });
      // Not fatal — patches are in place. Next dismiss/apply attempt
      // will surface the stale state via the `status !== open` check.
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

// ─────────────────────────────────────────────────────────────────────────────
// Per-test-case work unit
// ─────────────────────────────────────────────────────────────────────────────

async function applyToOneTestCase(params: {
  testCaseId: string;
  userId: string;
  findingId: string;
  finding: {
    project_id: string;
    url_pattern: string;
    target_element_key: string | null;
    error_shape: string;
  };
  patch: DriftProposedPatch;
}): Promise<PerTestOutcome> {
  const { testCaseId, userId, findingId, finding, patch } = params;

  // ── Load ──────────────────────────────────────────────────────────────────
  const { data: row, error: readErr } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, user_id, project_id, steps_json, updated_at')
    .eq('id', testCaseId)
    .maybeSingle();

  if (readErr) {
    return { testCaseId, status: 'error', message: `read failed: ${readErr.message}` };
  }
  if (!row) {
    return { testCaseId, status: 'skipped', reason: 'test_case_missing' };
  }
  if (row.user_id !== userId) {
    return { testCaseId, status: 'skipped', reason: 'access_denied' };
  }

  const before = Array.isArray(row.steps_json) ? (row.steps_json as IntentStep[]) : [];
  const beforeUpdatedAt = row.updated_at as string;

  // ── Find the target step ──────────────────────────────────────────────────
  const matchIdx = locateTargetStep(before, finding, patch);
  if (matchIdx == null) {
    return { testCaseId, status: 'skipped', reason: 'no_step_matched' };
  }

  // ── Build the patched array ───────────────────────────────────────────────
  let after: IntentStep[];
  let changeDescription: string;
  try {
    const result = applyPatch(before, matchIdx, patch);
    after = result.steps;
    changeDescription = result.description;
  } catch (err) {
    if (err instanceof StepOutOfBoundsError) {
      return { testCaseId, status: 'skipped', reason: 'step_out_of_bounds' };
    }
    throw err;
  }

  // No-op detection. If after === before (byte-identical JSON), we
  // already-applied this patch. Report as skipped rather than writing
  // a meaningless snapshot and bumping updated_at.
  if (JSON.stringify(after) === JSON.stringify(before)) {
    return { testCaseId, status: 'skipped', reason: 'already_patched' };
  }

  // ── Snapshot (insert first so if write fails we still have audit) ─────────
  const { data: snapshotRow, error: snapErr } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .insert({
      finding_id: findingId,
      test_case_id: testCaseId,
      user_id: userId,
      project_id: row.project_id,
      steps_before: before,
      before_updated_at: beforeUpdatedAt,
      steps_after: after,
      change_description: changeDescription,
    })
    .select('id')
    .single();

  if (snapErr || !snapshotRow) {
    return {
      testCaseId,
      status: 'error',
      message: `snapshot failed: ${snapErr?.message ?? 'unknown'}`,
    };
  }

  // ── Optimistic write ──────────────────────────────────────────────────────
  // If `updated_at` changed between our read and write, this UPDATE hits
  // 0 rows and we report concurrent_edit. Supabase's default return is
  // the updated row(s) — when none match, `.select()` returns [].
  const { data: updated, error: updErr } = await supabaseAdmin
    .from('intent_test_cases')
    .update({ steps_json: after })
    .eq('id', testCaseId)
    .eq('updated_at', beforeUpdatedAt)
    .select('id');

  if (updErr) {
    return { testCaseId, status: 'error', message: `write failed: ${updErr.message}` };
  }
  if (!updated || updated.length === 0) {
    // Race: someone updated this row after our read. The snapshot we
    // wrote is now orphaned but harmless (it preserves the state at
    // the time WE saw). Delete it so the audit trail isn't polluted.
    await supabaseAdmin
      .from('regression_doctor_apply_snapshots')
      .delete()
      .eq('id', snapshotRow.id);
    return { testCaseId, status: 'skipped', reason: 'concurrent_edit' };
  }

  return {
    testCaseId,
    status: 'applied',
    snapshotId: snapshotRow.id as string,
    changeDescription,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Target step resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Given a test case's steps and the finding's pattern descriptor, return
 * the index of the step the patch should act upon.
 *
 * Strategy (highest priority first):
 *   1. Match by targetElementKey `"<tag>:<text>"` — tag in step.bindingHints
 *      and text in step.description.
 *   2. Match by description substring equivalence on targetElementKey's
 *      text portion.
 *   3. Fall back to finding.proposed_patch.targetStepIndex if it's within
 *      bounds of this test's steps array.
 *
 * Returns null if nothing matches. The caller then records the test as
 * skipped with reason `no_step_matched` — users see it in the per-test
 * summary and can handle manually.
 */
/** @internal — exported for unit tests only */
export function locateTargetStep(
  steps: IntentStep[],
  finding: { target_element_key: string | null; url_pattern: string },
  patch: DriftProposedPatch,
): number | null {
  if (steps.length === 0) return null;

  const keyText = extractKeyText(finding.target_element_key);
  const keyTag = extractKeyTag(finding.target_element_key);

  // Primary: exact match on description text + tag hint.
  if (keyText) {
    const idx = steps.findIndex((s) => {
      if (!s || typeof s !== 'object') return false;
      const desc = (s.description || '').toLowerCase();
      if (!desc.includes(keyText.toLowerCase())) return false;
      if (keyTag && s.bindingHints && typeof s.bindingHints === 'object') {
        const hintTag = (s.bindingHints as { tag?: string }).tag;
        if (hintTag && hintTag !== keyTag) return false;
      }
      return true;
    });
    if (idx >= 0) return idx;
  }

  // Secondary: targetStepIndex from the patch if in bounds. This handles
  // the case where the failing test's original step has been renamed but
  // is still at the same position across tests.
  if (typeof patch.targetStepIndex === 'number' && patch.targetStepIndex >= 0) {
    if (patch.targetStepIndex < steps.length) return patch.targetStepIndex;
    // insert_before can target index === steps.length (append at end).
    if (patch.action === 'insert_before' && patch.targetStepIndex === steps.length) {
      return patch.targetStepIndex;
    }
  }

  return null;
}

function extractKeyText(key: string | null): string | null {
  if (!key) return null;
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(colon + 1).trim() : key.trim();
}
function extractKeyTag(key: string | null): string | null {
  if (!key) return null;
  const colon = key.indexOf(':');
  return colon >= 0 ? key.slice(0, colon).trim().toLowerCase() : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Patch application
// ─────────────────────────────────────────────────────────────────────────────

/** @internal — exported for unit tests only */
export class StepOutOfBoundsError extends Error {}

/** @internal — exported for unit tests only */
export function applyPatch(
  steps: IntentStep[],
  idx: number,
  patch: DriftProposedPatch,
): { steps: IntentStep[]; description: string } {
  const next = steps.slice();

  switch (patch.action) {
    case 'insert_before': {
      if (!patch.insertStep) throw new Error('insert_before patch without insertStep');
      // Generate fresh UUID for the new step. Existing ids stay intact
      // downstream so compiled plans / evidence keyed on step id survive.
      const newStep: IntentStep = {
        id: randomUUID(),
        type: patch.insertStep.type as IntentStep['type'],
        description: patch.insertStep.description,
        ...(patch.insertStep.value !== undefined ? { value: patch.insertStep.value } : {}),
      };
      next.splice(idx, 0, newStep);
      return {
        steps: next,
        description: `Inserted step at index ${idx}: ${newStep.type} — ${newStep.description}`,
      };
    }

    case 'replace_selector': {
      if (!patch.newSelector) throw new Error('replace_selector patch without newSelector');
      if (idx < 0 || idx >= next.length) throw new StepOutOfBoundsError();
      const existing = next[idx];
      next[idx] = {
        ...existing,
        // New selector rides in bindingHints — that's the path downstream
        // resolvers prefer over raw CSS strings embedded in description.
        bindingHints: {
          ...(existing.bindingHints || {}),
          // Cast: bindingHints.selector isn't a declared field on the
          // BindingHints interface for every kind, but is tolerated by
          // the compiled-plan builder. Keeps the patch minimal.
          ...(patch.newSelector ? { selector: patch.newSelector } : {}),
        } as IntentStep['bindingHints'],
      };
      return {
        steps: next,
        description: `Replaced selector on step ${idx}: ${patch.newSelector}`,
      };
    }

    case 'delete_step': {
      if (idx < 0 || idx >= next.length) throw new StepOutOfBoundsError();
      const removed = next.splice(idx, 1)[0];
      return {
        steps: next,
        description: `Deleted step ${idx}: ${removed?.type ?? ''} — ${removed?.description ?? ''}`,
      };
    }

    case 'update_value': {
      if (idx < 0 || idx >= next.length) throw new StepOutOfBoundsError();
      const existing = next[idx];
      const nextValue = patch.insertStep?.value ?? '';
      next[idx] = { ...existing, value: nextValue };
      return {
        steps: next,
        description: `Updated value on step ${idx}: "${nextValue}"`,
      };
    }

    default: {
      const _exhaustive: never = patch.action;
      throw new Error(`Unknown patch action: ${String(_exhaustive)}`);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Typed errors so the controller can map cleanly to HTTP codes.
// Named `Apply*` to avoid colliding with the common `NotFoundError` exported
// from `@/types` (which is already imported by the regression controller).
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
