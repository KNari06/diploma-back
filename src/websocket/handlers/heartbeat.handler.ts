/**
 * Heartbeat Handler
 * Handles ping/pong for connection health checks
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
import { refreshWarmupTtl, touchRunnerSessions } from '@/services/mobile/mobile-idle.service';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types/types';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Handle heartbeat (ping/pong)
 */
export const handleHeartbeat = (socket: TypedSocket): void => {
  // Get userId safely (may fail if socket is not authenticated)
  let userId: string | undefined;
  try {
    userId = getUserId(socket);
  } catch {
    userId = undefined;
  }

  // Prevent client-side ping spam (especially costly on polling transport).
  // Socket.IO already has transport-level ping/pong; this is an app-level heartbeat.
  let lastPingAt = 0;
  const MIN_PING_INTERVAL_MS = 5000; // 5s hard floor

  socket.on('ping', (clientTimestamp?: number) => {
    try {
      // Validate timestamp — must be a positive number (epoch ms from client)
      const ts: number | undefined =
        typeof clientTimestamp === 'number' && clientTimestamp > 0
          ? clientTimestamp
          : undefined;

      // Check if socket is still connected — still send pong so client clears pending state
      if (!socket.connected) {
        logger.debug('[WebSocket] Socket disconnected, ignoring ping', {
          socketId: socket.id,
          userId: userId || 'anonymous',
        });
        return;
      }

      const now = Date.now();
      if (now - lastPingAt < MIN_PING_INTERVAL_MS) {
        // Still respond with pong for latency measurement (just skip logging)
        socket.emit('pong', { t: ts });
        return;
      }
      lastPingAt = now;

      // Echo back client timestamp so client can calculate RTT
      socket.emit('pong', { t: ts });
    } catch (error) {
      logger.error('[WebSocket] Error in ping handler', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });

      // Don't disconnect on heartbeat error - just log
    }
  });

  // Mobile-runner activity keepalive. Fire-and-forget by design (no ack to
  // emit). Live device gestures and recording actions go directly to the
  // mobile runner's socket and bypass the backend; this event lets the
  // frontend signal that the user is still active.
  //
  // Three things must be kept alive for an actively-used mobile session:
  //   1. The in-memory idle timer (`mobile-idle.service.ts`, 15-min) — refreshed
  //      generically by the `socket.use()` activity middleware in
  //      core/server.ts (this event is not in IDLE_BACKGROUND_EVENTS).
  //   2. The Redis `mobile_warmup` binding (15-min FIXED TTL that nothing else
  //      extends); `refreshWarmupTtl` re-arms it here (throttled, best-effort)
  //      so authz/session-resolution don't lapse under an active user. Without
  //      it, #1 alone keeps the editor open while the binding silently expires,
  //      breaking chat-driven mobile actions at ~15 min.
  //   3. The RUNNER session's `lastActivityAt` — `touchRunnerSessions` pings the
  //      runner (throttled, best-effort) so a session being actively EDITED (no
  //      device gestures = no runner traffic) isn't capacity-evicted as the
  //      "oldest idle" session. Closes the 2026-06-29 lint-410 incident: #1/#2
  //      tracked activity on the backend only — nothing told the runner.
  socket.on('mobile:keepalive', () => {
    logger.debug('[WebSocket] mobile:keepalive', {
      socketId: socket.id,
      userId: userId || 'anonymous',
    });
    if (userId) {
      void refreshWarmupTtl(userId);
      void touchRunnerSessions(userId);
    }
  });
};
