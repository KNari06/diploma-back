/**
 * Heartbeat Handler
 * Handles ping/pong for connection health checks
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
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
};
