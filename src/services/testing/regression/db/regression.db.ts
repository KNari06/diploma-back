import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for the regression pipeline.
 * Pure Supabase queries — no business logic, no orchestration.
 */

// ── resolve-test-case-priority ────────────────────────────────────────────────

/**
 * 2-hop join: test_executions.test_id → intent_test_cases.priority.
 * Returns the raw priority string, or null when not found.
 * Throws on DB/network error — the caller wraps this in try/catch.
 */
export async function fetchPriorityByTestId(testId: string): Promise<string | null> {
  const { data: exec } = await supabaseAdmin
    .from('test_executions')
    .select('test_case_id')
    .eq('test_id', testId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!exec?.test_case_id) return null;

  const { data: tc } = await supabaseAdmin
    .from('intent_test_cases')
    .select('priority')
    .eq('id', exec.test_case_id)
    .maybeSingle();

  return (tc as any)?.priority ?? null;
}

// ── web-test-request-builder ──────────────────────────────────────────────────

/**
 * Get browsers and options from a source test row.
 * Returns null when the test has no source_test_id or the row is not found.
 */
export async function getTestBrowsersAndOptions(
  testId: string,
): Promise<{ browsers: any; options: any } | null> {
  const { data } = await supabaseAdmin
    .from('tests')
    .select('browsers, options')
    .eq('id', testId)
    .maybeSingle();

  return data ?? null;
}

// ── regression-save ───────────────────────────────────────────────────────────

/**
 * Fetch source test for the save flow (includes project join for ownership check).
 * Throws when the Supabase query errors; returns null when not found.
 */
export async function getSourceTestForSave(testId: string): Promise<any | null> {
  const { data, error } = await supabaseAdmin
    .from('tests')
    .select('*, projects!inner(user_id)')
    .eq('id', testId)
    .single();

  if (error) throw error;
  return data ?? null;
}

/**
 * Fetch the intelligent session for a test (best-effort — may return null).
 */
export async function getIntelligentSessionForTest(testId: string): Promise<any | null> {
  const { data } = await supabaseAdmin
    .from('intelligent_test_sessions')
    .select('*')
    .eq('test_id', testId)
    .maybeSingle();

  return data ?? null;
}

/**
 * Fetch project for the save-from-recording flow (ownership check).
 * Returns null when not found.
 */
export async function getProjectForSave(
  projectId: string,
): Promise<{ id: string; user_id: string } | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, user_id')
    .eq('id', projectId)
    .single();

  if (error) return null;
  return data ?? null;
}

/**
 * Insert a new intent_test_cases row.
 * Returns the generated id.
 */
export async function insertIntentTestCase(
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  const { data: row, error } = await supabaseAdmin
    .from('intent_test_cases')
    .insert(data)
    .select('id')
    .single();

  if (error || !row) throw new Error(`insertIntentTestCase failed: ${error?.message}`);
  return row as { id: string };
}

// ── mobile-test-dispatcher ────────────────────────────────────────────────────

/**
 * Get owner + workspace for a project (access verification).
 * Returns null when not found or on query error — the caller treats both as
 * "not found".
 */
export async function getProjectForAccess(
  projectId: string,
): Promise<{ user_id: string; workspace_id: string | null } | null> {
  const { data } = await supabaseAdmin
    .from('projects')
    .select('user_id, workspace_id')
    .eq('id', projectId)
    .maybeSingle();

  return (data as { user_id: string; workspace_id: string | null }) ?? null;
}

/**
 * Get the workspace_id for a project.
 * Returns null when not found.
 */
export async function getProjectWorkspaceId(projectId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from('projects')
    .select('workspace_id')
    .eq('id', projectId)
    .single();

  return (data as any)?.workspace_id ?? null;
}

/**
 * Get active member user_ids for a workspace.
 * Returns an empty array when the workspace has no active members.
 */
export async function getActiveWorkspaceMemberIds(workspaceId: string): Promise<string[]> {
  const { data } = await supabaseAdmin
    .from('workspace_members')
    .select('user_id')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active');

  return (data || [])
    .map((m: any) => m?.user_id as string | undefined)
    .filter((id): id is string => !!id);
}
