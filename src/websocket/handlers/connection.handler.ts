/**
 * Connection Handler
 * Handles WebSocket connection lifecycle
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
import {
  AuthenticatedPayload,
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types/types';
import { handleHeartbeat } from './heartbeat.handler';
import { handlePreviewEvents } from './preview.handler';
import { handleSubscriptions } from './subscription.handler';
import {
  cancelIdle,
  deleteUserMobileKeys,
  getUserWarmupSessionIds,
} from '@/services/mobile/mobile-idle.service';
import { cancelIdle as cancelPreviewIdle } from '@/services/testing/ui/preview/preview-idle.service';
import { getMobileRunnerClientForSession } from '@/services/mobile/session-runner-routing';
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { uploadEditorTrace } from '@/services/testing/ui/preview/editor-trace-upload';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Per-user grace timer for "user has gone away — destroy their mobile
 * emulator soon." Set on disconnect when this is the user's last socket;
 * cancelled on a fresh connect (refresh / brief reconnect doesn't pay the
 * cost of a re-warmup). 15s grace tolerates a quick reload.
 */
const DISCONNECT_GRACE_MS = 15_000;
const disconnectGraceTimers = new Map<string, NodeJS.Timeout>();

/**
 * Run the actual cleanup: destroy each warmed runner session for this
 * user, then delete the Redis warmup keys, then cancel any pending idle
 * timer. Best-effort — failures are logged but not surfaced.
 */
async function performDisconnectCleanup(userId: string, disconnectReason?: string): Promise<void> {
  try {
    const sessionIds = await getUserWarmupSessionIds(userId);

    if (sessionIds.length > 0) {
      await Promise.allSettled(
        sessionIds.map(async (sid) => {
          try {
            // Resolve per-session: a companion/dedicated session must be
            // destroyed through its OWN runner, not the shared singleton —
            // otherwise the destroy hits a runner that never held the session.
            const client = await getMobileRunnerClientForSession(sid);
            await client.destroySession(sid, { userId });
          } catch (err) {
            logger.warn('[WebSocket] Cleanup destroy failed (runner TTL will reclaim)', {
              sessionId: sid,
              error: err instanceof Error ? err.message : String(err),
            });
          }
          // Close + upload the mobile editor trace, same as the explicit
          // DELETE /sessions/:id path and the web editor's recording:stop.
          // Without this, a browser-close teardown left the trace writer
          // open and the file never reached Supabase. Dev mode keeps the
          // file local (uploadEditorTrace skips the upload).
          try {
            // Record WHY the session is being torn down (browser socket
            // dropped past the grace window → destroy) into the trace BEFORE
            // it's closed + uploaded, so prod sees disconnect-grace teardowns
            // in Supabase (Storage + trace_files). getOrCreate so even a
            // lint-less session still uploads a minimal teardown trace.
            EditorTraceService.getOrCreate(`mobile-${sid}`, userId).writeMobileSessionTeardown({
              cause: 'disconnect_grace',
              sessionId: sid,
              disconnectReason,
              graceMs: DISCONNECT_GRACE_MS,
              emulatorPreserved: false,
            });
            const meta = await EditorTraceService.close(`mobile-${sid}`);
            if (meta) {
              uploadEditorTrace({
                filePath: meta.filePath,
                userId: meta.userId,
                previewSessionId: `mobile-${sid}`,
                traceType: 'editor',
              }).catch((err) => logger.error('[WebSocket] Editor trace upload failed on cleanup', {
                sessionId: sid,
                error: err instanceof Error ? err.message : String(err),
              }));
            }
          } catch {
            // Trace close is best-effort — never block cleanup on it.
          }
        }),
      );
    }

    const deletedKeys = await deleteUserMobileKeys(userId);
    cancelIdle(userId);
    // Web preview has its own per-user idle timer driven by the same socket
    // middleware. On grace cleanup we cancel both so a stale timer can't
    // fire `preview:session:expired` against a reconnect on a fresh socket.
    cancelPreviewIdle(userId);

    logger.info('[WebSocket] Cleanup fired — destroyed sessions + cleared Redis', {
      userId: userId.substring(0, 8) + '...',
      destroyedSessions: sessionIds.length,
      deletedKeys,
    });
  } catch (error) {
    logger.error('[WebSocket] Cleanup error (non-fatal)', {
      userId: userId.substring(0, 8) + '...',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Cancel a pending grace timer (e.g. user reconnects). */
function cancelDisconnectGrace(userId: string): void {
  const t = disconnectGraceTimers.get(userId);
  if (t) {
    clearTimeout(t);
    disconnectGraceTimers.delete(userId);
    logger.debug('[WebSocket] Cancelled scheduled cleanup', {
      userId: userId.substring(0, 8) + '...',
    });
  }
}

/**
 * Handle new WebSocket connection
 */
export const handleConnection = async (socket: TypedSocket): Promise<void> => {
  // Validate socket data
  if (!socket || !socket.data) {
    logger.error('[WebSocket] Invalid socket or missing socket data', {
      socketId: socket?.id,
    });
    socket.disconnect(true);
    return;
  }

  // Get userId safely (socketData removed - was not used)
  let userId: string;
  try {
    userId = getUserId(socket);
  } catch (error) {
    logger.error('[WebSocket] Failed to get userId', {
      socketId: socket.id,
      error: error instanceof Error ? error.message : String(error),
    });
    socket.disconnect(true);
    return;
  }

  // Validate userId format (should be UUID)
  if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
    logger.error('[WebSocket] Invalid userId format', {
      socketId: socket.id,
      userId,
    });
    socket.disconnect(true);
    return;
  }

  // Get user email for logging
  let userEmail: string | undefined = undefined;
  try {
    const { supabaseAdmin } = await import('@/db/supabase');
    const { data: user } = await supabaseAdmin
      .from('users')
      .select('email')
      .eq('id', userId)
      .maybeSingle();
    userEmail = user?.email;
  } catch (emailError) {
    // Non-critical - continue without email
    logger.debug('[WebSocket] Failed to fetch user email', {
      userId,
      error: emailError instanceof Error ? emailError.message : String(emailError),
    });
  }

  // Get transport type for monitoring
  const transport = (socket.conn as any).transport?.name || 'unknown';

  logger.info('[WebSocket] New connection', {
    socketId: socket.id,
    email: userEmail || 'unknown',
    userId: userId.substring(0, 8) + '...', // Shortened for logs
    transport, // 'polling' or 'websocket' - important for debugging excessive requests
  });

  try {
    // Send authentication confirmation
    const authPayload: AuthenticatedPayload = {
      userId,
      isAnonymous: false,
      timestamp: new Date().toISOString(),
    };
    socket.emit('authenticated', authPayload);

    // Join user room
    const userRoom = `user:${userId}`;
    socket.join(userRoom);
    logger.info('[WebSocket] User joined personal room', {
      socketId: socket.id,
      email: userEmail || 'unknown',
      room: userRoom,
    });

    // The user is back — cancel any pending grace-period destroy. This
    // handles refresh / brief reconnect: the cleanup never fires unless
    // the user is gone for the full DISCONNECT_GRACE_MS window.
    cancelDisconnectGrace(userId);

    // Setup event handlers
    handleSubscriptions(socket);
    handleHeartbeat(socket);
    handlePreviewEvents(socket);
  } catch (error) {
    logger.error('[WebSocket] Error setting up connection handlers', {
      socketId: socket.id,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't disconnect - let client try to reconnect
  }

  // Handle disconnection — schedule mobile cleanup if this was the last
  // socket for the user. Refreshes / brief reconnects don't trigger the
  // destroy because the connect-side `cancelDisconnectGrace()` cancels
  // the timer.
  socket.on('disconnect', async (reason) => {
    const uid = socket.data?.userId;
    logger.info('[WebSocket] Client disconnected', {
      socketId: socket.id,
      userId: uid || 'unknown',
      reason,
    });
    if (!uid) return;

    try {
      const remaining = await socket.nsp.in(`user:${uid}`).fetchSockets();
      if (remaining.length > 0) {
        // Other tabs still connected — leave the session alone.
        return;
      }
    } catch (err) {
      logger.warn('[WebSocket] fetchSockets failed during disconnect', {
        userId: uid.substring(0, 8) + '...',
        error: err instanceof Error ? err.message : String(err),
      });
      // Fall through and schedule cleanup defensively.
    }

    // Last socket gone — schedule cleanup. Replaces any prior pending
    // timer (shouldn't exist, but defensive).
    const existing = disconnectGraceTimers.get(uid);
    if (existing) clearTimeout(existing);

    logger.info('[WebSocket] Last socket for user gone — scheduling cleanup', {
      userId: uid.substring(0, 8) + '...',
      graceMs: DISCONNECT_GRACE_MS,
    });

    const timer = setTimeout(() => {
      disconnectGraceTimers.delete(uid);
      void performDisconnectCleanup(uid, reason);
    }, DISCONNECT_GRACE_MS);

    disconnectGraceTimers.set(uid, timer);
  });

  // Handle errors
  socket.on('error', (error) => {
    logger.error('[WebSocket] Socket error', {
      socketId: socket.id,
      userId: socket.data?.userId || 'unknown',
      error: error instanceof Error ? error.message : String(error),
      errorType: error instanceof Error ? error.constructor.name : typeof error,
    });
  });
};
