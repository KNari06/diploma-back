/**
 * isRunProgressStale — the predicate that decides whether a regression run has
 * genuinely stalled, used by both `recomputeRunStatus`'s force-fail guard and
 * the periodic reaper. Extracted from the service so it's directly unit-testable
 * without mocking Supabase.
 *
 * Regression coverage: the clock must anchor on the NEWEST progress signal the
 * run produced (a child starting or finishing), not on `regression_runs.started_at`.
 * A chain-wide clock force-failed the still-live children of any suite that
 * legitimately ran longer than the threshold — reporting passing tests as timed
 * out and losing the run's real result.
 */

jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {} }));
jest.mock('@/websocket/core/websocket.service', () => ({ webSocketService: {} }));

import { isRunProgressStale } from '../test-completion-handler.service';

const MINUTES = 60 * 1000;
const THRESHOLD = 30 * MINUTES;

const ago = (now: number, mins: number) => new Date(now - mins * MINUTES).toISOString();

describe('isRunProgressStale', () => {
  it('is not stale while a child is still finishing, however old the run is', () => {
    const now = Date.now();
    const run = { started_at: ago(now, 90) };
    const rows = [
      { started_at: ago(now, 90), completed_at: ago(now, 2) }, // just finished
      { started_at: ago(now, 88), completed_at: null }, // still running
    ];
    expect(isRunProgressStale(run, rows, now, THRESHOLD)).toBe(false);
  });

  it('is not stale when a child only just started (serial mobile dispatch)', () => {
    const now = Date.now();
    const run = { started_at: ago(now, 120) };
    const rows = [
      { started_at: ago(now, 120), completed_at: ago(now, 95) },
      { started_at: ago(now, 3), completed_at: null }, // next test just dispatched
    ];
    expect(isRunProgressStale(run, rows, now, THRESHOLD)).toBe(false);
  });

  it('is stale once every signal — run, starts and completions — is past the threshold', () => {
    const now = Date.now();
    const run = { started_at: ago(now, 120) };
    const rows = [
      { started_at: ago(now, 120), completed_at: ago(now, 100) },
      { started_at: ago(now, 100), completed_at: null }, // died 100 min ago
    ];
    expect(isRunProgressStale(run, rows, now, THRESHOLD)).toBe(true);
  });

  it('falls back to the run row when there are no executions to read', () => {
    const now = Date.now();
    expect(isRunProgressStale({ started_at: ago(now, 45) }, [], now, THRESHOLD)).toBe(true);
    expect(isRunProgressStale({ started_at: ago(now, 5) }, [], now, THRESHOLD)).toBe(false);
  });

  it('counts a freshly dispatched segment as progress', () => {
    const now = Date.now();
    const run = { started_at: ago(now, 90), last_segment_dispatched_at: ago(now, 4) };
    expect(isRunProgressStale(run, [], now, THRESHOLD)).toBe(false);
  });

  it('ignores nulls rather than treating them as old or new', () => {
    const now = Date.now();
    // Every row is 'pending' (no started_at, no completed_at) — the only real
    // signal is the run's own dispatch, which is stale.
    const rows = [
      { started_at: null, completed_at: null },
      { started_at: null, completed_at: null },
    ];
    expect(isRunProgressStale({ started_at: ago(now, 45) }, rows, now, THRESHOLD)).toBe(true);
  });

  it('is not stale when nothing can be judged (no timestamps at all)', () => {
    expect(isRunProgressStale({}, [], Date.now(), THRESHOLD)).toBe(false);
    expect(isRunProgressStale({}, [{ started_at: null, completed_at: null }], Date.now(), THRESHOLD))
      .toBe(false);
  });

  it('is exact at the boundary: not yet stale at exactly the threshold, stale just past it', () => {
    const now = Date.now();
    const atThreshold = { started_at: new Date(now - THRESHOLD).toISOString() };
    const pastThreshold = { started_at: new Date(now - THRESHOLD - 1).toISOString() };
    expect(isRunProgressStale(atThreshold, [], now, THRESHOLD)).toBe(false);
    expect(isRunProgressStale(pastThreshold, [], now, THRESHOLD)).toBe(true);
  });
});
