import { supabaseAdmin } from '@/db/supabase';
import { markNegativesStaleByParent } from '@/services/testing/ui/preview/db/intent-test-case.db';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

/**
 * db/ sublayer for the Doctor's WRITE path — applying a patch and reverting it.
 *
 * Split from `regression-doctor.db.ts`, which serves the read path (collecting
 * evidence for analysis). The two have no query in common and different
 * lifetimes: one runs in a background job, the other behind a user click.
 *
 * Every write here is optimistic-concurrency shaped: the caller passes the
 * `updated_at` it read, and a zero-row result means somebody else wrote first.
 * That distinction is the whole reason an apply cannot silently overwrite a
 * user's manual edit, so these functions report rows-written rather than
 * throwing.
 */

export interface FindingForApplyRow {
  id: string;
  user_id: string;
  project_id: string;
  status: string;
  verdict: string | null;
  test_case_id: string | null;
  step_id: string | null;
  proposed_patch: unknown;
  affected_test_ids: string[] | null;
}

export interface TestCaseForApplyRow {
  id: string;
  user_id: string;
  project_id: string | null;
  flow_id: string | null;
  steps_json: IntentStep[] | null;
  updated_at: string;
}

export interface SnapshotRow {
  id: string;
  test_case_id: string;
  steps_before: unknown;
  steps_after: unknown;
}





export async function getFindingForApply(findingId: string): Promise<FindingForApplyRow | null> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_findings')
    .select(
      'id, user_id, project_id, status, verdict, test_case_id, step_id, proposed_patch, affected_test_ids',
    )
    .eq('id', findingId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load finding: ${error.message}`);
  }
  return (data as FindingForApplyRow) ?? null;
}

export async function getFindingForRevert(
  findingId: string,
): Promise<{ id: string; user_id: string; project_id: string | null; status: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_findings')
    // `project_id` is part of the access check (owner OR workspace member) —
    // without it a teammate's revert would be denied for a finding they can
    // otherwise read and apply.
    .select('id, user_id, project_id, status, applied_at')
    .eq('id', findingId)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to load finding: ${error.message}`);
  }
  return (
    (data as { id: string; user_id: string; project_id: string | null; status: string }) ?? null
  );
}

export async function getTestCaseForApply(testCaseId: string): Promise<{
  row: TestCaseForApplyRow | null;
  error: string | null;
}> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, user_id, project_id, flow_id, steps_json, updated_at')
    .eq('id', testCaseId)
    .maybeSingle();

  return { row: (data as TestCaseForApplyRow) ?? null, error: error?.message ?? null };
}

/**
 * Write `steps_json` guarded by the `updated_at` we read.
 *
 * Returns the number of rows written — 0 means somebody else wrote to the case
 * between our read and this call, and the caller must treat it as a concurrent
 * edit rather than retrying blindly. Users never get their manual edits
 * silently overwritten by an apply.
 */
export async function updateStepsJsonIfUnchanged(params: {
  testCaseId: string;
  steps: IntentStep[];
  expectedUpdatedAt: string;
}): Promise<{ written: number; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .update({ steps_json: params.steps })
    .eq('id', params.testCaseId)
    .eq('updated_at', params.expectedUpdatedAt)
    .select('id');

  return { written: Array.isArray(data) ? data.length : 0, error: error?.message ?? null };
}

export async function insertApplySnapshot(row: {
  finding_id: string;
  test_case_id: string;
  user_id: string;
  project_id: string | null;
  steps_before: IntentStep[];
  before_updated_at: string;
  steps_after: IntentStep[];
  change_description: string;
}): Promise<{ id: string | null; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .insert(row)
    .select('id')
    .single();

  return { id: (data as { id: string } | null)?.id ?? null, error: error?.message ?? null };
}

export async function deleteApplySnapshot(snapshotId: string): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .delete()
    .eq('id', snapshotId);

  return { error: error?.message ?? null };
}

export async function getSnapshotsForFinding(findingId: string): Promise<SnapshotRow[]> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .select('id, test_case_id, steps_before, steps_after')
    .eq('finding_id', findingId);

  if (error) {
    throw new Error(`Failed to load snapshots: ${error.message}`);
  }
  return (data as SnapshotRow[]) || [];
}

export async function countSnapshotsForFinding(
  findingId: string,
): Promise<{ count: number | null; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_apply_snapshots')
    .select('id')
    .eq('finding_id', findingId);

  return { count: Array.isArray(data) ? data.length : null, error: error?.message ?? null };
}

/**
 * Flip a finding to applied, guarded on `status = 'open'`.
 *
 * Returns rows written, because zero is not an error: it means a concurrent
 * request flipped this finding first. The caller must not then report a state
 * transition it did not perform.
 */
export async function markFindingApplied(params: {
  findingId: string;
  userId: string;
}): Promise<{ written: number; error: string | null }> {
  const { data, error } = await supabaseAdmin
    .from('regression_doctor_findings')
    .update({
      status: 'applied',
      applied_at: new Date().toISOString(),
      applied_by: params.userId,
    })
    .eq('id', params.findingId)
    .eq('status', 'open')
    .select('id');

  return { written: Array.isArray(data) ? data.length : 0, error: error?.message ?? null };
}

/** Flip a fully-reverted finding back to open. */
export async function markFindingOpen(findingId: string): Promise<{ error: string | null }> {
  const { error } = await supabaseAdmin
    .from('regression_doctor_findings')
    .update({ status: 'open', applied_at: null, applied_by: null })
    .eq('id', findingId)
    .eq('status', 'applied');

  return { error: error?.message ?? null };
}

/**
 * Mark negatives derived from a patched case as stale.
 *
 * Reuses the preview domain's query rather than restating it — the staleness
 * contract (`negative_stale_reason = 'parent_steps_changed'`, only rows that
 * are still fresh) belongs to that domain, and two copies would drift. Every
 * other path that mutates `steps_json` calls it; an apply that skips it leaves
 * generated negatives running against a mutation of the pre-patch step.
 */
export async function markNegativesStaleForTestCase(
  testCaseId: string,
): Promise<{ count: number | null; error: string | null }> {
  const { error, count } = await markNegativesStaleByParent(testCaseId);
  return { count: count ?? null, error: error?.message ?? null };
}
