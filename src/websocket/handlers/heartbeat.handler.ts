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

  socket.on('ping', () => {
    try {
      // Check if socket is still connected
      if (!socket.connected) {
        logger.debug('[WebSocket] Socket disconnected, ignoring ping', {
          socketId: socket.id,
          userId: userId || 'anonymous',
        });
        return;
      }

      socket.emit('pong');

      // logger.debug('[WebSocket] Heartbeat', {
      //   socketId: socket.id,
      //   userId: userId || 'anonymous',
      // });
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
