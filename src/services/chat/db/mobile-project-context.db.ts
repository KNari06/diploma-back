/**
 * DB reads for mobile-project-context.service.ts — queries only, no logic.
 *
 * First db/ sublayer in services/chat. The mobile agent's save path used
 * to query `chat_sessions` inline from tools.ts; the eager resolution
 * moves those reads here so the service stays unit-testable.
 */

import { supabaseAdmin } from '@/db/supabase';

export interface ProjectRowLite {
  id: string;
  name: string;
  workspaceId: string | null;
  userId: string | null;
  settings: Record<string, unknown> | null;
}

export interface TestCaseAuthoringRow {
  id: string;
  name: string;
  projectId: string;
  platform: string | null;
  /** JSON string carrying { appPackage, startActivity } for mobile rows. */
  goal: string | null;
  stepsJson: unknown[];
}

/** Project the chat session is bound to, or null. */
export async function getChatSessionProjectId(
  chatSessionId: string,
): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('chat_sessions')
    .select('project_id')
    .eq('id', chatSessionId)
    .maybeSingle();
  if (error || !data?.project_id) return null;
  return data.project_id as string;
}

/** Single project row with the settings blob (mobileApp metadata lives there). */
export async function getProjectRow(
  projectId: string,
): Promise<ProjectRowLite | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, name, workspace_id, user_id, settings')
    .eq('id', projectId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    name: (data.name as string) ?? '',
    workspaceId: (data.workspace_id as string | null) ?? null,
    userId: (data.user_id as string | null) ?? null,
    settings: (data.settings as Record<string, unknown> | null) ?? null,
  };
}

/** All projects in a workspace — candidates for "which project do you mean?". */
export async function listWorkspaceProjects(
  workspaceId: string,
): Promise<ProjectRowLite[]> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id, name, workspace_id, user_id, settings')
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false })
    .limit(25);
  if (error || !data) return [];
  return (data as Record<string, unknown>[]).map((row) => ({
    id: row.id as string,
    name: (row.name as string) ?? '',
    workspaceId: (row.workspace_id as string | null) ?? null,
    userId: (row.user_id as string | null) ?? null,
    settings: (row.settings as Record<string, unknown> | null) ?? null,
  }));
}

/**
 * The fields the agent needs to extend (not duplicate) an open test case:
 * identity, platform, mobile app metadata (in `goal`), and the saved steps.
 */
export async function getTestCaseAuthoringRow(
  testCaseId: string,
): Promise<TestCaseAuthoringRow | null> {
  const { data, error } = await supabaseAdmin
    .from('intent_test_cases')
    .select('id, name, project_id, platform, goal, steps_json')
    .eq('id', testCaseId)
    .maybeSingle();
  if (error || !data) return null;
  return {
    id: data.id as string,
    name: (data.name as string) ?? '',
    projectId: data.project_id as string,
    platform: (data.platform as string | null) ?? null,
    goal: (data.goal as string | null) ?? null,
    stepsJson: Array.isArray(data.steps_json) ? (data.steps_json as unknown[]) : [],
  };
}
