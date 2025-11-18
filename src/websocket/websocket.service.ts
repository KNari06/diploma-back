/**
 * WebSocket Service (Singleton)
 * Central service for emitting events to clients
 */

import { logger } from '@/utils/logger';
import { getIO, isWebSocketInitialized } from './server';
import {
  createRoomName,
  RoomType,
  ServerToClientEvents,
  TestCreatedPayload,
  TestStartedPayload,
  TestProgressPayload,
  TestStepCompletedPayload,
  TestBrowserCompletedPayload,
  TestCompletedPayload,
  TestFailedPayload,
  TestCancelledPayload,
  ResultReadyPayload,
  ResultScreenshotPayload,
  ResultErrorPayload,
  AIAnalysisStartedPayload,
  AIAnalysisProgressPayload,
  AIAnalysisCompletedPayload,
  AIBugFoundPayload,
  ChatMessagePayload,
  ChatTestUpdatePayload,
  SystemErrorPayload,
  SystemMaintenancePayload,
} from './types';

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
   */
  private isReady(): boolean {
    if (!isWebSocketInitialized()) {
      logger.warn('[WebSocketService] WebSocket not initialized, skipping emit');
      return false;
    }
    return true;
  }

  // ============================================================================
  // GENERIC EMIT METHODS
  // ============================================================================

  /**
   * Emit to specific user
   */
  public emitToUser(
    userId: string,
    event: keyof ServerToClientEvents,
    data: any
  ): void {
    if (!this.isReady()) return;

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
      const room = createRoomName('user', userId.trim());
      getIO().to(room).emit(event, data);

      logger.info('[WebSocketService] Emitted to user', {
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

      logger.info('[WebSocketService] Emitted to test', {
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

      logger.info('[WebSocketService] Emitted to chat', {
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

      logger.info('[WebSocketService] Emitted to room', {
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
    this.emitToTest(testId, 'test:created', payload);

    // Also emit to user if userId present
    if (payload.userId) {
      this.emitToUser(payload.userId, 'test:created', payload);
    }
  }

  public emitTestStarted(testId: string, payload: TestStartedPayload): void {
    logger.info('[WebSocketService] Emitting test started', {
      testId,
      timestamp: payload.timestamp,
    });
    this.emitToTest(testId, 'test:started', payload);
  }

  public emitTestProgress(testId: string, payload: TestProgressPayload): void {
    logger.info('[WebSocketService] Emitting test progress', {
      testId,
      progress: payload.progress,
      phase: payload.phase,
      currentStep: payload.currentStep,
      action: payload.action?.type,
    });
    this.emitToTest(testId, 'test:progress', payload);
  }

  public emitTestStepCompleted(testId: string, payload: TestStepCompletedPayload): void {
    this.emitToTest(testId, 'test:step:completed', payload);
  }

  public emitTestBrowserCompleted(testId: string, payload: TestBrowserCompletedPayload): void {
    this.emitToTest(testId, 'test:browser:completed', payload);
  }

  public emitTestCompleted(testId: string, payload: TestCompletedPayload): void {
    logger.info('[WebSocketService] Emitting test completed', {
      testId,
      status: payload.status,
      timestamp: payload.timestamp,
    });
    this.emitToTest(testId, 'test:completed', payload);
  }

  public emitTestFailed(testId: string, payload: TestFailedPayload): void {
    logger.error('[WebSocketService] Emitting test failed', {
      testId,
      error: payload.error,
      timestamp: payload.timestamp,
    });
    this.emitToTest(testId, 'test:failed', payload);
  }

  public emitTestCancelled(testId: string, payload: TestCancelledPayload): void {
    this.emitToTest(testId, 'test:cancelled', payload);
  }

  // ============================================================================
  // RESULT EVENTS
  // ============================================================================

  public emitResultReady(testId: string, payload: ResultReadyPayload): void {
    this.emitToTest(testId, 'result:ready', payload);
  }

  public emitResultScreenshot(testId: string, payload: ResultScreenshotPayload): void {
    this.emitToTest(testId, 'result:screenshot', payload);
  }

  public emitResultError(testId: string, payload: ResultErrorPayload): void {
    this.emitToTest(testId, 'result:error', payload);
  }

  // ============================================================================
  // AI ANALYSIS EVENTS
  // ============================================================================

  public emitAIAnalysisStarted(testId: string, payload: AIAnalysisStartedPayload): void {
    this.emitToTest(testId, 'ai:analysis:started', payload);
  }

  public emitAIAnalysisProgress(testId: string, payload: AIAnalysisProgressPayload): void {
    this.emitToTest(testId, 'ai:analysis:progress', payload);
  }

  public emitAIAnalysisCompleted(testId: string, payload: AIAnalysisCompletedPayload): void {
    this.emitToTest(testId, 'ai:analysis:completed', payload);
  }

  public emitAIBugFound(testId: string, payload: AIBugFoundPayload): void {
    this.emitToTest(testId, 'ai:bug:found', payload);
  }

  // ============================================================================
  // CHAT EVENTS
  // ============================================================================

  public emitChatMessage(sessionId: string, payload: ChatMessagePayload): void {
    this.emitToChat(sessionId, 'chat:message', payload);
  }

  public emitChatTestUpdate(sessionId: string, payload: ChatTestUpdatePayload): void {
    this.emitToChat(sessionId, 'chat:test:update', payload);
  }

  public emitChatProcessingStep(sessionId: string, payload: any): void {
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
