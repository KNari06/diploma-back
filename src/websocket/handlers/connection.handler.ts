/**
 * Connection Handler
 * Handles WebSocket connection lifecycle
 */

import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  AuthenticatedPayload,
} from '../types';
import { getUserId, isAuthenticated } from '../middleware';
import { handleSubscriptions } from './subscription.handler';
import { handleHeartbeat } from './heartbeat.handler';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Handle new WebSocket connection
 */
export const handleConnection = (socket: TypedSocket): void => {
  const socketData = socket.data;
  const userId = getUserId(socket);

  logger.info('[WebSocket] New connection', {
    socketId: socket.id,
    userId: userId || 'anonymous',
    isAuthenticated: isAuthenticated(socket),
  });

  // Send authentication confirmation
  const authPayload: AuthenticatedPayload = {
    userId: userId || 'anonymous',
    isAnonymous: socketData.isAnonymous,
    timestamp: new Date().toISOString(),
  };
  socket.emit('authenticated', authPayload);

  // Join user room if authenticated
  if (userId) {
    const userRoom = `user:${userId}`;
    socket.join(userRoom);
    logger.info('[WebSocket] User joined personal room', {
      socketId: socket.id,
      userId,
      room: userRoom,
    });
  }

  // Setup event handlers
  handleSubscriptions(socket);
  handleHeartbeat(socket);

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    logger.info('[WebSocket] Client disconnected', {
      socketId: socket.id,
      userId: userId || 'anonymous',
      reason,
    });
  });

  // Handle errors
  socket.on('error', (error) => {
    logger.error('[WebSocket] Socket error', {
      socketId: socket.id,
      userId: userId || 'anonymous',
      error: error.message,
    });
  });
};
