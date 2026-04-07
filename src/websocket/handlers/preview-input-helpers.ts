/**
 * Preview Input Helpers
 * Reusable functions for interactive preview control handlers
 * Reduces duplication in preview.handler.ts
 */

import { logger } from '@/utils/core/logger';
import { Socket } from 'socket.io';
import {
  ClientToServerEvents,
  createRoomName,
  PreviewMouseResultPayload,
  ServerToClientEvents,
  SocketData,
} from '../types/types';

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents, object, SocketData>;

/**
 * Validate input request and extract previewSessionId
 * Returns normalized previewSessionId or null if invalid
 */
export function validateInputRequest(
  data: { previewSessionId?: string },
  socketId: string,
  userId: string
): string | null {
  if (!data.previewSessionId || typeof data.previewSessionId !== 'string' || data.previewSessionId.trim().length === 0) {
    logger.warn('[WebSocket] Invalid previewSessionId in input event', {
      socketId,
      userId,
      previewSessionId: data.previewSessionId,
    });
    return null;
  }

  return data.previewSessionId.trim();
}

/**
 * Emit error result for input action
 */
export function emitInputError(
  socket: TypedSocket,
  previewSessionId: string | undefined,
  action: PreviewMouseResultPayload['action'],
  error: string
): void {
  socket.emit('preview:mouse:result', {
    previewSessionId: typeof previewSessionId === 'string' ? previewSessionId : '',
    success: false,
    action,
    error,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit success result for input action
 */
export function emitInputSuccess(
  socket: TypedSocket,
  previewSessionId: string,
  action: PreviewMouseResultPayload['action']
): void {
  socket.emit('preview:mouse:result', {
    previewSessionId,
    success: true,
    action,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Emit preview:page snapshot to caller + subscribers
 * Used after input actions that may have changed the page.
 *
 * V20 (signature dedup):
 *   - `forceEmit` still bypasses the "onlyIfChanged" gate inside getSnapshot() so we
 *     always collect a fresh snapshot (needed because the throttle window would
 *     otherwise skip the collect and leave us comparing stale signatures).
 *   - BUT after the collect, we compare `snapshot.pageSignature` against the
 *     per-session `lastEmittedSignature`. If the DOM hasn't mutated since the
 *     previous emit, we skip the WebSocket send entirely — the frontend already
 *     has the exact same data. This is safe because the frontend:
 *       (a) keeps `lastKnownDomNodes` across emits and gracefully handles missing
 *           domNodes fields;
 *       (b) batches preview:page into a single setState via a 140-650ms debounce,
 *           so the 'dropped' emit would have collapsed into the batch anyway;
 *       (c) drives URL / title updates from the same payload, so once the signature
 *           DOES change (navigation, real DOM mutation) the very next emit carries
 *           the fresh url/title.
 *     The DOM tick (500ms interval) and apply/subscribe/page-switch handlers use the
 *     same `lastEmittedSignature` window, so all emit sites agree on dedup state.
 *
 * @param options.forceEmit - If true, collect a fresh snapshot even if throttled.
 *   Dedup by signature still applies — use `bypassDedup` to also disable that.
 * @param options.bypassDedup - If true, skip the signature-dedup gate and ALWAYS emit.
 *   Required for cases where the frontend needs the snapshot as a handshake response
 *   regardless of DOM state (viewport resize → coordinate rescale, page reset → fresh
 *   page handshake, subscribe → initial state delivery).
 */
export async function emitSnapshotIfChanged(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string,
  options?: { forceEmit?: boolean; bypassDedup?: boolean }
): Promise<void> {
  const forceEmit = options?.forceEmit ?? false;
  const bypassDedup = options?.bypassDedup ?? false;

  try {
    const { getPreviewSessionService, getPreviewVideoStreamRegistry } =
      await import('@/services/testing/ui/preview');
    const sessionService = getPreviewSessionService();

    const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
      force: true,
      includeDomNodes: forceEmit, // Include domNodes when forced
      onlyIfChanged: !forceEmit, // Skip change-gate when forceEmit=true
    });

    if (!snapshot) return;

    // V20: signature-based dedup — skip wire emit when the DOM is byte-identical
    // to the last payload we already sent. `bypassDedup` callers (resize/reset/
    // subscribe) opt out because the frontend uses their emit as a handshake.
    if (!bypassDedup) {
      const lastSig = sessionService.getLastEmittedSignature(previewSessionId, userId);
      if (lastSig && snapshot.pageSignature === lastSig) {
        // Nothing new on the wire. Still update the video stream's domVersion pointer
        // so downstream consumers see the freshest version number; it's idempotent.
        getPreviewVideoStreamRegistry().setDomVersion(previewSessionId, snapshot.domVersion);
        logger.debug('[WebSocket] Skipped preview:page emit (signature unchanged)', {
          socketId: socket.id,
          previewSessionId,
          domVersion: snapshot.domVersion,
          forceEmit,
        });
        return;
      }
    }

    // Emit when forceEmit/bypassDedup or when change was detected
    if (forceEmit || bypassDedup || snapshot.changed) {
      const room = createRoomName('preview', previewSessionId);
      const payload = {
        previewSessionId,
        url: snapshot.url,
        pageTitle: snapshot.pageTitle,
        domVersion: snapshot.domVersion,
        pageSignature: snapshot.pageSignature,
        domNodes: snapshot.domNodes,
        timestamp: new Date().toISOString(),
      };

      // Emit to caller
      socket.emit('preview:page', payload);
      // Emit to other subscribers
      socket.to(room).emit('preview:page', payload);

      // V20: Record the signature we just sent so subsequent emit sites can dedup
      sessionService.markEmittedSignature(previewSessionId, userId, snapshot.pageSignature);

      // Update video stream with new DOM version
      getPreviewVideoStreamRegistry().setDomVersion(previewSessionId, snapshot.domVersion);

      logger.debug('[WebSocket] Emitted preview:page after input', {
        socketId: socket.id,
        previewSessionId,
        domVersion: snapshot.domVersion,
        forceEmit,
        bypassDedup,
      });
    }
  } catch (snapshotError) {
    logger.warn('[WebSocket] Failed to emit preview:page after input', {
      socketId: socket.id,
      previewSessionId,
      error: snapshotError instanceof Error ? snapshotError.message : String(snapshotError),
    });
  }
}

/**
 * Emit preview:page unconditionally (always send new snapshot + screenshot).
 * Used after click/up/wheel where user expects visual feedback regardless of
 * "detected change". V20: still subject to signature dedup — use
 * `emitSnapshotForHandshake` when the caller is a handshake-style operation
 * (resize/reset/subscribe) that needs delivery guaranteed.
 */
export async function emitSnapshotAlways(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string
): Promise<void> {
  return emitSnapshotIfChanged(socket, previewSessionId, userId, { forceEmit: true });
}

/**
 * V20: Guaranteed delivery of preview:page, bypassing signature dedup.
 * Use for handshake-style cases where the frontend needs the emit regardless of
 * DOM state (viewport resize → client rescale, page reset → fresh page state).
 */
export async function emitSnapshotForHandshake(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string
): Promise<void> {
  return emitSnapshotIfChanged(socket, previewSessionId, userId, { forceEmit: true, bypassDedup: true });
}
