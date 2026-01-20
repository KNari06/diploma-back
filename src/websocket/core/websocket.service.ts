/**
 * WebSocket Service (Singleton)
 * Central service for emitting events to clients
 *
 * Architecture:
 * - Main Process: Emits directly via WebSocket
 * - Worker Process: Publishes to Redis Pub/Sub → Main Process → WebSocket
 */

import { TestExecutedStepsRedisService } from '@/services/testing/results/test-executed-steps-redis.service';
import { redisWebSocketBridge } from '@/services/websocket/redis-bridge.service';
import { logger } from '@/utils/core/logger';
import {
  AIAnalysisCompletedPayload,
  AIAnalysisProgressPayload,
  AIAnalysisStartedPayload,
  AIBugFoundPayload,
  ChatMessagePayload,
  ChatTestUpdatePayload,
  createRoomName,
  ResultErrorPayload,
  ResultReadyPayload,
  ResultScreenshotPayload,
  RoomType,
  ServerToClientEvents,
  SystemErrorPayload,
  SystemMaintenancePayload,
  TestBrowserCompletedPayload,
  TestCancelledPayload,
  TestCompletedPayload,
  TestCreatedPayload,
  TestFailedPayload,
  TestGraphUpdatePayload,
  TestProgressPayload,
  TestStartedPayload,
  TestStepCompletedPayload,
  // Video streaming payloads
  TestVideoFramePayload,
  TestVideoPausedPayload,
  TestVideoResumedPayload,
  TestVideoStartedPayload,
  TestVideoStatsPayload,
  TestVideoStoppedPayload,
  TestVideoUnavailablePayload,
} from '../types/types';
import { getIO, isWebSocketInitialized } from './server';

class WebSocketService {
  private static instance: WebSocketService;

  private constructor() {
    logger.info('[WebSocketService] Service initialized');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): WebSocketService {
    if (!WebSocketService.instance) {
      WebSocketService.instance = new WebSocketService();
    }
    return WebSocketService.instance;
  }

  /**
   * Check if WebSocket is ready
   * In worker processes, WebSocket is not available (separate process)
   * This is expected behavior - worker should use Redis Pub/Sub instead
   */
  private isReady(): boolean {
    return isWebSocketInitialized();
  }

  /**
   * Emit event with automatic fallback to Redis Pub/Sub
   * - Main Process: Emits directly via WebSocket
   * - Worker Process: Publishes to Redis → Main Process handles WebSocket emission
   *
   * @param event - Event name
   * @param payload - Event data
   * @param directEmit - Function to emit directly via WebSocket (main process)
   * @param target - Target identifiers for routing (testId, userId, sessionId)
   */
  private emitWithFallback(
    event: string,
    payload: any,
    directEmit: () => void,
    target?: { testId?: string; userId?: string; sessionId?: string }
  ): void {
    if (this.isReady()) {
      // Main process: emit directly via WebSocket
      directEmit();
    } else {
      // Worker process: publish to Redis Pub/Sub
      logger.debug('[WebSocketService] Using Redis Pub/Sub fallback (worker process)', {
        event,
        target,
      });

      redisWebSocketBridge.publishEvent(event, payload, target).catch((error) => {
        logger.error('[WebSocketService] Failed to publish to Redis', {
          event,
          target,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  // ============================================================================
  // GENERIC EMIT METHODS
  // ============================================================================

  /**
   * Emit to specific user
   * Note: This method is used by both main and worker processes
   * Worker processes will automatically fallback to Redis Pub/Sub
   */
  public emitToUser(
    userId: string,
    event: keyof ServerToClientEvents,
    data: any
  ): void {
    // Use fallback for worker processes
    if (!this.isReady()) {
      logger.debug('[WebSocketService] Using Redis Pub/Sub fallback for emitToUser (worker process)', {
        userId,
        event,
      });
      redisWebSocketBridge.publishEvent(event as string, data, { userId }).catch((error) => {
        logger.error('[WebSocketService] Failed to publish emitToUser to Redis', {
          userId,
          event,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }

    // Validate inputs
    if (!userId || typeof userId !== 'string' || userId.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid userId in emitToUser', { userId, event });
      return;
    }

    if (!event || typeof event !== 'string' || event.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid event in emitToUser', { userId, event });
      return;
    }

    try {
      // Store executed progress events in Redis for restore while running (main process only).
      // Avoid double-store for structured progress (those are stored via emitTestProgress).
      if (
        this.isReady() &&
        event === 'test:progress' &&
        data?.testId &&
        !(typeof data?.progress === 'number' && typeof data?.phase === 'string')
      ) {
        void TestExecutedStepsRedisService.appendProgress(data.testId, data);
      }

      const room = createRoomName('user', userId.trim());
      getIO().to(room).emit(event, data);

      // Use debug for routine emits, info only for important events
      const logLevel = ['test:started', 'test:completed', 'test:failed', 'chat:message'].includes(event) ? 'info' : 'debug';
      logger[logLevel]('[WebSocketService] Emitted to user', {
        userId,
        event,
        room,
      });
    } catch (error) {
      logger.error('[WebSocketService] Error emitting to user', {
        userId,
        event,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  /**
   * Emit to specific test room
   */
  public emitToTest(
    testId: string,
    event: keyof ServerToClientEvents,
    data: any
  ): void {
    if (!this.isReady()) return;

    // Validate inputs
    if (!testId || typeof testId !== 'string' || testId.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid testId in emitToTest', { testId, event });
      return;
    }

    if (!event || typeof event !== 'string' || event.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid event in emitToTest', { testId, event });
      return;
    }

    try {
      const room = createRoomName('test', testId.trim());
      getIO().to(room).emit(event, data);

      // Use debug for routine emits, info only for important events
      const logLevel = ['test:started', 'test:completed', 'test:failed'].includes(event) ? 'info' : 'debug';
      logger[logLevel]('[WebSocketService] Emitted to test', {
        testId,
        event,
        room,
      });
    } catch (error) {
      logger.error('[WebSocketService] Error emitting to test', {
        testId,
        event,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  /**
   * Emit to specific chat room
   */
  public emitToChat(
    sessionId: string,
    event: keyof ServerToClientEvents,
    data: any
  ): void {
    if (!this.isReady()) return;

    // Validate inputs
    if (!sessionId || typeof sessionId !== 'string' || sessionId.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid sessionId in emitToChat', { sessionId, event });
      return;
    }

    if (!event || typeof event !== 'string' || event.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid event in emitToChat', { sessionId, event });
      return;
    }

    try {
      const room = createRoomName('chat', sessionId.trim());
      getIO().to(room).emit(event, data);

      // Use debug for routine emits, info only for important chat events
      const logLevel = event === 'chat:message' ? 'info' : 'debug';
      logger[logLevel]('[WebSocketService] Emitted to chat', {
        sessionId,
        event,
        room,
      });
    } catch (error) {
      logger.error('[WebSocketService] Error emitting to chat', {
        sessionId,
        event,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  /**
   * Emit to specific room
   */
  public emitToRoom(
    roomType: RoomType,
    roomId: string,
    event: keyof ServerToClientEvents,
    data: any
  ): void {
    if (!this.isReady()) return;

    // Validate inputs
    if (!roomType || !['test', 'chat', 'user'].includes(roomType)) {
      logger.warn('[WebSocketService] Invalid roomType in emitToRoom', { roomType, roomId, event });
      return;
    }

    if (!roomId || typeof roomId !== 'string' || roomId.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid roomId in emitToRoom', { roomType, roomId, event });
      return;
    }

    if (!event || typeof event !== 'string' || event.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid event in emitToRoom', { roomType, roomId, event });
      return;
    }

    try {
      const room = createRoomName(roomType, roomId.trim());
      getIO().to(room).emit(event, data);

      // Use debug for routine emits
      logger.debug('[WebSocketService] Emitted to room', {
        roomType,
        roomId,
        event,
        room,
      });
    } catch (error) {
      logger.error('[WebSocketService] Error emitting to room', {
        roomType,
        roomId,
        event,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  /**
   * Broadcast to all connected clients
   */
  public broadcast(
    event: keyof ServerToClientEvents,
    data: any
  ): void {
    if (!this.isReady()) return;

    // Validate inputs
    if (!event || typeof event !== 'string' || event.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid event in broadcast', { event });
      return;
    }

    try {
      getIO().emit(event, data);

      // Broadcast is always important - keep as info
      logger.info('[WebSocketService] Broadcasted to all', {
        event,
      });
    } catch (error) {
      logger.error('[WebSocketService] Error broadcasting', {
        event,
        error: error instanceof Error ? error.message : String(error),
        errorType: error instanceof Error ? error.constructor.name : typeof error,
      });
    }
  }

  // ============================================================================
  // TEST EVENTS
  // ============================================================================

  public emitTestCreated(testId: string, payload: TestCreatedPayload): void {
    this.emitWithFallback(
      'test:created',
      payload,
      () => {
        this.emitToTest(testId, 'test:created', payload);
        // Also emit to user if userId present
        if (payload.userId) {
          this.emitToUser(payload.userId, 'test:created', payload);
        }
      },
      { testId, userId: payload.userId }
    );
  }

  public emitTestStarted(testId: string, payload: TestStartedPayload): void {
    this.emitWithFallback(
      'test:started',
      payload,
      () => {
        logger.info('[WebSocketService] Emitting test started', {
          testId,
          timestamp: payload.timestamp,
        });
        this.emitToTest(testId, 'test:started', payload);
      },
      { testId }
    );
  }

  public emitTestProgress(testId: string, payload: TestProgressPayload & { userId?: string }): void {
    this.emitWithFallback(
      'test:progress',
      payload,
      () => {
        void TestExecutedStepsRedisService.appendProgress(testId, payload);
        logger.info('[WebSocketService] Emitting test progress', {
          testId,
          progress: payload.progress,
          phase: payload.phase,
          currentStep: payload.currentStep,
          action: payload.action?.type,
          userId: payload.userId,
          sessionId: payload.sessionId,
        });
        // ✅ Emit to test room (always)
        this.emitToTest(testId, 'test:progress', payload);
        // ✅ FIX: If sessionId is provided, emit to chat room for isolation (not user-room)
        // This prevents mixing progress from multiple tests in different chats
        if (payload.sessionId) {
          this.emitToChat(payload.sessionId, 'test:progress', payload);
        } else if (payload.userId) {
          // Fallback: emit to user room if no sessionId (backward compatibility)
          this.emitToUser(payload.userId, 'test:progress', payload);
        }
      },
      { testId, userId: payload.userId, sessionId: payload.sessionId }
    );
  }

  // ✅ NEW: Emit real-time graph update
  // ✅ FIX: Test completion check is done at class level (LiteEngine/IntelligentTestOrchestrator)
  // to prevent late events from async operations (e.g., screenshot uploads)
  public emitTestGraphUpdate(testId: string, payload: TestGraphUpdatePayload): void {
    // Validate payload structure
    if (!payload || typeof payload !== 'object') {
      logger.warn('[WebSocketService] Invalid test:graph-update payload', { testId });
      return;
    }

    if (!payload.type || !['full', 'incremental'].includes(payload.type)) {
      logger.warn('[WebSocketService] Invalid test:graph-update type', {
        testId,
        type: payload.type,
      });
      return;
    }

    if (!payload.data || typeof payload.data !== 'object') {
      logger.warn('[WebSocketService] Invalid test:graph-update data', { testId });
      return;
    }

    // Validate that payload has at least one of the required data fields
    const hasIncrementalData = payload.data.newNode || payload.data.newEdge || payload.data.updatedNode;
    const hasFullData = payload.data.fullGraph;

    if (!hasIncrementalData && !hasFullData) {
      logger.warn('[WebSocketService] test:graph-update missing graph data', {
        testId,
        type: payload.type,
      });
      return;
    }

    this.emitWithFallback(
      'test:graph-update',
      payload,
      () => {
        // ✅ Emit to test room (always)
        this.emitToTest(testId, 'test:graph-update', payload);
        // ✅ FIX: If sessionId is provided, emit to chat room for isolation
        if (payload.sessionId) {
          this.emitToChat(payload.sessionId, 'test:graph-update', payload);
        }
      },
      { testId, sessionId: payload.sessionId }
    );
  }

  public emitTestStepCompleted(testId: string, payload: TestStepCompletedPayload): void {
    this.emitWithFallback(
      'test:step:completed',
      payload,
      () => {
        void TestExecutedStepsRedisService.appendStepCompleted(testId, payload);
        this.emitToTest(testId, 'test:step:completed', payload);
      },
      { testId }
    );
  }

  public emitTestBrowserCompleted(testId: string, payload: TestBrowserCompletedPayload): void {
    this.emitWithFallback(
      'test:browser:completed',
      payload,
      () => this.emitToTest(testId, 'test:browser:completed', payload),
      { testId }
    );
  }

  public emitTestCompleted(testId: string, payload: TestCompletedPayload): void {
    this.emitWithFallback(
      'test:completed',
      payload,
      () => {
        // Finalize executed steps: move Redis → Postgres and cleanup Redis.
        void TestExecutedStepsRedisService.finalizeToDb(testId);

        logger.info('[WebSocketService] Emitting test completed', {
          testId,
          status: payload.status,
          timestamp: payload.timestamp,
        });
        this.emitToTest(testId, 'test:completed', payload);
      },
      { testId }
    );
  }

  public emitTestFailed(testId: string, payload: TestFailedPayload): void {
    this.emitWithFallback(
      'test:failed',
      payload,
      () => {
        // Finalize executed steps: move Redis → Postgres and cleanup Redis.
        void TestExecutedStepsRedisService.finalizeToDb(testId);

        logger.error('[WebSocketService] Emitting test failed', {
          testId,
          error: payload.error,
          timestamp: payload.timestamp,
        });
        this.emitToTest(testId, 'test:failed', payload);
      },
      { testId }
    );
  }

  public emitTestCancelled(testId: string, payload: TestCancelledPayload): void {
    this.emitWithFallback(
      'test:cancelled',
      payload,
      () => {
        // Finalize executed steps: move Redis → Postgres and cleanup Redis.
        void TestExecutedStepsRedisService.finalizeToDb(testId);
        this.emitToTest(testId, 'test:cancelled', payload);
      },
      { testId }
    );
  }

  public emitTestClarificationRequest(testId: string, payload: any): void {
    this.emitWithFallback(
      'test:clarification:request',
      payload,
      () => {
        logger.info('[WebSocketService] Emitting clarification request', {
          testId,
          questionId: payload.questionId,
          type: payload.type,
        });
        this.emitToTest(testId, 'test:clarification:request', payload);
        // Also emit to user if userId provided
        if (payload.userId) {
          this.emitToUser(payload.userId, 'test:clarification:request', payload);
        }
      },
      { testId }
    );
  }

  // ============================================================================
  // VIDEO STREAMING EVENTS
  // ============================================================================

  /**
   * Emit video frame to test room
   * High frequency - ~12 fps during streaming
   */
  public emitTestVideoFrame(testId: string, payload: TestVideoFramePayload): void {
    this.emitWithFallback(
      'test:video:frame',
      payload,
      () => {
        this.emitToTest(testId, 'test:video:frame', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:frame', payload);
        }
      },
      { testId }
    );
  }

  /**
   * Emit video stats to test room
   * Sent every 10 seconds during streaming
   */
  public emitTestVideoStats(testId: string, payload: TestVideoStatsPayload): void {
    this.emitWithFallback(
      'test:video:stats',
      payload,
      () => {
        this.emitToTest(testId, 'test:video:stats', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:stats', payload);
        }
      },
      { testId }
    );
  }

  /**
   * Emit video paused notification
   * Sent when backpressure forces stream pause
   */
  public emitTestVideoPaused(testId: string, payload: TestVideoPausedPayload): void {
    this.emitWithFallback(
      'test:video:paused',
      payload,
      () => {
        logger.warn('[WebSocketService] Video stream paused', {
          testId,
          reason: payload.reason,
        });
        this.emitToTest(testId, 'test:video:paused', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:paused', payload);
        }
      },
      { testId }
    );
  }

  /**
   * Emit video resumed notification
   * Sent when stream resumes after pause
   */
  public emitTestVideoResumed(testId: string, payload: TestVideoResumedPayload): void {
    this.emitWithFallback(
      'test:video:resumed',
      payload,
      () => {
        logger.info('[WebSocketService] Video stream resumed', { testId });
        this.emitToTest(testId, 'test:video:resumed', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:resumed', payload);
        }
      },
      { testId }
    );
  }

  /**
   * Emit video stopped notification
   * Sent when streaming ends
   */
  public emitTestVideoStopped(testId: string, payload: TestVideoStoppedPayload): void {
    this.emitWithFallback(
      'test:video:stopped',
      payload,
      () => {
        logger.info('[WebSocketService] Video stream stopped', {
          testId,
          reason: payload.reason,
        });
        this.emitToTest(testId, 'test:video:stopped', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:stopped', payload);
        }
      },
      { testId }
    );
  }

  /**
   * Emit video unavailable notification
   * Sent when CDP screencast fails to start
   */
  public emitTestVideoUnavailable(testId: string, payload: TestVideoUnavailablePayload): void {
    this.emitWithFallback(
      'test:video:unavailable',
      payload,
      () => {
        logger.warn('[WebSocketService] Video streaming unavailable', {
          testId,
          reason: payload.reason,
        });
        this.emitToTest(testId, 'test:video:unavailable', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:unavailable', payload);
        }
      },
      { testId }
    );
  }

  /**
   * Emit video started notification
   * Sent when streaming begins (for late join)
   */
  public emitTestVideoStarted(testId: string, payload: TestVideoStartedPayload): void {
    this.emitWithFallback(
      'test:video:started',
      payload,
      () => {
        logger.info('[WebSocketService] Video stream started', {
          testId,
          sessionId: payload.sessionId,
          fps: payload.fps,
        });
        this.emitToTest(testId, 'test:video:started', payload);
        if (payload.chatSessionId) {
          this.emitToChat(payload.chatSessionId, 'test:video:started', payload);
        }
      },
      { testId }
    );
  }

  // ============================================================================
  // RESULT EVENTS
  // ============================================================================

  public emitResultReady(testId: string, payload: ResultReadyPayload): void {
    this.emitWithFallback(
      'result:ready',
      payload,
      () => this.emitToTest(testId, 'result:ready', payload),
      { testId }
    );
  }

  public emitResultScreenshot(testId: string, payload: ResultScreenshotPayload): void {
    this.emitWithFallback(
      'result:screenshot',
      payload,
      () => this.emitToTest(testId, 'result:screenshot', payload),
      { testId }
    );
  }

  public emitResultError(testId: string, payload: ResultErrorPayload): void {
    this.emitWithFallback(
      'result:error',
      payload,
      () => this.emitToTest(testId, 'result:error', payload),
      { testId }
    );
  }

  // ============================================================================
  // AI ANALYSIS EVENTS
  // ============================================================================

  public emitAIAnalysisStarted(testId: string, payload: AIAnalysisStartedPayload): void {
    this.emitWithFallback(
      'ai:analysis:started',
      payload,
      () => this.emitToTest(testId, 'ai:analysis:started', payload),
      { testId }
    );
  }

  public emitAIAnalysisProgress(testId: string, payload: AIAnalysisProgressPayload): void {
    this.emitWithFallback(
      'ai:analysis:progress',
      payload,
      () => this.emitToTest(testId, 'ai:analysis:progress', payload),
      { testId }
    );
  }

  public emitAIAnalysisCompleted(testId: string, payload: AIAnalysisCompletedPayload): void {
    this.emitWithFallback(
      'ai:analysis:completed',
      payload,
      () => this.emitToTest(testId, 'ai:analysis:completed', payload),
      { testId }
    );
  }

  public emitAIBugFound(testId: string, payload: AIBugFoundPayload): void {
    this.emitWithFallback(
      'ai:bug:found',
      payload,
      () => this.emitToTest(testId, 'ai:bug:found', payload),
      { testId }
    );
  }

  // ============================================================================
  // CHAT EVENTS
  // ============================================================================

  public emitChatMessage(sessionId: string, payload: ChatMessagePayload): void {
    // Chat events are typically from main process, but add fallback for safety
    if (!this.isReady()) {
      logger.debug('[WebSocketService] Using Redis Pub/Sub fallback for emitChatMessage (worker process)', {
        sessionId,
      });
      redisWebSocketBridge.publishEvent('chat:message', payload, { sessionId }).catch((error) => {
        logger.error('[WebSocketService] Failed to publish chat:message to Redis', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    this.emitToChat(sessionId, 'chat:message', payload);
  }

  public emitChatTestUpdate(sessionId: string, payload: ChatTestUpdatePayload): void {
    if (!this.isReady()) {
      logger.debug('[WebSocketService] Using Redis Pub/Sub fallback for emitChatTestUpdate (worker process)', {
        sessionId,
      });
      redisWebSocketBridge.publishEvent('chat:test:update', payload, { sessionId }).catch((error) => {
        logger.error('[WebSocketService] Failed to publish chat:test:update to Redis', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    this.emitToChat(sessionId, 'chat:test:update', payload);
  }

  public emitChatProcessingStep(sessionId: string, payload: any): void {
    if (!this.isReady()) {
      logger.debug('[WebSocketService] Using Redis Pub/Sub fallback for emitChatProcessingStep (worker process)', {
        sessionId,
      });
      redisWebSocketBridge.publishEvent('chat:processing:step', payload, { sessionId }).catch((error) => {
        logger.error('[WebSocketService] Failed to publish chat:processing:step to Redis', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      return;
    }
    this.emitToChat(sessionId, 'chat:processing:step', payload);
  }

  // ============================================================================
  // SYSTEM EVENTS
  // ============================================================================

  public emitSystemError(payload: SystemErrorPayload): void {
    this.broadcast('system:error', payload);
  }

  public emitSystemMaintenance(payload: SystemMaintenancePayload): void {
    this.broadcast('system:maintenance', payload);
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Get number of connected clients
   */
  public async getConnectedCount(): Promise<number> {
    if (!this.isReady()) return 0;

    try {
      const sockets = await getIO().fetchSockets();
      return sockets.length;
    } catch (error) {
      logger.error('[WebSocketService] Error getting connected count', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Get rooms a test is subscribed to
   */
  public async getTestSubscribers(testId: string): Promise<number> {
    if (!this.isReady()) return 0;

    // Validate input
    if (!testId || typeof testId !== 'string' || testId.trim().length === 0) {
      logger.warn('[WebSocketService] Invalid testId in getTestSubscribers', { testId });
      return 0;
    }

    try {
      const room = createRoomName('test', testId.trim());
      const sockets = await getIO().in(room).fetchSockets();
      return sockets.length;
    } catch (error) {
      logger.error('[WebSocketService] Error getting test subscribers', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }
}

// Export singleton instance
export const webSocketService = WebSocketService.getInstance();
