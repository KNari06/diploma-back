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
 * Stops every live preview session the user owns and pushes
 * `preview:session:expired` to the user's room. The frontend closes the
 * editor, shows a toast, and bounces back to Repository.
 */
async function onIdleFire(userId: string, io: SocketIOServer): Promise<void> {
  try {
    // Stop the user's preview session so the Playwright context is freed
    // before we tell the user "your session is gone". Done first so a racing
    // socket reconnect can't keep the session alive past the event.
    // preview-session.service.ts maps userId → at most one sessionId
    // (`userToSession`), so we just resolve that and stop it.
    let stoppedSessionId: string | null = null;
    try {
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const ownedSession = sessionService.getSessionForUser(userId);
      if (ownedSession) {
        try {
          await sessionService.stopSession(ownedSession.id, userId);
          stoppedSessionId = ownedSession.id;
        } catch (stopErr) {
          logger.debug('[PREVIEW_IDLE] stopSession failed', {
            previewSessionId: ownedSession.id,
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        }
      }
    } catch (importErr) {
      logger.warn('[PREVIEW_IDLE] Failed to import preview session service', {
        error: importErr instanceof Error ? importErr.message : String(importErr),
      });
    }

    // Notify all of the user's sockets in the personal room.
    io.to(`user:${userId}`).emit('preview:session:expired', { reason: 'idle' });

    logger.info('[PREVIEW_IDLE] Fired for user — preview sessions stopped, client notified', {
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
