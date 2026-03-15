/**
 * Subscription Handler
 * Handles room subscriptions for tests and chats
 * ✅ FIX: Added ownership verification to prevent cross-user event leakage
 */

import { connection } from '@/config/infrastructure/queues';
import { supabaseAdmin } from '@/db/supabase';

import { logger } from '@/utils/core/logger';
import Redis from 'ioredis';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
import {
  ClientToServerEvents,
  createRoomName,
  ErrorPayload,
  ServerToClientEvents,
  SocketData,
  TestVideoFramePayload,
} from '../types/types';

// Redis client for catchup buffer
let catchupRedis: Redis | null = null;
let redisConnectionFailed = false;
let redisConnectAttempts = 0;
const MAX_REDIS_CONNECT_ATTEMPTS = 3;

/**
 * Get Redis client for catchup buffer
 * Uses lazy initialization with retry limit
 */
const getCatchupRedis = async (): Promise<Redis | null> => {
  // Return existing connection if available
  if (catchupRedis && catchupRedis.status === 'ready') {
    return catchupRedis;
  }

  // Don't retry if we've failed too many times
  if (redisConnectionFailed && redisConnectAttempts >= MAX_REDIS_CONNECT_ATTEMPTS) {
    return null;
  }

  try {
    redisConnectAttempts++;

    // Clean up old connection if exists
    if (catchupRedis) {
      try {
        catchupRedis.disconnect();
      } catch {
        // Ignore
      }
    }

    catchupRedis = new Redis({
      ...(connection as any),
      connectTimeout: 5000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null, // Don't auto-retry
      lazyConnect: false,
    });

    // Wait for connection with timeout
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Redis connection timeout'));
      }, 5000);

      catchupRedis!.once('ready', () => {
        clearTimeout(timeout);
        redisConnectionFailed = false;
        resolve();
      });

      catchupRedis!.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    return catchupRedis;
  } catch (error) {
    redisConnectionFailed = true;
    logger.debug('[WebSocket] Failed to connect to Redis for catchup buffer', {
      error: error instanceof Error ? error.message : String(error),
      attempt: redisConnectAttempts,
      maxAttempts: MAX_REDIS_CONNECT_ATTEMPTS,
    });

    // Cleanup failed connection
    if (catchupRedis) {
      try {
        catchupRedis.disconnect();
      } catch {
        // Ignore
      }
      catchupRedis = null;
    }

    return null;
  }
};

/**
 * Cleanup catchup Redis client
 * Called during graceful shutdown
 */
export const cleanupCatchupRedis = async (): Promise<void> => {
  if (catchupRedis) {
    try {
      await catchupRedis.quit();
      logger.info('[WebSocket] Catchup Redis client closed');
    } catch (error) {
      logger.debug('[WebSocket] Error closing catchup Redis client', {
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        catchupRedis.disconnect();
      } catch {
        // Ignore
      }
    }
    catchupRedis = null;
  }
};

/**
 * Send video catchup frames to newly subscribed socket
 */
const sendCatchupFrames = async (socket: Socket, testId: string): Promise<void> => {
  try {
    const redis = await getCatchupRedis();
    if (!redis) {
      return;
    }

    const catchupKey = `stream:catchup:${testId}`;
    const frames = await redis.lrange(catchupKey, 0, -1);

    if (frames.length === 0) {
      return;
    }

    logger.debug('[WebSocket] Sending catchup frames', {
      socketId: socket.id,
      testId,
      frameCount: frames.length,
    });

    // Send frames in reverse order (oldest first)
    for (const frameData of frames.reverse()) {
      try {
        const frame = JSON.parse(frameData);
        const payload: TestVideoFramePayload = {
          testId,
          browser: 'chrome',
          sessionId: frame.sessionId || 'catchup',
          seq: frame.seq,
          format: 'jpeg',
          data: frame.data,
          width: frame.width,
          height: frame.height,
          timestamp: frame.timestamp,
          elapsedTime: frame.elapsedTime,
          isCatchup: true,
        };
        socket.emit('test:video:frame', payload);
      } catch {
        // Ignore invalid frame data
      }
    }
  } catch (error) {
    logger.debug('[WebSocket] Error sending catchup frames', {
      testId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// Rate limiting: max subscriptions per socket
const MAX_SUBSCRIPTIONS = 50;
const subscriptionCounts = new Map<string, number>();
const subscribedRooms = new Map<string, Set<string>>();

/**
 * Get (or create) set of subscribed rooms for a socket.
 * Keeping explicit sets makes subscriptions idempotent and prevents false limit hits.
 */
const getRoomSet = (socketId: string): Set<string> => {
  const existing = subscribedRooms.get(socketId);
  if (existing) return existing;
  const created = new Set<string>();
  subscribedRooms.set(socketId, created);
  return created;
};

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
  subscribedRooms.delete(socketId);
};

/**
 * Handle subscription events
 */
export const handleSubscriptions = (socket: TypedSocket): void => {
  // Get userId safely (may fail if socket is not authenticated)
  let userId: string | undefined;
  try {
    userId = getUserId(socket);
  } catch {
    userId = undefined;
  }

  // Subscribe to test updates
  // ✅ FIX: Added async ownership verification to prevent cross-user event leakage
  socket.on('subscribe:test', async ({ testId }) => {
    try {
      // Validate input
      if (!testId || typeof testId !== 'string' || testId.trim().length === 0) {
        logger.warn('[WebSocket] Invalid testId in subscribe:test', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          testId,
        });
        socket.emit('error', {
          code: 'VALIDATION_ERROR',
          message: 'Invalid testId provided',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check if socket is still connected
      if (!socket.connected) {
        logger.debug('[WebSocket] Socket disconnected, ignoring subscribe:test', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          testId,
        });
        return;
      }

      // ✅ SECURITY: Require authenticated user for subscriptions
      if (!userId) {
        socket.emit('error', {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // ✅ SECURITY: Verify test ownership before allowing subscription (fail-closed)
      // This prevents users from subscribing to other users' test events.
      try {
        const { data: test, error: testError } = await supabaseAdmin
          .from('tests')
          .select('user_id')
          .eq('id', testId.trim())
          .maybeSingle();

        if (testError) {
          logger.warn('[WebSocket] Failed to verify test ownership (denying subscription)', {
            socketId: socket.id,
            userId,
            testId,
            error: testError.message,
          });
          socket.emit('error', {
            code: 'ACCESS_DENIED',
            message: 'Authorization check failed',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (!test) {
          logger.warn('[WebSocket] Test not found for subscription', {
            socketId: socket.id,
            userId,
            testId,
          });
          socket.emit('error', {
            code: 'TEST_NOT_FOUND',
            message: 'Test not found',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (!test.user_id) {
          logger.warn('[WebSocket] Test owner is missing (denying subscription)', {
            socketId: socket.id,
            userId,
            testId,
          });
          socket.emit('error', {
            code: 'ACCESS_DENIED',
            message: 'You do not have access to this test',
            timestamp: new Date().toISOString(),
          });
          return;
        }

        if (test.user_id !== userId) {
          logger.warn('[WebSocket] Subscription denied: test belongs to different user', {
            socketId: socket.id,
            requestingUserId: userId,
            testOwnerId: test.user_id.substring(0, 8) + '...',
            testId,
          });
          socket.emit('error', {
            code: 'ACCESS_DENIED',
            message: 'You do not have access to this test',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      } catch (verifyError) {
        logger.warn('[WebSocket] Exception verifying test ownership (denying subscription)', {
          socketId: socket.id,
          userId,
          testId,
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        });
        socket.emit('error', {
          code: 'ACCESS_DENIED',
          message: 'Authorization check failed',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!canSubscribe(socket.id)) {
        const errorPayload: ErrorPayload = {
          code: 'SUBSCRIPTION_LIMIT',
          message: 'Maximum subscription limit reached',
          timestamp: new Date().toISOString(),
        };
        socket.emit('error', errorPayload);
        return;
      }

      const room = createRoomName('test', testId.trim());
      const rooms = getRoomSet(socket.id);

      // Idempotent subscribe: don't double-count if already joined
      if (rooms.has(room)) {
        logger.debug('[WebSocket] Already subscribed to test', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          testId,
          room,
        });
        return;
      }

      socket.join(room);
      rooms.add(room);
      incrementSubscriptions(socket.id);

      logger.info('[WebSocket] Subscribed to test', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        testId,
        room,
      });

      // Send catchup frames for video streaming (async, fire-and-forget)
      sendCatchupFrames(socket, testId.trim()).catch(() => {
        // Ignore catchup errors
      });
    } catch (error) {
      logger.error('[WebSocket] Error in subscribe:test', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
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
      // Validate input
      if (!testId || typeof testId !== 'string' || testId.trim().length === 0) {
        logger.warn('[WebSocket] Invalid testId in unsubscribe:test', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          testId,
        });
        return;
      }

      const room = createRoomName('test', testId.trim());
      socket.leave(room);
      const rooms = getRoomSet(socket.id);
      if (rooms.has(room)) {
        rooms.delete(room);
        decrementSubscriptions(socket.id);
      }

      logger.info('[WebSocket] Unsubscribed from test', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        testId,
        room,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:test', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  });

  // Subscribe to chat updates
  // ✅ FIX: Added async ownership verification to prevent cross-user event leakage
  socket.on('subscribe:chat', async ({ sessionId }, callback) => {
    // Helper: ack callback (backward-compatible — old clients don't pass callback)
    const ack = (response: { ok: boolean; error?: string }) => {
      if (typeof callback === 'function') callback(response);
    };

    try {
      // Validate input
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        logger.warn('[WebSocket] Invalid sessionId in subscribe:chat', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          sessionId,
        });
        socket.emit('error', {
          code: 'VALIDATION_ERROR',
          message: 'Invalid sessionId provided',
          timestamp: new Date().toISOString(),
        });
        ack({ ok: false, error: 'Invalid sessionId provided' });
        return;
      }

      // Check if socket is still connected
      if (!socket.connected) {
        logger.debug('[WebSocket] Socket disconnected, ignoring subscribe:chat', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          sessionId,
        });
        ack({ ok: false, error: 'Socket disconnected' });
        return;
      }

      // ✅ SECURITY: Require authenticated user for subscriptions
      if (!userId) {
        socket.emit('error', {
          code: 'AUTH_REQUIRED',
          message: 'Authentication required',
          timestamp: new Date().toISOString(),
        });
        ack({ ok: false, error: 'Authentication required' });
        return;
      }

      // ✅ SECURITY: Verify session ownership before allowing subscription (fail-closed)
      // Per-user chat: each user can only subscribe to their own session.
      try {
        const { data: chatSession, error: sessionError } = await supabaseAdmin
          .from('chat_sessions')
          .select('workspace_id, user_id')
          .eq('id', sessionId.trim())
          .maybeSingle();

        if (sessionError) {
          logger.warn('[WebSocket] Failed to verify chat session ownership (denying subscription)', {
            socketId: socket.id,
            userId,
            sessionId,
            error: sessionError.message,
          });
          socket.emit('error', {
            code: 'ACCESS_DENIED',
            message: 'Authorization check failed',
            timestamp: new Date().toISOString(),
          });
          ack({ ok: false, error: 'Authorization check failed' });
          return;
        }

        if (!chatSession) {
          logger.warn('[WebSocket] Chat session not found for subscription', {
            socketId: socket.id,
            userId,
            sessionId,
          });
          socket.emit('error', {
            code: 'SESSION_NOT_FOUND',
            message: 'Chat session not found',
            timestamp: new Date().toISOString(),
          });
          ack({ ok: false, error: 'Chat session not found' });
          return;
        }

        if (!chatSession.workspace_id) {
          logger.warn('[WebSocket] Chat session has no workspace (denying subscription)', {
            socketId: socket.id,
            userId,
            sessionId,
          });
          socket.emit('error', {
            code: 'ACCESS_DENIED',
            message: 'You do not have access to this chat session',
            timestamp: new Date().toISOString(),
          });
          ack({ ok: false, error: 'You do not have access to this chat session' });
          return;
        }

        // Per-user chat: verify session belongs to this user
        if (chatSession.user_id !== userId) {
          logger.warn('[WebSocket] Subscription denied: session belongs to different user', {
            socketId: socket.id,
            userId,
            sessionUserId: chatSession.user_id,
            sessionId,
          });
          socket.emit('error', {
            code: 'ACCESS_DENIED',
            message: 'You do not have access to this chat session',
            timestamp: new Date().toISOString(),
          });
          ack({ ok: false, error: 'You do not have access to this chat session' });
          return;
        }
      } catch (verifyError) {
        logger.warn('[WebSocket] Exception verifying chat session access (denying subscription)', {
          socketId: socket.id,
          userId,
          sessionId,
          error: verifyError instanceof Error ? verifyError.message : String(verifyError),
        });
        socket.emit('error', {
          code: 'ACCESS_DENIED',
          message: 'Authorization check failed',
          timestamp: new Date().toISOString(),
        });
        ack({ ok: false, error: 'Authorization check failed' });
        return;
      }

      if (!canSubscribe(socket.id)) {
        const errorPayload: ErrorPayload = {
          code: 'SUBSCRIPTION_LIMIT',
          message: 'Maximum subscription limit reached',
          timestamp: new Date().toISOString(),
        };
        socket.emit('error', errorPayload);
        ack({ ok: false, error: 'Maximum subscription limit reached' });
        return;
      }

      const room = createRoomName('chat', sessionId.trim());
      const rooms = getRoomSet(socket.id);

      // Idempotent subscribe: don't double-count if already joined
      if (rooms.has(room)) {
        ack({ ok: true });
        return;
      }

      socket.join(room);
      rooms.add(room);
      incrementSubscriptions(socket.id);

      // ✅ ACK immediately after join — before welcome message fetch
      // This unblocks the frontend to send HTTP POST /api/v1/chat
      ack({ ok: true });

      // Emit welcome message if chat is empty (first time open)
      try {
        const trimmedSessionId = sessionId.trim();
        const { count: userMessageCount } = await supabaseAdmin
          .from('chat_messages')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', trimmedSessionId)
          .not('metadata->>type', 'eq', 'welcome');

        if (userMessageCount === 0) {
          const { data: welcomeMsg } = await supabaseAdmin
            .from('chat_messages')
            .select('id, role, content, metadata, created_at')
            .eq('session_id', trimmedSessionId)
            .eq('metadata->>type', 'welcome')
            .maybeSingle();

          if (welcomeMsg) {
            socket.emit('chat:message', {
              sessionId: trimmedSessionId,
              messageId: welcomeMsg.id,
              role: 'assistant' as const,
              content: welcomeMsg.content,
              metadata: welcomeMsg.metadata,
              timestamp: welcomeMsg.created_at,
            });
          }
        }
      } catch (welcomeError) {
        logger.warn('[WebSocket] Failed to emit welcome message on subscribe', {
          socketId: socket.id,
          sessionId,
          error: welcomeError instanceof Error ? welcomeError.message : String(welcomeError),
        });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in subscribe:chat', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
      socket.emit('error', {
        code: 'SUBSCRIPTION_ERROR',
        message: 'Failed to subscribe to chat updates',
        timestamp: new Date().toISOString(),
      });
      ack({ ok: false, error: 'Failed to subscribe to chat updates' });
    }
  });

  // Unsubscribe from chat updates
  socket.on('unsubscribe:chat', ({ sessionId }) => {
    try {
      // Validate input
      if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
        logger.warn('[WebSocket] Invalid sessionId in unsubscribe:chat', {
          socketId: socket.id,
          userId: userId || 'anonymous',
          sessionId,
        });
        return;
      }

      const room = createRoomName('chat', sessionId.trim());
      socket.leave(room);
      const rooms = getRoomSet(socket.id);
      if (rooms.has(room)) {
        rooms.delete(room);
        decrementSubscriptions(socket.id);
      }

      // logger.info('[WebSocket] Unsubscribed from chat', {
      //   socketId: socket.id,
      //   userId: userId || 'anonymous',
      //   sessionId,
      //   room,
      // });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:chat', {
        socketId: socket.id,
        userId: userId || 'anonymous',
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  });

  // Handle clarification response
  socket.on('test:clarification:response', ({ testId, questionId, answer }) => {
    logger.info('[SubscriptionHandler] Received clarification response', {
      socketId: socket.id,
      userId,
      testId,
      questionId,
    });

    try {
      // Import dynamically to avoid circular dependency
      const { ClarificationService } = require('@/agent/utils/clarification.service');
      ClarificationService.handleResponse(testId, questionId, answer);
    } catch (error) {
      logger.error('[SubscriptionHandler] Failed to handle clarification response', {
        error: error instanceof Error ? error.message : String(error),
        testId,
        questionId,
      });
    }
  });

  // Handle exploration clarification response (captcha/2FA)
  socket.on('exploration:clarification:response', ({ questionId, answer }) => {
    logger.info('[SubscriptionHandler] Received exploration clarification response', {
      socketId: socket.id,
      userId,
      questionId,
    });

    try {
      const { ClarificationService } = require('@/agent/utils/context/clarification.service');
      ClarificationService.handleExplorationClarificationResponse(questionId, answer);
    } catch (error) {
      logger.error('[SubscriptionHandler] Failed to handle exploration clarification response', {
        error: error instanceof Error ? error.message : String(error),
        questionId,
      });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    try {
      cleanupSubscriptions(socket.id);
    } catch (error) {
      logger.error('[WebSocket] Error cleaning up subscriptions on disconnect', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
};
