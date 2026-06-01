/**
 * Pure classifier for fast-auth snapshot restore errors.
 *
 * Determines whether a restore failure should:
 *   - `invalidate_snapshot` — strip the snapshot; it is the root cause
 *   - `config_bug`          — runner rejected due to user config; snapshot is fine
 *   - `transient`           — runner/network blip; leave snapshot, retry next run
 *   - `unknown`             — unrecognised shape; be conservative, leave snapshot
 *
 * The `code` field (from `MobileRunnerError`) is the authoritative signal —
 * status code alone is not sufficient because a future runner version could
 * ship a 400 for a non-config issue.
 *
 * See mobile-test-run.job.ts Phase 3c for the full decision tree rationale.
 */

export type FastAuthErrorCategory =
  | 'invalidate_snapshot'
  | 'config_bug'
  | 'transient'
  | 'unknown';

/**
 * Classify a fast-auth restore error.
 *
 * @param code       - `MobileRunnerError.code` (undefined for non-runner errors)
 * @param statusCode - HTTP status from the runner (undefined for network errors)
 */
export function categorizeFastAuthError(
  code: string | undefined,
  statusCode: number | undefined,
): FastAuthErrorCategory {
  const shouldInvalidate =
    code === 'SNAPSHOT_TOO_LARGE' || code === 'SNAPSHOT_PRIVILEGE';
  if (shouldInvalidate) return 'invalidate_snapshot';

  const isConfigBug =
    code === 'PACKAGE_NAME_MISMATCH' || code === 'PLATFORM_UNSUPPORTED';
  if (isConfigBug) return 'config_bug';

  const isTransient = !code && (!statusCode || statusCode >= 500);
  if (isTransient) return 'transient';

  return 'unknown';
}
