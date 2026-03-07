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
 * Used after input actions that may have changed the page
 * @param options.forceEmit - If true, always emit even if change-detection says unchanged (for clicks etc.)
 */
export async function emitSnapshotIfChanged(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string,
  options?: { forceEmit?: boolean }
): Promise<void> {
  const forceEmit = options?.forceEmit ?? false;

  try {
    const { getPreviewSessionService, getPreviewVideoStreamRegistry } =
      await import('@/services/testing/ui/preview');
    const sessionService = getPreviewSessionService();

    const snapshot = await sessionService.getSnapshot(previewSessionId, userId, {
      force: true,
      includeDomNodes: forceEmit, // Include domNodes when forced
      onlyIfChanged: !forceEmit, // Skip change-gate when forceEmit=true
    });

    // Emit when forceEmit or when change was detected
    if (snapshot && (forceEmit || snapshot.changed)) {
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

      // Update video stream with new DOM version
      getPreviewVideoStreamRegistry().setDomVersion(previewSessionId, snapshot.domVersion);

      logger.debug('[WebSocket] Emitted preview:page after input', {
        socketId: socket.id,
        previewSessionId,
        domVersion: snapshot.domVersion,
        forceEmit,
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
 * Emit preview:page unconditionally (always send new snapshot + screenshot)
 * Used after click/up/wheel where user expects visual feedback regardless of "detected change"
 */
export async function emitSnapshotAlways(
  socket: TypedSocket,
  previewSessionId: string,
  userId: string
): Promise<void> {
  return emitSnapshotIfChanged(socket, previewSessionId, userId, { forceEmit: true });
}
