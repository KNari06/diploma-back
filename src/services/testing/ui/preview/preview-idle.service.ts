/**
 * Preview Idle Timer Service
 *
 * Mirror of `services/mobile/mobile-idle.service.ts` for the web Preview editor.
 * Per-user idle timer that fires when the user has been inactive for IDLE_TTL_MS.
 * Refreshed on every Socket.IO event from any of the user's sockets via the same
 * `socket.use(...)` middleware that drives the mobile idle timer (see
 * `websocket/core/server.ts`).
 *
 * Behaviour on fire:
 *   - Emit `preview:session:expired` to the user's room.
 *   - Stop ALL of the user's live preview sessions via `stopSession` so the
 *     Playwright browser context is released. Web preview doesn't carry a
 *     "keep warm" expectation (Chromium spin-up is cheap vs an Android
 *     emulator), so we tear the session down on idle rather than the
 *     mobile pattern of preserving it.
 *
 * Coordinated with the existing `cleanupExpiredSessions` sweep in
 * `preview-session.service.ts` — that one is a backstop based on
 * `session.lastSeenAt`; this one is the user-facing redirect timer.
 */
import type { Server as SocketIOServer } from 'socket.io';
import { logger } from '@/utils/core/logger';

/**
 * 15 minutes — kept in lockstep with `IDLE_TTL_MS` in mobile-idle.service.ts.
 * If product wants to retune them separately, split the constants then; until
 * then a single value keeps editor UX consistent across web/mobile.
 */
export const IDLE_TTL_MS = 15 * 60 * 1000;

/** userId → pending fire timer. */
const idleTimers = new Map<string, NodeJS.Timeout>();

/**
 * Reset (or start) the idle timer for a user.
 * Called from the shared `socket.use(...)` middleware on every event from any
 * of the user's sockets.
 */
export function refreshIdle(userId: string, io: SocketIOServer, source?: string): void {
  if (!userId) return;

  const existing = idleTimers.get(userId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    idleTimers.delete(userId);
    logger.info('[PREVIEW_IDLE] Timer fired — running cleanup', {
      userId: userId.substring(0, 8) + '...',
      idleTtlMs: IDLE_TTL_MS,
    });
    void onIdleFire(userId, io);
  }, IDLE_TTL_MS);

  idleTimers.set(userId, timer);

  logger.debug('[PREVIEW_IDLE] refreshed', {
    userId: userId.substring(0, 8) + '...',
    source: source || 'unknown',
    idleTtlMs: IDLE_TTL_MS,
  });
}

/**
 * Cancel a pending idle timer without firing.
 * Useful if the user explicitly closes the editor or logs out — we don't want
 * a stale timer firing a redirect on their next session.
 */
export function cancelIdle(userId: string): void {
  if (!userId) return;
  const t = idleTimers.get(userId);
  if (t) {
    clearTimeout(t);
    idleTimers.delete(userId);
  }
}

/**
 * Whether a user has a pending idle timer (test/debug aid).
 */
export function hasIdle(userId: string): boolean {
  return idleTimers.has(userId);
}

/**
 * Fired when a user has been idle past IDLE_TTL_MS.
 *
 * The middleware refreshes this timer for every authenticated socket event,
 * even when the user has no active preview session (mobile-only flow, just
 * logged in, etc.). So at fire time we re-check ownership and skip the emit
 * entirely if there's nothing to redirect — otherwise mobile-only / idle
 * users get a spurious `preview:session:expired` and the frontend reacts
 * to a session that never existed.
 *
 * Order is `emit → stopSession`, not the reverse. The public `stopSession`
 * has no force-kill safety net (only `stopSessionInternal` does), so if
 * Playwright hangs on browser teardown the user would sit in a frozen
 * editor waiting for a redirect that never arrives. By emitting first we
 * guarantee the redirect; cleanup happens in the background and is
 * idempotent (`stopSession` is a no-op for already-stopped sessions).
 */
async function onIdleFire(userId: string, io: SocketIOServer): Promise<void> {
  try {
    // Lazy-import to dodge the circular-dep risk between preview-session
    // and any future preview service that wants to reference this one.
    const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
    const sessionService = getPreviewSessionService();

    // Resolve the user's session BEFORE deciding whether to emit. The
    // middleware refreshes this timer for every authenticated event, even
    // when the user has no preview session (mobile-only flow, just logged
    // in, etc.). No session → nothing to redirect → return silently.
    const ownedSession = sessionService.getSessionForUser(userId);
    if (!ownedSession) {
      logger.debug('[PREVIEW_IDLE] Timer fired without active session — skipping', {
        userId: userId.substring(0, 8) + '...',
      });
      return;
    }
    const stoppedSessionId = ownedSession.id;

    // Notify FIRST, then tear down the Playwright session. The public
    // `stopSession` has no force-kill safety net (only `stopSessionInternal`
    // does), so a hung Playwright teardown would block the redirect event
    // and leave the user in a frozen editor. Emitting first guarantees
    // the redirect; the cleanup below is idempotent and best-effort.
    io.to(`user:${userId}`).emit('preview:session:expired', { reason: 'idle' });

    try {
      await sessionService.stopSession(stoppedSessionId, userId);
    } catch (stopErr) {
      logger.debug('[PREVIEW_IDLE] stopSession failed (post-emit)', {
        previewSessionId: stoppedSessionId,
        error: stopErr instanceof Error ? stopErr.message : String(stopErr),
      });
    }

    logger.info('[PREVIEW_IDLE] Fired for user — client notified, session stopped', {
      userId: userId.substring(0, 8) + '...',
      stoppedSessionId,
    });
  } catch (error) {
    logger.error('[PREVIEW_IDLE] onIdleFire failed', {
      userId: userId.substring(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
