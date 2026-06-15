import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for self-serve provisioning.
 * Pure Supabase queries — no business logic, no orchestration.
 * Each function throws on DB/network error; the calling service wraps in try/catch.
 */

export interface ApprovedUserRow {
  id: string;
  email: string | null;
  name: string | null;
}

/**
 * Approve a user who is awaiting approval. Scoped to `pending_approval` only,
 * so a manual 'rejected' or already-'approved' row is never touched. Returns
 * the freshly-approved row (id + email + name) when the pending→approved
 * transition just happened, or null when nothing was updated (not pending).
 * The email/name let the caller send the approval email exactly once, on the
 * transition, without a second query.
 */
export async function approvePendingUser(userId: string): Promise<ApprovedUserRow | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .update({ status: 'approved', updated_at: new Date().toISOString() })
    .eq('id', userId)
    .eq('status', 'pending_approval')
    .select('id, email, name');

  if (error) throw error;
  return data?.[0] ?? null;
}

/**
 * Read a user's approval status ('pending_approval' | 'approved' | 'rejected').
 * Returns null when the row is missing.
 */
export async function fetchUserStatus(userId: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('status')
    .eq('id', userId)
    .maybeSingle();

  if (error) throw error;
  return (data?.status as string | undefined) ?? null;
}

/**
 * Mark a workspace's onboarding as completed by merging the flag into the
 * existing settings object. Read-then-write: under concurrent writes for the
 * same workspace the last write wins, which is acceptable here — this only
 * sets onboarding flags during provisioning, never user-edited settings.
 */
export async function markWorkspaceOnboardingCompleted(workspaceId: string): Promise<void> {
  const { data: ws, error: readError } = await supabaseAdmin
    .from('workspaces')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle();

  if (readError) throw readError;

  const settings = {
    ...((ws?.settings as Record<string, unknown>) || {}),
    onboarding_completed: true,
    onboarding_completed_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from('workspaces')
    .update({ settings })
    .eq('id', workspaceId);

  if (error) throw error;
}

/**
 * Verify a project belongs to a workspace. Returns true when a matching row
 * exists. Used to reject cross-workspace projectId values before they reach
 * the exploration queue (IDOR guard).
 */
export async function projectBelongsToWorkspace(
  projectId: string,
  workspaceId: string
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('projects')
    .select('id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();

  if (error) throw error;
  return !!data;
}

/**
 * Merge the lightweight B2C profile (role + goal/source) into a workspace's
 * settings and flag profile_completed. Read-then-write merge so existing
 * settings (incl. onboarding flags) are preserved. Scoped to the owning user.
 */
export async function saveWorkspaceProfile(
  workspaceId: string,
  userId: string,
  profile: { role?: string; goal?: string; source?: string }
): Promise<void> {
  const { data: ws, error: readError } = await supabaseAdmin
    .from('workspaces')
    .select('settings')
    .eq('id', workspaceId)
    .eq('user_id', userId)
    .maybeSingle();

  if (readError) throw readError;

  const settings = {
    ...((ws?.settings as Record<string, unknown>) || {}),
    ...(profile.role !== undefined ? { role: profile.role } : {}),
    ...(profile.goal !== undefined ? { goal: profile.goal } : {}),
    ...(profile.source !== undefined ? { acquisition_source: profile.source } : {}),
    profile_completed: true,
    profile_completed_at: new Date().toISOString(),
  };

  const { error } = await supabaseAdmin
    .from('workspaces')
    .update({ settings })
    .eq('id', workspaceId)
    .eq('user_id', userId);

  if (error) throw error;
}
