import { cacheMetrics } from '../cache-metrics';

// The module keeps process-global counters with no per-test reset for the
// lifetime map, so every test uses a unique cache name to stay isolated.
let n = 0;
const uniqueCache = () => `test-cache-${n++}`;

describe('cacheMetrics.inc + snapshot', () => {
  it('counts increments into the named bucket', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'hit');
    cacheMetrics.inc(c, 'hit');
    cacheMetrics.inc(c, 'miss');
    const snap = cacheMetrics.snapshot(c);
    expect(snap.intervalCounts).toEqual({ hit: 2, miss: 1 });
    expect(snap.intervalTotal).toBe(3);
  });

  it('supports a custom increment amount', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'hit', 5);
    expect(cacheMetrics.snapshot(c).intervalCounts.hit).toBe(5);
  });

  it('returns an empty snapshot for an unknown cache', () => {
    const snap = cacheMetrics.snapshot('never-touched-cache');
    expect(snap.intervalCounts).toEqual({});
    expect(snap.intervalTotal).toBe(0);
    expect(snap.intervalHitRatio).toBeUndefined();
  });

  it('computes a hit ratio when both hit and miss buckets exist', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'hit', 3);
    cacheMetrics.inc(c, 'miss', 1);
    expect(cacheMetrics.snapshot(c).intervalHitRatio).toBe(0.75);
  });

  it('rounds the hit ratio to two decimals', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'hit', 1);
    cacheMetrics.inc(c, 'miss', 2);
    expect(cacheMetrics.snapshot(c).intervalHitRatio).toBe(0.33);
  });

  it('omits the hit ratio for reason-only buckets', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'ttl_expired', 4);
    const snap = cacheMetrics.snapshot(c);
    expect(snap.intervalTotal).toBe(4);
    expect(snap.intervalHitRatio).toBeUndefined();
  });
});

describe('cacheMetrics.dumpNow', () => {
  it('resets interval counters but preserves lifetime counters', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'hit', 2);
    cacheMetrics.inc(c, 'miss', 1);

    cacheMetrics.dumpNow();

    const after = cacheMetrics.snapshot(c);
    expect(after.intervalTotal).toBe(0);
    expect(after.intervalCounts).toEqual({});
    expect(after.lifetimeCounts).toEqual({ hit: 2, miss: 1 });
    expect(after.lifetimeTotal).toBe(3);
    expect(after.lifetimeHitRatio).toBe(0.67);
  });

  it('keeps accumulating lifetime totals across intervals', () => {
    const c = uniqueCache();
    cacheMetrics.inc(c, 'hit', 1);
    cacheMetrics.dumpNow();
    cacheMetrics.inc(c, 'hit', 1);
    const snap = cacheMetrics.snapshot(c);
    expect(snap.intervalCounts.hit).toBe(1);
    expect(snap.lifetimeCounts.hit).toBe(2);
  });
});
