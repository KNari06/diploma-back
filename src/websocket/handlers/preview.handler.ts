/**
 * Preview Handler V2
 * Handles WebSocket events for step editor preview sessions
 * Features: ownership enforcement, rate limiting, consistent error codes
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
import {
  ClientToServerEvents,
  createRoomName,
  PreviewPagePayload,
  ServerToClientEvents,
  SocketData,
} from '../types/types';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// Track subscribed preview sessions per socket
const previewSubscriptions = new Map<string, Set<string>>();

// ═══════════════════════════════════════════════════════════════════════════
// V2: Rate limiting
// ═══════════════════════════════════════════════════════════════════════════
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Rate limits per socket (events per window)
const RATE_LIMITS = {
  lint: { max: 30, windowMs: 10000 },     // 30 lint requests per 10s
  apply: { max: 10, windowMs: 10000 },    // 10 apply requests per 10s
  subscribe: { max: 5, windowMs: 10000 }, // 5 subscribes per 10s
};

const rateLimitStore = new Map<string, Map<string, RateLimitEntry>>();

/**
 * Check and update rate limit for a socket/action
 */
function checkRateLimit(socketId: string, action: keyof typeof RATE_LIMITS): boolean {
  const limit = RATE_LIMITS[action];
  const now = Date.now();

  let socketLimits = rateLimitStore.get(socketId);
  if (!socketLimits) {
    socketLimits = new Map();
    rateLimitStore.set(socketId, socketLimits);
  }

  let entry = socketLimits.get(action);
  if (!entry || now >= entry.resetAt) {
    entry = { count: 0, resetAt: now + limit.windowMs };
    socketLimits.set(action, entry);
  }

  if (entry.count >= limit.max) {
    return false; // Rate limited
  }

  entry.count++;
  return true; // Allowed
}

/**
 * Cleanup rate limit data for a socket
 */
function cleanupRateLimits(socketId: string): void {
  rateLimitStore.delete(socketId);
}

/**
 * Get preview subscriptions for a socket
 */
const getPreviewSubs = (socketId: string): Set<string> => {
  const existing = previewSubscriptions.get(socketId);
  if (existing) return existing;
  const created = new Set<string>();
  previewSubscriptions.set(socketId, created);
  return created;
};

/**
 * Cleanup preview subscriptions on disconnect
 */
const cleanupPreviewSubscriptions = (socketId: string): void => {
  previewSubscriptions.delete(socketId);
};

/**
 * Handle preview-related events
 */
export const handlePreviewEvents = (socket: TypedSocket): void => {
  // Get userId safely
  let userId: string | undefined;
  try {
    userId = getUserId(socket);
  } catch {
    userId = undefined;
  }

  const requireUser = (): string | null => {
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      socket.emit('error', {
        code: 'UNAUTHORIZED',
        message: 'Authentication required for preview events',
        timestamp: new Date().toISOString(),
      });
      return null;
    }
    return userId;
  };

  // Subscribe to preview updates
  socket.on('subscribe:preview', async ({ previewSessionId }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // V2: Rate limit check
      if (!checkRateLimit(socket.id, 'subscribe')) {
        socket.emit('error', {
          code: 'RATE_LIMITED',
          message: 'Too many subscribe requests. Please wait.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!previewSessionId || typeof previewSessionId !== 'string' || previewSessionId.trim().length === 0) {
        logger.warn('[WebSocket] Invalid previewSessionId in subscribe:preview', {
          socketId: socket.id,
          userId: ensuredUserId,
          previewSessionId,
        });
        socket.emit('error', {
          code: 'VALIDATION_ERROR',
          message: 'Invalid previewSessionId provided',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (!socket.connected) {
        return;
      }

      const normalizedPreviewSessionId = previewSessionId.trim();

      // ✅ Security: validate session ownership before joining room
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      if (!sessionService.isSessionOwned(normalizedPreviewSessionId, ensuredUserId)) {
        socket.emit('error', {
          code: 'FORBIDDEN',
          message: 'Preview session not found or not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const room = createRoomName('preview', normalizedPreviewSessionId);
      const subs = getPreviewSubs(socket.id);

      // Idempotent subscribe
      if (subs.has(room)) {
        logger.debug('[WebSocket] Already subscribed to preview', {
          socketId: socket.id,
          previewSessionId,
        });
        return;
      }

      socket.join(room);
      subs.add(room);

      logger.info('[WebSocket] Subscribed to preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
        room,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in subscribe:preview', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'SUBSCRIPTION_ERROR',
        message: 'Failed to subscribe to preview updates',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Unsubscribe from preview updates
  socket.on('unsubscribe:preview', ({ previewSessionId }) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!previewSessionId || typeof previewSessionId !== 'string' || previewSessionId.trim().length === 0) {
        return;
      }

      const room = createRoomName('preview', previewSessionId.trim());
      socket.leave(room);
      const subs = getPreviewSubs(socket.id);
      subs.delete(room);

      logger.info('[WebSocket] Unsubscribed from preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:preview', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle step lint request
  socket.on('preview:step:lint', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // V2: Rate limit check
      if (!checkRateLimit(socket.id, 'lint')) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Rate limited. Please slow down.',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { previewSessionId, stepDraft, pageRef } = data;

      if (!previewSessionId || !stepDraft) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Missing required fields',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      logger.debug('[WebSocket] Step lint request', {
        socketId: socket.id,
        previewSessionId,
        stepType: stepDraft.type,
        description: stepDraft.description,
      });

      // Import linting service dynamically to avoid circular deps
      const { IntentStepLintService } = await import('@/services/testing/ui/preview/intent-step-lint.service');

      const result = await IntentStepLintService.lintStep({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
      });

      socket.emit('preview:step:lint:result', {
        ...result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:step:lint', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:step:lint:result', {
        status: 'error',
        message: error instanceof Error ? error.message : 'Linting failed',
        confidence: 0,
        candidates: [],
        highlight: [],
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Handle step apply request
  socket.on('preview:step:apply', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // V2: Rate limit check
      if (!checkRateLimit(socket.id, 'apply')) {
        socket.emit('preview:step:apply:result', {
          success: false,
          error: 'Rate limited. Please slow down.',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { previewSessionId, stepDraft, pageRef } = data;

      if (!previewSessionId || !stepDraft) {
        socket.emit('preview:step:apply:result', {
          success: false,
          error: 'Missing required fields',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      logger.debug('[WebSocket] Step apply request', {
        socketId: socket.id,
        previewSessionId,
        stepType: stepDraft.type,
        description: stepDraft.description,
      });

      // Import apply service dynamically to avoid circular deps
      const { PreviewStepApplyService } = await import('@/services/testing/ui/preview/preview-step-apply.service');

      const result = await PreviewStepApplyService.applyStep({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
      });

      socket.emit('preview:step:apply:result', {
        ...result,
        timestamp: new Date().toISOString(),
      });

      // If successful, emit updated page state to all subscribers
      if (result.success) {
        const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
        const sessionService = getPreviewSessionService();
        const snapshot = await sessionService.getSnapshot(previewSessionId, ensuredUserId, { force: true });

        if (snapshot) {
          const room = createRoomName('preview', previewSessionId);
          const payload = {
            previewSessionId,
            url: snapshot.url,
            domNodes: snapshot.domNodes,
            timestamp: new Date().toISOString(),
          };

          // Emit to the caller immediately (even if not subscribed)
          socket.emit('preview:page', payload);
          // Emit to other subscribers
          socket.to(room).emit('preview:page', payload);
        }
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:step:apply', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:step:apply:result', {
        success: false,
        error: error instanceof Error ? error.message : 'Apply failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    cleanupPreviewSubscriptions(socket.id);
    cleanupRateLimits(socket.id); // V2: Cleanup rate limit data
  });
};

/**
 * Emit page update to preview subscribers
 */
export const emitPreviewPage = (
  io: any, // Socket.IO server instance
  previewSessionId: string,
  payload: Omit<PreviewPagePayload, 'previewSessionId' | 'timestamp'>
): void => {
  const room = createRoomName('preview', previewSessionId);
  io.to(room).emit('preview:page', {
    previewSessionId,
    ...payload,
    timestamp: new Date().toISOString(),
  });
};
