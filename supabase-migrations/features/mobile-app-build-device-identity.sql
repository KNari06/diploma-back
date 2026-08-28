-- ─────────────────────────────────────────────────────────────────────────
-- mobile_app_builds: remember what a build ACTUALLY becomes on a device
--
-- Problem this solves
-- -------------------
-- Before installing an app the backend asks "is this exact build already on
-- the slot?". Until now the only answer came from Redis (`WARMUP_PREFIX` /
-- `INSTALLED_BUILD_PREFIX`), and that Redis runs with `--maxmemory-policy
-- allkeys-lru` and NO volume attached — so the record is evictable at any
-- moment regardless of its 30-day TTL, and does not survive a restart.
--
-- When the record is gone the code does the right thing and reinstalls
-- rather than trusting package presence (see mobile-app-prep.service.ts —
-- "no record of which build is installed"). But for a large APK that is not
-- merely slow. On 2026-08-28 it was a dead end: Klara's 324 MB build made the
-- backend exceed its 2 GiB memory limit and be OOM-killed (exit 137) partway
-- through, three retries in a row, while the build it was trying to install
-- was ALREADY on the device.
--
-- Why these two columns
-- ---------------------
-- They record what the DEVICE reported after this build was installed
-- successfully — not something derived from the APK. Deriving it was the
-- obvious alternative and was rejected: these APKs are signed with scheme v2,
-- where the certificate lives in the APK Signing Block rather than
-- META-INF/*.RSA, so reproducing the device's digest would mean parsing
-- PKCS#7 and the signing-block format in the upload path. Recording the
-- observation is exact, cheap, and cannot drift from what the device will
-- report next time.
--
-- `signer_sha256` and not just a version: two builds can share a versionCode
-- and be different apps to us. JanaPost shipped release and debug builds both
-- at 426, differing only by signing key; matching on version alone kept the
-- release build in place and Flutter attach failed with FLUTTER_NOT_DETECTED,
-- because a release build ships no Dart VM Service.
--
-- Both are NULL until the first successful install of that build, and NULL
-- means "unknown" — which callers must treat as "reinstall", never as a match.
-- ─────────────────────────────────────────────────────────────────────────

ALTER TABLE public.mobile_app_builds
  ADD COLUMN IF NOT EXISTS signer_sha256 text,
  ADD COLUMN IF NOT EXISTS observed_version_code integer,
  ADD COLUMN IF NOT EXISTS identity_observed_at timestamptz;

COMMENT ON COLUMN public.mobile_app_builds.signer_sha256 IS
  'SHA-256 of the signing certificate, colon-separated uppercase hex, exactly as the device prints it in `dumpsys package`. Observed after a successful install — never derived from the APK. NULL = unknown; treat as "reinstall".';

COMMENT ON COLUMN public.mobile_app_builds.observed_version_code IS
  'versionCode the device reported after installing this build. Recorded alongside signer_sha256 so a match requires BOTH: version alone cannot separate a debug from a release build of the same version.';

COMMENT ON COLUMN public.mobile_app_builds.identity_observed_at IS
  'When the identity above was observed. Diagnostic only — staleness does not invalidate it, because the pair is a property of the build artifact, not of the device.';
