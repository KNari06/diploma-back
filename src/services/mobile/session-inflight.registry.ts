/**
 * In-flight work registry for mobile device sessions.
 *
 * WHY THIS EXISTS
 *
 * A mobile editor run is driven over REST (the frontend's sequential
 * `applySession` loop), but the session's LIFETIME is governed by the
 * WebSocket: when the browser's socket drops past `DISCONNECT_GRACE_MS`,
 * `performDisconnectCleanup` destroys every warmed session for that user.
 *
 * Those are two independent channels. A Socket.IO `ping timeout` (two missed
 * 10s heartbeats — the single most common teardown cause in `trace_files`:
 * 59 occurrences between 2026-06-23 and 2026-07-31) kills the WS while the
 * REST run is perfectly healthy. The cleanup then destroys the session the
 * in-flight apply is executing against, so nothing can answer that request —
 * it hangs until the socket resets and the browser reports a bare
 * `TypeError: Failed to fetch`, which the UI blamed on a step that had
 * already passed (2026-07-31, session `…_h5vegt`).
 *
 * The asymmetry this closes: the REST apply handler already propagates an
 * HTTP client disconnect to the runner via `req.on('close')` → AbortController.
 * The WS disconnect handler had no equivalent check — it destroyed sessions
 * unconditionally. This registry lets it ask "is this session mid-step?"
 *
 * SCOPE / LIFETIME
 *
 * Deliberately in-process and NOT Redis-backed. Socket.IO here runs without a
 * cluster adapter (`websocket/core/server.ts` constructs a plain `Server`), so
 * the process that serves the apply is the same one that handles the socket's
 * disconnect — a module-level Map sees both. If a Socket.IO Redis adapter is
 * ever introduced, this must move to Redis or the guard silently stops working
 * across instances.
 *
 * Entries are strictly scoped to one request via try/finally in `track()`, so
 * a crashing handler cannot leak a permanent "busy" marker. `staleAfterMs`
 * bounds the damage if one ever does.
 */

import { logger } from '@/utils/core/logger';

interface InFlightEntry {
  /** Distinct in-flight operations on this session. */
  count: number;
  /** When the most recent operation started — used for the staleness bound. */
  startedAt: number;
}

const inFlight = new Map<string, InFlightEntry>();

/**
 * An entry older than this is treated as leaked rather than genuine work, so a
 * bug here can delay a cleanup by minutes but never block it forever.
 *
 * Sized above the runner client's step budget (`runStepsTimeoutMs` = 300_000)
 * plus its retries, since a legitimately slow step can occupy a session for
 * that long. Below that and the guard would expire mid-step and reintroduce the
 * very bug it exists to prevent.
 */
export const INFLIGHT_STALE_AFTER_MS = 6 * 60 * 1000;

/**
 * Mark `sessionId` busy for the duration of `fn`, then release it.
 *
 * Always releases — `finally` covers throw, abort, and early return alike.
 *
 * @param sessionId runner session id (NOT the `mobile-` trace-prefixed form)
 * @param fn the operation to run while the session is marked busy
 */
export async function track<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  if (!sessionId) return fn();
  const entry = inFlight.get(sessionId);
  if (entry) {
    entry.count += 1;
    entry.startedAt = Date.now();
  } else {
    inFlight.set(sessionId, { count: 1, startedAt: Date.now() });
  }
  try {
    return await fn();
  } finally {
    const current = inFlight.get(sessionId);
    if (current) {
      current.count -= 1;
      if (current.count <= 0) inFlight.delete(sessionId);
    }
  }
}

/**
 * True when `sessionId` has an operation in flight that started recently
 * enough to be believable.
 *
 * A stale entry (older than `INFLIGHT_STALE_AFTER_MS`) reports false AND is
 * evicted, so a leak self-heals on the next read instead of pinning the
 * session forever.
 */
export function hasInFlight(sessionId: string): boolean {
  const entry = inFlight.get(sessionId);
  if (!entry) return false;
  if (Date.now() - entry.startedAt > INFLIGHT_STALE_AFTER_MS) {
    inFlight.delete(sessionId);
    logger.warn('[InFlightRegistry] Evicted stale in-flight entry', {
      sessionId,
      ageMs: Date.now() - entry.startedAt,
      count: entry.count,
    });
    return false;
  }
  return true;
}

/** Test-only: reset all state between cases. */
export function __resetForTests(): void {
  inFlight.clear();
}
