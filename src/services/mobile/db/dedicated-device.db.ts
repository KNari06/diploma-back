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
export async function getActiveDedicatedDevice(
  workspaceId: string,
): Promise<DedicatedDeviceRow | null> {
  if (!workspaceId) return null;

  const { data, error } = await supabaseAdmin
    .from('workspace_dedicated_device')
    .select('platform, runner_serial, runner_url, runner_api_key')
    .eq('workspace_id', workspaceId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) {
    logger.warn('[DEDICATED_DEVICE_DB] Lookup failed — treating as no dedicated device', {
      workspaceId,
      error: error.message,
    });
    return null;
  }
  if (!data) return null;

  return {
    platform: data.platform as 'android' | 'ios',
    runnerSerial: data.runner_serial,
    runnerUrl: data.runner_url ?? null,
    runnerApiKey: data.runner_api_key ?? null,
  };
}
