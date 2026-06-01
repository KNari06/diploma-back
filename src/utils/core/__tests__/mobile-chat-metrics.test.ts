/**
 * Unit tests for mobile-chat-metrics.ts.
 *
 * Pure-function metric primitives — easy to verify in isolation. The
 * dump-loop timer is exercised in a separate scenario that opt-in
 * starts/stops it inside the test (we don't let the module's `unref()`
 * timer keep jest's event loop awake).
 */

import {
  incCounter,
  observeMs,
  snapshotAndReset,
  startDumpLoop,
  stopDumpLoop,
  _resetAllForTests,
} from '../mobile-chat-metrics';

beforeEach(() => {
  _resetAllForTests();
});

afterAll(() => {
  stopDumpLoop();
});

describe('incCounter', () => {
  it('records an increment in both interval and lifetime', () => {
    incCounter('eager_snapshot', 'success');
    const dump = snapshotAndReset();
    const eager = dump.counters.find((c) => c.name === 'eager_snapshot');
    expect(eager).toBeDefined();
    expect(eager!.interval).toEqual({ success: 1 });
    expect(eager!.lifetime).toEqual({ success: 1 });
  });

  it('accumulates across multiple calls', () => {
    incCounter('foo', 'bar');
    incCounter('foo', 'bar');
    incCounter('foo', 'baz', 3);
    const dump = snapshotAndReset();
    const foo = dump.counters.find((c) => c.name === 'foo')!;
    expect(foo.interval).toEqual({ bar: 2, baz: 3 });
  });

  it('resets interval but preserves lifetime across snapshots', () => {
    incCounter('foo', 'a');
    snapshotAndReset();
    incCounter('foo', 'b');
    const dump = snapshotAndReset();
    const foo = dump.counters.find((c) => c.name === 'foo')!;
    expect(foo.interval).toEqual({ b: 1 });            // reset
    expect(foo.lifetime).toEqual({ a: 1, b: 1 });      // accumulated
  });

  it('separates counters by name', () => {
    incCounter('tool_call', 'get_foreground');
    incCounter('eager_snapshot', 'success');
    const dump = snapshotAndReset();
    expect(dump.counters).toHaveLength(2);
  });
});

describe('observeMs', () => {
  it('records a single observation', () => {
    observeMs('eager_snapshot_ms', 100);
    const dump = snapshotAndReset();
    const h = dump.histograms.find((x) => x.name === 'eager_snapshot_ms')!;
    expect(h.interval.count).toBe(1);
    expect(h.interval.sum).toBe(100);
    expect(h.interval.p50).toBe(100);
    expect(h.interval.max).toBe(100);
  });

  it('computes p50 / p95 / p99 across many observations', () => {
    for (let i = 1; i <= 100; i++) observeMs('lat', i);
    const dump = snapshotAndReset();
    const h = dump.histograms.find((x) => x.name === 'lat')!;
    expect(h.interval.count).toBe(100);
    // Sorted samples are 1..100; p50 ≈ 50.5 (linear interpolation)
    expect(h.interval.p50).toBeCloseTo(50.5, 1);
    expect(h.interval.p95).toBeCloseTo(95.05, 1);
    expect(h.interval.p99).toBeCloseTo(99.01, 1);
    expect(h.interval.max).toBe(100);
  });

  it('ignores non-finite and negative values (caller-bug defence)', () => {
    observeMs('lat', NaN);
    observeMs('lat', Infinity);
    observeMs('lat', -1);
    observeMs('lat', 50);
    const dump = snapshotAndReset();
    const h = dump.histograms.find((x) => x.name === 'lat')!;
    expect(h.interval.count).toBe(1);
    expect(h.interval.sum).toBe(50);
  });

  it('caps interval samples and reports dropped count', () => {
    // Push more than MAX_HISTOGRAM_SAMPLES (10_000). Lifetime counts
    // every sample; interval count + dropped together should equal
    // the raw number of calls.
    const N = 10_005;
    for (let i = 0; i < N; i++) observeMs('lat', 1);
    const dump = snapshotAndReset();
    const h = dump.histograms.find((x) => x.name === 'lat')!;
    expect(h.interval.count + h.interval.dropped).toBe(N);
    expect(h.interval.count).toBeLessThanOrEqual(10_000);
    expect(h.lifetime.count).toBe(N);
  });

  it('lifetime mean is computed from sum/count', () => {
    observeMs('lat', 10);
    observeMs('lat', 30);
    observeMs('lat', 50);
    const dump = snapshotAndReset();
    const h = dump.histograms.find((x) => x.name === 'lat')!;
    expect(h.lifetime.mean).toBe(30);
  });
});

describe('snapshotAndReset', () => {
  it('returns empty arrays on idle', () => {
    const dump = snapshotAndReset();
    expect(dump.counters).toEqual([]);
    expect(dump.histograms).toEqual([]);
  });

  it('preserves lifetime histogram across resets', () => {
    observeMs('lat', 100);
    snapshotAndReset(); // interval cleared
    observeMs('lat', 200);
    const dump = snapshotAndReset();
    const h = dump.histograms.find((x) => x.name === 'lat')!;
    expect(h.interval.count).toBe(1);
    expect(h.lifetime.count).toBe(2);
    expect(h.lifetime.sum).toBe(300);
  });
});

describe('dump loop', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    stopDumpLoop();
    jest.useRealTimers();
  });

  it('startDumpLoop is idempotent', () => {
    // Second call should NOT register a second interval; if it did, the
    // dump would fire twice per tick. We can't directly inspect the
    // timer count but we can verify no exception + state stays sane.
    startDumpLoop(1000);
    startDumpLoop(1000);
    stopDumpLoop();
  });

  it('does not throw when the loop fires with no data', () => {
    startDumpLoop(100);
    expect(() => jest.advanceTimersByTime(150)).not.toThrow();
  });
});
