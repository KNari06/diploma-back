import { logger } from '@/utils/logger';
import { ChatProcessingStepPayload } from '@/websocket/types';
import { webSocketService } from '@/websocket/websocket.service';

/**
 * Helper to emit WebSocket events (with fallback for missing sessionId)
 * Added error handling to prevent WebSocket errors from breaking HTTP request
 */
export function createProgressEmitter(sessionId?: string) {
  return (step: string, message: string, progress: number) => {
    if (!sessionId) {
      logger.warn('[AUTONOMOUS] No sessionId - skipping WebSocket event', { step, message });
      return;
    }

    try {
      const stepPayload: ChatProcessingStepPayload = {
        sessionId,
        step: step as any,
        message,
        progress,
        timestamp: new Date().toISOString(),
      };
      webSocketService.emitChatProcessingStep(sessionId, stepPayload);
    } catch (error) {
      // CRITICAL: Don't let WebSocket errors break the HTTP request
      // Log error but continue processing
      logger.warn('[AUTONOMOUS] Failed to emit WebSocket progress (non-critical)', {
        step,
        message,
        progress,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue execution - WebSocket is optional for progress updates
    }
  };
}
