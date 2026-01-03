/**
 * TestProgressEmitter
 * Helper class for emitting real-time test progress via WebSocket
 */

import { logger } from '@/utils/core/logger';
import { getActionIcon, StateDiffSummary } from '@/websocket/types/types';
import { webSocketService } from '@/websocket/core/websocket.service';

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
  icon?: string; // Icon name for frontend display
  diff?: StateDiffSummary; // State diff for frontend highlighting
}

export class TestProgressEmitter {
  private testId: string;
  private browser: string;
  private userId?: string;
  private startTime: number;
  private totalActions: number = 0;
  private lastLoggedPhase: string = '';

  // ✅ OPTIMIZATION: Deduplicate and throttle progress updates
  private lastEmittedProgress: number = -1;
  private lastEmitTime: number = 0;
  private EMIT_THROTTLE_MS: number = 300; // Min 300ms between emits

  constructor(testId: string, browser: string, userId?: string) {
    this.testId = testId;
    this.browser = browser;
    this.userId = userId;
    this.startTime = Date.now();

    logger.info('[PROGRESS] Test progress tracking started', {
      testId,
      browser,
      userId,
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
   * ✅ OPTIMIZED: Throttles updates to reduce WebSocket noise
   */
  emit(params: EmitParams): void {
    try {
      // Validate progress value
      const progress = Math.max(0, Math.min(100, params.progress));
      const now = Date.now();

      // ✅ OPTIMIZATION: Skip if progress unchanged and not enough time passed
      // Always emit for key events (phase change, completion, failure)
      const isKeyEvent =
        progress === 100 ||
        progress === 0 ||
        params.status === 'completed' ||
        params.status === 'failed' ||
        params.phase !== this.lastLoggedPhase;

      const timeSinceLastEmit = now - this.lastEmitTime;
      const progressUnchanged = progress === this.lastEmittedProgress;

      if (!isKeyEvent && progressUnchanged && timeSinceLastEmit < this.EMIT_THROTTLE_MS) {
        return; // Skip duplicate/rapid updates
      }

      const elapsedTime = now - this.startTime;

      // Calculate estimated remaining time based on current progress
      // Formula: if we're at X%, and it took Y ms, then 100% will take (Y / X) * 100 ms
      // Remaining = Total - Elapsed
      let estimatedTotal: number;
      let estimatedRemaining: number;

      if (progress === 0) {
        // At start, use default estimate
        estimatedTotal = 30000; // 30 seconds default
        estimatedRemaining = estimatedTotal;
      } else if (progress >= 100) {
        // At completion, no time remaining
        estimatedTotal = elapsedTime;
        estimatedRemaining = 0;
      } else {
        // Calculate based on current progress
        estimatedTotal = (elapsedTime / progress) * 100;
        estimatedRemaining = Math.max(0, estimatedTotal - elapsedTime);
      }

      webSocketService.emitTestProgress(this.testId, {
        testId: this.testId,
        browser: this.browser,
        progress,
        phase: params.phase,
        currentStep: params.currentStep,
        icon: params.icon || getActionIcon(params.action?.type, params.phase),
        action: params.action,
        totalSteps: this.totalActions > 0 ? this.totalActions : undefined,
        completedSteps: params.completedSteps,
        status: params.status || 'running',
        timestamp: new Date().toISOString(),
        elapsedTime,
        estimatedRemaining,
        userId: this.userId,
        diff: params.diff, // State diff for frontend highlighting
      });

      // Update tracking state
      this.lastEmittedProgress = progress;
      this.lastEmitTime = now;

      // Log key milestones (phase transitions and completion)
      if (isKeyEvent) {
        logger.info('[PROGRESS] Test milestone', {
          testId: this.testId,
          progress,
          phase: params.phase,
          status: params.status,
          elapsed: `${Math.round(elapsedTime / 1000)}s`,
          // estimated: `${Math.round(estimatedRemaining / 1000)}s`,
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
