import { logger } from '@/utils/logger';

/**
 * Active request tracking for cancellation
 */
interface ActiveRequest {
  abortController: AbortController;
  userId: string;
  chatSessionId?: string;
  startedAt: number;
  message?: string;
}

/**
 * Map of active requests by chat session ID
 */
const activeRequests = new Map<string, ActiveRequest>();

/**
 * Map of active requests by user ID (for fallback)
 */
const activeRequestsByUser = new Map<string, ActiveRequest>();

/**
 * Register active request for cancellation
 */
export function registerActiveRequest(
  chatSessionId: string | undefined,
  userId: string,
  message?: string
): AbortController {
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

  logger.info('[REQUEST_CANCEL] Registered active request', {
    chatSessionId,
    userId: userId.substring(0, 8) + '...',
    message: message?.substring(0, 50),
  });

  return abortController;
}

/**
 * Check if there is an active request in progress
 */
export function hasActiveRequest(chatSessionId: string | undefined, userId: string): boolean {
  if (chatSessionId) {
    const req = activeRequests.get(chatSessionId);
    if (req && !req.abortController.signal.aborted) return true;
  }
  const userReq = activeRequestsByUser.get(userId);
  return !!(userReq && !userReq.abortController.signal.aborted);
}

/**
 * Cancel active request for chat session
 */
export function cancelActiveRequest(
  chatSessionId: string | undefined,
  userId: string
): { cancelled: boolean; message?: string } {
  let cancelled = false;
  let cancelledMessage: string | undefined;

  // Try to cancel by chat session
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

  return { cancelled, message: cancelledMessage };
}

/**
 * Unregister active request (when request completes)
 */
export function unregisterActiveRequest(
  chatSessionId: string | undefined,
  userId: string
): void {
  if (chatSessionId) {
    activeRequests.delete(chatSessionId);
  }
  activeRequestsByUser.delete(userId);
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
