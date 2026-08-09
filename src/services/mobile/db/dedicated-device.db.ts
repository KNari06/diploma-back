/**
 * Data-access for `workspace_dedicated_device` — the workspace → dedicated
 * runner device map (Phase 1 of dedicated-emulator-per-workspace).
 *
 * db/ sublayer contract: queries + row→type mapping only. No business logic,
 * no service calls. Reads go through `supabaseAdmin` (service role) — the
 * table's RLS is owner-only and exists purely to guard direct PostgREST
 * access; the backend is trusted here.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface DedicatedDeviceRow {
  platform: 'android' | 'ios';
  runnerSerial: string;
  runnerUrl: string | null;
  runnerApiKey: string | null;
}

/**
 * Fetch the ACTIVE dedicated-device row for a workspace, or null when the
 * workspace has none (the common case — most workspaces use the shared pool).
 *
 * Never throws: a DB error degrades to null so the caller falls back to the
 * shared pool rather than failing the test path.
 */
/**
 * ALL active devices pinned to a workspace, oldest first.
 *
 * Deliberately NOT `.maybeSingle()`: a workspace may pin several devices so a
 * regression can run while someone is in the editor. `maybeSingle` ERRORS on
 * more than one row, and the catch below turns any error into "no dedicated
 * device" — which would silently drop the workspace onto the shared pool and
 * lose the isolation the pinning exists to provide. The failure would be
 * invisible: a green run on the wrong device.
 *
 * Order is stable (`created_at`) so callers try devices in the same sequence
 * every time — an unordered scan makes a DEVICE_BUSY retry pick at random and
 * turns "which device ran my test" into a coin flip in the traces.
 */
export async function getActiveDedicatedDevices(
  workspaceId: string,
): Promise<DedicatedDeviceRow[]> {
  if (!workspaceId) return [];

  const { data, error } = await supabaseAdmin
    .from('workspace_dedicated_device')
    .select('platform, runner_serial, runner_url, runner_api_key')
    .eq('workspace_id', workspaceId)
    .eq('is_active', true)
    .order('created_at', { ascending: true });

  if (error) {
    logger.warn('[DEDICATED_DEVICE_DB] Lookup failed — treating as no dedicated device', {
      workspaceId,
      error: error.message,
    });
    return [];
  }

  return (data ?? []).map((row) => ({
    platform: row.platform as 'android' | 'ios',
    runnerSerial: row.runner_serial,
    runnerUrl: row.runner_url ?? null,
    runnerApiKey: row.runner_api_key ?? null,
  }));
}
