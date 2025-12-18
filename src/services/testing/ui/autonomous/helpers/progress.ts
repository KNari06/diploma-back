import { logger } from '@/utils/core/logger';

/**
 * Emit WebSocket progress updates
 */
export function emitExplorationProgress(sessionId: string | undefined, message: string): void {
  if (!sessionId) return;

  try {
    const { webSocketService } = require('@/websocket/websocket.service');
    const stepPayload = {
      sessionId,
      step: 'analyzing' as any,
      message,
      progress: 40,
      timestamp: new Date().toISOString(),
    };
    webSocketService.emitChatProcessingStep(sessionId, stepPayload);
  } catch (wsError) {
    logger.warn('[EXPLORATION] Failed to emit WebSocket event', {
      error: wsError instanceof Error ? wsError.message : String(wsError),
    });
  }
}
