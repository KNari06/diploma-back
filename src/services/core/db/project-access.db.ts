/**
 * Owner + workspace of a project — the single read behind the shared
 * project-access gate.
 */

import { supabaseAdmin } from '@/db/supabase';

export async function fetchProjectAccessRow(
  projectId: string,
): Promise<{ userId: string; workspaceId: string | null } | null> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('user_id, workspace_id')
    .eq('id', projectId)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  const row = data as { user_id: string; workspace_id: string | null };
  return { userId: row.user_id, workspaceId: row.workspace_id ?? null };
}
