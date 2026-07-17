import { supabaseAdmin } from '@/db/supabase';

/**
 * db/ sublayer for the per-app screen-graph skeleton (mobile_app_skeletons).
 * Pure Supabase reads/writes + row↔type mapping — no merge logic (that lives in
 * app-skeleton.service.ts). Callers wrap in try/catch.
 */

export type SkeletonPlatform = 'mobile_android' | 'mobile_ios' | 'mobile_flutter';

/** One screen in the stored map. Mirrors the wire `mobile.graph` node, trimmed
 *  to what a navigation/scenario map needs (no screenshot pixels). */
export interface SkeletonScreen {
  fingerprint: string;
  name: string;
  purpose?: string;
  isTerminal?: boolean;
  visitCount: number;
  /** `checks` is the QA "what to verify" spec for a control scenario
   *  (slider/select/toggle) — persisted so a later "what can I test here" query
   *  starts with real assertions, not just a name. Absent for simple scenarios. */
  scenarios: Array<{ name: string; kind: string; status: string; checks?: string[] }>;
}

/** One navigable transition. Lossy by design — carries the action label the
 *  agent needs to understand the map, NOT the replayable IntentStep. */
export interface SkeletonTransition {
  from: string;
  to: string;
  action: string;
  description: string;
}

/** The natural key. */
export interface SkeletonKey {
  projectId: string;
  platform: SkeletonPlatform;
  packageName: string;
}

/** A stored skeleton row, mapped to camelCase. */
export interface AppSkeletonRow {
  id: string;
  projectId: string;
  platform: SkeletonPlatform;
  packageName: string;
  fingerprintVersion: number;
  screens: SkeletonScreen[];
  transitions: SkeletonTransition[];
  rootFingerprint: string | null;
  domainGuess: string | null;
  screenCount: number;
  runCount: number;
  bestCoverageScore: number;
  lastRunId: string | null;
  firstSeenAt: string;
  updatedAt: string;
}

/** Fields the service writes on an upsert (merge result). */
export interface AppSkeletonUpsert extends SkeletonKey {
  fingerprintVersion: number;
  screens: SkeletonScreen[];
  transitions: SkeletonTransition[];
  rootFingerprint?: string | null;
  domainGuess?: string | null;
  screenCount: number;
  runCount: number;
  bestCoverageScore: number;
  lastRunId?: string | null;
}

function mapRow(r: Record<string, unknown>): AppSkeletonRow {
  return {
    id: r.id as string,
    projectId: r.project_id as string,
    platform: r.platform as SkeletonPlatform,
    packageName: r.package_name as string,
    fingerprintVersion: (r.fingerprint_version as number) ?? 0,
    screens: (r.screens as SkeletonScreen[]) ?? [],
    transitions: (r.transitions as SkeletonTransition[]) ?? [],
    rootFingerprint: (r.root_fingerprint as string | null) ?? null,
    domainGuess: (r.domain_guess as string | null) ?? null,
    screenCount: (r.screen_count as number) ?? 0,
    runCount: (r.run_count as number) ?? 0,
    bestCoverageScore: (r.best_coverage_score as number) ?? 0,
    lastRunId: (r.last_run_id as string | null) ?? null,
    firstSeenAt: r.first_seen_at as string,
    updatedAt: r.updated_at as string,
  };
}

/** Owner + workspace of a project — the read-side access gate for the skeleton
 *  (which is keyed by project_id and carries no user_id of its own). Mirrors
 *  regression's `getProjectForAccess`. Null when the project doesn't exist. */
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

/** Load the skeleton for one app in one project, or null if none yet. */
export async function fetchAppSkeleton(key: SkeletonKey): Promise<AppSkeletonRow | null> {
  const { data, error } = await supabaseAdmin
    .from('mobile_app_skeletons')
    .select('*')
    .eq('project_id', key.projectId)
    .eq('platform', key.platform)
    .eq('package_name', key.packageName)
    .maybeSingle();

  if (error) throw error;
  return data ? mapRow(data as Record<string, unknown>) : null;
}

/**
 * Upsert the merged skeleton on its natural key. `first_seen_at` is set only on
 * insert (DB default) and preserved on update via onConflict; `updated_at` is
 * bumped to now on every write.
 */
export async function upsertAppSkeleton(row: AppSkeletonUpsert): Promise<void> {
  const { error } = await supabaseAdmin
    .from('mobile_app_skeletons')
    .upsert(
      {
        project_id: row.projectId,
        platform: row.platform,
        package_name: row.packageName,
        fingerprint_version: row.fingerprintVersion,
        screens: row.screens,
        transitions: row.transitions,
        root_fingerprint: row.rootFingerprint ?? null,
        domain_guess: row.domainGuess ?? null,
        screen_count: row.screenCount,
        run_count: row.runCount,
        best_coverage_score: row.bestCoverageScore,
        last_run_id: row.lastRunId ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'project_id,platform,package_name' },
    );

  if (error) throw error;
}
