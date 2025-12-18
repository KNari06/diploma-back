import { redisConnection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';

/**
 * Active request tracking for cancellation
 * ✅ FIX #2: Added Redis-based tracking for multi-instance deployments
 */
interface ActiveRequest {
  abortController: AbortController;
  userId: string;
  chatSessionId?: string;
  startedAt: number;
  message?: string;
}

/**
 * Map of active requests by chat session ID (local in-memory)
 */
const activeRequests = new Map<string, ActiveRequest>();

/**
 * Map of active requests by user ID (for fallback, local in-memory)
 */
const activeRequestsByUser = new Map<string, ActiveRequest>();

/**
 * Redis keys for active request tracking (shared across instances)
 * TTL: 5 minutes (requests should not last longer than this)
 */
const REDIS_KEY_PREFIX = 'active_request:';
const REDIS_TTL = 300; // 5 minutes in seconds

/**
 * Register active request for cancellation
 * ✅ FIX #2: Added Redis tracking for multi-instance support
 */
export async function registerActiveRequest(
  chatSessionId: string | undefined,
  userId: string,
  message?: string
): Promise<AbortController> {
  const abortController = new AbortController();
  const request: ActiveRequest = {
    abortController,
    userId,
    chatSessionId,
    startedAt: Date.now(),
    message: message?.substring(0, 50),
  };

  // Register by chat session if available
  if (chatSessionId) {
    // IMPORTANT: Do NOT auto-cancel previous request here.
    // Frontend controls whether a new request can be sent. Cancellation must happen only via explicit /chat/cancel.
    // If we ever get here with an existing active request, we overwrite tracking and log a warning.
    const previousRequest = activeRequests.get(chatSessionId);
    if (previousRequest && !previousRequest.abortController.signal.aborted) {
      logger.warn('[REQUEST_CANCEL] Overwriting active request for session (unexpected concurrency)', {
        chatSessionId,
        previousMessage: previousRequest.message,
        newMessage: message?.substring(0, 50),
      });
    }
    activeRequests.set(chatSessionId, request);

    // ✅ FIX #2: Store in Redis for cross-instance tracking
    try {
      await redisConnection.setex(
        `${REDIS_KEY_PREFIX}session:${chatSessionId}`,
        REDIS_TTL,
        JSON.stringify({
          userId,
          startedAt: request.startedAt,
          message: request.message,
        })
      );
    } catch (redisError) {
      logger.warn('[REQUEST_CANCEL] Failed to store request in Redis (fallback to in-memory)', {
        error: redisError instanceof Error ? redisError.message : String(redisError),
        chatSessionId,
      });
    }
  }

  // Also register by user ID (for fallback)
  const previousUserRequest = activeRequestsByUser.get(userId);
  if (previousUserRequest && !previousUserRequest.abortController.signal.aborted) {
    logger.warn('[REQUEST_CANCEL] Overwriting active request for user (unexpected concurrency)', {
      userId: userId.substring(0, 8) + '...',
      previousMessage: previousUserRequest.message,
      newMessage: message?.substring(0, 50),
    });
  }
  activeRequestsByUser.set(userId, request);

  // ✅ FIX #2: Store in Redis for cross-instance tracking
  try {
    await redisConnection.setex(
      `${REDIS_KEY_PREFIX}user:${userId}`,
      REDIS_TTL,
      JSON.stringify({
        chatSessionId,
        startedAt: request.startedAt,
        message: request.message,
      })
    );
  } catch (redisError) {
    logger.warn('[REQUEST_CANCEL] Failed to store user request in Redis (fallback to in-memory)', {
      error: redisError instanceof Error ? redisError.message : String(redisError),
      userId: userId.substring(0, 8) + '...',
    });
  }

  logger.info('[REQUEST_CANCEL] Registered active request', {
    chatSessionId,
    userId: userId.substring(0, 8) + '...',
    message: message?.substring(0, 50),
  });

  return abortController;
}

/**
 * Check if there is an active request in progress
 * ✅ FIX #2: Check Redis for cross-instance tracking
 */
export async function hasActiveRequest(chatSessionId: string | undefined, userId: string): Promise<boolean> {
  // Check local in-memory first (fastest)
  if (chatSessionId) {
    const req = activeRequests.get(chatSessionId);
    if (req && !req.abortController.signal.aborted) return true;
  }
  const userReq = activeRequestsByUser.get(userId);
  if (userReq && !userReq.abortController.signal.aborted) return true;

  // ✅ FIX #2: Check Redis for requests from other instances
  try {
    if (chatSessionId) {
      const redisData = await redisConnection.get(`${REDIS_KEY_PREFIX}session:${chatSessionId}`);
      if (redisData) return true;
    }
    const userRedisData = await redisConnection.get(`${REDIS_KEY_PREFIX}user:${userId}`);
    if (userRedisData) return true;
  } catch (redisError) {
    logger.warn('[REQUEST_CANCEL] Failed to check Redis for active request (fallback to in-memory)', {
      error: redisError instanceof Error ? redisError.message : String(redisError),
    });
  }

  return false;
}

/**
 * Cancel active request for chat session
 * ✅ FIX #2: Delete from Redis to notify other instances
 */
export async function cancelActiveRequest(
  chatSessionId: string | undefined,
  userId: string
): Promise<{ cancelled: boolean; message?: string }> {
  let cancelled = false;
  let cancelledMessage: string | undefined;

  // Try to cancel by chat session (local in-memory)
  if (chatSessionId) {
    const request = activeRequests.get(chatSessionId);
    if (request && !request.abortController.signal.aborted) {
      request.abortController.abort();
      cancelled = true;
      cancelledMessage = request.message;
      logger.info('[REQUEST_CANCEL] Cancelled request by session', {
        chatSessionId,
        message: request.message,
        duration: Date.now() - request.startedAt,
      });
      activeRequests.delete(chatSessionId);
    }

    // ✅ FIX #2: Delete from Redis to signal cancellation to other instances
    try {
      await redisConnection.del(`${REDIS_KEY_PREFIX}session:${chatSessionId}`);
    } catch (redisError) {
      logger.warn('[REQUEST_CANCEL] Failed to delete session from Redis', {
        error: redisError instanceof Error ? redisError.message : String(redisError),
        chatSessionId,
      });
    }
  }

  // Also try to cancel by user ID (fallback)
  const userRequest = activeRequestsByUser.get(userId);
  if (userRequest && !userRequest.abortController.signal.aborted) {
    userRequest.abortController.abort();
    if (!cancelled) {
      cancelled = true;
      cancelledMessage = userRequest.message;
    }
    logger.info('[REQUEST_CANCEL] Cancelled request by user', {
      userId: userId.substring(0, 8) + '...',
      message: userRequest.message,
      duration: Date.now() - userRequest.startedAt,
    });
    activeRequestsByUser.delete(userId);
  }

  // ✅ FIX #2: Delete from Redis to signal cancellation to other instances
  try {
    await redisConnection.del(`${REDIS_KEY_PREFIX}user:${userId}`);
  } catch (redisError) {
    logger.warn('[REQUEST_CANCEL] Failed to delete user request from Redis', {
      error: redisError instanceof Error ? redisError.message : String(redisError),
      userId: userId.substring(0, 8) + '...',
    });
  }

  return { cancelled, message: cancelledMessage };
}

/**
 * Unregister active request (when request completes)
 * ✅ FIX #2: Delete from Redis to clean up cross-instance tracking
 */
export async function unregisterActiveRequest(
  chatSessionId: string | undefined,
  userId: string
): Promise<void> {
  if (chatSessionId) {
    activeRequests.delete(chatSessionId);

    // ✅ FIX #2: Delete from Redis
    try {
      await redisConnection.del(`${REDIS_KEY_PREFIX}session:${chatSessionId}`);
    } catch (redisError) {
      logger.warn('[REQUEST_CANCEL] Failed to delete session from Redis on unregister', {
        error: redisError instanceof Error ? redisError.message : String(redisError),
        chatSessionId,
      });
    }
  }

  activeRequestsByUser.delete(userId);

  // ✅ FIX #2: Delete from Redis
  try {
    await redisConnection.del(`${REDIS_KEY_PREFIX}user:${userId}`);
  } catch (redisError) {
    logger.warn('[REQUEST_CANCEL] Failed to delete user request from Redis on unregister', {
      error: redisError instanceof Error ? redisError.message : String(redisError),
      userId: userId.substring(0, 8) + '...',
    });
  }
}

/**
 * Check if request is aborted
 */
export function isRequestAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Throw error if request is aborted
 */
export function checkRequestAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new Error('Request was cancelled by user');
  }
}
