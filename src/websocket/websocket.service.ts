/**
 * WebSocket Service (Singleton)
 * Central service for emitting events to clients
 */

import { logger } from '@/utils/logger';
import { getIO, isWebSocketInitialized } from './server';
import {
  createRoomName,
  RoomType,
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
    event: string,
    data: any
  ): void {
    if (!this.isReady()) return;

    const room = createRoomName('user', userId);
    (getIO().to(room) as any).emit(event, data);

    logger.debug('[WebSocketService] Emitted to user', {
      userId,
      event,
      room,
    });
  }

  /**
   * Emit to specific test room
   */
  public emitToTest(
    testId: string,
    event: string,
    data: any
  ): void {
    if (!this.isReady()) return;

    const room = createRoomName('test', testId);
    (getIO().to(room) as any).emit(event, data);

    logger.debug('[WebSocketService] Emitted to test', {
      testId,
      event,
      room,
    });
  }

  /**
   * Emit to specific chat room
   */
  public emitToChat(
    sessionId: string,
    event: string,
    data: any
  ): void {
    if (!this.isReady()) return;

    const room = createRoomName('chat', sessionId);
    (getIO().to(room) as any).emit(event, data);

    logger.debug('[WebSocketService] Emitted to chat', {
      sessionId,
      event,
      room,
    });
  }

  /**
   * Emit to specific room
   */
  public emitToRoom(
    roomType: RoomType,
    roomId: string,
    event: string,
    data: any
  ): void {
    if (!this.isReady()) return;

    const room = createRoomName(roomType, roomId);
    (getIO().to(room) as any).emit(event, data);

    logger.debug('[WebSocketService] Emitted to room', {
      roomType,
      roomId,
      event,
      room,
    });
  }

  /**
   * Broadcast to all connected clients
   */
  public broadcast(
    event: string,
    data: any
  ): void {
    if (!this.isReady()) return;

    (getIO() as any).emit(event, data);

    logger.debug('[WebSocketService] Broadcasted to all', {
      event,
    });
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
    this.emitToTest(testId, 'test:started', payload);
  }

  public emitTestProgress(testId: string, payload: TestProgressPayload): void {
    this.emitToTest(testId, 'test:progress', payload);
  }

  public emitTestStepCompleted(testId: string, payload: TestStepCompletedPayload): void {
    this.emitToTest(testId, 'test:step:completed', payload);
  }

  public emitTestBrowserCompleted(testId: string, payload: TestBrowserCompletedPayload): void {
    this.emitToTest(testId, 'test:browser:completed', payload);
  }

  public emitTestCompleted(testId: string, payload: TestCompletedPayload): void {
    this.emitToTest(testId, 'test:completed', payload);
  }

  public emitTestFailed(testId: string, payload: TestFailedPayload): void {
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

    const sockets = await getIO().fetchSockets();
    return sockets.length;
  }

  /**
   * Get rooms a test is subscribed to
   */
  public async getTestSubscribers(testId: string): Promise<number> {
    if (!this.isReady()) return 0;

    const room = createRoomName('test', testId);
    const sockets = await getIO().in(room).fetchSockets();
    return sockets.length;
  }
}

// Export singleton instance
export const webSocketService = WebSocketService.getInstance();
