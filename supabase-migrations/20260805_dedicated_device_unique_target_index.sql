-- One physical device can be dedicated to at most ONE workspace at a time.
--
-- `workspace_dedicated_device` already has `workspace_id UNIQUE` — a workspace
-- cannot be pinned to two devices. The reverse was unguarded: nothing stopped
-- two rows from naming the same (runner_url, runner_serial). That is the exact
-- failure the dedicated-emulator feature exists to prevent — two workspaces
-- sharing one redroid container, seeing each other's app state, racing on the
-- same ADB connection. Ops populates this table by hand (see
-- features/workspace-dedicated-device.sql), so a typo was one INSERT away from
-- silently un-isolating two customers.
--
-- Partial on `is_active`: deactivated rows are history, and a device freed by
-- flipping `is_active = false` must be re-assignable. `is_active` is
-- NOT NULL DEFAULT true, so there is no third state that quietly escapes the
-- index.
--
-- coalesce(runner_url, ''): a NULL `runner_url` means "the shared-pool runner
-- from env" (Model A — the column is reserved for per-workspace runners). Two
-- workspaces both pinned to a serial on that same default runner collide just
-- as hard as two on an explicit URL, so NULLs must compare equal here — which
-- a plain UNIQUE would not do.
--
-- lower(rtrim(url, '/')): `http://10.0.0.5:8080` and `http://10.0.0.5:8080/`
-- are the same runner but different strings, and the trailing slash does occur
-- in practice — runnerUrlToSocketUrl (services/mobile/session-runner-routing.ts)
-- strips it explicitly. Without normalisation the index is bypassable by a
-- keystroke. All three functions are IMMUTABLE, so they are legal in an index.
--
-- `platform` is deliberately NOT in the key: an Android serial is 'host:port'
-- and an iOS one is a UDID, so the target tuple is already unambiguous, and
-- including platform would let the same container be claimed twice under two
-- platform labels.
--
-- Plain CREATE INDEX, not CONCURRENTLY: this table holds one row per
-- dedicated-emulator customer (single digits today) and is written only by
-- ops, so the lock is momentary — and CONCURRENTLY cannot run inside the
-- transaction block the migration path may wrap this in. Same reasoning as
-- 20260727_projects_ci_api_key_hash_index.sql.
--
-- Verified before writing: no existing active duplicates.
--   select coalesce(runner_url,''), runner_serial, count(*)
--   from workspace_dedicated_device where is_active
--   group by 1,2 having count(*) > 1;   -- 0 rows

CREATE UNIQUE INDEX IF NOT EXISTS uniq_dedicated_device_target
  ON workspace_dedicated_device (lower(coalesce(rtrim(runner_url, '/'), '')), runner_serial)
  WHERE is_active;

COMMENT ON INDEX uniq_dedicated_device_target IS
  'One active dedicated device per (runner_url, runner_serial). URL is normalised (lower, no trailing slash) and NULL collapses to the shared-pool runner. Does NOT cover shared-pool exclusion — that lives in the runner env POOL_ANDROID_EXCLUDED_PORTS.';
