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
import { EditorTraceService } from '@/services/testing/ui/preview/editor-trace.service';
import { uploadEditorTrace } from '@/services/testing/ui/preview/editor-trace-upload';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

// Track subscribed preview sessions per socket
const previewSubscriptions = new Map<string, Set<string>>();

// ═══════════════════════════════════════════════════════════════════════════
// RECORDING: Module-level state
// ═══════════════════════════════════════════════════════════════════════════

/** Per-session typing debounce timers */
const recordingTypingTimers = new Map<string, NodeJS.Timeout>();
const RECORDING_TYPING_DEBOUNCE_MS = 1500;

/** Per-session scroll debounce timers */
const recordingScrollTimers = new Map<string, { deltaY: number; timer: NodeJS.Timeout }>();
const RECORDING_SCROLL_DEBOUNCE_MS = 500;
/** V10: Time window (ms) within which consecutive scroll steps merge into one */
const RECORDING_SCROLL_MERGE_WINDOW_MS = 3000;

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
const activeDomUpdateTicks = new Set<string>();

/**
 * Acquire per-session DOM tick guard.
 * Returns true when the current tick is allowed to run.
 */
export function acquireDomTickGuard(previewSessionId: string, inFlight: Set<string>): boolean {
  if (inFlight.has(previewSessionId)) {
    return false;
  }
  inFlight.add(previewSessionId);
  return true;
}

/**
 * Release per-session DOM tick guard.
 */
export function releaseDomTickGuard(previewSessionId: string, inFlight: Set<string>): void {
  inFlight.delete(previewSessionId);
}

/**
 * Confirm whether user actually selected file(s) after filechooser opened.
 * filechooser event fires on dialog open, including cancel path.
 */
export async function waitForFileSelectionConfirmation(
  element: { evaluate: <T>(fn: (el: { files?: { length: number } | null }) => T) => Promise<T> },
  wait: (ms: number) => Promise<void>,
  maxAttempts = 50,
  intervalMs = 100,
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    const hasSelectedFiles = await element
      .evaluate((el) => (el.files?.length || 0) > 0)
      .catch(() => false);
    if (hasSelectedFiles) {
      return true;
    }
    await wait(intervalMs).catch(() => {});
  }
  return false;
}

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

const clarificationCleanupInterval = setInterval(() => {
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
clarificationCleanupInterval.unref?.();

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
  // Typing can be bursty (frontend sends per-keystroke type/press events),
  // so keep this high enough to avoid UX throttling while still preventing abuse.
  keyboard: { max: 600, windowMs: 10000 }, // 600 keyboard events per 10s
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
 * Emit action result for page actions (refresh/reset/back/forward)
 */
function emitPageActionResult(
  socket: TypedSocket,
  previewSessionId: string,
  action: 'refresh' | 'reset' | 'back' | 'forward',
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
      if (!acquireDomTickGuard(previewSessionId, activeDomUpdateTicks)) {
        return;
      }
      try {
        const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
          onlyIfChanged: true, // Only return full data if changed
        });

        if (snapshot && snapshot.changed) {
          const payload: PreviewPagePayload = {
            previewSessionId,
            url: snapshot.url,
            pageTitle: snapshot.pageTitle,
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
      } finally {
        releaseDomTickGuard(previewSessionId, activeDomUpdateTicks);
      }
    }, DOM_UPDATE_INTERVAL_MS);

    activeDomUpdateIntervals.set(previewSessionId, domInterval);

    // V11: Register page-switch callback so popup/new-tab auto-restarts video + devtools
    sessionService.setOnPageSwitch(previewSessionId, userId, (newPage, previousUrl) => {
      logger.info('[PREVIEW_STREAM] Page switched (popup/new tab) — restarting streams', {
        previewSessionId,
        previousUrl,
        newUrl: newPage.url(),
      });

      // Restart video + devtools on the new page (async, non-blocking)
      setImmediate(async () => {
        try {
          // Restart video stream (startStream internally stops the old one and inherits seq)
          await videoRegistry.startStream(previewSessionId, userId, room, newPage, nsp);

          // Restart devtools collectors
          devtoolsRegistry.stop(previewSessionId);
          devtoolsRegistry.start(previewSessionId, room, newPage, nsp);

          logger.info('[PREVIEW_STREAM] Streams restarted after page switch', { previewSessionId });

          // V11: Force-emit a fresh DOM snapshot after page switch.
          // DOM tick may have been blocked by pageSwitchInProgress, so we need to send
          // the first valid snapshot explicitly. Retry up to 3 times if nodeCount is 0
          // (page may still be rendering).
          for (let attempt = 1; attempt <= 3; attempt++) {
            try {
              const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
                force: true,
                includeDomNodes: true,
              });
              if (snapshot) {
                const payload: PreviewPagePayload = {
                  previewSessionId,
                  url: snapshot.url,
                  pageTitle: snapshot.pageTitle,
                  domVersion: snapshot.domVersion,
                  pageSignature: snapshot.pageSignature,
                  domNodes: snapshot.domNodes,
                  timestamp: new Date().toISOString(),
                };
                nsp.to(room).emit('preview:page', payload);
                videoRegistry.setDomVersion(previewSessionId, snapshot.domVersion);

                logger.info('[PREVIEW_STREAM] Emitted fresh snapshot after page switch', {
                  previewSessionId,
                  attempt,
                  domVersion: snapshot.domVersion,
                  nodeCount: snapshot.domNodes?.length || 0,
                });

                // If we got actual DOM nodes, we're done
                if (snapshot.domNodes && snapshot.domNodes.length > 0) {
                  break;
                }
              }
              // Wait before retry (page may still be rendering)
              if (attempt < 3) {
                await new Promise(r => setTimeout(r, 1000));
              }
            } catch (snapshotError) {
              logger.warn('[PREVIEW_STREAM] Failed to emit snapshot after page switch', {
                previewSessionId,
                attempt,
                error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
              });
            }
          }
        } catch (restartError) {
          logger.warn('[PREVIEW_STREAM] Failed to restart streams after page switch', {
            previewSessionId,
            error: restartError instanceof Error ? restartError.message : String(restartError),
          });
        }
      });
    });

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
  activeDomUpdateTicks.delete(previewSessionId);

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
            pageTitle: snapshot.pageTitle,
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

      // V9: Guard — cannot manually apply steps while a run is active
      {
        const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
        if (PreviewRunService.isRunning(previewSessionId)) {
          socket.emit('preview:step:apply:result', {
            success: false,
            error: 'Cannot apply steps while a run is in progress',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

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

      // Editor trace: log step apply request (getOrCreate ensures trace file exists even without recording)
      const applyTrace = EditorTraceService.getOrCreate(previewSessionId, ensuredUserId);
      applyTrace.writeStepApplyRequest(stepDraft);

      const result = await PreviewStepApplyService.applyStep({
        previewSessionId,
        stepDraft,
        pageRef,
        userId: ensuredUserId,
        selectedRef, // V3: Pass confirmed selection
      });

      // Editor trace: log step apply result
      applyTrace.writeStepApplyResult(result);

      // V3: Clean up confirmed selection only after successful apply
      if (result.success && confirmedSelection) {
        confirmedSelections.delete(selectionKey);
      }

      socket.emit('preview:step:apply:result', {
        ...result,
        timestamp: new Date().toISOString(),
      });

      // V8: Auto-persist to DB if intentTestCaseId provided and apply succeeded.
      // Skip if a run is active (the run will batch-persist at the end).
      // Awaited instead of setImmediate to prevent race with run:start.
      if (result.success && intentTestCaseId && result.appliedStep) {
        try {
          const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
          if (!PreviewRunService.isRunning(previewSessionId)) {
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
            }
          }
        } catch (persistError) {
          logger.error('[WebSocket] Error auto-persisting appliedStep to DB', {
            socketId: socket.id,
            intentTestCaseId,
            error: persistError instanceof Error ? persistError.message : String(persistError),
          });
        }
      }

      // If successful, emit updated page state to all subscribers
      if (result.success) {
        // Emit result immediately, then snapshot async
        setImmediate(async () => {
          try {
            const { getPreviewSessionService, getPreviewVideoStreamRegistry } =
              await import('@/services/testing/ui/preview');
            const sessionService = getPreviewSessionService();

            // V9: Update recording URL baseline after step:apply (prevents false nav steps)
            if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              if (page) {
                sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
              }
            }

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
                pageTitle: snapshot.pageTitle,
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

        // V11: Track last hover position for recording (used to emit hover step before click)
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          sessionService.setRecordingLastHover(previewSessionId, ensuredUserId, {
            x, y, timestamp: Date.now(),
          });
        }
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

      // V9: Pre-click probe for recording (state-aware: need element state BEFORE click)
      let preClickElement: Awaited<ReturnType<typeof import('@/services/testing/ui/preview/recording-capture.service').RecordingCaptureService.probeForRecording>> = null;
      const isRecording = sessionService.isRecording(previewSessionId, ensuredUserId);
      if (isRecording) {
        try {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );
          const page = sessionService.getPage(previewSessionId, ensuredUserId);
          if (page) {
            preClickElement = await RecordingCaptureService.probeForRecording(page, x, y);
          }
        } catch {
          // Non-critical — recording probe failure doesn't block click
        }
      }

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

        // Editor trace: log click input
        const clickTrace = EditorTraceService.get(previewSessionId);
        if (clickTrace) clickTrace.writeClick({ x, y, button, clickCount, preClickElement, isRecording });

        // V9: Recording hook (non-blocking)
        if (isRecording && preClickElement) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const room = createRoomName('preview', previewSessionId);
              const cTrace = EditorTraceService.get(previewSessionId);

              // Flush pending typing buffer (user clicked elsewhere)
              const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
              if (buffer) {
                // V10: Merge with previous type step if same element
                const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                const sameElement = lastTypeStep
                  && buffer.elementRef
                  && lastTypeStep.elementRef === buffer.elementRef;

                if (sameElement && lastTypeStep) {
                  const mergedValue = lastTypeStep.value + buffer.text;
                  const typingStep = RecordingCaptureService.flushTypingBuffer({
                    ...buffer, text: mergedValue,
                  });
                  if (typingStep) {
                    typingStep.id = lastTypeStep.id;
                    socket.nsp.to(room).emit('preview:recording:step:update', {
                      previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                    });
                    if (cTrace) cTrace.writeStepUpdated(typingStep, 'type_merge_on_click');
                  }
                } else {
                  const typingStep = RecordingCaptureService.flushTypingBuffer(buffer);
                  if (typingStep) {
                    socket.nsp.to(room).emit('preview:recording:step', {
                      previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                    });
                    if (cTrace) cTrace.writeStepCaptured(typingStep, 'type_flush_on_click');
                  }
                }
                // Click = user left the field → clear merge state
                sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                const timer = recordingTypingTimers.get(previewSessionId);
                if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
              }

              // V11: Emit hover step before click if user hovered a different element (dropdown/menu pattern)
              const lastHover = sessionService.getRecordingLastHover(previewSessionId, ensuredUserId);
              if (lastHover && preClickElement!.ref) {
                const timeSinceHover = Date.now() - lastHover.timestamp;
                const hoverOnDifferentElement = !lastHover.ref || lastHover.ref !== preClickElement!.ref;
                if (hoverOnDifferentElement && timeSinceHover > 200 && timeSinceHover < 5000) {
                  // Probe the hover target to get element info
                  try {
                    const page = sessionService.getPage(previewSessionId, ensuredUserId);
                    if (page) {
                      const hoverElement = await RecordingCaptureService.probeForRecording(page, lastHover.x, lastHover.y);
                      if (hoverElement && hoverElement.ref !== preClickElement!.ref) {
                        const hoverStep = RecordingCaptureService.captureHover(hoverElement);
                        socket.nsp.to(room).emit('preview:recording:step', {
                          previewSessionId, step: hoverStep, timestamp: new Date().toISOString(),
                        });
                        if (cTrace) cTrace.writeStepCaptured(hoverStep, 'hover_before_click');
                      }
                    }
                  } catch {
                    // Non-critical — hover step is best-effort
                  }
                }
              }
              sessionService.setRecordingLastHover(previewSessionId, ensuredUserId, null);

              // V10: Pass button and clickCount to inferClickActionType for dblclick/right-click support
              const safeButton = (data.button === 'right' || data.button === 'middle') ? data.button : 'left';
              const safeClickCount = (data.clickCount === 2) ? 2 : 1;
              const actionType = RecordingCaptureService.inferClickActionType(preClickElement!, safeClickCount, safeButton);
              const description = RecordingCaptureService.buildDescription(actionType, preClickElement!);
              const bindingHints = RecordingCaptureService.buildBindingHints(preClickElement!);

              const currentPage = sessionService.getPage(previewSessionId, ensuredUserId);
              const step: PreviewIntentStep = {
                id: `rec_${Date.now().toString(36)}`,
                type: actionType,
                description,
                bindingHints: Object.keys(bindingHints).length > 0 ? bindingHints : undefined,
                evidence: preClickElement!.ref ? {
                  lastSuccessRef: preClickElement!.ref,
                  confidence: 1.0,
                  pageUrl: currentPage?.url(),
                } : undefined,
              };

              // V10: Click breaks scroll merge context
              sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, null);

              socket.nsp.to(room).emit('preview:recording:step', {
                previewSessionId,
                step,
                highlight: preClickElement?.boundingBox,
                timestamp: new Date().toISOString(),
              });
              if (cTrace) cTrace.writeStepCaptured(step, 'click');

              // Check for navigation (wait a bit for page to settle)
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              if (page) {
                await page.waitForLoadState('domcontentloaded', { timeout: 500 }).catch(() => {});
                const currentUrl = page.url();
                const prevUrl = sessionService.getRecordingLastUrl(previewSessionId, ensuredUserId);
                if (prevUrl && currentUrl !== prevUrl) {
                  if (cTrace) cTrace.writeNavDetected({ fromUrl: prevUrl, toUrl: currentUrl });
                  const navStep = RecordingCaptureService.captureNavigation(currentUrl, prevUrl);
                  if (navStep) {
                    socket.nsp.to(room).emit('preview:recording:step', {
                      previewSessionId,
                      step: navStep,
                      timestamp: new Date().toISOString(),
                    });
                    if (cTrace) cTrace.writeStepCaptured(navStep, 'nav_after_click');
                  }
                  sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, currentUrl);
                }
              }
            } catch (e) {
              logger.debug('[RECORDING] Click capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        emitInputError(socket, previewSessionId, 'click', result.error || 'Click failed');
        const clickErrTrace = EditorTraceService.get(previewSessionId);
        if (clickErrTrace) clickErrTrace.writeError('click_failed', { x, y, button, error: result.error });
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

        // Editor trace: log mouse down
        const downTrace = EditorTraceService.get(previewSessionId);
        if (downTrace) downTrace.writeMouseDown({ x, y, button });

        // V10 Fix #4: Recording hook — start drag tracking
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              const startElement = page
                ? await RecordingCaptureService.probeForRecording(page, x, y)
                : null;
              sessionService.setRecordingDragState(previewSessionId, ensuredUserId, {
                startX: x,
                startY: y,
                startElement,
                startedAt: Date.now(),
              });
            } catch (e) {
              logger.debug('[RECORDING] Drag start capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        emitInputError(socket, previewSessionId, 'down', result.error || 'Mouse down failed');
        const downErrTrace = EditorTraceService.get(previewSessionId);
        if (downErrTrace) downErrTrace.writeError('mouse_down_failed', { x, y, error: result.error });
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

        // Editor trace: log mouse up
        const upTrace = EditorTraceService.get(previewSessionId);
        if (upTrace) upTrace.writeMouseUp({ x, y, button });

        // V10 Fix #4: Recording hook — detect drag & drop
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const dragState = sessionService.getRecordingDragState(previewSessionId, ensuredUserId);
              // Clear drag state regardless
              sessionService.setRecordingDragState(previewSessionId, ensuredUserId, null);

              if (!dragState) return; // No drag was started

              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );

              // Probe drop target
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              const endElement = page
                ? await RecordingCaptureService.probeForRecording(page, x, y)
                : null;

              const dragStep = RecordingCaptureService.captureDragAndDrop(
                dragState,
                x,
                y,
                endElement,
              );

              if (dragStep) {
                const room = createRoomName('preview', previewSessionId);
                socket.nsp.to(room).emit('preview:recording:step', {
                  previewSessionId,
                  step: dragStep,
                  timestamp: new Date().toISOString(),
                });
                // Editor trace: log drag-drop step
                const ddTrace = EditorTraceService.get(previewSessionId);
                if (ddTrace) {
                  ddTrace.writeDragDrop({
                    startX: dragState.startX, startY: dragState.startY,
                    endX: x, endY: y,
                    startElement: dragState.startElement, endElement,
                  });
                  ddTrace.writeStepCaptured(dragStep, 'drag_drop');
                }
              }
            } catch (e) {
              logger.debug('[RECORDING] Drag end capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        emitInputError(socket, previewSessionId, 'up', result.error || 'Mouse up failed');
        const upErrTrace = EditorTraceService.get(previewSessionId);
        if (upErrTrace) upErrTrace.writeError('mouse_up_failed', { x, y, error: result.error });
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

        // Editor trace: log scroll input
        const scrollTrace = EditorTraceService.get(previewSessionId);
        if (scrollTrace) scrollTrace.writeScroll({ deltaX, deltaY });

        // V9: Recording hook — debounced scroll step
        // V10: Merge consecutive scrolls within SCROLL_MERGE_WINDOW_MS into a single step
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          const existing = recordingScrollTimers.get(previewSessionId);
          const accumulatedDeltaY = (existing?.deltaY ?? 0) + (data.deltaY ?? 0);
          if (existing) clearTimeout(existing.timer);

          recordingScrollTimers.set(previewSessionId, {
            deltaY: accumulatedDeltaY,
            timer: setTimeout(async () => {
              try {
                const finalDeltaY = recordingScrollTimers.get(previewSessionId)?.deltaY ?? accumulatedDeltaY;
                recordingScrollTimers.delete(previewSessionId);
                if (finalDeltaY === 0) return;

                const { RecordingCaptureService } = await import(
                  '@/services/testing/ui/preview/recording-capture.service'
                );
                const room = createRoomName('preview', previewSessionId);
                const sTrace = EditorTraceService.get(previewSessionId);

                // V10: Merge with previous scroll step if emitted recently (within 3s)
                const lastScrollStep = sessionService.getRecordingLastScrollStep(previewSessionId, ensuredUserId);
                const now = Date.now();
                const withinMergeWindow = lastScrollStep && (now - lastScrollStep.emittedAt) < RECORDING_SCROLL_MERGE_WINDOW_MS;

                if (withinMergeWindow && lastScrollStep) {
                  // Same direction or continuation — merge deltas
                  const mergedDelta = lastScrollStep.totalDelta + finalDeltaY;
                  const scrollStep = RecordingCaptureService.captureScroll(mergedDelta);
                  if (scrollStep) {
                    scrollStep.id = lastScrollStep.id; // Reuse original step id
                    socket.nsp.to(room).emit('preview:recording:step:update', {
                      previewSessionId, step: scrollStep, timestamp: new Date().toISOString(),
                    });
                    if (sTrace) sTrace.writeStepUpdated(scrollStep, 'scroll_merge');
                    sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, {
                      id: lastScrollStep.id,
                      totalDelta: mergedDelta,
                      emittedAt: now,
                    });
                  }
                } else {
                  // New scroll sequence — emit new step
                  const scrollStep = RecordingCaptureService.captureScroll(finalDeltaY);
                  if (scrollStep) {
                    socket.nsp.to(room).emit('preview:recording:step', {
                      previewSessionId, step: scrollStep, timestamp: new Date().toISOString(),
                    });
                    if (sTrace) sTrace.writeStepCaptured(scrollStep, 'scroll');
                    sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, {
                      id: scrollStep.id,
                      totalDelta: finalDeltaY,
                      emittedAt: now,
                    });
                  }
                }
              } catch (e) {
                logger.debug('[RECORDING] Scroll capture failed', {
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }, RECORDING_SCROLL_DEBOUNCE_MS),
          });
        }
      } else {
        emitInputError(socket, previewSessionId, 'wheel', result.error || 'Wheel failed');
        const wheelErrTrace = EditorTraceService.get(previewSessionId);
        if (wheelErrTrace) wheelErrTrace.writeError('wheel_failed', { deltaX, deltaY, error: result.error });
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

        // Editor trace: log type input
        const typeTrace = EditorTraceService.get(previewSessionId);
        if (typeTrace) typeTrace.writeType({ text: data.text });

        // V9: Recording hook — accumulate typing into buffer
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );

              let buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);

              if (!buffer) {
                // First character — probe focused element for label
                const page = sessionService.getPage(previewSessionId, ensuredUserId);
                const focusedEl = page ? await RecordingCaptureService.probeFocusedElement(page) : null;
                buffer = {
                  text: data.text,
                  elementRef: focusedEl?.ref,
                  elementLabel: RecordingCaptureService.getElementLabel(focusedEl),
                  lastCharAt: Date.now(),
                  bindingHints: focusedEl ? RecordingCaptureService.buildBindingHints(focusedEl) as Record<string, string> : undefined,
                  isMultiline: focusedEl?.isMultiline,
                  pageUrl: page?.url(),
                };
              } else {
                buffer.text += data.text;
                buffer.lastCharAt = Date.now();
              }

              sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, buffer);

              // Reset debounce timer
              const existingTimer = recordingTypingTimers.get(previewSessionId);
              if (existingTimer) clearTimeout(existingTimer);

              recordingTypingTimers.set(previewSessionId, setTimeout(async () => {
                try {
                  const currentBuffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
                  if (currentBuffer) {
                    const room = createRoomName('preview', previewSessionId);
                    const tTrace = EditorTraceService.get(previewSessionId);

                    // V10: Check if this is a continuation of typing in the same element
                    const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                    const sameElement = lastTypeStep
                      && currentBuffer.elementRef
                      && lastTypeStep.elementRef === currentBuffer.elementRef;

                    if (sameElement && lastTypeStep) {
                      // Merge: combine previous + current text, reuse same step id
                      const mergedValue = lastTypeStep.value + currentBuffer.text;
                      const mergedStep = RecordingCaptureService.flushTypingBuffer({
                        ...currentBuffer,
                        text: mergedValue,
                      });
                      if (mergedStep) {
                        mergedStep.id = lastTypeStep.id; // Reuse the original step id
                        socket.nsp.to(room).emit('preview:recording:step:update', {
                          previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                        });
                        if (tTrace) tTrace.writeStepUpdated(mergedStep, 'type_merge');
                        sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                          id: lastTypeStep.id,
                          elementRef: currentBuffer.elementRef,
                          value: mergedValue,
                        });
                      }
                    } else {
                      // New element or first type — emit new step
                      const step = RecordingCaptureService.flushTypingBuffer(currentBuffer);
                      if (step) {
                        socket.nsp.to(room).emit('preview:recording:step', {
                          previewSessionId, step, timestamp: new Date().toISOString(),
                        });
                        if (tTrace) tTrace.writeStepCaptured(step, 'type');
                        sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                          id: step.id,
                          elementRef: currentBuffer.elementRef,
                          value: currentBuffer.text,
                        });
                      }
                    }

                    sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                  }
                } catch (e) {
                  logger.debug('[RECORDING] Typing flush failed', {
                    error: e instanceof Error ? e.message : String(e),
                  });
                }
                recordingTypingTimers.delete(previewSessionId);
              }, RECORDING_TYPING_DEBOUNCE_MS));
            } catch (e) {
              logger.debug('[RECORDING] Type capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        emitInputError(socket, previewSessionId, 'type', result.error || 'Type failed');
        const typeErrTrace = EditorTraceService.get(previewSessionId);
        if (typeErrTrace) typeErrTrace.writeError('type_failed', { text: data.text, error: result.error });
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

        // Editor trace: log press input
        const pressTrace = EditorTraceService.get(previewSessionId);
        if (pressTrace) pressTrace.writePress({ key, modifiers, isRecording: sessionService.isRecording(previewSessionId, ensuredUserId) });

        // V9: Recording hook — flush typing buffer + emit press step
        // V10: When Enter is pressed after typing, merge into single step with pressEnter:true
        // V10 Fix #1: Shift+Enter in multiline elements appends \n to buffer instead of flushing
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const room = createRoomName('preview', previewSessionId);
              const pTrace = EditorTraceService.get(previewSessionId);

              const isEnterKey = data.key === 'Enter';
              let mergedEnterIntoType = false;

              // V10 Fix #1: Detect Shift+Enter in multiline → append \n to buffer
              const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
              const isMultiline = buffer?.isMultiline ?? false;

              if (RecordingCaptureService.isNewlineInsertion(data.key, data.modifiers, isMultiline)) {
                // Shift+Enter in textarea/contenteditable = newline character
                // Append \n to typing buffer instead of flushing
                if (buffer) {
                  buffer.text += '\n';
                  buffer.lastCharAt = Date.now();
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, buffer);

                  // Reset debounce timer (same as regular typing, with merge logic)
                  const existingTimer = recordingTypingTimers.get(previewSessionId);
                  if (existingTimer) clearTimeout(existingTimer);
                  recordingTypingTimers.set(previewSessionId, setTimeout(async () => {
                    try {
                      const currentBuffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
                      if (currentBuffer) {
                        // V10: Same merge logic as keyboard:type debounce
                        const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                        const sameElement = lastTypeStep
                          && currentBuffer.elementRef
                          && lastTypeStep.elementRef === currentBuffer.elementRef;

                        if (sameElement && lastTypeStep) {
                          const mergedValue = lastTypeStep.value + currentBuffer.text;
                          const mergedStep = RecordingCaptureService.flushTypingBuffer({
                            ...currentBuffer,
                            text: mergedValue,
                          });
                          if (mergedStep) {
                            mergedStep.id = lastTypeStep.id;
                            socket.nsp.to(room).emit('preview:recording:step:update', {
                              previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                            });
                            if (pTrace) pTrace.writeStepUpdated(mergedStep, 'multiline_type_merge');
                            sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                              id: lastTypeStep.id,
                              elementRef: currentBuffer.elementRef,
                              value: mergedValue,
                            });
                          }
                        } else {
                          const step = RecordingCaptureService.flushTypingBuffer(currentBuffer);
                          if (step) {
                            socket.nsp.to(room).emit('preview:recording:step', {
                              previewSessionId, step, timestamp: new Date().toISOString(),
                            });
                            if (pTrace) pTrace.writeStepCaptured(step, 'multiline_type');
                            sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                              id: step.id,
                              elementRef: currentBuffer.elementRef,
                              value: currentBuffer.text,
                            });
                          }
                        }
                        sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                      }
                    } catch { /* ignore */ }
                    recordingTypingTimers.delete(previewSessionId);
                  }, RECORDING_TYPING_DEBOUNCE_MS));
                }
                // Don't flush, don't emit press step — the \n is part of the typed text
                return;
              }

              // Backspace/Delete while typing: edit the buffer instead of emitting a separate press step.
              // This ensures the recorded type step reflects the final corrected text, not the raw keystrokes.
              if (data.key === 'Backspace' || data.key === 'Delete') {
                const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);

                if (buffer && buffer.text.length > 0) {
                  // Case 1: Active buffer with text — remove last char from current buffer batch
                  buffer.text = buffer.text.slice(0, -1);
                  buffer.lastCharAt = Date.now();
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, buffer);

                  // If we have a previously emitted step for same element, update it with corrected merge
                  const sameElement = lastTypeStep
                    && buffer.elementRef
                    && lastTypeStep.elementRef === buffer.elementRef;

                  if (sameElement && lastTypeStep) {
                    const mergedValue = lastTypeStep.value + buffer.text;
                    const mergedStep = RecordingCaptureService.flushTypingBuffer({
                      ...buffer, text: mergedValue,
                    });
                    if (mergedStep) {
                      mergedStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: mergedStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepUpdated(mergedStep, 'backspace_buffer_edit');
                    }
                  }
                  return; // Absorbed into buffer edit
                }

                if (lastTypeStep && lastTypeStep.value.length > 0) {
                  // Case 2: Buffer is empty/null (debounce already flushed) — trim the lastTypeStep value directly
                  const trimmedValue = lastTypeStep.value.slice(0, -1);
                  sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, {
                    ...lastTypeStep,
                    value: trimmedValue,
                  });

                  if (trimmedValue.length > 0) {
                    const updatedStep = RecordingCaptureService.flushTypingBuffer({
                      text: trimmedValue,
                      elementLabel: '',
                      elementRef: lastTypeStep.elementRef,
                      lastCharAt: Date.now(),
                    });
                    if (updatedStep) {
                      updatedStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: updatedStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepUpdated(updatedStep, 'backspace_trim');
                    }
                  } else {
                    // All text deleted — remove the step entirely
                    socket.nsp.to(room).emit('preview:recording:step:remove', {
                      previewSessionId, stepId: lastTypeStep.id, timestamp: new Date().toISOString(),
                    });
                    if (pTrace) pTrace.writeStepRemoved(lastTypeStep.id, 'all_text_deleted');
                    sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                  }
                  return; // Absorbed into lastTypeStep edit
                }

                // No buffer and no lastTypeStep — fall through to emit "Press Backspace" as normal
              }

              // Flush typing buffer if Enter/Tab triggers it
              if (RecordingCaptureService.shouldFlushOnKey(data.key, data.modifiers, isMultiline)) {
                if (buffer) {
                  // V10: If Enter triggered the flush and there's text in the buffer,
                  // merge type + Enter into a single step with pressEnter: true.
                  // This avoids creating two steps (type + press Enter) and prevents
                  // double-Enter during replay.
                  //
                  // V10: Also merge with previous type step if same element
                  const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                  const sameElement = lastTypeStep
                    && buffer.elementRef
                    && lastTypeStep.elementRef === buffer.elementRef;

                  if (sameElement && lastTypeStep) {
                    // Merge with previously emitted step for same element
                    const mergedValue = lastTypeStep.value + buffer.text;
                    const typingStep = RecordingCaptureService.flushTypingBuffer(
                      { ...buffer, text: mergedValue },
                      isEnterKey,
                    );
                    if (typingStep) {
                      typingStep.id = lastTypeStep.id;
                      socket.nsp.to(room).emit('preview:recording:step:update', {
                        previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepUpdated(typingStep, isEnterKey ? 'type_merge_enter' : 'type_merge_flush');
                      if (isEnterKey) mergedEnterIntoType = true;
                    }
                  } else {
                    const typingStep = RecordingCaptureService.flushTypingBuffer(
                      buffer,
                      isEnterKey,
                    );
                    if (typingStep) {
                      socket.nsp.to(room).emit('preview:recording:step', {
                        previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                      });
                      if (pTrace) pTrace.writeStepCaptured(typingStep, isEnterKey ? 'type_enter' : 'type_flush');
                      if (isEnterKey) mergedEnterIntoType = true;
                    }
                  }

                  // Enter/Tab = user finished typing in this field → clear merge state
                  sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                  sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                  const timer = recordingTypingTimers.get(previewSessionId);
                  if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
                }
              }

              // Emit press step for meaningful keys
              // V10: Skip emitting separate "Press Enter" if it was merged into the type step
              if (!mergedEnterIntoType) {
                const pressStep = RecordingCaptureService.capturePress(data.key, data.modifiers);
                if (pressStep) {
                  socket.nsp.to(room).emit('preview:recording:step', {
                    previewSessionId, step: pressStep, timestamp: new Date().toISOString(),
                  });
                  if (pTrace) pTrace.writeStepCaptured(pressStep, 'press');
                }
              }
            } catch (e) {
              logger.debug('[RECORDING] Press capture failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
      } else {
        emitInputError(socket, previewSessionId, 'press', result.error || 'Press failed');
        const pressErrTrace = EditorTraceService.get(previewSessionId);
        if (pressErrTrace) pressErrTrace.writeError('press_failed', { key, error: result.error });
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:keyboard:press', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Handle viewport change (live resize)
  socket.on('preview:viewport:set', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId, width, height } = data;

      if (!previewSessionId || !Number.isFinite(width) || !Number.isFinite(height)) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'Missing previewSessionId or invalid dimensions',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const normalizedPreviewSessionId = String(previewSessionId).trim();

      logger.info('[WebSocket] Viewport change requested', {
        socketId: socket.id,
        previewSessionId: normalizedPreviewSessionId,
        width,
        height,
      });

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.setViewport(normalizedPreviewSessionId, ensuredUserId, width, height);

      if (!result.success) {
        socket.emit('error', {
          code: 'VIEWPORT_CHANGE_FAILED',
          message: result.error || 'Failed to change viewport',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // First: force snapshot re-collect with the new viewport already reflowed.
      // This ensures domNodes/boundingBox are correct BEFORE the client rescales.
      await emitSnapshotAlways(socket, normalizedPreviewSessionId, ensuredUserId);

      // Then: emit viewport metadata so client updates coordinate mapping
      // with coordinates that match the freshly-collected snapshot.
      const room = createRoomName('preview', normalizedPreviewSessionId);
      const viewportPayload = {
        previewSessionId: normalizedPreviewSessionId,
        viewport: { width, height },
        devicePixelRatio: 1,
        timestamp: new Date().toISOString(),
      };
      socket.emit('preview:viewport', viewportPayload);
      socket.to(room).emit('preview:viewport', viewportPayload);
    } catch (error) {
      logger.error('[WebSocket] Error in preview:viewport:set', {
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
        // Snapshot is already kicked off inside refreshPage() via setImmediate —
        // the DOM-update interval (500ms) will pick it up and emit preview:page.

        // Inject a fresh screenshot frame so frontend doesn't show stale/white frame
        // while CDP screencast catches up after page reload
        setImmediate(async () => {
          try {
            const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
            await getPreviewVideoStreamRegistry().injectFrame(previewSessionId);
          } catch {
            // Non-critical — CDP screencast will resume on its own
          }
        });

        // V9: Recording hook — flush buffers and update URL baseline after refresh
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          setImmediate(async () => {
            try {
              const { RecordingCaptureService } = await import(
                '@/services/testing/ui/preview/recording-capture.service'
              );
              const room = createRoomName('preview', previewSessionId);

              // Flush pending typing buffer (with merge logic)
              const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
              if (buffer) {
                const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
                const sameElement = lastTypeStep && buffer.elementRef && lastTypeStep.elementRef === buffer.elementRef;

                if (sameElement && lastTypeStep) {
                  const mergedValue = lastTypeStep.value + buffer.text;
                  const typingStep = RecordingCaptureService.flushTypingBuffer({ ...buffer, text: mergedValue });
                  if (typingStep) {
                    typingStep.id = lastTypeStep.id;
                    socket.nsp.to(room).emit('preview:recording:step:update', {
                      previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                    });
                  }
                } else {
                  const typingStep = RecordingCaptureService.flushTypingBuffer(buffer);
                  if (typingStep) {
                    socket.nsp.to(room).emit('preview:recording:step', {
                      previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
                    });
                  }
                }
                sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
                sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
                const timer = recordingTypingTimers.get(previewSessionId);
                if (timer) { clearTimeout(timer); recordingTypingTimers.delete(previewSessionId); }
              }

              // V11: Record a navigate step for refresh
              const page = sessionService.getPage(previewSessionId, ensuredUserId);
              if (page) {
                const refreshStep: PreviewIntentStep = {
                  id: `rec_${Date.now().toString(36)}`,
                  type: 'navigate',
                  description: 'Refresh page',
                  value: page.url(),
                };
                socket.nsp.to(room).emit('preview:recording:step', {
                  previewSessionId, step: refreshStep, timestamp: new Date().toISOString(),
                });

                // Update URL baseline (URL may change after redirect)
                sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
              }
            } catch (e) {
              logger.debug('[RECORDING] Refresh hook failed', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          });
        }
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

  // Handle page back (browser history)
  socket.on('preview:page:back', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      logger.info('[WebSocket] Preview goBack requested', { previewSessionId, userId: ensuredUserId });

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.goBack(previewSessionId, ensuredUserId);

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'back', true);
        // Snapshot is already kicked off inside goBack() via setImmediate —
        // the DOM-update interval (500ms) will pick it up and emit preview:page.

        // Inject a fresh frame so frontend doesn't show stale content
        setImmediate(async () => {
          try {
            const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
            await getPreviewVideoStreamRegistry().injectFrame(previewSessionId);
          } catch {
            // Non-critical
          }
        });

        // V11: Recording hook — record navigate step for back
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          const page = sessionService.getPage(previewSessionId, ensuredUserId);
          if (page) {
            const room = createRoomName('preview', previewSessionId);
            const step: PreviewIntentStep = {
              id: `rec_${Date.now().toString(36)}`,
              type: 'navigate',
              description: 'Navigate back',
              value: page.url(),
            };
            socket.nsp.to(room).emit('preview:recording:step', {
              previewSessionId, step, timestamp: new Date().toISOString(),
            });
            sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
          }
        }
      } else {
        emitPageActionResult(socket, previewSessionId, 'back', false, 'No history to go back or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:back', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'back', false, 'Internal error');
      }
    }
  });

  // Handle page forward (browser history)
  socket.on('preview:page:forward', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      if (!checkRateLimit(socket.id, 'pageAction')) return;

      const previewSessionId = validateInputRequest(data, socket.id, ensuredUserId);
      if (!previewSessionId) return;

      logger.info('[WebSocket] Preview goForward requested', { previewSessionId, userId: ensuredUserId });

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      const result = await sessionService.goForward(previewSessionId, ensuredUserId);

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'forward', true);
        // Snapshot is already kicked off inside goForward() via setImmediate —
        // the DOM-update interval (500ms) will pick it up and emit preview:page.

        setImmediate(async () => {
          try {
            const { getPreviewVideoStreamRegistry } = await import('@/services/testing/ui/preview');
            await getPreviewVideoStreamRegistry().injectFrame(previewSessionId);
          } catch {
            // Non-critical
          }
        });

        // V11: Recording hook — record navigate step for forward
        if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
          const page = sessionService.getPage(previewSessionId, ensuredUserId);
          if (page) {
            const room = createRoomName('preview', previewSessionId);
            const step: PreviewIntentStep = {
              id: `rec_${Date.now().toString(36)}`,
              type: 'navigate',
              description: 'Navigate forward',
              value: page.url(),
            };
            socket.nsp.to(room).emit('preview:recording:step', {
              previewSessionId, step, timestamp: new Date().toISOString(),
            });
            sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());
          }
        }
      } else {
        emitPageActionResult(socket, previewSessionId, 'forward', false, 'No history to go forward or session not found');
      }
    } catch (error) {
      logger.error('[WebSocket] Error in preview:page:forward', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      if (data.previewSessionId) {
        emitPageActionResult(socket, data.previewSessionId, 'forward', false, 'Internal error');
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

      // V9: Capture recording state BEFORE reset (reset clears it)
      const wasRecording = sessionService.isRecording(previewSessionId, ensuredUserId);
      if (wasRecording) {
        // Flush typing buffer before reset destroys the session state
        const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
        if (buffer) {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );
          const typingStep = RecordingCaptureService.flushTypingBuffer(buffer);
          if (typingStep) {
            const room = createRoomName('preview', previewSessionId);
            socket.nsp.to(room).emit('preview:recording:step', {
              previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
            });
          }
        }
      }

      // Reset session (clears cookies/storage/context)
      const result = await sessionService.resetSession({
        sessionId: previewSessionId,
        userId: ensuredUserId,
      });

      if (result) {
        emitPageActionResult(socket, previewSessionId, 'reset', true);
        setImmediate(() => emitSnapshotAlways(socket, previewSessionId, ensuredUserId));

        // Restart video + devtools streams on the new page (old stream died with old page)
        setImmediate(async () => {
          try {
            const { getPreviewVideoStreamRegistry, getPreviewDevToolsRegistry, getPreviewSessionService: getSvc } =
              await import('@/services/testing/ui/preview');
            const videoReg = getPreviewVideoStreamRegistry();
            const devtoolsReg = getPreviewDevToolsRegistry();
            const svc = getSvc();
            const newPage = svc.getPage(previewSessionId, ensuredUserId);

            if (!newPage) return;

            const room = createRoomName('preview', previewSessionId);

            // Stop old (already dead) stream, then start fresh on new page
            await videoReg.stopStream(previewSessionId);
            await videoReg.startStream(previewSessionId, ensuredUserId, room, newPage, socket.nsp);

            // Restart devtools collectors on new page
            devtoolsReg.stop(previewSessionId);
            devtoolsReg.start(previewSessionId, room, newPage, socket.nsp);

            logger.info('[PREVIEW_STREAM] Streams restarted after reset', { previewSessionId });
          } catch (restartError) {
            logger.warn('[PREVIEW_STREAM] Failed to restart streams after reset', {
              previewSessionId,
              error: restartError instanceof Error ? restartError.message : String(restartError),
            });
          }
        });

        // V9: Recording — reset destroys old page+context, so recording must stop
        // (resetSession already sets recording=false and clears buffer)
        // But we need to flush pending buffers, clean up timers, and notify client
        if (wasRecording) {
          const room = createRoomName('preview', previewSessionId);

          // Clean up timers
          const typingTimer = recordingTypingTimers.get(previewSessionId);
          if (typingTimer) { clearTimeout(typingTimer); recordingTypingTimers.delete(previewSessionId); }
          const scrollState = recordingScrollTimers.get(previewSessionId);
          if (scrollState) { clearTimeout(scrollState.timer); recordingScrollTimers.delete(previewSessionId); }

          // Notify client that recording has stopped
          socket.nsp.to(room).emit('preview:recording:state', {
            previewSessionId,
            recording: false,
            timestamp: new Date().toISOString(),
          });

          // Editor trace: log recording stop on page reset
          const resetTrace = EditorTraceService.get(previewSessionId);
          if (resetTrace) {
            resetTrace.writeRecordingStop('user');
            EditorTraceService.close(previewSessionId).then((meta) => {
              if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor' });
            }).catch(() => {});
          }

          logger.info('[RECORDING] Stopped due to page reset', { previewSessionId, userId: ensuredUserId });
        }
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

  // Handle network list request (on-demand, for initial load)
  socket.on('preview:network:list:request', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId } = data;
      if (!previewSessionId) return;

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

      const items = collector.getNetworkItems();
      socket.emit('preview:network:list', {
        previewSessionId,
        items,
      });

      logger.debug('[WebSocket] Emitted network list', {
        socketId: socket.id,
        previewSessionId,
        itemCount: items.length,
      });
    } catch (error) {
      logger.debug('[WebSocket] Error in preview:network:list:request', {
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

  // ═══════════════════════════════════════════════════════════════════════════
  // V8: Preview Run Handlers ("Run from start" feature)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Handle preview:run:start - Start "Run from start" execution
   * Executes all saved steps sequentially in existing preview session
   */
  socket.on('preview:run:start', async (data) => {
    try {
      const userId = getUserId(socket);
      const { previewSessionId, intentTestCaseId, steps: inlineSteps, startUrl: inlineStartUrl } = data;

      // Validate input
      if (!previewSessionId || !intentTestCaseId) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'previewSessionId and intentTestCaseId are required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      // Check ownership
      if (!sessionService.isSessionOwned(previewSessionId, userId)) {
        socket.emit('error', {
          code: 'UNAUTHORIZED',
          message: 'Session not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Import PreviewRunService
      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');

      // Check if already running
      if (PreviewRunService.isRunning(previewSessionId)) {
        socket.emit('error', {
          code: 'RUN_IN_PROGRESS',
          message: 'Run already in progress',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // V9: Stop recording if active (run replays existing steps, would create duplicates)
      if (sessionService.isRecording(previewSessionId, userId)) {
        // Flush pending typing buffer (with merge logic)
        const buffer = sessionService.getRecordingBuffer(previewSessionId, userId);
        if (buffer) {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );
          const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, userId);
          const sameElement = lastTypeStep && buffer.elementRef && lastTypeStep.elementRef === buffer.elementRef;
          const room = createRoomName('preview', previewSessionId);

          const rsTrace = EditorTraceService.get(previewSessionId);
          if (sameElement && lastTypeStep) {
            const mergedValue = lastTypeStep.value + buffer.text;
            const typingStep = RecordingCaptureService.flushTypingBuffer({ ...buffer, text: mergedValue });
            if (typingStep) {
              typingStep.id = lastTypeStep.id;
              socket.nsp.to(room).emit('preview:recording:step:update', {
                previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
              });
              if (rsTrace) rsTrace.writeStepUpdated(typingStep, 'type_merge_on_run_start');
            }
          } else {
            const typingStep = RecordingCaptureService.flushTypingBuffer(buffer);
            if (typingStep) {
              socket.nsp.to(room).emit('preview:recording:step', {
                previewSessionId, step: typingStep, timestamp: new Date().toISOString(),
              });
              if (rsTrace) rsTrace.writeStepCaptured(typingStep, 'type_flush_on_run_start');
            }
          }
          sessionService.setRecordingLastTypeStep(previewSessionId, userId, null);
          sessionService.setRecordingBuffer(previewSessionId, userId, null);
        }

        // Clean up timers
        const typingTimer = recordingTypingTimers.get(previewSessionId);
        if (typingTimer) { clearTimeout(typingTimer); recordingTypingTimers.delete(previewSessionId); }
        const scrollState = recordingScrollTimers.get(previewSessionId);
        if (scrollState) { clearTimeout(scrollState.timer); recordingScrollTimers.delete(previewSessionId); }

        // Remove select listener
        const page = sessionService.getPage(previewSessionId, userId);
        if (page) {
          try {
            const { RecordingCaptureService } = await import(
              '@/services/testing/ui/preview/recording-capture.service'
            );
            await RecordingCaptureService.removeSelectChangeListener(page);
            const loadHandler = (page as any).__qai_recording_load_handler;
            if (loadHandler) {
              page.off('load', loadHandler);
              delete (page as any).__qai_recording_load_handler;
            }
            // V10 Fix #5: Remove filechooser handler
            const fcHandler = (page as any).__qai_recording_filechooser_handler;
            if (fcHandler) {
              page.off('filechooser', fcHandler);
              delete (page as any).__qai_recording_filechooser_handler;
            }
          } catch { /* page may be closing */ }
        }

        sessionService.setRecording(previewSessionId, userId, false);

        const room = createRoomName('preview', previewSessionId);
        socket.nsp.to(room).emit('preview:recording:state', {
          previewSessionId,
          recording: false,
          timestamp: new Date().toISOString(),
        });
        // Editor trace: log recording stop on run:start
        const runStopTrace = EditorTraceService.get(previewSessionId);
        if (runStopTrace) {
          runStopTrace.writeRecordingStop('user');
          EditorTraceService.close(previewSessionId).then((meta) => {
            if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor', intentTestCaseId });
          }).catch(() => {});
        }
        logger.info('[RECORDING] Stopped due to run:start', { previewSessionId, userId });
      }

      logger.info('[WebSocket] Starting preview run', {
        previewSessionId,
        intentTestCaseId,
        userId,
        socketId: socket.id,
      });

      // Start run (async, emits progress via WebSocket)
      // If inline steps are provided (Apply All flow), save them first and use directly.
      const runOptions = (Array.isArray(inlineSteps) && inlineSteps.length > 0)
        ? { inlineSteps, startUrl: inlineStartUrl }
        : undefined;
      PreviewRunService.runSavedSteps(previewSessionId, intentTestCaseId, userId, runOptions).catch((error) => {
        logger.error('[WebSocket] Preview run failed', {
          previewSessionId,
          intentTestCaseId,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
        socket.emit('error', {
          code: 'RUN_FAILED',
          message: error instanceof Error ? error.message : 'Run failed',
          timestamp: new Date().toISOString(),
        });
      });
    } catch (error) {
      logger.error('[WebSocket] Error in preview:run:start', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Internal error',
        timestamp: new Date().toISOString(),
      });
    }
  });

  /**
   * Handle preview:run:cancel - Cancel active preview run
   * Sets cancellation flag, main loop handles skipping remaining steps
   */
  socket.on('preview:run:cancel', async (data) => {
    try {
      const userId = getUserId(socket);
      const { previewSessionId } = data;

      if (!previewSessionId) {
        socket.emit('error', {
          code: 'INVALID_INPUT',
          message: 'previewSessionId is required',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');

      logger.info('[WebSocket] Cancelling preview run', {
        previewSessionId,
        userId,
        socketId: socket.id,
      });

      PreviewRunService.cancelRun(previewSessionId, userId);
    } catch (error) {
      logger.error('[WebSocket] Error in preview:run:cancel', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
      socket.emit('error', {
        code: 'INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Cancel failed',
        timestamp: new Date().toISOString(),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // V9: Recording handlers
  // ═══════════════════════════════════════════════════════════════════════════

  socket.on('preview:recording:start', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId } = data;
      if (!previewSessionId) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) {
        socket.emit('error', {
          code: 'FORBIDDEN',
          message: 'Session not found or not owned by user',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // V9: Guard — cannot start recording while a run is active
      {
        const { PreviewRunService } = await import('@/services/testing/ui/preview/preview-run.service');
        if (PreviewRunService.isRunning(previewSessionId)) {
          socket.emit('error', {
            code: 'RUN_IN_PROGRESS',
            message: 'Cannot start recording while a run is in progress',
            timestamp: new Date().toISOString(),
          });
          return;
        }
      }

      // Already recording? Ignore silently
      if (sessionService.isRecording(previewSessionId, ensuredUserId)) return;

      sessionService.setRecording(previewSessionId, ensuredUserId, true);

      // Set the current URL as baseline for navigation detection
      const page = sessionService.getPage(previewSessionId, ensuredUserId);

      // Editor trace: create writer and log recording start
      const recStartTrace = EditorTraceService.getOrCreate(previewSessionId, ensuredUserId);
      recStartTrace.writeRecordingStart(page?.url());

      if (page) {
        sessionService.setRecordingLastUrl(previewSessionId, ensuredUserId, page.url());

        // Inject <select> change listener
        try {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );

          const SELECT_CB_NAME = '__qai_select_change';

          // Expose callback function (ignore if already exposed)
          await page.exposeFunction(SELECT_CB_NAME, (changeData: { label: string; text: string; value: string }) => {
            try {
              // Guard: only emit if still recording
              if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;

              const step = RecordingCaptureService.captureSelectChange({
                label: changeData.label,
                selectedText: changeData.text,
                selectedValue: changeData.value,
              });
              const room = createRoomName('preview', previewSessionId);
              socket.nsp.to(room).emit('preview:recording:step', {
                previewSessionId,
                step,
                timestamp: new Date().toISOString(),
              });
              // Editor trace: log select change
              const selTrace = EditorTraceService.get(previewSessionId);
              if (selTrace) {
                selTrace.writeSelectChange({ label: changeData.label, selectedText: changeData.text, selectedValue: changeData.value });
                selTrace.writeStepCaptured(step, 'select_change');
              }
            } catch (e) {
              logger.debug('[RECORDING] Select change callback error', {
                error: e instanceof Error ? e.message : String(e),
              });
            }
          }).catch(() => {
            // exposeFunction may fail if already exposed (e.g., page reload) — that's OK
          });

          await RecordingCaptureService.injectSelectChangeListener(page, SELECT_CB_NAME);

          // Re-inject on navigation (page.evaluate scripts are lost on load)
          const reInjectHandler = async () => {
            try {
              if (sessionService.isRecording(previewSessionId, ensuredUserId)) {
                await RecordingCaptureService.injectSelectChangeListener(page, SELECT_CB_NAME);
              }
            } catch {
              // Page may be closing during navigation
            }
          };
          page.on('load', reInjectHandler);
          // Store cleanup reference (removed on recording:stop)
          (page as any).__qai_recording_load_handler = reInjectHandler;
        } catch (e) {
          logger.debug('[RECORDING] Select listener injection failed (non-critical)', {
            error: e instanceof Error ? e.message : String(e),
          });
        }

        // V10 Fix #5: Listen for filechooser events to record file uploads
        try {
          const { RecordingCaptureService: RecCapSvc } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );

          const fileChooserHandler = async (fileChooser: any) => {
            try {
              if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;

              // Probe the file input element for binding hints
              let probedEl = null;
              let hasSelectedFiles = false;
              try {
                const element = fileChooser.element();
                if (element) {
                  const box = await element.boundingBox().catch(() => null);
                  if (box) {
                    probedEl = await RecCapSvc.probeForRecording(page, box.x + box.width / 2, box.y + box.height / 2);
                  }

                  // Avoid false positives: record upload only if user actually selected files.
                  // filechooser event fires when dialog opens, including cancel path.
                  hasSelectedFiles = await waitForFileSelectionConfirmation(
                    element,
                    async (ms) => page.waitForTimeout(ms),
                  );
                }
              } catch { /* non-critical */ }

              if (!hasSelectedFiles) {
                return;
              }

              // Record confirmed upload interaction.
              // Actual file path will be configured by user in step editor.
              const uploadStep = RecCapSvc.captureFileUpload(['(file)'], probedEl);
              if (uploadStep) {
                const recordRoom = createRoomName('preview', previewSessionId);
                socket.nsp.to(recordRoom).emit('preview:recording:step', {
                  previewSessionId,
                  step: uploadStep,
                  timestamp: new Date().toISOString(),
                });
                // Editor trace: log file upload
                const fuTrace = EditorTraceService.get(previewSessionId);
                if (fuTrace) {
                  fuTrace.writeFileUpload({ fileNames: ['(file)'], probedElement: probedEl });
                  fuTrace.writeStepCaptured(uploadStep, 'file_upload');
                }
              }
            } catch (fcErr) {
              logger.debug('[RECORDING] File chooser capture failed', {
                error: fcErr instanceof Error ? fcErr.message : String(fcErr),
              });
            }
          };

          page.on('filechooser', fileChooserHandler);
          (page as any).__qai_recording_filechooser_handler = fileChooserHandler;
        } catch (e) {
          logger.debug('[RECORDING] File chooser listener setup failed (non-critical)', {
            error: e instanceof Error ? e.message : String(e),
          });
        }
      }

      // Emit state to all subscribers
      const room = createRoomName('preview', previewSessionId);
      socket.nsp.to(room).emit('preview:recording:state', {
        previewSessionId,
        recording: true,
        timestamp: new Date().toISOString(),
      });

      logger.info('[RECORDING] Started', { previewSessionId, userId: ensuredUserId });
    } catch (error) {
      logger.error('[RECORDING] Start failed', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  socket.on('preview:recording:stop', async (data) => {
    try {
      const ensuredUserId = requireUser();
      if (!ensuredUserId) return;

      const { previewSessionId } = data;
      if (!previewSessionId) return;

      const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
      const sessionService = getPreviewSessionService();

      if (!sessionService.isSessionOwned(previewSessionId, ensuredUserId)) return;
      if (!sessionService.isRecording(previewSessionId, ensuredUserId)) return;

      const room = createRoomName('preview', previewSessionId);

      // Flush pending typing buffer (with merge logic)
      const buffer = sessionService.getRecordingBuffer(previewSessionId, ensuredUserId);
      const stopTrace = EditorTraceService.get(previewSessionId);
      if (buffer) {
        const { RecordingCaptureService } = await import(
          '@/services/testing/ui/preview/recording-capture.service'
        );
        const lastTypeStep = sessionService.getRecordingLastTypeStep(previewSessionId, ensuredUserId);
        const sameElement = lastTypeStep && buffer.elementRef && lastTypeStep.elementRef === buffer.elementRef;

        if (sameElement && lastTypeStep) {
          const mergedValue = lastTypeStep.value + buffer.text;
          const step = RecordingCaptureService.flushTypingBuffer({ ...buffer, text: mergedValue });
          if (step) {
            step.id = lastTypeStep.id;
            socket.nsp.to(room).emit('preview:recording:step:update', {
              previewSessionId, step, timestamp: new Date().toISOString(),
            });
            if (stopTrace) stopTrace.writeStepUpdated(step, 'type_merge_on_stop');
          }
        } else {
          const step = RecordingCaptureService.flushTypingBuffer(buffer);
          if (step) {
            socket.nsp.to(room).emit('preview:recording:step', {
              previewSessionId, step, timestamp: new Date().toISOString(),
            });
            if (stopTrace) stopTrace.writeStepCaptured(step, 'type_flush_on_stop');
          }
        }
        sessionService.setRecordingLastTypeStep(previewSessionId, ensuredUserId, null);
        sessionService.setRecordingBuffer(previewSessionId, ensuredUserId, null);
      }

      // Clear typing timer
      const typingTimer = recordingTypingTimers.get(previewSessionId);
      if (typingTimer) {
        clearTimeout(typingTimer);
        recordingTypingTimers.delete(previewSessionId);
      }

      // Clear scroll timer and flush (V10: with merge logic)
      const scrollState = recordingScrollTimers.get(previewSessionId);
      if (scrollState) {
        clearTimeout(scrollState.timer);
        recordingScrollTimers.delete(previewSessionId);

        const { RecordingCaptureService: RecCapSvcScroll } = await import(
          '@/services/testing/ui/preview/recording-capture.service'
        );
        const lastScrollStep = sessionService.getRecordingLastScrollStep(previewSessionId, ensuredUserId);
        const withinMergeWindow = lastScrollStep && (Date.now() - lastScrollStep.emittedAt) < RECORDING_SCROLL_MERGE_WINDOW_MS;

        if (withinMergeWindow && lastScrollStep) {
          const mergedDelta = lastScrollStep.totalDelta + scrollState.deltaY;
          const scrollStep = RecCapSvcScroll.captureScroll(mergedDelta);
          if (scrollStep) {
            scrollStep.id = lastScrollStep.id;
            socket.nsp.to(room).emit('preview:recording:step:update', {
              previewSessionId, step: scrollStep, timestamp: new Date().toISOString(),
            });
            if (stopTrace) stopTrace.writeStepUpdated(scrollStep, 'scroll_merge_on_stop');
          }
        } else {
          const scrollStep = RecCapSvcScroll.captureScroll(scrollState.deltaY);
          if (scrollStep) {
            socket.nsp.to(room).emit('preview:recording:step', {
              previewSessionId, step: scrollStep, timestamp: new Date().toISOString(),
            });
            if (stopTrace) stopTrace.writeStepCaptured(scrollStep, 'scroll_flush_on_stop');
          }
        }
        sessionService.setRecordingLastScrollStep(previewSessionId, ensuredUserId, null);
      }

      // Remove <select> listener and load handler
      const page = sessionService.getPage(previewSessionId, ensuredUserId);
      if (page) {
        try {
          const { RecordingCaptureService } = await import(
            '@/services/testing/ui/preview/recording-capture.service'
          );
          await RecordingCaptureService.removeSelectChangeListener(page);
          // Remove navigation re-injection handler
          const loadHandler = (page as any).__qai_recording_load_handler;
          if (loadHandler) {
            page.off('load', loadHandler);
            delete (page as any).__qai_recording_load_handler;
          }
          // V10 Fix #5: Remove filechooser handler
          const fcHandler = (page as any).__qai_recording_filechooser_handler;
          if (fcHandler) {
            page.off('filechooser', fcHandler);
            delete (page as any).__qai_recording_filechooser_handler;
          }
        } catch {
          // Page may be closed
        }
      }

      sessionService.setRecording(previewSessionId, ensuredUserId, false);

      // Editor trace: log recording stop and close writer
      const recStopTrace = EditorTraceService.get(previewSessionId);
      if (recStopTrace) {
        recStopTrace.writeRecordingStop('user');
        EditorTraceService.close(previewSessionId).then((meta) => {
          if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor' });
        }).catch(() => {});
      }

      socket.nsp.to(room).emit('preview:recording:state', {
        previewSessionId,
        recording: false,
        timestamp: new Date().toISOString(),
      });

      logger.info('[RECORDING] Stopped', { previewSessionId, userId: ensuredUserId });
    } catch (error) {
      logger.error('[RECORDING] Stop failed', {
        socketId: socket.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Cleanup on disconnect
  socket.on('disconnect', async () => {
    const trimmedUserId = typeof userId === 'string' ? userId.trim() : '';
    const canCleanupRecording = trimmedUserId.length > 0;
    let sessionService: Awaited<ReturnType<typeof import('@/services/testing/ui/preview')['getPreviewSessionService']>> | null = null;
    let recordingCaptureService: (typeof import('@/services/testing/ui/preview/recording-capture.service'))['RecordingCaptureService'] | null = null;

    if (canCleanupRecording) {
      try {
        const { getPreviewSessionService } = await import('@/services/testing/ui/preview');
        sessionService = getPreviewSessionService();
      } catch (error) {
        logger.debug('[WebSocket] Failed to initialize session service for disconnect cleanup', {
          socketId: socket.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

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

          // Cleanup recording timers
          const typingTimer = recordingTypingTimers.get(previewSessionId);
          if (typingTimer) { clearTimeout(typingTimer); recordingTypingTimers.delete(previewSessionId); }
          const scrollState = recordingScrollTimers.get(previewSessionId);
          if (scrollState) { clearTimeout(scrollState.timer); recordingScrollTimers.delete(previewSessionId); }

          if (
            canCleanupRecording
            && sessionService
            && sessionService.isSessionOwned(previewSessionId, trimmedUserId)
            && sessionService.isRecording(previewSessionId, trimmedUserId)
          ) {
            try {
              const page = sessionService.getPage(previewSessionId, trimmedUserId);
              if (page) {
                if (!recordingCaptureService) {
                  const mod = await import('@/services/testing/ui/preview/recording-capture.service');
                  recordingCaptureService = mod.RecordingCaptureService;
                }
                await recordingCaptureService.removeSelectChangeListener(page).catch(() => {});

                const loadHandler = (page as any).__qai_recording_load_handler;
                if (loadHandler) {
                  page.off('load', loadHandler);
                  delete (page as any).__qai_recording_load_handler;
                }

                const fcHandler = (page as any).__qai_recording_filechooser_handler;
                if (fcHandler) {
                  page.off('filechooser', fcHandler);
                  delete (page as any).__qai_recording_filechooser_handler;
                }
              }

              sessionService.setRecordingBuffer(previewSessionId, trimmedUserId, null);
              sessionService.setRecordingLastTypeStep(previewSessionId, trimmedUserId, null);
              sessionService.setRecordingLastScrollStep(previewSessionId, trimmedUserId, null);
              sessionService.setRecordingDragState(previewSessionId, trimmedUserId, null);
              sessionService.setRecording(previewSessionId, trimmedUserId, false);

              // Editor trace: log disconnect stop and close writer
              const dcTrace = EditorTraceService.get(previewSessionId);
              if (dcTrace) {
                dcTrace.writeRecordingStop('disconnect');
                EditorTraceService.close(previewSessionId).then((meta) => {
                  if (meta) uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId, traceType: 'editor' });
                }).catch(() => {});
              }
            } catch (error) {
              logger.debug('[WebSocket] Recording cleanup failed on disconnect', {
                socketId: socket.id,
                previewSessionId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }

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
