/**
 * Data-access sublayer for qa_handoffs. Queries + row↔type mapping only — no
 * business logic (that lives in HandoffService). This is what lets the service
 * be unit-tested without a real DB.
 */

import { supabaseAdmin } from '@/db/supabase';
import type { QaHandoff, QaHandoffStatus } from '@/types/testing.types';

interface QaHandoffRow {
  id: string;
  project_id: string;
  issue_key: string;
  cloud_id: string | null;
  status: QaHandoffStatus;
  handoff: QaHandoff;
  test_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersistHandoffInput {
  projectId: string;
  issueKey: string;
  cloudId?: string;
  status: QaHandoffStatus;
  handoff: QaHandoff;
  testId?: string;
}

function mapRow(row: QaHandoffRow): QaHandoff {
  return {
    ...row.handoff,
    status: row.status,
    testId: row.test_id ?? row.handoff.testId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Upsert a handoff keyed by (project_id, issue_key). Re-assessment overwrites. */
export async function upsertHandoff(input: PersistHandoffInput): Promise<QaHandoff | null> {
  const { data, error } = await supabaseAdmin
    .from('qa_handoffs')
    .upsert(
      {
        project_id: input.projectId,
        issue_key: input.issueKey,
        cloud_id: input.cloudId ?? null,
        status: input.status,
        handoff: input.handoff,
        ...(input.testId ? { test_id: input.testId } : {}),
      },
      { onConflict: 'project_id,issue_key' },
    )
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data ? mapRow(data as QaHandoffRow) : null;
}

/** Read the handoff for a (project, issue), or null. */
export async function getHandoff(projectId: string, issueKey: string): Promise<QaHandoff | null> {
  const { data, error } = await supabaseAdmin
    .from('qa_handoffs')
    .select('*')
    .eq('project_id', projectId)
    .eq('issue_key', issueKey)
    .maybeSingle();

  if (error) throw error;
  return data ? mapRow(data as QaHandoffRow) : null;
}

/**
 * Patch a handoff post-run: status + merged payload (test_id, fixPromptRef).
 * Reads the current payload, spread-merges the patch, and writes both the
 * top-level status column and the embedded artifact.
 */
export async function patchHandoffPostRun(input: {
  projectId: string;
  issueKey: string;
  status: QaHandoffStatus;
  testId?: string;
  fixPromptRef?: string;
}): Promise<QaHandoff | null> {
  const current = await getHandoff(input.projectId, input.issueKey);
  if (!current) return null;

  const mergedPayload: QaHandoff = {
    ...current,
    status: input.status,
    ...(input.testId ? { testId: input.testId } : {}),
    ...(input.fixPromptRef ? { fixPromptRef: input.fixPromptRef } : {}),
  };

  const { data, error } = await supabaseAdmin
    .from('qa_handoffs')
    .update({
      status: input.status,
      handoff: mergedPayload,
      ...(input.testId ? { test_id: input.testId } : {}),
    })
    .eq('project_id', input.projectId)
    .eq('issue_key', input.issueKey)
    .select('*')
    .maybeSingle();

  if (error) throw error;
  return data ? mapRow(data as QaHandoffRow) : null;
}
