-- Add runner_api_key to workspace_dedicated_device.
--
-- Phase 1 of per-workspace runner routing: ops can now record the API key
-- for a workspace's dedicated runner alongside the URL. The backend reads
-- this key to authenticate MobileRunnerClient calls on sessions pinned to
-- that runner. Nullable — existing rows and the shared-pool path are unaffected.
ALTER TABLE workspace_dedicated_device
    ADD COLUMN IF NOT EXISTS runner_api_key TEXT;

COMMENT ON COLUMN workspace_dedicated_device.runner_api_key IS
    'API key for the dedicated runner at runner_url. Null = shared-pool runner (uses env MOBILE_RUNNER_API_KEY).';
