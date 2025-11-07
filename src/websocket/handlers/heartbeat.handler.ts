/**
 * Heartbeat Handler
 * Handles ping/pong for connection health checks
 */

import { logger } from '@/utils/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware';
import {
    ClientToServerEvents,
    ServerToClientEvents,
    SocketData,
} from '../types';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Handle heartbeat (ping/pong)
 */
export const handleHeartbeat = (socket: TypedSocket): void => {
  const userId = getUserId(socket);

  socket.on('ping', () => {
    try {
      socket.emit('pong');

      logger.debug('[WebSocket] Heartbeat', {
        socketId: socket.id,
        userId: userId || 'anonymous',
      });
    } catch (error) {
      logger.error('[WebSocket] Error in ping handler', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
