import { supabaseAdmin } from '@/db/supabase';

export interface CompanionDevice {
  id: string;
  userId: string;
  deviceLabel: string;
  refreshTokenHash: string;
  createdAt: Date;
  lastSeenAt: Date | null;
  revokedAt: Date | null;
}

export async function createCompanionDevice(params: {
  userId: string;
  deviceLabel: string;
  refreshTokenHash: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabaseAdmin
    .from('companion_devices')
    .insert({
      user_id: params.userId,
      device_label: params.deviceLabel,
      refresh_token_hash: params.refreshTokenHash,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Failed to create companion device: ${error?.message}`);
  return { id: data.id };
}

export async function getCompanionDeviceByRefreshHash(hash: string): Promise<CompanionDevice | null> {
  const { data, error } = await supabaseAdmin
    .from('companion_devices')
    .select('id, user_id, device_label, refresh_token_hash, created_at, last_seen_at, revoked_at')
    .eq('refresh_token_hash', hash)
    .maybeSingle();
  if (error) throw new Error(`Failed to look up companion device: ${error.message}`);
  if (!data) return null;
  return {
    id: data.id,
    userId: data.user_id,
    deviceLabel: data.device_label,
    refreshTokenHash: data.refresh_token_hash,
    createdAt: new Date(data.created_at),
    lastSeenAt: data.last_seen_at ? new Date(data.last_seen_at) : null,
    revokedAt: data.revoked_at ? new Date(data.revoked_at) : null,
  };
}

export async function revokeCompanionDevice(deviceId: string, userId: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from('companion_devices')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', deviceId)
    .eq('user_id', userId)
    .is('revoked_at', null)
    .select('id')
    .maybeSingle();
  if (error) throw new Error(`Failed to revoke companion device: ${error.message}`);
  return !!data;
}

// Stamp a device's last activity. Called from the token-refresh path (the
// companion refreshes ~every 25 min), so `last_seen_at` reflects a live device
// instead of staying null forever. Best-effort — callers fire-and-forget.
export async function touchCompanionDeviceLastSeen(deviceId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from('companion_devices')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', deviceId);
  if (error) throw new Error(`Failed to touch companion device last_seen_at: ${error.message}`);
}
