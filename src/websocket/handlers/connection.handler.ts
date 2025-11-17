/**
 * Connection Handler
 * Handles WebSocket connection lifecycle
 */

import { logger } from '@/utils/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware';
import {
    AuthenticatedPayload,
    ClientToServerEvents,
    ServerToClientEvents,
    SocketData,
} from '../types';
import { handleHeartbeat } from './heartbeat.handler';
import { handleSubscriptions } from './subscription.handler';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Handle new WebSocket connection
 */
export const handleConnection = (socket: TypedSocket): void => {
  // Validate socket data
  if (!socket || !socket.data) {
    logger.error('[WebSocket] Invalid socket or missing socket data', {
      socketId: socket?.id,
    });
    socket.disconnect(true);
    return;
  }

  const socketData = socket.data;

  // Get userId safely
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

  logger.info('[WebSocket] New connection', {
    socketId: socket.id,
    userId,
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
      userId,
      room: userRoom,
    });

    // Setup event handlers
    handleSubscriptions(socket);
    handleHeartbeat(socket);
  } catch (error) {
    logger.error('[WebSocket] Error setting up connection handlers', {
      socketId: socket.id,
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't disconnect - let client try to reconnect
  }

  // Handle disconnection
  socket.on('disconnect', (reason) => {
    logger.info('[WebSocket] Client disconnected', {
      socketId: socket.id,
      userId: socket.data?.userId || 'unknown',
      reason,
    });
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
