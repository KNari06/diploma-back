/**
 * Subscription Handler
 * Handles room subscriptions for tests and chats
 */

import { logger } from '@/utils/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware';
import {
    ClientToServerEvents,
    createRoomName,
    ErrorPayload,
    ServerToClientEvents,
    SocketData,
} from '../types';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// Rate limiting: max subscriptions per socket
const MAX_SUBSCRIPTIONS = 50;
const subscriptionCounts = new Map<string, number>();

/**
 * Check if socket can subscribe to more rooms
 */
const canSubscribe = (socketId: string): boolean => {
  const count = subscriptionCounts.get(socketId) || 0;
  return count < MAX_SUBSCRIPTIONS;
};

/**
 * Increment subscription count
 */
const incrementSubscriptions = (socketId: string): void => {
  const count = subscriptionCounts.get(socketId) || 0;
  subscriptionCounts.set(socketId, count + 1);
};

/**
 * Decrement subscription count
 */
const decrementSubscriptions = (socketId: string): void => {
  const count = subscriptionCounts.get(socketId) || 0;
  if (count > 0) {
    subscriptionCounts.set(socketId, count - 1);
  }
};

/**
 * Cleanup subscriptions on disconnect
 */
const cleanupSubscriptions = (socketId: string): void => {
  subscriptionCounts.delete(socketId);
};

/**
 * Handle subscription events
 */
export const handleSubscriptions = (socket: TypedSocket): void => {
  const userId = getUserId(socket);

  // Subscribe to test updates
  socket.on('subscribe:test', ({ testId }) => {
    try {
      if (!canSubscribe(socket.id)) {
        const errorPayload: ErrorPayload = {
          code: 'SUBSCRIPTION_LIMIT',
          message: 'Maximum subscription limit reached',
          timestamp: new Date().toISOString(),
        };
        socket.emit('error', errorPayload);
        return;
      }

      const room = createRoomName('test', testId);
      socket.join(room);
      incrementSubscriptions(socket.id);

      logger.info('[WebSocket] Subscribed to test', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        testId,
        room,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in subscribe:test', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'SUBSCRIPTION_ERROR',
        message: 'Failed to subscribe to test updates',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Unsubscribe from test updates
  socket.on('unsubscribe:test', ({ testId }) => {
    try {
      const room = createRoomName('test', testId);
      socket.leave(room);
      decrementSubscriptions(socket.id);

      logger.info('[WebSocket] Unsubscribed from test', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        testId,
        room,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:test', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Subscribe to chat updates
  socket.on('subscribe:chat', ({ sessionId }) => {
    try {
      if (!canSubscribe(socket.id)) {
        const errorPayload: ErrorPayload = {
          code: 'SUBSCRIPTION_LIMIT',
          message: 'Maximum subscription limit reached',
          timestamp: new Date().toISOString(),
        };
        socket.emit('error', errorPayload);
        return;
      }

      const room = createRoomName('chat', sessionId);
      socket.join(room);
      incrementSubscriptions(socket.id);

      logger.info('[WebSocket] Subscribed to chat', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        sessionId,
        room,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in subscribe:chat', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'SUBSCRIPTION_ERROR',
        message: 'Failed to subscribe to chat updates',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Unsubscribe from chat updates
  socket.on('unsubscribe:chat', ({ sessionId }) => {
    try {
      const room = createRoomName('chat', sessionId);
      socket.leave(room);
      decrementSubscriptions(socket.id);

      logger.info('[WebSocket] Unsubscribed from chat', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        sessionId,
        room,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:chat', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    cleanupSubscriptions(socket.id);
  });
};
