/**
 * Video Stream Registry
 * Global registry for managing active video streams in the worker process
 *
 * Purpose:
 * - Track all active VideoStreamService instances
 * - Enable cleanup on worker stalled/shutdown events
 * - Prevent orphaned CDP sessions
 */

import { logger } from '@/utils/core/logger';
import { VideoStreamService } from './video-stream.service';

/**
 * Global registry for video streams
 * Used for cleanup on worker shutdown/stalled events
 */
class VideoStreamRegistryClass {
  private streams = new Map<string, VideoStreamService>();

  /**
   * Register a video stream service
   * @param testId - Test ID to associate with the stream
   * @param stream - VideoStreamService instance
   */
  register(testId: string, stream: VideoStreamService): void {
    // If there's already a stream for this testId, stop it first
    const existing = this.streams.get(testId);
    if (existing) {
      logger.warn('[VIDEO_REGISTRY] Replacing existing stream', { testId });
      existing.stop('error').catch(() => {
        // Ignore cleanup errors
      });
    }

    this.streams.set(testId, stream);
    logger.debug('[VIDEO_REGISTRY] Stream registered', {
      testId,
      totalStreams: this.streams.size,
    });
  }

  /**
   * Unregister a video stream service
   * @param testId - Test ID to unregister
   */
  unregister(testId: string): void {
    this.streams.delete(testId);
    logger.debug('[VIDEO_REGISTRY] Stream unregistered', {
      testId,
      totalStreams: this.streams.size,
    });
  }

  /**
   * Get a video stream service by test ID
   * @param testId - Test ID to look up
   */
  get(testId: string): VideoStreamService | undefined {
    return this.streams.get(testId);
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

    for (const [testId, stream] of this.streams.entries()) {
      const stopPromise = stream.stop(reason === 'shutdown' ? 'completed' : 'error')
        .catch((error) => {
          logger.warn('[VIDEO_REGISTRY] Error stopping stream', {
            testId,
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

    logger.info('[VIDEO_REGISTRY] All streams stopped', { count });
  }

  /**
   * Stop stream for a specific test ID
   * @param testId - Test ID to stop
   * @param reason - Reason for stopping
   */
  async stopByTestId(testId: string, reason: 'completed' | 'cancelled' | 'error' | 'timeout'): Promise<void> {
    const stream = this.streams.get(testId);
    if (stream) {
      try {
        await stream.stop(reason);
      } catch (error) {
        logger.warn('[VIDEO_REGISTRY] Error stopping stream by testId', {
          testId,
          reason,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.unregister(testId);
    }
  }

  /**
   * Check if a stream is active for a test ID
   * @param testId - Test ID to check
   */
  isActive(testId: string): boolean {
    const stream = this.streams.get(testId);
    return stream ? stream.isActive() : false;
  }

  /**
   * Get summary of all active streams
   * Useful for debugging and monitoring
   */
  getSummary(): { testId: string; sessionId: string; isActive: boolean }[] {
    return Array.from(this.streams.entries()).map(([testId, stream]) => ({
      testId,
      sessionId: stream.getSessionId(),
      isActive: stream.isActive(),
    }));
  }
}

// Singleton instance
export const VideoStreamRegistry = new VideoStreamRegistryClass();
