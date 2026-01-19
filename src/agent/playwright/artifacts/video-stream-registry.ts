/**
 * Video Stream Registry
 * Global registry for managing active video streams in the worker process
 *
 * Purpose:
 * - Track all active VideoStreamService instances
 * - Enable cleanup on worker stalled/shutdown events
 * - Prevent orphaned CDP sessions
 *
 * Key concept: Uses `runKey` (testId:browser) as primary key for isolation
 */

import { logger } from '@/utils/core/logger';
import { VideoStreamService } from './video-stream.service';

/**
 * Global registry for video streams
 * Uses runKey (testId:browser) for proper isolation of parallel browser runs
 */
class VideoStreamRegistryClass {
  /** Primary map: runKey -> stream */
  private streams = new Map<string, VideoStreamService>();
  /** Secondary index: testId -> Set of runKeys */
  private testIdIndex = new Map<string, Set<string>>();

  /**
   * Add runKey to testId index
   */
  private addToIndex(testId: string, runKey: string): void {
    let runKeys = this.testIdIndex.get(testId);
    if (!runKeys) {
      runKeys = new Set();
      this.testIdIndex.set(testId, runKeys);
    }
    runKeys.add(runKey);
  }

  /**
   * Remove runKey from testId index
   */
  private removeFromIndex(testId: string, runKey: string): void {
    const runKeys = this.testIdIndex.get(testId);
    if (runKeys) {
      runKeys.delete(runKey);
      if (runKeys.size === 0) {
        this.testIdIndex.delete(testId);
      }
    }
  }

  /**
   * Extract testId from runKey
   */
  private getTestIdFromRunKey(runKey: string): string {
    const lastColonIdx = runKey.lastIndexOf(':');
    return lastColonIdx === -1 ? runKey : runKey.substring(0, lastColonIdx);
  }

  /**
   * Register a video stream service
   * @param runKey - Run key (testId:browser) to associate with the stream
   * @param stream - VideoStreamService instance
   */
  register(runKey: string, stream: VideoStreamService): void {
    // If there's already a stream for this runKey, stop it first
    const existing = this.streams.get(runKey);
    if (existing) {
      logger.warn('[VIDEO_REGISTRY] Replacing existing stream', { runKey });
      existing.stop('error').catch(() => {
        // Ignore cleanup errors
      });
    }

    this.streams.set(runKey, stream);

    // Update index
    const testId = this.getTestIdFromRunKey(runKey);
    this.addToIndex(testId, runKey);

    logger.debug('[VIDEO_REGISTRY] Stream registered', {
      runKey,
      totalStreams: this.streams.size,
    });
  }

  /**
   * Unregister a video stream service
   * @param runKey - Run key (testId:browser) to unregister
   */
  unregister(runKey: string): void {
    if (this.streams.has(runKey)) {
      const testId = this.getTestIdFromRunKey(runKey);
      this.removeFromIndex(testId, runKey);
    }
    this.streams.delete(runKey);
    logger.debug('[VIDEO_REGISTRY] Stream unregistered', {
      runKey,
      totalStreams: this.streams.size,
    });
  }

  /**
   * Get a video stream service by runKey
   * @param runKey - Run key (testId:browser) to look up
   */
  get(runKey: string): VideoStreamService | undefined {
    return this.streams.get(runKey);
  }

  /**
   * Get all runKeys for a testId
   * @param testId - Test ID
   */
  getRunKeysByTestId(testId: string): string[] {
    const runKeys = this.testIdIndex.get(testId);
    return runKeys ? Array.from(runKeys) : [];
  }

  /**
   * Get all active video stream services
   */
  getAll(): VideoStreamService[] {
    return Array.from(this.streams.values());
  }

  /**
   * Get count of active streams
   */
  getCount(): number {
    return this.streams.size;
  }

  /**
   * Stop all active video streams
   * Used for graceful shutdown and stalled job handling
   * @param reason - Reason for stopping all streams
   */
  async stopAll(reason: 'stalled' | 'shutdown' | 'error'): Promise<void> {
    const count = this.streams.size;

    if (count === 0) {
      return;
    }

    logger.info('[VIDEO_REGISTRY] Stopping all streams', {
      reason,
      count,
    });

    const stopPromises: Promise<void>[] = [];

    for (const [runKey, stream] of this.streams.entries()) {
      const stopPromise = stream.stop(reason === 'shutdown' ? 'completed' : 'error')
        .catch((error) => {
          logger.warn('[VIDEO_REGISTRY] Error stopping stream', {
            runKey,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      stopPromises.push(stopPromise);
    }

    // Wait for all streams to stop (with timeout)
    await Promise.race([
      Promise.allSettled(stopPromises),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)), // 5 second timeout
    ]);

    this.streams.clear();
    this.testIdIndex.clear();

    logger.info('[VIDEO_REGISTRY] All streams stopped', { count });
  }

  /**
   * Stop stream for a specific runKey
   * @param runKey - Run key (testId:browser) to stop
   * @param reason - Reason for stopping
   */
  async stopByRunKey(runKey: string, reason: 'completed' | 'cancelled' | 'error' | 'timeout'): Promise<void> {
    const stream = this.streams.get(runKey);
    if (stream) {
      try {
        await stream.stop(reason);
      } catch (error) {
        logger.warn('[VIDEO_REGISTRY] Error stopping stream by runKey', {
          runKey,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.unregister(runKey);
    }
  }

  /**
   * Stop all streams for a specific testId
   * @param testId - Test ID to stop streams for
   * @param reason - Reason for stopping
   */
  async stopByTestId(testId: string, reason: 'completed' | 'cancelled' | 'error' | 'timeout'): Promise<void> {
    const runKeys = this.testIdIndex.get(testId);
    if (!runKeys || runKeys.size === 0) return;

    const stopPromises: Promise<void>[] = [];
    for (const runKey of runKeys) {
      stopPromises.push(this.stopByRunKey(runKey, reason));
    }

    await Promise.allSettled(stopPromises);
    logger.debug('[VIDEO_REGISTRY] All streams stopped for testId', { testId, count: runKeys.size });
  }

  /**
   * Check if a stream is active for a runKey
   * @param runKey - Run key (testId:browser) to check
   */
  isActive(runKey: string): boolean {
    const stream = this.streams.get(runKey);
    return stream ? stream.isActive() : false;
  }

  /**
   * Get summary of all active streams
   * Useful for debugging and monitoring
   */
  getSummary(): { runKey: string; sessionId: string; isActive: boolean }[] {
    return Array.from(this.streams.entries()).map(([runKey, stream]) => ({
      runKey,
      sessionId: stream.getSessionId(),
      isActive: stream.isActive(),
    }));
  }
}

// Singleton instance
export const VideoStreamRegistry = new VideoStreamRegistryClass();
