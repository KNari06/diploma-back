/**
 * isPendingSegmentsStale — the pure staleness predicate `recomputeRunStatus`
 * uses to decide whether a segmented (cross-platform link_test_case) chain
 * with pending segments should be force-finalized. Extracted from the
 * service so it's directly unit-testable without mocking Supabase.
 *
 * Regression coverage: the staleness clock must anchor on the CURRENT
 * segment's own progress (`last_segment_dispatched_at`), not the chain's
 * `started_at` — otherwise a legitimately long chain (3+ segments, each with
 * its own 10-minute poll budget) gets force-finalized mid-flight.
 */

jest.mock('@/config/infrastructure/queues', () => ({ redisConnection: {} }));
jest.mock('@/db/supabase', () => ({ supabaseAdmin: {} }));
jest.mock('@/websocket/core/websocket.service', () => ({ webSocketService: {} }));

import { isPendingSegmentsStale } from '../test-completion-handler.service';

const MINUTES = 60 * 1000;

describe('isPendingSegmentsStale', () => {
  it('is not stale when last_segment_dispatched_at is recent, even if started_at is old', () => {
    const now = Date.now();
    const run = {
      started_at: new Date(now - 45 * MINUTES).toISOString(), // 45 min ago — would be stale alone
      last_segment_dispatched_at: new Date(now - 2 * MINUTES).toISOString(), // 2 min ago — current segment just dispatched
    };
    expect(isPendingSegmentsStale(run, now)).toBe(false);
  });

  it('is stale when last_segment_dispatched_at itself is older than 30 minutes', () => {
    const now = Date.now();
    const run = {
      started_at: new Date(now - 45 * MINUTES).toISOString(),
      last_segment_dispatched_at: new Date(now - 35 * MINUTES).toISOString(),
    };
    expect(isPendingSegmentsStale(run, now)).toBe(true);
  });

  it('falls back to started_at when last_segment_dispatched_at is null (pre-migration row)', () => {
    const now = Date.now();
    const staleRun = { started_at: new Date(now - 31 * MINUTES).toISOString(), last_segment_dispatched_at: null };
    const freshRun = { started_at: new Date(now - 5 * MINUTES).toISOString(), last_segment_dispatched_at: null };
    expect(isPendingSegmentsStale(staleRun, now)).toBe(true);
    expect(isPendingSegmentsStale(freshRun, now)).toBe(false);
  });

  it('is not stale when neither timestamp is set', () => {
    expect(isPendingSegmentsStale({}, Date.now())).toBe(false);
  });

  it('is exactly at the 30-minute boundary: not yet stale at exactly 30:00, stale just past it', () => {
    const now = Date.now();
    const exactlyThirty = { last_segment_dispatched_at: new Date(now - 30 * MINUTES).toISOString() };
    const justPastThirty = { last_segment_dispatched_at: new Date(now - 30 * MINUTES - 1).toISOString() };
    expect(isPendingSegmentsStale(exactlyThirty, now)).toBe(false);
    expect(isPendingSegmentsStale(justPastThirty, now)).toBe(true);
  });
});
