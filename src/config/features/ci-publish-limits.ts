/**
 * Limits for the CI build-publish path, shared by `/ci/app/*` and `/ci/run`'s
 * `appUrl` branch.
 *
 * They live here, not in a controller, because BOTH controllers need them and
 * a constant exported from one HTTP layer into another couples the two for no
 * reason. They were previously declared separately in each file — which is how
 * two callers of one Redis key drifted apart in the first place.
 */

import { env } from '@/config/environment/env';
import type { RedisRateLimitConfig } from '@/middleware/redis-rate-limit.middleware';

/**
 * Hourly publish quota, per project. A ceiling on a runaway pipeline, NOT a
 * storage budget — retention (`BUILD_HISTORY_LIMIT`) is what bounds stored
 * builds. A full matrix is one publish per lane per platform, so this must
 * stay comfortably above (named variants x platforms).
 *
 * A FUNCTION, not a constant carrying a `max` getter. The sibling
 * `CI_WHOAMI_RATE_LIMIT` is spread with `...` at its call site, and the first
 * person to copy that idiom here would evaluate a getter once at module init,
 * silently pinning `MAX_CI_PUBLISHES_PER_HOUR` to whatever the environment held
 * then, with nothing failing to reveal it. A fresh object per call makes that
 * mistake unrepresentable.
 */
export function ciPublishRateLimit(): RedisRateLimitConfig {
  const n = env.MAX_CI_PUBLISHES_PER_HOUR;
  return {
    prefix: 'ci_publish_rate:',
    windowSec: 3600,
    max: Number.isFinite(n) && n > 0 ? Math.floor(n) : 30,
    // DENY on an unreachable limiter: this endpoint mints signed storage-WRITE
    // URLs, and an object whose finalize never runs is collected by nothing
    // (`cleanupOrphan` only runs from finalize; `pruneOldBuilds` only reclaims
    // storage for rows it prunes). Failing open buys no real availability
    // either — Redis down means BullMQ down, so no CI run could execute anyway.
    onUnavailable: 'deny',
    logTag: 'CI_APP',
  };
}

/**
 * Per-project in-flight mutex around anything that FINALIZES a build.
 *
 * `finalizeMobileAppUpload` reads `project.settings`, spends 13-26s parsing the
 * binary, then writes a patch rebuilt from that now-stale snapshot, and
 * `ProjectService.updateProject` merges settings shallowly — so two overlapping
 * publishes silently drop one lane's `mobileAppVariants` entry. The old
 * 1-per-5-minutes upload gate was the only thing preventing that overlap.
 *
 * A contender WAITS rather than being rejected: a matrix pipeline publishing
 * android + ios in parallel jobs is the normal case, and a 429 there fails the
 * customer's build. The wait stays well below the ingress timeout (finalize is
 * 13-26s, so ~3 can stack inside 90s).
 */
export const CI_PUBLISH_LOCK = {
  prefix: 'ci_publish_lock:',
  /** Crash ceiling for one download+parse, not an expected duration. */
  ttlSec: 600,
  waitMs: 90_000,
};

/**
 * Per-storagePath mutex on `finalize`. Rejects immediately rather than waiting:
 * the same upload submitted twice is a duplicate, not a queue — waiting would
 * record the same binary twice whenever the pipeline supplied no commitSha for
 * the unique constraint to catch.
 */
export const CI_FINALIZE_LOCK = {
  prefix: 'ci_apk_finalize:',
  ttlSec: 600,
};

/** Per-IP limit on `whoami`. Read-only and pre-auth, so it fails OPEN. */
export const CI_WHOAMI_RATE_LIMIT: RedisRateLimitConfig = {
  prefix: 'ci_whoami_rate:',
  windowSec: 60,
  max: 30,
  onUnavailable: 'allow' as const,
  logTag: 'CI_APP',
};
