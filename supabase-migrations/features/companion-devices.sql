-- Companion devices: physical phones linked via the companion CLI (ADR-0009).
-- Each row represents one paired device; refresh_token_hash is SHA-256 of the
-- raw token stored on the companion. revoked_at IS NOT NULL means the device
-- cannot refresh access tokens.

CREATE TABLE IF NOT EXISTS companion_devices (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  device_label       TEXT NOT NULL,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  created_at         TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMP WITH TIME ZONE,
  revoked_at         TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS companion_devices_user_id_idx ON companion_devices(user_id);
CREATE INDEX IF NOT EXISTS companion_devices_refresh_token_hash_idx ON companion_devices(refresh_token_hash);

ALTER TABLE companion_devices ENABLE ROW LEVEL SECURITY;

-- Users can read and delete their own devices; inserts and revocation
-- happen only via service role (backend), never directly from the client.
CREATE POLICY "companion_devices_select_own"
  ON companion_devices FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "companion_devices_delete_own"
  ON companion_devices FOR DELETE
  USING (auth.uid() = user_id);
