/**
 * Preview Handler V7
 * Handles WebSocket events for step editor preview sessions
 * Features:
 * - Ownership enforcement, rate limiting
 * - AI semantic matching, clarification flow
 * - Video stream (CDP screencast) instead of 500ms screenshot polling
 * - DevTools tabs: Console, Network, HTML, Accessibility, Context
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
// V7: Video + DevTools streaming registry
// ═══════════════════════════════════════════════════════════════════════════

// Subscriber refcount per room (preview:<sessionId>)
const previewRoomRefCount = new Map<string, number>();

// Stream context to remember userId/room for streams
interface StreamContext {
  previewSessionId: string;
  userId: string;
  room: string;
}
const previewStreamContext = new Map<string, StreamContext>();

// DOM update interval for preview:page (check every 500ms, emit only on change)
const DOM_UPDATE_INTERVAL_MS = 500;
const activeDomUpdateIntervals = new Map<string, NodeJS.Timeout>();

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
  // Typing can be bursty (frontend may send frequent keyboard:type updates),
  // so keep this high enough to avoid UX throttling while still preventing abuse.
  keyboard: { max: 300, windowMs: 10000 }, // 300 keyboard events per 10s
  pageAction: { max: 5, windowMs: 10000 }, // 5 refresh/reset per 10s
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
 * Emit action result for page actions (refresh/reset)
 */
function emitPageActionResult(
  socket: TypedSocket,
  previewSessionId: string,
  action: 'refresh' | 'reset',
  success: boolean,
  error?: string
): void {
  socket.emit('preview:page:action:result', {
    previewSessionId,
    action,
    success,
    error,
    timestamp: new Date().toISOString(),
  });
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
 * Start video stream + DevTools collectors for a preview session
 * - Video: CDP screencast ~10 fps
 * - DOM updates: preview:page only on change
 * - DevTools: Console/Network push, HTML/Accessibility on-demand
 */
const startPreviewStreams = async (context: StreamContext, nsp: any): Promise<void> => {
  const { previewSessionId, userId, room } = context;

  // Don't start if already streaming
  if (activeDomUpdateIntervals.has(previewSessionId)) {
    return;
  }

  previewStreamContext.set(previewSessionId, context);

  try {
    const { getPreviewSessionService, getPreviewVideoStreamRegistry, getPreviewDevToolsRegistry } =
      await import('@/services/testing/ui/preview');
    const sessionService = getPreviewSessionService();
    const videoRegistry = getPreviewVideoStreamRegistry();
    const devtoolsRegistry = getPreviewDevToolsRegistry();

    // Get page from session
    const page = sessionService.getPage(previewSessionId, userId);
    if (!page) {
      logger.warn('[PREVIEW_STREAM] No page found for session', { previewSessionId });
      return;
    }

    // Start video stream (CDP screencast)
    const videoStarted = await videoRegistry.startStream(previewSessionId, userId, room, page, nsp);
    if (videoStarted) {
      logger.info('[PREVIEW_STREAM] Video stream started', { previewSessionId, room });
    }

    // Start DevTools collectors (console/network push)
    devtoolsRegistry.start(previewSessionId, room, page, nsp);

    // Start DOM update interval (emit preview:page only on change)
    const domInterval = setInterval(async () => {
      try {
        const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
          onlyIfChanged: true, // Only return full data if changed
        });

        if (snapshot && snapshot.changed) {
          const payload: PreviewPagePayload = {
            previewSessionId,
            url: snapshot.url,
            domVersion: snapshot.domVersion,
            pageSignature: snapshot.pageSignature,
            domNodes: snapshot.domNodes, // Only included when changed
            timestamp: new Date().toISOString(),
          };

          // Emit to entire room
          nsp.to(room).emit('preview:page', payload);

          // Update video stream with new DOM version
          videoRegistry.setDomVersion(previewSessionId, snapshot.domVersion);

          logger.debug('[PREVIEW_STREAM] Emitted preview:page (DOM changed)', {
            previewSessionId,
            domVersion: snapshot.domVersion,
            nodeCount: snapshot.domNodes?.length || 0,
          });
        }
      } catch (error) {
        logger.error('[PREVIEW_STREAM] Failed to check DOM update', {
          previewSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }, DOM_UPDATE_INTERVAL_MS);

    activeDomUpdateIntervals.set(previewSessionId, domInterval);

    logger.info('[PREVIEW_STREAM] All streams started', { previewSessionId, room });
  } catch (error) {
    logger.error('[PREVIEW_STREAM] Failed to start streams', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

/**
 * Stop all preview streams for a session
 */
const stopPreviewStreams = async (previewSessionId: string): Promise<void> => {
  // Stop DOM update interval
  const domInterval = activeDomUpdateIntervals.get(previewSessionId);
  if (domInterval) {
    clearInterval(domInterval);
    activeDomUpdateIntervals.delete(previewSessionId);
  }

  // Stop video stream
  try {
    const { getPreviewVideoStreamRegistry, getPreviewDevToolsRegistry } =
      await import('@/services/testing/ui/preview');

    await getPreviewVideoStreamRegistry().stopStream(previewSessionId);
    getPreviewDevToolsRegistry().stop(previewSessionId);
  } catch (error) {
    logger.warn('[PREVIEW_STREAM] Error stopping streams', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  previewStreamContext.delete(previewSessionId);
  logger.info('[PREVIEW_STREAM] All streams stopped', { previewSessionId });
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

      // V7: Start video + devtools streaming on first subscriber
      const currentCount = previewRoomRefCount.get(room) || 0;
      previewRoomRefCount.set(room, currentCount + 1);

      if (currentCount === 0 && !activeDomUpdateIntervals.has(normalizedPreviewSessionId)) {
        // First subscriber - start streaming (async, non-blocking)
        startPreviewStreams(
          {
            previewSessionId: normalizedPreviewSessionId,
            userId: ensuredUserId,
            room,
          },
          socket.nsp
        ).catch((err) => {
          logger.error('[WebSocket] Failed to start preview streams', {
            previewSessionId: normalizedPreviewSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      logger.info('[WebSocket] Subscribed to preview', {
        socketId: socket.id,
        userId: ensuredUserId,
        previewSessionId,
        room,
        subscriberCount: currentCount + 1,
      });

      // V7: Emit initial preview:page with domNodes (video stream handles visuals)
      try {
        const snapshot = await sessionService.getSnapshot(normalizedPreviewSessionId, ensuredUserId, {
          force: true,
          includeDomNodes: true, // Always include domNodes on initial load
        });

        if (snapshot) {
          socket.emit('preview:page', {
            previewSessionId: normalizedPreviewSessionId,
            url: snapshot.url,
            domVersion: snapshot.domVersion,
            pageSignature: snapshot.pageSignature,
            domNodes: snapshot.domNodes,
            timestamp: new Date().toISOString(),
          });

          logger.debug('[WebSocket] Emitted initial preview:page', {
            socketId: socket.id,
            previewSessionId,
            domVersion: snapshot.domVersion,
            nodeCount: snapshot.domNodes?.length || 0,
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
          if (snapshot.domNodes && snapshot.domNodes.length > 0) {
            setImmediate(async () => {
              try {
                const { prefetchEmbeddings } = await import('@/services/testing/ui/preview/intent-step-lint.service');
                await prefetchEmbeddings({
                  previewSessionId: normalizedPreviewSessionId,
                  domNodes: snapshot.domNodes!,
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

      // V7: Stop all streaming when last subscriber leaves
      const currentCount = previewRoomRefCount.get(room) || 0;
      const newCount = Math.max(0, currentCount - 1);
      previewRoomRefCount.set(room, newCount);

      if (newCount === 0) {
        // Last subscriber left - stop all streams
        stopPreviewStreams(normalizedPreviewSessionId).catch((err) => {
          logger.warn('[WebSocket] Error stopping preview streams on unsubscribe', {
            previewSessionId: normalizedPreviewSessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
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

  // Handle step lint request (V5: with HardAllowed/SoftAllowed sets + includeAlternatives)
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

      const { previewSessionId, stepDraft, pageRef, includeAlternatives } = data;

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

      logger.debug('[WebSocket] Step lint request (V5)', {
        socketId: socket.id,
        previewSessionId,
        stepType: stepDraft.type,
        descriptionPreview: typeof stepDraft.description === 'string' ? stepDraft.description.slice(0, 80) : '',
        includeAlternatives: !!includeAlternatives,
      });

      // Import linting service dynamically to avoid circular deps
      const { IntentStepLintService } = await import('@/services/testing/ui/preview/intent-step-lint.service');

      // V5: Use AI-powered linting with includeAlternatives flag
      const result = await IntentStepLintService.lintStepWithAI({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
        includeAlternatives: !!includeAlternatives,
      });

      // V5: Handle needs_clarification status
      if (result.status === 'needs_clarification') {
        const validCandidates = result.candidates.filter(c => c.ref && c.ref.trim().length > 0);

        // Store pending clarification for this step (for use if user clicks "Show alternatives")
        const clarifyKey = `${previewSessionId}:${stepDraft.id}`;
        if (validCandidates.length > 0) {
          pendingClarifications.set(clarifyKey, {
            candidates: validCandidates,
            stepDraft,
            userId: ensuredUserId,
            timestamp: Date.now(),
          });
        }

        // V5: If includeAlternatives=true, emit clarify event with candidates
        // Otherwise, just emit lint:result with LLM message (no candidates)
        if (includeAlternatives && validCandidates.length > 0) {
          // Emit clarify event with candidates (for "Show alternatives" flow)
          socket.emit('preview:step:clarify', {
            previewSessionId,
            stepId: stepDraft.id,
            candidates: validCandidates.slice(0, 5).map(c => ({
              ref: c.ref!,
              label: c.label,
              reason: c.reason,
              boundingBox: c.boundingBox,
            })),
            interpretation: result.interpretation || '',
            message: result.clarificationQuestion || result.message,
            timestamp: new Date().toISOString(),
          });

          logger.info('[WebSocket] Emitted clarify event (alternatives requested)', {
            socketId: socket.id,
            previewSessionId,
            stepId: stepDraft.id,
            candidateCount: validCandidates.length,
          });
        }

        // V5: Always emit lint:result for needs_clarification
        // Frontend uses this to show LLM message and disable Apply
        socket.emit('preview:step:lint:result', {
          status: result.status,
          message: result.message,
          confidence: result.confidence,
          // V5: Only include candidates if includeAlternatives=true
          candidates: includeAlternatives ? validCandidates.slice(0, 5).map(c => ({
            ref: c.ref,
            label: c.label,
            reason: c.reason,
            confidence: c.confidence,
            boundingBox: c.boundingBox,
          })) : [],
          highlight: includeAlternatives ? result.highlight : [],
          interpretation: result.interpretation,
          clarificationQuestion: result.clarificationQuestion,
          alternativesIncluded: !!includeAlternatives,
          applyDisabled: true, // V5: Apply should be disabled for needs_clarification
          timestamp: new Date().toISOString(),
        });

        return;
      }

      // For resolved/not_found/error, emit result as usual
      socket.emit('preview:step:lint:result', {
        ...result,
        applyDisabled: result.status !== 'resolved', // V5: Apply only enabled for resolved
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
        applyDisabled: true,
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

      const { previewSessionId, stepDraft, pageRef, intentTestCaseId } = data;

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
          intentTestCaseId,
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

      // V6: Optional auto-persist to DB if intentTestCaseId provided and apply succeeded
      if (result.success && intentTestCaseId && result.appliedStep) {
        // Don't wait for DB update - fire and forget (don't block response)
        setImmediate(async () => {
          try {
            const { IntentTestCaseService } = await import('@/services/testing/ui/preview/intent-test-case.service');
            const updated = await IntentTestCaseService.updateStepFromPreviewApply({
              intentTestCaseId,
              appliedStep: result.appliedStep!,
            });

            if (updated) {
              logger.info('[WebSocket] Auto-persisted appliedStep to DB', {
                socketId: socket.id,
                intentTestCaseId,
                stepId: result.appliedStep!.id,
              });
            } else {
              logger.warn('[WebSocket] Failed to auto-persist appliedStep to DB', {
                socketId: socket.id,
                intentTestCaseId,
                stepId: result.appliedStep!.id,
              });
            }
          } catch (persistError) {
            logger.error('[WebSocket] Error auto-persisting appliedStep to DB', {
              socketId: socket.id,
              intentTestCaseId,
              error: persistError instanceof Error ? persistError.message : String(persistError),
            });
          }
        });
      }

      // If successful, emit updated page state to all subscribers
      if (result.success) {
        // Emit result immediately, then snapshot async
        setImmediate(async () => {
          try {
            const { getPreviewSessionService, getPreviewVideoStreamRegistry } =
              await import('@/services/testing/ui/preview');
            const sessionService = getPreviewSessionService();
            const snapshot = await sessionService.getSnapshot(previewSessionId, ensuredUserId, {
              force: true,
              includeDomNodes: true, // Always include after action
              onlyIfChanged: true,
            });

            if (snapshot && snapshot.changed) {
              const room = createRoomName('preview', previewSessionId);
              const payload: PreviewPagePayload = {
                previewSessionId,
                url: snapshot.url,
                domVersion: snapshot.domVersion,
                pageSignature: snapshot.pageSignature,
                domNodes: snapshot.domNodes,
                timestamp: new Date().toISOString(),
              };

              // Emit to the caller immediately (even if not subscribed)
              socket.emit('preview:page', payload);
              // Emit to other subscribers
              socket.to(room).emit('preview:page', payload);

              // Update video stream with new DOM version
              getPreviewVideoStreamRegistry().setDomVersion(previewSessionId, snapshot.domVersion);

              logger.debug('[WebSocket] Emitted preview:page after apply', {
                socketId: socket.id,
                previewSessionId,
                domVersion: snapshot.domVersion,
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

  // Handle page refresh
  socket.on('preview:page:refresh', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) {
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        return;
      }

      logger.info('[WebSocket] Preview refresh requested', { previewSessionId, userId: ensuredUserId });

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Refresh page
      const result = await sessionService.refreshPage(previewSessionId, ensuredUserId);

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'refresh', true);
        setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
      } else {
        emitPageActionResult(socket, previewSessionId, 'refresh', false, 'Refresh failed or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:refresh', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'refresh', false, 'Internal error');
      }
    }
  });

  // Handle page reset
  socket.on('preview:page:reset', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) {
        return;
      }

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) {
        return;
      }

      logger.info('[WebSocket] Preview reset requested', { previewSessionId, userId: ensuredUserId });

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Reset session (clears cookies/storage/context)
      const result = await sessionService.resetSession({
        sessionId: previewSessionId,
        userId: ensuredUserId,
      });

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'reset', true);
        setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));
      } else {
        emitPageActionResult(socket, previewSessionId, 'reset', false, 'Reset failed or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:reset', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'reset', false, 'Internal error');
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V7: DevTools handlers (on-demand requests)
  // ═══════════════════════════════════════════════════════════════════════════

  // Handle network detail request (on-demand body fetch)
  socket.on('preview:network:detail:request', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, id } = data;
      if (!previewSessionId || !id) return;

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      // Check session ownership
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        return;
      }

      const collector = devtoolsRegistry.get(previewSessionId);
      if (!collector) {
        logger.debug('[WebSocket] DevTools collector not found', { previewSessionId });
        return;
      }

      const detail = collector.getNetworkDetail(id);
      if (detail) {
        socket.emit('preview:network:detail', detail);
      }
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:network:detail:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle HTML request (on-demand, heavy content)
  socket.on('preview:html:request', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, domVersion } = data;
      if (!previewSessionId) return;

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      // Check session ownership
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        return;
      }

      const currentDomVersion = sessionService.getDomVersion(previewSessionId, ensuredUserId);

      // If client has same or newer version, skip
      if (domVersion !== undefined && currentDomVersion !== null && domVersion >= currentDomVersion) {
        return;
      }

      const collector = devtoolsRegistry.get(previewSessionId);
      if (!collector) return;

      const htmlPayload = await collector.fetchHtml(currentDomVersion || 1);
      if (htmlPayload) {
        socket.emit('preview:html:update', htmlPayload);
      }
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:html:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle Accessibility request (on-demand, heavy content)
  socket.on('preview:accessibility:request', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, domVersion } = data;
      if (!previewSessionId) return;

      const { getPreviewSessionService, getPreviewDevToolsRegistry } =
        await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();
      const devtoolsRegistry = getPreviewDevToolsRegistry();

      // Check session ownership
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        return;
      }

      const currentDomVersion = sessionService.getDomVersion(previewSessionId, ensuredUserId);

      // If client has same or newer version, skip
      if (domVersion !== undefined && currentDomVersion !== null && domVersion >= currentDomVersion) {
        return;
      }

      const collector = devtoolsRegistry.get(previewSessionId);
      if (!collector) return;

      const accessibilityPayload = await collector.fetchAccessibility(currentDomVersion || 1);
      if (accessibilityPayload) {
        socket.emit('preview:accessibility:update', accessibilityPayload);
      }
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:accessibility:request', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle Context set (step editor env/variables)
  socket.on('preview:context:set', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, data: contextData } = data;
      if (!previewSessionId || !contextData) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Check session ownership
      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        return;
      }

      const result = sessionService.setContextData(previewSessionId, ensuredUserId, contextData);
      if (result) {
        const room = createRoomName('preview', previewSessionId);

        // Emit to all subscribers including sender
        socket.nsp.to(room).emit('preview:context:update', {
          previewSessionId,
          version: result.version,
          data: result.data,
          timestamp: new Date().toISOString(),
        });

        logger.debug('[WebSocket] Context updated', {
          previewSessionId,
          version: result.version,
        });
      }
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:context:set', {
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
    // V7: Cleanup all streams for all rooms the socket was subscribed to
    const subs = previewSubscriptions.get(socket.id);
    if (subs) {
      for (const room of subs) {
        // Decrement refcount for this room
        const currentCount = previewRoomRefCount.get(room) || 0;
        const newCount = Math.max(0, currentCount - 1);

        if (newCount === 0) {
          // Extract previewSessionId from room name (format: "preview:<sessionId>")
          const previewSessionId = room.replace('preview:', '');
          stopPreviewStreams(previewSessionId).catch(() => {});
          previewRoomRefCount.delete(room);

          logger.debug('[WebSocket] Stopped streams on disconnect', {
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
