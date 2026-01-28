/**
 * Preview Handler V3
 * Handles WebSocket events for step editor preview sessions
 * Features: ownership enforcement, rate limiting, AI semantic matching, clarification flow
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import { getUserId } from '../middleware/middleware';
import {
  ClientToServerEvents,
  createRoomName,
  PreviewIntentStep,
  PreviewLintCandidate,
  PreviewPagePayload,
  ServerToClientEvents,
  SocketData,
} from '../types/types';
import {
  emitInputError,
  emitInputSuccess,
  emitSnapshotAlways,
  emitSnapshotIfChanged,
  validateInputRequest,
} from './preview-input-helpers';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// Track subscribed preview sessions per socket
const previewSubscriptions = new Map<string, Set<string>>();

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot streaming registry (V6: continuous preview:page emission)
// ═══════════════════════════════════════════════════════════════════════════

// Active streaming intervals keyed by previewSessionId
const activePreviewStreams = new Map<string, NodeJS.Timeout>();

// Subscriber refcount per room (preview:<sessionId>)
const previewRoomRefCount = new Map<string, number>();

// Stream context to remember userId/room for snapshot emission
interface StreamContext {
  previewSessionId: string;
  userId: string;
  room: string;
}
const previewStreamContext = new Map<string, StreamContext>();

const SNAPSHOT_STREAM_INTERVAL_MS = 500;

// ═══════════════════════════════════════════════════════════════════════════
// V3: Pending clarifications cache
// ═══════════════════════════════════════════════════════════════════════════
interface PendingClarification {
  candidates: PreviewLintCandidate[];
  stepDraft: PreviewIntentStep;
  userId: string;
  timestamp: number;
}

// Key: `${previewSessionId}:${stepId}` -> PendingClarification
const pendingClarifications = new Map<string, PendingClarification>();

// ═══════════════════════════════════════════════════════════════════════════
// V3: Confirmed selections cache (after user picks from clarify options)
// Used by apply to skip re-linting and use user's choice directly
// ═══════════════════════════════════════════════════════════════════════════
interface ConfirmedSelection {
  selectedRef: string;
  userId: string;
  timestamp: number;
}

// Key: `${previewSessionId}:${stepId}` -> ConfirmedSelection
const confirmedSelections = new Map<string, ConfirmedSelection>();

// Cleanup old clarifications and selections (older than 5 minutes)
const CLARIFICATION_TTL_MS = 5 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, value] of pendingClarifications) {
    if (now - value.timestamp > CLARIFICATION_TTL_MS) {
      pendingClarifications.delete(key);
    }
  }
  // Also cleanup confirmed selections
  for (const [key, value] of confirmedSelections) {
    if (now - value.timestamp > CLARIFICATION_TTL_MS) {
      confirmedSelections.delete(key);
    }
  }
}, 60 * 1000); // Check every minute

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
  mouse: { max: 100, windowMs: 10000 },   // 100 mouse events per 10s
  keyboard: { max: 50, windowMs: 10000 }, // 50 keyboard events per 10s
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
 * Start snapshot streaming for a preview session
 * Emits preview:page every ~500ms to all subscribers in the room
 */
const startSnapshotStream = (context: StreamContext, nsp: any): void => {
  const { previewSessionId, userId, room } = context;

  // Don't start if already streaming
  if (activePreviewStreams.has(previewSessionId)) {
    return;
  }

  logger.info('[SNAPSHOT_STREAM] Starting stream', { previewSessionId, room });

  const interval = setInterval(async () => {
    try {
      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
        includeScreenshot: true,
        onlyIfChanged: false, // Always emit, don't gate on change detection
      });

      if (snapshot) {
        const payload: PreviewPagePayload = {
          previewSessionId,
          url: snapshot.url,
          domNodes: snapshot.domNodes,
          screenshot: snapshot.screenshot,
          timestamp: new Date().toISOString(),
        };

        // Emit to entire room (including sender)
        nsp.to(room).emit('preview:page', payload);

        logger.debug('[SNAPSHOT_STREAM] Emitted preview:page', {
          previewSessionId,
          room,
          hasScreenshot: !!snapshot.screenshot,
          nodeCount: snapshot.domNodes.length,
        });
      }
    } catch (error) {
      logger.error('[SNAPSHOT_STREAM] Failed to emit snapshot', {
        previewSessionId,
        room,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, SNAPSHOT_STREAM_INTERVAL_MS);

  activePreviewStreams.set(previewSessionId, interval);
  previewStreamContext.set(previewSessionId, context);
};

/**
 * Stop snapshot streaming for a preview session
 */
const stopSnapshotStream = (previewSessionId: string): void => {
  const interval = activePreviewStreams.get(previewSessionId);
  if (interval) {
    clearInterval(interval);
    activePreviewStreams.delete(previewSessionId);
    previewStreamContext.delete(previewSessionId);
    logger.info('[SNAPSHOT_STREAM] Stopped stream', { previewSessionId });
  }
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

      // V6: Start snapshot streaming on first subscriber
      const currentCount = previewRoomRefCount.get(room) || 0;
      previewRoomRefCount.set(room, currentCount + 1);

      if (currentCount === 0 && !activePreviewStreams.has(normalizedPreviewSessionId)) {
        // First subscriber - start streaming
        startSnapshotStream(
          {
            previewSessionId: normalizedPreviewSessionId,
            userId: ensuredUserId,
            room,
          },
          socket.nsp
        );
      }

      logger.info('[WebSocket] Subscribed to preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
        room,
        subscriberCount: currentCount + 1,
      });

      // V4: Emit initial preview:page with screenshot after subscribe
      try {
        const snapshot = await sessionService.getSnapshot(normalizedPreviewSessionId, ensuredUserId, {
          force: true,
          includeScreenshot: true,
        });

        if (snapshot) {
          socket.emit('preview:page', {
            previewSessionId: normalizedPreviewSessionId,
            url: snapshot.url,
            domNodes: snapshot.domNodes,
            screenshot: snapshot.screenshot,
            timestamp: new Date().toISOString(),
          });

          logger.debug('[WebSocket] Emitted initial preview:page with screenshot', {
            socketId: socket.id,
            previewSessionId,
            hasScreenshot: !!snapshot.screenshot,
            nodeCount: snapshot.domNodes.length,
          });

          // V5: Emit viewport metadata for coordinate mapping
          const viewportMeta = sessionService.getViewportMetadata(normalizedPreviewSessionId, ensuredUserId);
          if (viewportMeta) {
            socket.emit('preview:viewport', {
              previewSessionId: normalizedPreviewSessionId,
              viewport: {
                width: viewportMeta.width,
                height: viewportMeta.height,
              },
              devicePixelRatio: viewportMeta.devicePixelRatio,
              timestamp: new Date().toISOString(),
            });
          }

          // V4: Prefetch embeddings for faster first lint (async, non-blocking)
          setImmediate(async () => {
            try {
              const { prefetchEmbeddings } = await import('@/services/testing/ui/preview/intent-step-lint.service');
              await prefetchEmbeddings({
                previewSessionId: normalizedPreviewSessionId,
                domNodes: snapshot.domNodes,
                pageUrl: snapshot.url,
              });
            } catch (prefetchError) {
              // Don't fail - prefetch is optimization only
              logger.debug('[WebSocket] Embeddings prefetch failed (non-critical)', {
                socketId: socket.id,
                previewSessionId,
                error: prefetchError instanceof Error ? prefetchError.message : String(prefetchError),
              });
            }
          });
        }
      } catch (snapshotError) {
        logger.warn('[WebSocket] Failed to emit initial preview:page', {
          socketId: socket.id,
          previewSessionId,
          error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
        });
        // Don't fail subscription - just log warning
      }
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

      const normalizedPreviewSessionId = previewSessionId.trim();
      const room = createRoomName('preview', normalizedPreviewSessionId);
      socket.leave(room);
      const subs = getPreviewSubs(socket.id);
      subs.delete(room);

      // V6: Stop snapshot streaming when last subscriber leaves
      const currentCount = previewRoomRefCount.get(room) || 0;
      const newCount = Math.max(0, currentCount - 1);
      previewRoomRefCount.set(room, newCount);

      if (newCount === 0) {
        // Last subscriber left - stop streaming
        stopSnapshotStream(normalizedPreviewSessionId);
        previewRoomRefCount.delete(room);
      }

      logger.info('[WebSocket] Unsubscribed from preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
        subscriberCount: newCount,
      });
    } catch (error) {
      logger.error('[WebSocket] Error in unsubscribe:preview', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle step lint request (V3: with AI semantic matching)
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

      logger.debug('[WebSocket] Step lint request (AI)', {
        socketId: socket.id,
        previewSessionId,
        stepType: stepDraft.type,
        descriptionPreview: typeof stepDraft.description === 'string' ? stepDraft.description.slice(0, 80) : '',
      });

      // Import linting service dynamically to avoid circular deps
      const { IntentStepLintService } = await import('@/services/testing/ui/preview/intent-step-lint.service');

      // V3: Use AI-powered linting
      const result = await IntentStepLintService.lintStepWithAI({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
      });

      // V3: If needs clarification, emit separate clarify event
      if (result.status === 'needs_clarification') {
        // V3: Filter out candidates without valid ref (required for selection)
        const validCandidates = result.candidates.filter(c => c.ref && c.ref.trim().length > 0);

        if (validCandidates.length === 0) {
          // No valid candidates to clarify - emit error
          socket.emit('preview:step:lint:result', {
            status: 'not_found',
            message: 'No valid elements found for clarification',
            confidence: 0,
            candidates: [],
            highlight: [],
            timestamp: new Date().toISOString(),
          });
          return;
        }

        // Store pending clarification for this step (only valid candidates)
        const clarifyKey = `${previewSessionId}:${stepDraft.id}`;
        pendingClarifications.set(clarifyKey, {
          candidates: validCandidates,
          stepDraft,
          userId: ensuredUserId,
          timestamp: Date.now(),
        });

        // Emit clarify event with candidates (max 3, all with valid refs)
        socket.emit('preview:step:clarify', {
          previewSessionId,
          stepId: stepDraft.id,
          candidates: validCandidates.slice(0, 3).map(c => ({
            ref: c.ref!, // Safe - filtered above
            label: c.label,
            reason: c.reason,
            boundingBox: c.boundingBox,
          })),
          interpretation: result.interpretation || '',
          message: result.clarificationQuestion || 'Please select the correct element',
          timestamp: new Date().toISOString(),
        });

        logger.info('[WebSocket] Emitted clarify event', {
          socketId: socket.id,
          previewSessionId,
          stepId: stepDraft.id,
          candidateCount: validCandidates.length,
        });

        return; // Don't emit lint:result for clarification
      }

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

  // V3: Handle user selection from clarify options
  socket.on('preview:step:clarify:select', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, stepId, selectedRef } = data;

      if (!previewSessionId || !stepId || !selectedRef) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Missing required fields for clarification selection',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Get pending clarification
      const clarifyKey = `${previewSessionId}:${stepId}`;
      const pending = pendingClarifications.get(clarifyKey);

      if (!pending) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Clarification session expired or not found',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Validate user owns this clarification
      if (pending.userId !== ensuredUserId) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Unauthorized clarification selection',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Find selected candidate
      const selectedCandidate = pending.candidates.find(c => c.ref === selectedRef);

      if (!selectedCandidate) {
        socket.emit('preview:step:lint:result', {
          status: 'error',
          message: 'Selected element not found in candidates',
          confidence: 0,
          candidates: [],
          highlight: [],
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Clean up pending clarification
      pendingClarifications.delete(clarifyKey);

      // V3: Store confirmed selection for use in apply
      confirmedSelections.set(clarifyKey, {
        selectedRef,
        userId: ensuredUserId,
        timestamp: Date.now(),
      });

      logger.info('[WebSocket] Clarification selected and stored', {
        socketId: socket.id,
        previewSessionId,
        stepId,
        selectedRef,
      });

      // Return resolved result with user-confirmed candidate
      socket.emit('preview:step:lint:result', {
        status: 'resolved',
        message: 'User confirmed element selection',
        confidence: 1.0, // User confirmed = 100% confidence
        candidates: [selectedCandidate],
        highlight: [{
          ref: selectedCandidate.ref,
          boundingBox: selectedCandidate.boundingBox,
          type: 'success',
        }],
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:step:clarify:select', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('preview:step:lint:result', {
        status: 'error',
        message: error instanceof Error ? error.message : 'Clarification selection failed',
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

      // V4: Normalize/sanitize options if present
      if (stepDraft.options) {
        const opts = stepDraft.options;
        // Normalize timeout: must be number >= 0 and <= 60000 (max 1 min)
        if (opts.timeout !== undefined) {
          const t = Number(opts.timeout);
          if (Number.isNaN(t) || t < 0) {
            opts.timeout = undefined;
          } else {
            opts.timeout = Math.min(t, 60000);
          }
        }
        // Normalize booleans
        if (opts.replaceContent !== undefined) {
          opts.replaceContent = Boolean(opts.replaceContent);
        }
        if (opts.pressEnter !== undefined) {
          opts.pressEnter = Boolean(opts.pressEnter);
        }
      }

      // V3: Check if user confirmed a selection for this step
      const selectionKey = `${previewSessionId}:${stepDraft.id}`;
      const confirmedSelection = confirmedSelections.get(selectionKey);
      let selectedRef: string | undefined;

      if (confirmedSelection && confirmedSelection.userId === ensuredUserId) {
        selectedRef = confirmedSelection.selectedRef;
        logger.debug('[WebSocket] Using confirmed selection for apply', {
          socketId: socket.id,
          previewSessionId,
          stepId: stepDraft.id,
          selectedRef,
        });
      } else {
        logger.debug('[WebSocket] Step apply request (no confirmed selection)', {
          socketId: socket.id,
          previewSessionId,
          stepType: stepDraft.type,
          descriptionPreview: typeof stepDraft.description === 'string' ? stepDraft.description.slice(0, 80) : '',
        });
      }

      // Import apply service dynamically to avoid circular deps
      const { PreviewStepApplyService } = await import('@/services/testing/ui/preview/preview-step-apply.service');

      const result = await PreviewStepApplyService.applyStep({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
        selectedRef, // V3: Pass confirmed selection
      });

      // V3: Clean up confirmed selection only after successful apply
      if (result.success && confirmedSelection) {
        confirmedSelections.delete(selectionKey);
      }

      socket.emit('preview:step:apply:result', {
        ...result,
        timestamp: new Date().toISOString(),
      });

      // If successful, emit updated page state with screenshot to all subscribers
      if (result.success) {
        // Emit result immediately, then snapshot async
        setImmediate(async () => {
          try {
            const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
            const sessionService = getPreviewSessionService();
            const snapshot = await sessionService.getSnapshot(previewSessionId, ensuredUserId, {
              force: true,
              includeScreenshot: true,
              onlyIfChanged: true, // Only emit if page actually changed
            });

            if (snapshot && snapshot.changed !== false) {
              const room = createRoomName('preview', previewSessionId);
              const payload = {
                previewSessionId,
                url: snapshot.url,
                domNodes: snapshot.domNodes,
                screenshot: snapshot.screenshot,
                timestamp: new Date().toISOString(),
              };

              // Emit to the caller immediately (even if not subscribed)
              socket.emit('preview:page', payload);
              // Emit to other subscribers
              socket.to(room).emit('preview:page', payload);

              logger.debug('[WebSocket] Emitted preview:page after apply', {
                socketId: socket.id,
                previewSessionId,
                hasScreenshot: !!snapshot.screenshot,
                changed: snapshot.changed,
              });
            }
          } catch (snapshotError) {
            logger.warn('[WebSocket] Failed to emit preview:page after apply', {
              socketId: socket.id,
              previewSessionId,
              error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
            });
          }
        });
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

  // ═══════════════════════════════════════════════════════════════════════════
  // V5: Interactive preview control handlers
  // ═══════════════════════════════════════════════════════════════════════════

  // Handle mouse move (hover)
  socket.on('preview:mouse:move', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) {
        emitInputError(socket, data.previewSessionId || '', 'move', 'Mouse rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'move', 'Invalid previewSessionId');
        return;
      }

      const { x, y } = data;
      if (x === undefined || y === undefined) {
        emitInputError(socket, previewSessionId, 'move', 'Missing x or y coordinates');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'move',
        x,
        y,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'move');
      } else {
        emitInputError(socket, previewSessionId, 'move', result.error || 'Move failed');
      }
      // No snapshot for hover
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:move', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse click
  socket.on('preview:mouse:click', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) {
        emitInputError(socket, data.previewSessionId || '', 'click', 'Mouse rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'click', 'Invalid previewSessionId');
        return;
      }

      const { x, y, button, clickCount } = data;
      if (x === undefined || y === undefined) {
        emitInputError(socket, previewSessionId, 'click', 'Missing x or y coordinates');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'click',
        x,
        y,
        button,
        clickCount,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'click');
        if (result.needsSnapshot) {
          // Always emit snapshot after click so user always sees visual feedback
          setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
        }
      } else {
        emitInputError(socket, previewSessionId, 'click', result.error || 'Click failed');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:click', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse down (drag start)
  socket.on('preview:mouse:down', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) {
        emitInputError(socket, data.previewSessionId || '', 'down', 'Mouse rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'down', 'Invalid previewSessionId');
        return;
      }

      const { x, y, button } = data;
      if (x === undefined || y === undefined) {
        emitInputError(socket, previewSessionId, 'down', 'Missing x or y coordinates');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'down',
        x,
        y,
        button,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'down');
      } else {
        emitInputError(socket, previewSessionId, 'down', result.error || 'Mouse down failed');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:down', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse up (drag end)
  socket.on('preview:mouse:up', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) {
        emitInputError(socket, data.previewSessionId || '', 'up', 'Mouse rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'up', 'Invalid previewSessionId');
        return;
      }

      const { x, y, button } = data;
      if (x === undefined || y === undefined) {
        emitInputError(socket, previewSessionId, 'up', 'Missing x or y coordinates');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseAction({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        action: 'up',
        x,
        y,
        button,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'up');
        if (result.needsSnapshot) {
          // Always emit snapshot after mouse up (drag end) so user sees visual feedback
          setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
        }
      } else {
        emitInputError(socket, previewSessionId, 'up', result.error || 'Mouse up failed');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:up', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse wheel (scroll)
  socket.on('preview:mouse:wheel', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'mouse')) {
        emitInputError(socket, data.previewSessionId || '', 'wheel', 'Mouse rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'wheel', 'Invalid previewSessionId');
        return;
      }

      const { deltaX, deltaY } = data;
      if (deltaX === undefined || deltaY === undefined) {
        emitInputError(socket, previewSessionId, 'wheel', 'Missing deltaX or deltaY');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeMouseWheel({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        deltaX,
        deltaY,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'wheel');
        // Scroll may reveal lazy-loaded content – always emit for visual feedback
        setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
      } else {
        emitInputError(socket, previewSessionId, 'wheel', result.error || 'Wheel failed');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:mouse:wheel', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle keyboard type
  socket.on('preview:keyboard:type', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'keyboard')) {
        emitInputError(socket, data.previewSessionId || '', 'type', 'Keyboard rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'type', 'Invalid previewSessionId');
        return;
      }

      const { text } = data;
      if (!text) {
        emitInputError(socket, previewSessionId, 'type', 'Missing text');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeKeyboardType({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        text,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'type');
        setImmediate(() => emitSnapshotIfChanged(socket, previewSessionId, ensuredUserId));
      } else {
        emitInputError(socket, previewSessionId, 'type', result.error || 'Type failed');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:keyboard:type', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle keyboard press
  socket.on('preview:keyboard:press', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'keyboard')) {
        emitInputError(socket, data.previewSessionId || '', 'press', 'Keyboard rate limit exceeded');
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        emitInputError(socket, data.previewSessionId || '', 'press', 'Invalid previewSessionId');
        return;
      }

      const { key, modifiers } = data;
      if (!key) {
        emitInputError(socket, previewSessionId, 'press', 'Missing key');
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.executeKeyboardPress({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        key,
        modifiers,
      });

      if (result.success) {
        emitInputSuccess(socket, previewSessionId, 'press');
        setImmediate(() => emitSnapshotIfChanged(socket, previewSessionId, ensuredUserId));
      } else {
        emitInputError(socket, previewSessionId, 'press', result.error || 'Press failed');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:keyboard:press', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle mouse probe (debug: element under point)
  socket.on('preview:mouse:probe', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      // Use mouse rate limit for probe as well
      if (!checkRateLimit(socket.id, 'mouse')) {
        return; // Silently drop - this is debug tool, no error needed
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        return; // Silently drop - debug tool
      }

      const { x, y } = data;
      if (x === undefined || y === undefined) {
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.probeElementAt({
        sessionId: previewSessionId,
        userId: ensuredUserId,
        x,
        y,
      });

      socket.emit('preview:mouse:probe:result', {
        previewSessionId,
        x,
        y,
        element: result.element,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:mouse:probe', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', () => {
    // V6: Cleanup snapshot streams for all rooms the socket was subscribed to
    const subs = previewSubscriptions.get(socket.id);
    if (subs) {
      for (const room of subs) {
        // Decrement refcount for this room
        const currentCount = previewRoomRefCount.get(room) || 0;
        const newCount = Math.max(0, currentCount - 1);

        if (newCount === 0) {
          // Extract previewSessionId from room name (format: "preview:<sessionId>")
          const previewSessionId = room.replace('preview:', '');
          stopSnapshotStream(previewSessionId);
          previewRoomRefCount.delete(room);

          logger.debug('[WebSocket] Stopped stream on disconnect', {
            socketId: socket.id,
            room,
            previewSessionId,
          });
        } else {
          previewRoomRefCount.set(room, newCount);
        }
      }
    }

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
