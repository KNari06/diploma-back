/**
 * Phase 2 (May 2026) — Mobile telemetry helper unit tests.
 *
 * Imports the helper directly (NOT the job file). Pulling
 * `mobile-test-run.job.ts` into Jest would transitively load supabase,
 * BullMQ, websocket, and ~30 other modules — module resolution alone
 * takes 30s+. The helper module is side-effect-free precisely so this
 * test stays fast.
 *
 * Scope:
 *   - `sumStepDurations` — null-tolerant aggregation of MobileStepResult[]
 *
 * Out of scope (deferred to integration coverage with proper mocks):
 *   - `persistTelemetryByTestId` end-to-end (needs supabase mock)
 *   - `persistTelemetrySnapshot` wiring (covered indirectly above)
 *   - Full `process()` flow (needs BullMQ Job + runner mocks)
 */

import { sumStepDurations } from '../helpers/telemetry';

describe('sumStepDurations', () => {
  it('returns 0 for undefined input', () => {
    expect(sumStepDurations(undefined)).toBe(0);
  });

  it('returns 0 for null input (defensive — should never happen via type contract)', () => {
    expect(sumStepDurations(null)).toBe(0);
  });

  it('returns 0 for empty array', () => {
    expect(sumStepDurations([])).toBe(0);
  });

  it('sums a single step duration', () => {
    expect(sumStepDurations([{ durationMs: 1234 }])).toBe(1234);
  });

  it('sums multiple step durations', () => {
    expect(
      sumStepDurations([
        { durationMs: 100 },
        { durationMs: 250 },
        { durationMs: 50 },
      ]),
    ).toBe(400);
  });

  it('coalesces missing durationMs to 0 (does not throw)', () => {
    expect(
      sumStepDurations([
        { durationMs: 100 },
        {} as { durationMs?: number },
        { durationMs: 50 },
      ]),
    ).toBe(150);
  });

  it('coalesces null durationMs to 0', () => {
    expect(
      sumStepDurations([
        { durationMs: 100 },
        { durationMs: null },
        { durationMs: 50 },
      ]),
    ).toBe(150);
  });

  it('skips NaN and Infinity (does not poison the aggregate)', () => {
    expect(
      sumStepDurations([
        { durationMs: 100 },
        { durationMs: NaN },
        { durationMs: Infinity },
        { durationMs: 50 },
      ]),
    ).toBe(150);
  });

  it('skips negative durations (clock skew or corrupted runner response)', () => {
    expect(
      sumStepDurations([
        { durationMs: 100 },
        { durationMs: -50 },
        { durationMs: 25 },
      ]),
    ).toBe(125);
  });

  it('rounds the sum to an integer (DB column is INTEGER)', () => {
    expect(
      sumStepDurations([
        { durationMs: 100.4 },
        { durationMs: 99.7 },
      ]),
    ).toBe(200);
  });
});
