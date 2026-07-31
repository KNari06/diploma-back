/**
 * Tests for the in-flight session registry.
 *
 * This exists to stop a WebSocket ping-timeout cleanup from destroying a mobile
 * session that a REST-driven run is mid-step on. The contract that matters:
 *   - busy WHILE the operation runs, free once it settles;
 *   - released on throw and abort, not just on success (a leaked "busy" marker
 *     would block cleanup and leak an emulator);
 *   - concurrent operations on one session are ref-counted, not clobbered;
 *   - a leaked entry self-heals after INFLIGHT_STALE_AFTER_MS.
 */

import {
  track,
  hasInFlight,
  INFLIGHT_STALE_AFTER_MS,
  __resetForTests,
} from '../session-inflight.registry';

beforeEach(() => {
  __resetForTests();
  jest.restoreAllMocks();
});

describe('session in-flight registry', () => {
  it('reports a session busy only while the operation is running', async () => {
    expect(hasInFlight('sess-1')).toBe(false);

    let observedDuring = false;
    await track('sess-1', async () => {
      observedDuring = hasInFlight('sess-1');
    });

    expect(observedDuring).toBe(true);
    expect(hasInFlight('sess-1')).toBe(false);
  });

  it('releases the session when the operation throws', async () => {
    // The leak that would matter most: an apply that fails must not pin the
    // session busy forever, or cleanup could never reclaim the emulator.
    await expect(
      track('sess-1', async () => {
        throw new Error('runner exploded');
      }),
    ).rejects.toThrow('runner exploded');

    expect(hasInFlight('sess-1')).toBe(false);
  });

  it('does not mark unrelated sessions busy', async () => {
    await track('sess-1', async () => {
      expect(hasInFlight('sess-2')).toBe(false);
    });
  });

  it('ref-counts concurrent operations on the same session', async () => {
    // Two applies can overlap (e.g. a debounced lint racing a run step). The
    // first one finishing must not clear the marker while the second runs.
    let releaseA: () => void = () => {};
    let releaseB: () => void = () => {};
    const a = track('sess-1', () => new Promise<void>((r) => { releaseA = r; }));
    const b = track('sess-1', () => new Promise<void>((r) => { releaseB = r; }));

    expect(hasInFlight('sess-1')).toBe(true);
    releaseA();
    await a;
    expect(hasInFlight('sess-1')).toBe(true); // B is still running
    releaseB();
    await b;
    expect(hasInFlight('sess-1')).toBe(false);
  });

  it('returns the operation result unchanged', async () => {
    await expect(track('sess-1', async () => ({ ok: 1 }))).resolves.toEqual({ ok: 1 });
  });

  it('runs the operation even without a session id', async () => {
    // Defensive: a missing id must not skip the work.
    await expect(track('', async () => 'ran')).resolves.toBe('ran');
  });

  it('evicts a stale entry so a leak cannot block cleanup forever', async () => {
    let release: () => void = () => {};
    const pending = track('sess-1', () => new Promise<void>((r) => { release = r; }));
    expect(hasInFlight('sess-1')).toBe(true);

    // Simulate the entry having started longer ago than the staleness bound.
    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + INFLIGHT_STALE_AFTER_MS + 1);

    expect(hasInFlight('sess-1')).toBe(false);

    jest.restoreAllMocks();
    release();
    await pending;
  });

  it('keeps an entry that is younger than the staleness bound', async () => {
    let release: () => void = () => {};
    const pending = track('sess-1', () => new Promise<void>((r) => { release = r; }));

    const realNow = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(realNow + INFLIGHT_STALE_AFTER_MS - 1000);
    expect(hasInFlight('sess-1')).toBe(true);

    jest.restoreAllMocks();
    release();
    await pending;
  });

  it('bounds the staleness window above the runner step budget', () => {
    // runStepsTimeoutMs is 300_000 (mobile-runner-client.ts). If the window were
    // below that, the guard would expire mid-step and reintroduce the very bug
    // it exists to prevent.
    expect(INFLIGHT_STALE_AFTER_MS).toBeGreaterThan(300_000);
  });
});
