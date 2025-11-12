/**
 * TestProgressEmitter
 * Helper class for emitting real-time test progress via WebSocket
 */

import { webSocketService } from '@/websocket/websocket.service';
import { logger } from '@/utils/logger';

interface EmitParams {
  progress: number; // 0-100
  phase: string; // 'initialization' | 'analysis' | 'planning' | 'execution' | 'finalization'
  currentStep: string;
  action?: {
    type: string;
    description: string;
    target?: string;
  };
  completedSteps?: number;
  status?: string; // 'queued' | 'running' | 'completed' | 'failed'
}

export class TestProgressEmitter {
  private testId: string;
  private browser: string;
  private startTime: number;
  private totalActions: number = 0;
  private lastLoggedPhase: string = '';

  constructor(testId: string, browser: string) {
    this.testId = testId;
    this.browser = browser;
    this.startTime = Date.now();

    logger.info('[PROGRESS] Test progress tracking started', {
      testId,
      browser,
    });
  }

  /**
   * Set total number of actions for accurate progress calculation
   */
  setTotalActions(count: number): void {
    this.totalActions = count;
    logger.info('[PROGRESS] Action plan ready', {
      testId: this.testId,
      totalActions: count,
    });
  }

  /**
   * Emit progress update via WebSocket
   */
  emit(params: EmitParams): void {
    try {
      const elapsedTime = Date.now() - this.startTime;

      // Calculate estimated remaining time based on current progress
      // Formula: if we're at X%, and it took Y ms, then 100% will take (Y / X) * 100 ms
      // Remaining = Total - Elapsed
      const estimatedTotal =
        params.progress > 0 ? (elapsedTime / params.progress) * 100 : 30000; // Default 30s if progress is 0

      const estimatedRemaining = Math.max(0, estimatedTotal - elapsedTime);

      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.browser,
        progress: params.progress,
        phase: params.phase,
        currentStep: params.currentStep,
        action: params.action,
        totalSteps: this.totalActions > 0 ? this.totalActions : undefined,
        completedSteps: params.completedSteps,
        status: params.status || 'running',
        timestamp: new Date().toISOString(),
        elapsedTime,
        estimatedRemaining,
      });

      // Log key milestones (phase transitions and completion)
      const isKeyMilestone =
        params.progress === 100 ||
        params.status === 'completed' ||
        params.status === 'failed' ||
        params.phase !== this.lastLoggedPhase;

      if (isKeyMilestone) {
        logger.info('[PROGRESS] Test milestone', {
          testId: this.testId,
          progress: params.progress,
          phase: params.phase,
          status: params.status,
          elapsed: `${Math.round(elapsedTime / 1000)}s`,
          estimated: `${Math.round(estimatedRemaining / 1000)}s`,
        });
        this.lastLoggedPhase = params.phase;
      }
    } catch (error) {
      logger.error('[PROGRESS_EMITTER] Failed to emit progress', {
        testId: this.testId,
        error,
      });
      // Don't throw - progress emission should never break the test
    }
  }
}
