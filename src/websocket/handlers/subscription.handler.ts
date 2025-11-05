/**
 * Subscription Handler
 * Handles room subscriptions for tests and chats
 */

import { Socket } from 'socket.io';
import { logger } from '@/utils/logger';
import {
  ClientToServerEvents,
  ServerToClientEvents,
  SocketData,
  createRoomName,
  ErrorPayload,
} from '../types';
import { getUserId } from '../middleware';

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
  });

  // Unsubscribe from test updates
  socket.on('unsubscribe:test', ({ testId }) => {
    const room = createRoomName('test', testId);
    socket.leave(room);
    decrementSubscriptions(socket.id);

    logger.info('[WebSocket] Unsubscribed from test', {
      socketId: socket.id,
      userId: userId || 'anonymous',
      testId,
      room,
    });
  });

  // Subscribe to chat updates
  socket.on('subscribe:chat', ({ sessionId }) => {
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
  });

  // Unsubscribe from chat updates
  socket.on('unsubscribe:chat', ({ sessionId }) => {
    const room = createRoomName('chat', sessionId);
    socket.leave(room);
    decrementSubscriptions(socket.id);

    logger.info('[WebSocket] Unsubscribed from chat', {
      socketId: socket.id,
      userId: userId || 'anonymous',
      sessionId,
      room,
    });
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    cleanupSubscriptions(socket.id);
  });
};
