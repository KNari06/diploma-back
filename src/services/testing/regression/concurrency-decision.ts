/**
 * Phase 4 (May 2026) — Dynamic mobile-regression concurrency decision.
 *
 * Replaces the static `parseInt(REGRESSION_MOBILE_MAX_CONCURRENCY)` cap
 * in `regression-run.service.ts` with a function that takes operator
 * env + real-time pool capacity + test count into account.
 *
 * Decision is computed ONCE at regression start (snapshot-and-go); we
 * don't recompute mid-run. Rationale: multiple regressions can share
 * the pool, so live-updating one run's cap would race against others.
 *
 * Lives in its own module (not as a method on the service) so it can
 * be unit-tested without dragging in supabase, BullMQ, websocket, and
 * the rest of regression-run.service.ts's import graph — same pattern
 * we used for Phase 2 telemetry helpers.
 *
 * See `docs/mobile-test-orchestration-plan.md` Phase 4 for the spec.
 */

import { logger } from '@/utils/core/logger';

// ── Types ────────────────────────────────────────────────────────────────

/**
 * Minimal runner-client surface the decision function needs. We type
 * the parameter against an interface, not the concrete `MobileRunnerClient`
 * class, so unit tests can pass a `{ getCapacity: vi.fn() }` stub without
 * standing up the real HTTP client.
 *
 * The shape mirrors `MobileRunnerClient.getCapacity()` return type as of
 * May 2026; if the runner adds fields later they'll be ignored here.
 */
export interface RunnerCapacityProbe {
  getCapacity(): Promise<{
    pool: {
      android: { total: number; idle: number; busy: number } | null;
      ios: { total: number; idle: number; busy: number } | null;
    } | null;
    adhoc: { maxSessions: number; activeSessions: number; available: number };
    mode: 'pool' | 'classic';
  }>;
}

/** Aggregated platform of a regression's mobile tests. */
export type RegressionMobilePlatform = 'android' | 'ios' | 'mixed' | 'none';

export interface ConcurrencyInput {
  /** Total number of MOBILE tests in the regression (api / web excluded). */
  testCount: number;
  /** Dominant platform across mobile tests. 'none' when no mobile tests. */
  platform: RegressionMobilePlatform;
  /** Runner-client (or test stub) for capacity lookup. */
  runnerClient: RunnerCapacityProbe;
}

export interface ConcurrencyDecision {
  /** Final concurrency cap to use for the regression. Always >= 1. */
  cap: number;
  /** Human-readable rationale (logged so ops can grep the distribution). */
  reason: string;
  /** Raw inputs we considered — surfaced for the structured log line. */
  inputs: {
    envCap: number;
    poolIdle: number | null;
    testCount: number;
    platform: RegressionMobilePlatform;
  };
}

// ── Tunables (env-overridable so DevOps can adjust without redeploy) ─────

function readEnvInt(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v >= 1 ? v : def;
}

/**
 * Hard ceiling from operator. Default 1 (serial) — matches existing
 * behaviour. Exported so the regression service's last-resort
 * fallback path (when `decideMaxMobileInFlight` itself throws) can
 * reuse the same NaN-safe parsing — a naked
 *   `Math.max(1, parseInt(env, 10))`
 * would propagate NaN when the env value is malformed, breaking the
 * downstream `inFlight.size >= cap` gate (NaN comparisons are false,
 * which would dispatch every test in parallel and storm the pool).
 */
export function envCapMobile(): number {
  return readEnvInt('REGRESSION_MOBILE_MAX_CONCURRENCY', 1);
}

/**
 * Test-count threshold separating "small batch" from "large batch".
 *   testCount <= threshold → use SMALL_CAP (default 2)
 *   testCount >  threshold → use LARGE_CAP (default 3)
 * Both subordinate to envCap and poolIdle — they are the *desired* cap,
 * not the absolute one.
 */
const DEFAULT_SMALL_BATCH_THRESHOLD = 5;
const DEFAULT_SMALL_CAP = 2;
const DEFAULT_LARGE_CAP = 3;

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Decide the mobile in-flight cap for a regression run.
 *
 * Never throws — every failure mode falls back to cap=1 (serial), which
 * is byte-identical to the pre-Phase-4 default. So a misbehaving runner
 * can never make regressions WORSE than they were.
 */
export async function decideMaxMobileInFlight(
  input: ConcurrencyInput,
): Promise<ConcurrencyDecision> {
  const envCap = envCapMobile();

  // 1. Operator force-serial — always wins.
  if (envCap <= 1) {
    return mk(1, 'env-cap=1 (operator force-serial)', envCap, null, input);
  }

  // 2. No mobile tests / single mobile test — parallelism overhead is wasted.
  if (input.platform === 'none' || input.testCount <= 1) {
    return mk(1, `testCount=${input.testCount} (parallelism not useful)`, envCap, null, input);
  }

  // 3. iOS-only regression — POOL_IOS_SIZE=0 in current prod, so every
  //    test cold-starts regardless of cap. Parallelism just stacks
  //    cold-starts; serial is fastest here.
  if (input.platform === 'ios') {
    return mk(1, 'platform=ios (no pool capacity in prod)', envCap, null, input);
  }

  // 4. Probe the runner for real-time pool capacity. 5s timeout matches
  //    the existing MobileRunnerClient.getCapacity client timeout. Any
  //    failure → cap=1 (warn + fall back to serial). NEVER throws to
  //    the regression caller — analytics signal lives in the log line.
  let poolIdle: number | null = null;
  try {
    const cap = await input.runnerClient.getCapacity();
    // For 'mixed' regressions we still cap by android pool. iOS sessions
    // cold-start regardless (no prod pool); the bottleneck is android.
    if (cap?.pool?.android) {
      poolIdle = cap.pool.android.idle;
    }
  } catch (err) {
    logger.warn('[REGRESSION_RUN] getCapacity failed — falling back to serial', {
      error: err instanceof Error ? err.message : String(err),
    });
    return mk(1, 'getCapacity-failed', envCap, null, input);
  }

  // 5. Runner reports classic mode (no pool). Every claim is a cold-start;
  //    parallelism would race them on the same hardware. Serial.
  if (poolIdle === null) {
    return mk(1, 'pool-disabled (runner in classic mode)', envCap, null, input);
  }

  // 6. Pool has fewer than 2 idle slots — not enough headroom for
  //    parallelism. Serial keeps things simple.
  if (poolIdle < 2) {
    return mk(1, `poolIdle=${poolIdle} (need >=2 for parallelism)`, envCap, poolIdle, input);
  }

  // 7. All gates passed — choose a cap.
  const smallBatch = readEnvInt('REGRESSION_MOBILE_SMALL_BATCH_THRESHOLD', DEFAULT_SMALL_BATCH_THRESHOLD);
  const smallCap = readEnvInt('REGRESSION_MOBILE_SMALL_CAP', DEFAULT_SMALL_CAP);
  const largeCap = readEnvInt('REGRESSION_MOBILE_LARGE_CAP', DEFAULT_LARGE_CAP);
  const desired = input.testCount <= smallBatch ? smallCap : largeCap;
  const cap = Math.min(envCap, poolIdle, desired);

  return mk(
    cap,
    `chosen min(envCap=${envCap}, poolIdle=${poolIdle}, desired=${desired})`,
    envCap,
    poolIdle,
    input,
  );
}

// ── Pure helpers (also exported for direct use from the regression service) ─

/**
 * Count mobile tests across all topological levels. Web + API tests are
 * excluded — they don't consume the mobile pool, so they're irrelevant
 * to the concurrency decision.
 */
export function countMobileTests(
  levels: Array<Array<{ platform?: string }>>,
): number {
  let n = 0;
  for (const lvl of levels) {
    for (const tc of lvl) {
      if (isMobilePlatformString(tc.platform)) n += 1;
    }
  }
  return n;
}

/**
 * Determine the dominant mobile platform in a regression. Returns:
 *   'none'    — no mobile tests at all
 *   'android' — only Android (or Android-hosted Flutter) tests
 *   'ios'     — only iOS tests
 *   'mixed'   — both Android and iOS tests
 *
 * Why Flutter is bucketed as Android: the runner's `FlutterSession.hostPlatform`
 * can be either Android or iOS at runtime, but from the backend's static
 * type information we can't tell. The default in `dispatchMobileTest`
 * is Android (PLATFORM_MAP at regression-run.service.ts:605-609 maps
 * unknown to 'android'), so treating Flutter as Android here matches
 * what we'd actually claim from the pool.
 */
export function dominantMobilePlatform(
  levels: Array<Array<{ platform?: string }>>,
): RegressionMobilePlatform {
  let android = 0;
  let ios = 0;
  for (const lvl of levels) {
    for (const tc of lvl) {
      const p = tc.platform;
      if (!p) continue;
      if (p === 'mobile_ios') {
        ios += 1;
      } else if (p === 'mobile_android' || p === 'mobile_flutter') {
        android += 1;
      }
      // Other platforms (web_ui, api, undefined) are ignored — they
      // don't contribute to the mobile-platform decision.
    }
  }
  if (android === 0 && ios === 0) return 'none';
  if (android > 0 && ios === 0) return 'android';
  if (ios > 0 && android === 0) return 'ios';
  return 'mixed';
}

// ── Internal ─────────────────────────────────────────────────────────────

/** Inline mobile-platform check. Mirrors the inline pattern used elsewhere
 *  in regression-run.service.ts (no shared `isMobilePlatform` helper exists
 *  yet — see recon notes). */
function isMobilePlatformString(p: string | undefined): boolean {
  return typeof p === 'string' && p.startsWith('mobile_');
}

function mk(
  cap: number,
  reason: string,
  envCap: number,
  poolIdle: number | null,
  input: ConcurrencyInput,
): ConcurrencyDecision {
  return {
    cap,
    reason,
    inputs: {
      envCap,
      poolIdle,
      testCount: input.testCount,
      platform: input.platform,
    },
  };
}
