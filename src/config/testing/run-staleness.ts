import { env } from '@/config/environment/env';

/**
 * How long a regression run / test / execution may show NO progress before it
 * is presumed dead and force-failed.
 *
 * The clock is a PROGRESS clock, not an age clock: it is compared against the
 * newest signal the run produced (run dispatch, segment dispatch, any child
 * execution starting or completing) — never against `regression_runs.started_at`
 * alone. A suite of 20 tests legitimately runs for hours while each individual
 * test is bounded elsewhere; anchoring on run age force-failed those still-live
 * children from minute 30 onward. See
 * `.claude/decisions/20260809-run-staleness-is-measured-by-progress.md`.
 *
 * Single source for every staleness check:
 *   - `TestCompletionHandlerService.recomputeRunStatus` (event-driven guard)
 *   - `StaleRunReaperJob` / `StaleReaperService` (periodic backstop)
 *
 * Falls back to 30 minutes on a garbage env value — `Number('abc')` is NaN and
 * every comparison against NaN is false, which would silently disable the
 * backstop entirely.
 */
const DEFAULT_STALE_RUN_THRESHOLD_MIN = 30;

export const STALE_RUN_THRESHOLD_MIN =
  Number.isFinite(env.STALE_RUN_THRESHOLD_MIN) && env.STALE_RUN_THRESHOLD_MIN > 0
    ? env.STALE_RUN_THRESHOLD_MIN
    : DEFAULT_STALE_RUN_THRESHOLD_MIN;

export const STALE_RUN_THRESHOLD_MS = STALE_RUN_THRESHOLD_MIN * 60 * 1000;
