/**
 * Phase 4 (May 2026) — Unit tests for the mobile-regression concurrency
 * decision function.
 *
 * Pure unit tests: no supabase, no HTTP, no BullMQ. The `RunnerCapacityProbe`
 * interface lets us stub the runner with a minimal `{ getCapacity }` mock.
 * Jest startup stays in the low-seconds range because we never load the
 * full regression service or the real `MobileRunnerClient`.
 */

import {
  decideMaxMobileInFlight,
  countMobileTests,
  dominantMobilePlatform,
  envCapMobile,
  type RunnerCapacityProbe,
  type ConcurrencyInput,
} from '../concurrency-decision';

// ── Mock capacity factory ────────────────────────────────────────────────

function fakeCapacity(opts?: {
  androidIdle?: number;
  androidTotal?: number;
  androidBusy?: number;
  poolNull?: boolean;
  mode?: 'pool' | 'classic';
}): RunnerCapacityProbe {
  return {
    async getCapacity() {
      return {
        pool: opts?.poolNull
          ? null
          : {
              android: {
                total: opts?.androidTotal ?? 3,
                idle: opts?.androidIdle ?? 3,
                busy: opts?.androidBusy ?? 0,
              },
              ios: null,
            },
        adhoc: { maxSessions: 10, activeSessions: 0, available: 10 },
        mode: opts?.mode ?? 'pool',
      };
    },
  };
}

function rejectingCapacity(message = 'runner unreachable'): RunnerCapacityProbe {
  return {
    async getCapacity() {
      throw new Error(message);
    },
  };
}

// ── decideMaxMobileInFlight ──────────────────────────────────────────────

describe('decideMaxMobileInFlight', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('envCap=1 forces serial regardless of pool/testCount', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '1';
    const d = await decideMaxMobileInFlight({
      testCount: 50,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 5 }),
    });
    expect(d.cap).toBe(1);
    expect(d.reason).toMatch(/force-serial/);
    expect(d.inputs.envCap).toBe(1);
  });

  it('envCap unset defaults to 1 (matches pre-Phase-4 behaviour)', async () => {
    delete process.env.REGRESSION_MOBILE_MAX_CONCURRENCY;
    const d = await decideMaxMobileInFlight({
      testCount: 10,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 3 }),
    });
    expect(d.cap).toBe(1);
  });

  it('testCount=1 → serial (parallelism overhead wasted)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 1,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 3 }),
    });
    expect(d.cap).toBe(1);
    expect(d.reason).toMatch(/testCount=1/);
  });

  it('platform=none → serial', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 0,
      platform: 'none',
      runnerClient: fakeCapacity(),
    });
    expect(d.cap).toBe(1);
  });

  it('platform=ios → serial (no iOS pool capacity in prod)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 10,
      platform: 'ios',
      runnerClient: fakeCapacity({ androidIdle: 5 }),
    });
    expect(d.cap).toBe(1);
    expect(d.reason).toMatch(/ios/);
  });

  it('getCapacity rejects → serial + warn (never throws)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 10,
      platform: 'android',
      runnerClient: rejectingCapacity(),
    });
    expect(d.cap).toBe(1);
    expect(d.reason).toBe('getCapacity-failed');
  });

  it('classic mode (pool=null) → serial', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 10,
      platform: 'android',
      runnerClient: fakeCapacity({ poolNull: true, mode: 'classic' }),
    });
    expect(d.cap).toBe(1);
    expect(d.reason).toMatch(/classic|pool-disabled/);
  });

  it('poolIdle=1 (insufficient headroom) → serial', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 10,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 1, androidBusy: 2 }),
    });
    expect(d.cap).toBe(1);
    expect(d.reason).toMatch(/poolIdle=1/);
  });

  it('small batch (testCount<=5) → min(envCap, poolIdle, smallCap=2)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '5';
    const d = await decideMaxMobileInFlight({
      testCount: 4,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 3 }),
    });
    expect(d.cap).toBe(2);
    expect(d.reason).toMatch(/desired=2/);
  });

  it('large batch (testCount>5) → min(envCap, poolIdle, largeCap=3)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '5';
    const d = await decideMaxMobileInFlight({
      testCount: 20,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 5 }),
    });
    expect(d.cap).toBe(3);
    expect(d.reason).toMatch(/desired=3/);
  });

  it('envCap tightens the result (envCap=2 < poolIdle=10 < desired=3)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '2';
    const d = await decideMaxMobileInFlight({
      testCount: 20,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 10 }),
    });
    expect(d.cap).toBe(2);
  });

  it('poolIdle tightens the result (poolIdle=2 < envCap=5 < desired=3)', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '5';
    const d = await decideMaxMobileInFlight({
      testCount: 20,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 2 }),
    });
    expect(d.cap).toBe(2);
  });

  it('env-overridable tunables: SMALL_BATCH_THRESHOLD + SMALL_CAP take effect', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '5';
    process.env.REGRESSION_MOBILE_SMALL_BATCH_THRESHOLD = '10';
    process.env.REGRESSION_MOBILE_SMALL_CAP = '4';
    const d = await decideMaxMobileInFlight({
      testCount: 8, // under override threshold of 10
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 5 }),
    });
    expect(d.cap).toBe(4);
    expect(d.reason).toMatch(/desired=4/);
  });

  it('mixed platform → still uses android pool capacity for the decision', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 10,
      platform: 'mixed',
      runnerClient: fakeCapacity({ androidIdle: 3 }),
    });
    expect(d.cap).toBe(3);
    expect(d.inputs.poolIdle).toBe(3);
  });

  it('decision result always carries the inputs payload for log analysis', async () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    const d = await decideMaxMobileInFlight({
      testCount: 7,
      platform: 'android',
      runnerClient: fakeCapacity({ androidIdle: 3 }),
    });
    expect(d.inputs).toEqual({
      envCap: 3,
      poolIdle: 3,
      testCount: 7,
      platform: 'android',
    });
  });
});

// ── envCapMobile (audit fix #2: NaN-safe env parsing) ────────────────────

describe('envCapMobile (NaN-safe parsing for fallback path)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('returns 1 when env var is unset', () => {
    delete process.env.REGRESSION_MOBILE_MAX_CONCURRENCY;
    expect(envCapMobile()).toBe(1);
  });

  it('returns the parsed value when env var is a valid positive integer', () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '3';
    expect(envCapMobile()).toBe(3);
  });

  it('returns 1 when env var is a non-numeric string (was NaN bug)', () => {
    // Pre-audit: Math.max(1, parseInt('abc')) returned NaN, which silently
    // disabled the inFlight cap. This test pins NaN-safe behaviour.
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = 'abc';
    expect(envCapMobile()).toBe(1);
  });

  it('returns 1 when env var is an empty string', () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '';
    expect(envCapMobile()).toBe(1);
  });

  it('returns 1 when env var is 0 (need >=1)', () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '0';
    expect(envCapMobile()).toBe(1);
  });

  it('returns 1 when env var is negative', () => {
    process.env.REGRESSION_MOBILE_MAX_CONCURRENCY = '-5';
    expect(envCapMobile()).toBe(1);
  });
});

// ── countMobileTests ─────────────────────────────────────────────────────

describe('countMobileTests', () => {
  it('returns 0 for empty levels', () => {
    expect(countMobileTests([])).toBe(0);
  });

  it('returns 0 when no mobile tests present', () => {
    expect(countMobileTests([
      [{ platform: 'web_ui' }, { platform: 'api' }],
      [{ platform: 'web_ui' }],
    ])).toBe(0);
  });

  it('counts mobile tests across all levels', () => {
    expect(countMobileTests([
      [{ platform: 'mobile_android' }, { platform: 'web_ui' }],
      [{ platform: 'mobile_ios' }, { platform: 'mobile_flutter' }, { platform: 'api' }],
    ])).toBe(3);
  });

  it('treats missing platform as non-mobile', () => {
    expect(countMobileTests([
      [{ platform: undefined }, { platform: 'mobile_android' }],
    ])).toBe(1);
  });
});

// ── dominantMobilePlatform ───────────────────────────────────────────────

describe('dominantMobilePlatform', () => {
  it('returns "none" when no mobile tests', () => {
    expect(dominantMobilePlatform([
      [{ platform: 'web_ui' }, { platform: 'api' }],
    ])).toBe('none');
  });

  it('returns "none" for fully empty input', () => {
    expect(dominantMobilePlatform([])).toBe('none');
    expect(dominantMobilePlatform([[]])).toBe('none');
  });

  it('returns "android" for android-only', () => {
    expect(dominantMobilePlatform([
      [{ platform: 'mobile_android' }, { platform: 'mobile_android' }],
    ])).toBe('android');
  });

  it('returns "android" when flutter is mixed in (flutter buckets as android)', () => {
    expect(dominantMobilePlatform([
      [{ platform: 'mobile_android' }, { platform: 'mobile_flutter' }],
    ])).toBe('android');
  });

  it('returns "ios" for ios-only', () => {
    expect(dominantMobilePlatform([
      [{ platform: 'mobile_ios' }],
    ])).toBe('ios');
  });

  it('returns "mixed" for android + ios in the same run', () => {
    expect(dominantMobilePlatform([
      [{ platform: 'mobile_android' }, { platform: 'mobile_ios' }],
    ])).toBe('mixed');
  });

  it('ignores web / api / undefined platforms when determining dominance', () => {
    expect(dominantMobilePlatform([
      [{ platform: 'web_ui' }, { platform: 'api' }, { platform: undefined }, { platform: 'mobile_android' }],
    ])).toBe('android');
  });
});
