/**
 * RequestKey — namespaced identity for in-flight chat requests.
 *
 * Why this exists
 * ────────────────
 * The legacy cancellation registry (request-cancellation.ts) keys its in-memory
 * Map on raw `chatSessionId` strings. Global chat and per-test-case chat each
 * have their own session-id space — two unrelated UUIDs from two different
 * tables. They will never collide today (UUID v4 birthday math), but the
 * shared key shape means any code path that accepts "a session id" can't tell
 * which backend it belongs to. That ambiguity is the seed of bugs like:
 *   - cancelling a global chat accidentally hits the test-case map (or vice versa)
 *   - a future Redis migration mixes the two key spaces under one prefix
 *   - logs/metrics/alerts can't easily attribute activity to the right surface
 *
 * RequestKey solves all three at the type level: every cancellation API call
 * names which backend it's targeting. Compiler refuses to drop the
 * discriminator. Reads stay O(1) — we just prefix the Map key.
 *
 * Why a thin wrapper instead of rewriting request-cancellation.ts
 * ──────────────────────────────────────────────────────────────
 * The legacy file is used by ~10 call sites in production (controller,
 * /cancel route, intent handlers). It works. Per the plan we agreed on
 * (Variant C), full cancel-cascade work is deferred to a later phase. Today's
 * goal is the smallest change that closes the namespace-collision risk while
 * leaving the legacy code path 100% intact.
 *
 * Mechanics
 * ─────────
 * For global chat we delegate to the existing `register/has/cancel/unregister`
 * functions unchanged — global behavior is byte-for-byte identical.
 * For test-case chat we maintain a separate Map keyed on `tc:<sessionId>`.
 * Cross-store cancellation is impossible because the two paths never share a
 * Map.
 *
 * Public surface
 * ──────────────
 *   RequestKey            — discriminated union, opaque to callers
 *   keyOfGlobal(sid)      — build a global-chat key
 *   keyOfTestCase(sid)    — build a test-case chat key
 *   register(key, ...)    — returns AbortController
 *   hasActive(key)        — boolean, for the 409 concurrency guard
 *   cancel(key, userId)   — fires AbortController.abort(), returns report
 *   unregister(key, ...)  — call from `finally` after the request settles
 *   checkAborted(signal)  — passthrough to legacy helper for convenience
 */

import {
  cancelActiveRequest as legacyCancel,
  hasActiveRequest as legacyHasActive,
  registerActiveRequest as legacyRegister,
  unregisterActiveRequest as legacyUnregister,
  checkRequestAborted,
  isRequestAborted,
} from './request-cancellation';
import { logger } from '@/utils/core/logger';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

export type RequestKeyKind = 'global' | 'testcase';

/**
 * Discriminated union — the `kind` tag forces every call site to commit to
 * a backend. Removing the tag is a compile error, not a silent default.
 */
export type RequestKey =
  | { kind: 'global'; sessionId: string }
  | { kind: 'testcase'; sessionId: string };

export const keyOfGlobal = (sessionId: string): RequestKey => ({
  kind: 'global',
  sessionId,
});

export const keyOfTestCase = (sessionId: string): RequestKey => ({
  kind: 'testcase',
  sessionId,
});

// Re-export the cheap helpers so callers only ever import from this file.
// Reduces the chance someone imports half from legacy and half from here.
export { checkRequestAborted, isRequestAborted };

// ────────────────────────────────────────────────────────────────────────────
// Test-case in-memory registry (mirrors the legacy shape, namespaced)
// ────────────────────────────────────────────────────────────────────────────

interface ActiveTestCaseRequest {
  abortController: AbortController;
  userId: string;
  sessionId: string;
  startedAt: number;
  message?: string;
}

/**
 * Test-case sessions live in their own Map. Keys are bare `sessionId`s
 * (already unique per test-case-session-row) — no need for the `tc:` prefix
 * inside this Map because the Map itself only ever holds test-case entries.
 */
const testCaseRequests = new Map<string, ActiveTestCaseRequest>();

// ────────────────────────────────────────────────────────────────────────────
// Public API — works on RequestKey
// ────────────────────────────────────────────────────────────────────────────

/**
 * Register an in-flight request and return its AbortController. The 409
 * concurrency guard at the controller level uses `hasActive` first, but we
 * also overwrite + log here so a race that sneaks past the guard doesn't
 * leak abort controllers into orphaned-Map territory.
 */
export async function register(
  key: RequestKey,
  userId: string,
  message?: string,
): Promise<AbortController> {
  if (key.kind === 'global') {
    return legacyRegister(key.sessionId, userId, message);
  }

  // testcase
  const previous = testCaseRequests.get(key.sessionId);
  if (previous && !previous.abortController.signal.aborted) {
    logger.warn('[REQUEST_KEY] Overwriting active testcase request (unexpected concurrency)', {
      sessionId: key.sessionId,
      previousMessage: previous.message,
      newMessage: message?.substring(0, 50),
    });
  }

  const abortController = new AbortController();
  testCaseRequests.set(key.sessionId, {
    abortController,
    userId,
    sessionId: key.sessionId,
    startedAt: Date.now(),
    message: message?.substring(0, 50),
  });

  logger.info('[REQUEST_KEY] Registered testcase request', {
    sessionId: key.sessionId,
    userId: userId.substring(0, 8) + '...',
    message: message?.substring(0, 50),
  });

  return abortController;
}

/**
 * 409 guard. Returns true if a non-aborted request is already in flight for
 * this key. Cheap — pure in-memory lookup, no Redis (intentional, see file
 * header).
 */
export async function hasActive(key: RequestKey): Promise<boolean> {
  if (key.kind === 'global') {
    // For the global path we cannot pass userId, so use only the
    // session-scoped check. That matches legacy controller behavior.
    return legacyHasActive(key.sessionId, /* userId */ '');
  }
  const req = testCaseRequests.get(key.sessionId);
  return !!req && !req.abortController.signal.aborted;
}

/**
 * Cancel a request. Returns `{ cancelled, message }` so the /cancel HTTP
 * endpoint can tell the frontend whether anything was actually aborted (e.g.
 * the request had already finished — `cancelled: false` and the UI can chill).
 *
 * For the test-case path we deliberately do NOT cancel by userId (no fallback
 * map). Keys are precise; if the caller doesn't know the sessionId, it has
 * no business cancelling.
 */
export async function cancel(
  key: RequestKey,
  userId: string,
): Promise<{ cancelled: boolean; message?: string }> {
  if (key.kind === 'global') {
    return legacyCancel(key.sessionId, userId);
  }

  const req = testCaseRequests.get(key.sessionId);
  if (!req) {
    return { cancelled: false };
  }
  if (req.userId !== userId) {
    // Hard fail-closed: another user can never cancel someone else's chat.
    // Should never happen in practice — middleware vets ownership upstream —
    // but defense in depth is cheap.
    logger.warn('[REQUEST_KEY] Cancel rejected — user mismatch', {
      sessionId: key.sessionId,
      requesterShort: userId.substring(0, 8) + '...',
    });
    return { cancelled: false };
  }
  if (req.abortController.signal.aborted) {
    return { cancelled: false, message: req.message };
  }

  req.abortController.abort();
  testCaseRequests.delete(key.sessionId);
  logger.info('[REQUEST_KEY] Cancelled testcase request', {
    sessionId: key.sessionId,
    userId: userId.substring(0, 8) + '...',
    message: req.message,
    durationMs: Date.now() - req.startedAt,
  });
  return { cancelled: true, message: req.message };
}

/**
 * Drop the registry entry. ALWAYS call this in a `finally` block — leaking
 * an entry leaks an AbortController, and over time fills the Map with
 * already-aborted ghosts that confuse `hasActive` into 409-ing forever.
 */
export async function unregister(key: RequestKey, userId: string): Promise<void> {
  if (key.kind === 'global') {
    return legacyUnregister(key.sessionId, userId);
  }
  testCaseRequests.delete(key.sessionId);
}

/**
 * Test-only helper — drops every test-case entry. Tests that exercise
 * concurrency guards must call this in `afterEach` to keep state clean.
 *
 * Not exported through the chat module index because no production code
 * has a reason to nuke the registry.
 */
export function __resetTestCaseRequestsForTests(): void {
  testCaseRequests.clear();
}
