/**
 * Phase 2 (May 2026) — Pure helpers for mobile-test-run telemetry.
 *
 * Extracted into its own module so unit tests can exercise the helpers
 * without dragging the full job file (which transitively pulls in
 * supabase, BullMQ, websocket, and ~30 other modules). Importing the
 * job file in a Jest run hangs for 30s+ on module resolution alone.
 *
 * No side effects. No imports from anywhere except `type`-only.
 * Used by: `src/jobs/mobile-test-run.job.ts`.
 */

/**
 * Sum per-step durations from a runner response. Null-tolerant:
 *   - missing/non-number durations coalesce to 0 (not NaN-poisoned)
 *   - Infinity / negative values dropped (probable clock skew or
 *     corrupted runner output)
 *   - non-array input returns 0 (defensive against type contract drift)
 *
 * Result is rounded to an integer ms since durations may be fractional
 * but our DB column is INTEGER.
 */
export function sumStepDurations(
  steps: Array<{ durationMs?: number | null }> | undefined | null,
): number {
  if (!Array.isArray(steps) || steps.length === 0) return 0;
  let sum = 0;
  for (const s of steps) {
    const d = s?.durationMs;
    if (typeof d === 'number' && Number.isFinite(d) && d >= 0) {
      sum += d;
    }
  }
  return Math.round(sum);
}
