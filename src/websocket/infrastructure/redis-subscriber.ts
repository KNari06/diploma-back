/**
 * WebSocket Redis Subscriber
 * Main process subscriber that receives events from worker processes via Redis Pub/Sub
 * and emits them to clients via WebSocket
 *
 * Architecture:
 * Worker Process → Redis Pub/Sub → THIS → WebSocket → Client
 *
 * Usage:
 * - Should ONLY be initialized in main process (where WebSocket server exists)
 * - Subscribes to Redis channel for WebSocket events
 * - Routes events to appropriate WebSocket emit methods
 */

import { redisWebSocketBridge } from '@/services/websocket/redis-bridge.service';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '../core/websocket.service';

class WebSocketRedisSubscriber {
  private isRunning = false;

  /**
   * Start Redis subscriber for WebSocket events
   * Should be called in main process ONLY (after WebSocket server initialization)
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('[WS_REDIS_SUB] Already running, skipping start');
      return;
    }

    try {
      logger.info('[WS_REDIS_SUB] Starting Redis subscriber for WebSocket events...');

      // Subscribe to Redis channel and handle events
      await redisWebSocketBridge.subscribe((event, payload, target) => {
        this.handleEvent(event, payload, target);
      });

      this.isRunning = true;
      logger.info('[WS_REDIS_SUB] ✅ Redis subscriber started successfully');
    } catch (error) {
      logger.error('[WS_REDIS_SUB] ❌ Failed to start subscriber', {
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });
      throw error;
    }
  }

  /**
   * Handle event from Redis and emit via WebSocket
   * Routes to appropriate WebSocketService method based on event type
   *
   * @param event - Event name (e.g., 'test:progress')
   * @param payload - Event payload data
   * @param target - Target identifiers (testId, userId, sessionId)
   */
  private handleEvent(event: string, payload: any, target?: any): void {
    try {
      const wsService = webSocketService;

      // Route event to appropriate handler
      switch (event) {
        // Test lifecycle events
        case 'test:started':
          wsService.emitTestStarted(payload.testId, payload);
          break;

        case 'test:progress':
          // ✅ FIX #4: Unified test:progress handling (removed duplicate case below)
          // This can come from emitToUser (intelligent-test-orchestrator) or emitTestProgress
          if (target?.userId) {
            // Emit to user if userId is in target (from emitToUser fallback)
            wsService.emitToUser(target.userId, 'test:progress', payload);
          } else if (payload.testId) {
            // Emit to test room if testId is in payload (standard flow)
            wsService.emitTestProgress(payload.testId, payload);
          }
          break;

        case 'test:step:completed':
          wsService.emitTestStepCompleted(payload.testId, payload);
          break;

        case 'test:browser:completed':
          wsService.emitTestBrowserCompleted(payload.testId, payload);
          break;

        case 'test:completed':
          wsService.emitTestCompleted(payload.testId, payload);
          break;

        case 'test:failed':
          wsService.emitTestFailed(payload.testId, payload);
          break;

        case 'test:cancelled':
          wsService.emitTestCancelled(payload.testId, payload);
          break;

        case 'test:clarification:request':
          wsService.emitTestClarificationRequest(payload.testId, payload);
          break;

        // Result events
        case 'result:ready':
          wsService.emitResultReady(payload.testId, payload);
          break;

        case 'result:screenshot':
          wsService.emitResultScreenshot(payload.testId, payload);
          break;

        case 'result:error':
          wsService.emitResultError(payload.testId, payload);
          break;

        // AI Analysis events
        case 'ai:analysis:started':
          wsService.emitAIAnalysisStarted(payload.testId, payload);
          break;

        case 'ai:analysis:progress':
          wsService.emitAIAnalysisProgress(payload.testId, payload);
          break;

        case 'ai:analysis:completed':
          wsService.emitAIAnalysisCompleted(payload.testId, payload);
          break;

        case 'ai:bug:found':
          wsService.emitAIBugFound(payload.testId, payload);
          break;

        // Chat events
        case 'chat:message':
          if (target?.sessionId || payload.sessionId) {
            wsService.emitChatMessage(target?.sessionId || payload.sessionId, payload);
          }
          break;

        case 'chat:test:update':
          if (target?.sessionId || payload.sessionId) {
            wsService.emitChatTestUpdate(target?.sessionId || payload.sessionId, payload);
          }
          break;

        case 'chat:processing:step':
          if (target?.sessionId || payload.sessionId) {
            wsService.emitChatProcessingStep(target?.sessionId || payload.sessionId, payload);
          }
          break;

        case 'api:agent:step':
          if (target?.sessionId || payload.sessionId) {
            wsService.emitApiAgentStep(target?.sessionId || payload.sessionId, payload);
          }
          break;

        // ✅ FIX #4: Removed duplicate 'test:progress' case
        // This case was already handled above in test lifecycle events (line 70-72)
        // Keeping only the first occurrence to avoid dead code

        case 'test:graph-update': // ✅ NEW: Real-time graph streaming
          // Check for userId first (from emitToUser fallback)
          if (target?.userId) {
            wsService.emitToUser(target.userId, 'test:graph-update', payload);
          } else if (payload?.testId) {
            // Validate payload structure before emitting
            if (!payload.type || !payload.data || !payload.timestamp) {
              logger.warn('[WS_REDIS_SUB] Invalid test:graph-update payload structure', {
                testId: payload?.testId,
                hasType: !!payload?.type,
                hasData: !!payload?.data,
                hasTimestamp: !!payload?.timestamp,
              });
              break;
            }
            wsService.emitTestGraphUpdate(payload.testId, payload);
          } else {
            logger.warn('[WS_REDIS_SUB] test:graph-update missing testId', {
              target,
              payloadKeys: payload ? Object.keys(payload) : [],
            });
          }
          break;

        // Video streaming events
        case 'test:video:frame':
          if (payload?.testId) {
            wsService.emitTestVideoFrame(payload.testId, payload);
          }
          break;

        case 'test:video:stats':
          if (payload?.testId) {
            wsService.emitTestVideoStats(payload.testId, payload);
          }
          break;

        case 'test:video:paused':
          if (payload?.testId) {
            wsService.emitTestVideoPaused(payload.testId, payload);
          }
          break;

        case 'test:video:resumed':
          if (payload?.testId) {
            wsService.emitTestVideoResumed(payload.testId, payload);
          }
          break;

        case 'test:video:stopped':
          if (payload?.testId) {
            wsService.emitTestVideoStopped(payload.testId, payload);
          }
          break;

        case 'test:video:unavailable':
          if (payload?.testId) {
            wsService.emitTestVideoUnavailable(payload.testId, payload);
          }
          break;

        case 'test:video:started':
          if (payload?.testId) {
            wsService.emitTestVideoStarted(payload.testId, payload);
          }
          break;

        // Regression run progress events
        case 'regression:run:progress':
          if (target?.userId) {
            wsService.emitRegressionRunProgress(target.userId, payload);
          } else if (payload?.userId) {
            wsService.emitRegressionRunProgress(payload.userId, payload);
          }
          break;

        // ── Exploration events ──
        case 'exploration:progress':
          wsService.emitExplorationProgress(payload);
          break;

        case 'exploration:completed':
          wsService.emitExplorationCompleted(payload);
          break;

        case 'exploration:clarification:request':
          wsService.emitExplorationClarification(payload);
          break;

        // Unknown event type
        default:
          logger.warn('[WS_REDIS_SUB] Unknown event type received', {
            event,
            payload: JSON.stringify(payload).substring(0, 200), // Log first 200 chars
            target,
          });
      }

      logger.debug('[WS_REDIS_SUB] Event handled successfully', {
        event,
        target,
      });
    } catch (error) {
      logger.error('[WS_REDIS_SUB] Failed to handle event', {
        event,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
        payload: JSON.stringify(payload).substring(0, 200),
      });
      // Don't throw - continue processing other events
    }
  }

  /**
   * Stop Redis subscriber
   * Called during graceful shutdown
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      logger.debug('[WS_REDIS_SUB] Not running, skipping stop');
      return;
    }

    try {
      logger.info('[WS_REDIS_SUB] Stopping Redis subscriber...');
      await redisWebSocketBridge.unsubscribe();
      this.isRunning = false;
      logger.info('[WS_REDIS_SUB] ✅ Redis subscriber stopped successfully');
    } catch (error) {
      logger.error('[WS_REDIS_SUB] ❌ Failed to stop subscriber', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Don't throw during shutdown - log and continue
    }
  }

  /**
   * Check if subscriber is running
   */
  isActive(): boolean {
    return this.isRunning;
  }

  /**
   * Get subscriber status for monitoring/health checks
   */
  getStatus(): { running: boolean; bridgeStatus: any } {
    return {
      running: this.isRunning,
      bridgeStatus: redisWebSocketBridge.getStatus(),
    };
  }
}

// Export singleton instance
export const webSocketRedisSubscriber = new WebSocketRedisSubscriber();
