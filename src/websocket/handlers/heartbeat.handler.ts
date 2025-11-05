/**
 * Heartbeat Handler
 * Handles ping/pong for connection health checks
 */

import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
} from '../types';
import { getUserId } from '../middleware';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Handle heartbeat (ping/pong)
 */
export const handleHeartbeat = (socket: TypedSocket): void => {
  const userId = getUserId(socket);

  socket.on('ping', () => {
    socket.emit('pong');

    logger.debug('[WebSocket] Heartbeat', {
      socketId: socket.id,
      userId: userId || 'anonymous',
    });
  });
};
