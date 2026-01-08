/**
 * Video Stream Service
 * Manages real-time video streaming from Playwright via Chrome CDP screencast
 *
 * Features:
 * - CDP screencast frame capture (Chrome only)
 * - Throttling and FPS control
 * - Backpressure handling with circuit breaker
 * - Redis lock for preventing duplicate streams
 * - Catchup buffer for late joiners
 * - Metrics and monitoring
 * - Graceful cleanup
 */

import { connection } from '@/config/infrastructure/queues';
import { logger } from '@/utils/core/logger';
import { webSocketService } from '@/websocket/core/websocket.service';
import Redis from 'ioredis';
import { CDPSession, Page } from 'playwright';
import { TestRunRegistry } from '../core/test-run-registry';
import { checkTestCancelled } from '../utils/test-cancellation-checker';

// ============================================================================
// CONFIGURATION
// ============================================================================

const VIDEO_STREAM_CONFIG = {
  // CDP Screencast settings
  fps: 12,
  maxWidth: 960,
  quality: 45,
  minQuality: 25, // Minimum quality when degrading
  format: 'jpeg' as const,

  // Backpressure handling
  maxPendingFrames: 5,
  publishTimeout: 500, // ms
  circuitBreakerThreshold: 3,
  circuitBreakerResetTime: 5000, // ms

  // Monitoring
  statsInterval: 10000, // ms
  cancellationCheckInterval: 5000, // ms
  heartbeatInterval: 30000, // ms - detect stale streams
  lockRenewalInterval: 60000, // ms - renew Redis lock for long tests

  // Redis
  lockTTL: 300, // seconds
  catchupBufferSize: 5,
  catchupBufferTTL: 30, // seconds
  redisConnectTimeout: 5000, // ms
  redisRetryAttempts: 3,

  // Safety limits
  maxFrameSize: 900 * 1024, // 900KB (Redis limit is 1MB)
  cleanupTimeout: 5000, // ms - max time for cleanup operations
  maxTestDuration: 30 * 60 * 1000, // 30 min - auto-stop if exceeded
};

// ============================================================================
// VIDEO STREAM SERVICE
// ============================================================================

export class VideoStreamService {
  private cdpSession: CDPSession | null = null;
  private isStreaming = false;
  private isStopped = false;
  private sessionId: string;
  private testId: string;
  private browser: string;
  private userId?: string;
  private url: string = '';

  // Metrics
  private framesEmitted = 0;
  private framesDropped = 0;
  private lastFrameTime = 0;
  private frameTimestamps: number[] = [];
  private pendingFrames = 0;
  private seq = 0;

  // Circuit breaker
  private consecutiveFailures = 0;
  private isPaused = false;

  // Intervals
  private cancellationCheckInterval: NodeJS.Timeout | null = null;
  private statsInterval: NodeJS.Timeout | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private lockRenewalInterval: NodeJS.Timeout | null = null;

  // Test timing (for elapsedTime in frames)
  private testStartTime = 0;

  // Frame handler reference (for cleanup)
  private frameHandler: ((params: any) => void) | null = null;

  // CDP session state
  private cdpSessionClosed = false;
  private pageCloseHandler: (() => void) | null = null;
  private page: Page | null = null;

  // Redis client
  private redis: Redis | null = null;
  private lockValue: string = '';
  private redisConnected = false;

  // Dynamic quality adjustment
  private currentQuality: number = VIDEO_STREAM_CONFIG.quality;
  private qualityDegradeCount = 0;

  constructor() {
    this.sessionId = '';
    this.testId = '';
    this.browser = '';
  }

  /**
   * Start video streaming for a page
   * Only works for Chrome/Chromium browsers
   */
  async start(
    page: Page,
    testId: string,
    browser: string,
    userId?: string,
    url?: string
  ): Promise<void> {
    // Only Chrome/Chromium supports CDP screencast
    if (!browser.toLowerCase().includes('chrome') && !browser.toLowerCase().includes('chromium')) {
      logger.debug('[VIDEO_STREAM] Skipping - not Chrome browser', { browser, testId });
      return;
    }

    this.testId = testId;
    this.browser = browser;
    this.userId = userId;
    this.url = url || '';
    this.sessionId = `${testId}-${process.pid}-${Date.now()}`;
    this.testStartTime = Date.now();

    try {
      // Store page reference for cleanup
      this.page = page;

      // Initialize Redis client with timeout
      try {
        this.redis = new Redis({
          ...(connection as any),
          connectTimeout: VIDEO_STREAM_CONFIG.redisConnectTimeout,
          maxRetriesPerRequest: VIDEO_STREAM_CONFIG.redisRetryAttempts,
          retryStrategy: (times: number) => {
            if (times > VIDEO_STREAM_CONFIG.redisRetryAttempts) {
              return null; // Stop retrying
            }
            return Math.min(times * 200, 2000);
          },
        });

        // Wait for connection
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Redis connection timeout'));
          }, VIDEO_STREAM_CONFIG.redisConnectTimeout);

          this.redis!.once('ready', () => {
            clearTimeout(timeout);
            this.redisConnected = true;
            resolve();
          });

          this.redis!.once('error', (err) => {
            clearTimeout(timeout);
            reject(err);
          });
        });
      } catch (redisError) {
        logger.warn('[VIDEO_STREAM] Redis connection failed, streaming without catchup buffer', {
          testId,
          error: redisError instanceof Error ? redisError.message : String(redisError),
        });
        // Continue without Redis - streaming still works, just no catchup buffer
        this.redis = null;
      }

      // Acquire Redis lock to prevent duplicate streams (if Redis is available)
      if (this.redis) {
        const lockKey = `stream:lock:${testId}`;
        this.lockValue = `${process.pid}-${Date.now()}`;
        const acquired = await this.redis.set(lockKey, this.lockValue, 'EX', VIDEO_STREAM_CONFIG.lockTTL, 'NX');

        if (!acquired) {
          logger.warn('[VIDEO_STREAM] Another worker is already streaming', { testId, sessionId: this.sessionId });
          await this.redis.quit().catch(() => {});
          this.redis = null;
          return;
        }

        logger.info('[VIDEO_STREAM] Acquired stream lock', { testId, sessionId: this.sessionId });
      }

      // Setup page close handler to detect when browser closes
      this.pageCloseHandler = () => {
        logger.info('[VIDEO_STREAM] Page closed, stopping stream', { testId: this.testId });
        this.cdpSessionClosed = true;
        this.stop('completed').catch(() => {});
      };
      page.once('close', this.pageCloseHandler);

      // Create CDP session
      const context = page.context();
      this.cdpSession = await context.newCDPSession(page);

      // Setup frame handler
      this.frameHandler = this.handleScreencastFrame.bind(this);
      this.cdpSession.on('Page.screencastFrame', this.frameHandler);

      // Start screencast
      this.currentQuality = VIDEO_STREAM_CONFIG.quality;
      await this.cdpSession.send('Page.startScreencast', {
        format: VIDEO_STREAM_CONFIG.format,
        quality: this.currentQuality,
        maxWidth: VIDEO_STREAM_CONFIG.maxWidth,
        everyNthFrame: 1,
      });

      this.isStreaming = true;

      // Start monitoring intervals
      this.startMonitoring();

      // Emit stream started event
      webSocketService.emitTestVideoStarted(testId, {
        testId,
        sessionId: this.sessionId,
        url: this.url,
        width: VIDEO_STREAM_CONFIG.maxWidth,
        height: Math.round(VIDEO_STREAM_CONFIG.maxWidth * 0.5625), // 16:9 ratio
        fps: VIDEO_STREAM_CONFIG.fps,
        timestamp: new Date().toISOString(),
      });

      logger.info('[VIDEO_STREAM] Started streaming', {
        testId,
        sessionId: this.sessionId,
        browser,
        fps: VIDEO_STREAM_CONFIG.fps,
        quality: this.currentQuality,
        maxWidth: VIDEO_STREAM_CONFIG.maxWidth,
        redisAvailable: this.redis !== null,
      });
    } catch (error) {
      logger.warn('[VIDEO_STREAM] Failed to start streaming', {
        testId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Emit unavailable event
      webSocketService.emitTestVideoUnavailable(testId, {
        testId,
        reason: error instanceof Error ? error.message : 'Unknown error',
        timestamp: new Date().toISOString(),
      });

      // Cleanup on failure
      await this.cleanup();
    }
  }

  /**
   * Stop video streaming
   */
  async stop(reason: 'completed' | 'cancelled' | 'error' | 'timeout'): Promise<void> {
    if (this.isStopped) {
      return;
    }

    this.isStopped = true;
    this.isStreaming = false;

    logger.info('[VIDEO_STREAM] Stopping streaming', {
      testId: this.testId,
      sessionId: this.sessionId,
      reason,
      framesEmitted: this.framesEmitted,
      framesDropped: this.framesDropped,
    });

    // Clear intervals
    this.stopMonitoring();

    // Stop CDP screencast
    if (this.cdpSession) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
      } catch (error) {
        logger.debug('[VIDEO_STREAM] Error stopping screencast (may already be closed)', {
          testId: this.testId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Emit stream stopped event
    if (this.testId && this.sessionId) {
      webSocketService.emitTestVideoStopped(this.testId, {
        testId: this.testId,
        sessionId: this.sessionId,
        reason,
        timestamp: new Date().toISOString(),
      });
    }

    // Cleanup resources
    await this.cleanup();
  }

  /**
   * Handle incoming screencast frame from CDP
   */
  private async handleScreencastFrame(params: {
    data: string;
    metadata: { offsetTop: number; pageScaleFactor: number; deviceWidth: number; deviceHeight: number; scrollOffsetX: number; scrollOffsetY: number; timestamp?: number };
    sessionId: number;
  }): Promise<void> {
    // Early exit checks
    if (!this.isStreaming || this.isStopped || this.cdpSessionClosed) {
      return;
    }

    // ✅ FIX: Check TestRunRegistry for global cancellation/completion (event silencing)
    if (TestRunRegistry.shouldSilenceEvents(this.testId)) {
      return;
    }

    const now = Date.now();

    // Check max test duration
    if (now - this.testStartTime > VIDEO_STREAM_CONFIG.maxTestDuration) {
      logger.warn('[VIDEO_STREAM] Max test duration exceeded, stopping stream', {
        testId: this.testId,
        duration: now - this.testStartTime,
        maxDuration: VIDEO_STREAM_CONFIG.maxTestDuration,
      });
      this.stop('timeout').catch(() => {});
      return;
    }

    // Always ACK the frame to keep CDP happy
    if (this.cdpSession && !this.cdpSessionClosed) {
      try {
        await this.cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch (ackError) {
        // CDP session might be closed
        if (ackError instanceof Error &&
            (ackError.message.includes('Target closed') ||
             ackError.message.includes('Session closed') ||
             ackError.message.includes('Protocol error'))) {
          this.cdpSessionClosed = true;
          this.stop('error').catch(() => {});
          return;
        }
      }
    }

    // Check frame size (base64 adds ~33% overhead)
    const frameSize = params.data.length;
    if (frameSize > VIDEO_STREAM_CONFIG.maxFrameSize) {
      this.framesDropped++;
      logger.debug('[VIDEO_STREAM] Dropping oversized frame', {
        testId: this.testId,
        frameSize,
        maxSize: VIDEO_STREAM_CONFIG.maxFrameSize,
      });
      return;
    }

    // Check backpressure
    if (this.pendingFrames >= VIDEO_STREAM_CONFIG.maxPendingFrames) {
      this.framesDropped++;
      logger.debug('[VIDEO_STREAM] Dropping frame due to backpressure', {
        testId: this.testId,
        pendingFrames: this.pendingFrames,
      });
      return;
    }

    // Check circuit breaker
    if (this.isPaused) {
      this.framesDropped++;
      return;
    }

    // Emit frame
    this.seq++;
    const elapsedTime = now - this.testStartTime;

    this.pendingFrames++;
    this.frameTimestamps.push(now);

    // Keep only last 30 timestamps for FPS calculation
    if (this.frameTimestamps.length > 30) {
      this.frameTimestamps.shift();
    }

    try {
      // Emit with timeout
      const emitPromise = this.emitFrame(params.data, params.metadata.deviceWidth, params.metadata.deviceHeight, elapsedTime);
      const timeoutPromise = new Promise<void>((_, reject) =>
        setTimeout(() => reject(new Error('Publish timeout')), VIDEO_STREAM_CONFIG.publishTimeout)
      );

      await Promise.race([emitPromise, timeoutPromise]);

      // Success - reset circuit breaker
      this.consecutiveFailures = 0;
      this.framesEmitted++;
      this.lastFrameTime = now;

      // Resume if was paused
      if (this.isPaused) {
        this.isPaused = false;
        webSocketService.emitTestVideoResumed(this.testId, {
          testId: this.testId,
          sessionId: this.sessionId,
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      // Failure - increment circuit breaker
      this.consecutiveFailures++;
      this.framesDropped++;

      if (this.consecutiveFailures >= VIDEO_STREAM_CONFIG.circuitBreakerThreshold && !this.isPaused) {
        this.isPaused = true;
        webSocketService.emitTestVideoPaused(this.testId, {
          testId: this.testId,
          sessionId: this.sessionId,
          reason: 'circuit_breaker',
          timestamp: new Date().toISOString(),
        });

        // Auto-reset after timeout
        setTimeout(() => {
          if (this.isStreaming && !this.isStopped) {
            this.isPaused = false;
            this.consecutiveFailures = 0;
          }
        }, VIDEO_STREAM_CONFIG.circuitBreakerResetTime);
      }
    } finally {
      this.pendingFrames--;
    }
  }

  /**
   * Emit frame to WebSocket and save to catchup buffer
   */
  private async emitFrame(data: string, width: number, height: number, elapsedTime: number): Promise<void> {
    const payload = {
      testId: this.testId,
      browser: this.browser,
      sessionId: this.sessionId,
      seq: this.seq,
      format: 'jpeg' as const,
      data,
      width,
      height,
      timestamp: new Date().toISOString(),
      elapsedTime,
    };

    // Emit via WebSocket service
    webSocketService.emitTestVideoFrame(this.testId, payload);

    // Save to catchup buffer (fire and forget)
    this.saveToCatchupBuffer(payload).catch(() => {
      // Ignore catchup buffer errors
    });
  }

  /**
   * Save frame to Redis catchup buffer for late joiners
   */
  private async saveToCatchupBuffer(payload: any): Promise<void> {
    if (!this.redis) {
      return;
    }

    const catchupKey = `stream:catchup:${this.testId}`;
    const catchupData = {
      sessionId: payload.sessionId,
      seq: payload.seq,
      data: payload.data,
      width: payload.width,
      height: payload.height,
      timestamp: payload.timestamp,
      elapsedTime: payload.elapsedTime,
    };

    await this.redis.lpush(catchupKey, JSON.stringify(catchupData));
    await this.redis.ltrim(catchupKey, 0, VIDEO_STREAM_CONFIG.catchupBufferSize - 1);
    await this.redis.expire(catchupKey, VIDEO_STREAM_CONFIG.catchupBufferTTL);
  }

  /**
   * Start monitoring intervals
   */
  private startMonitoring(): void {
    // Stats interval with dynamic quality adjustment
    this.statsInterval = setInterval(async () => {
      if (!this.isStreaming || this.isStopped) {
        return;
      }

      const currentFPS = this.calculateFPS();
      const totalFrames = this.framesEmitted + this.framesDropped;
      const dropRate = totalFrames > 0 ? this.framesDropped / totalFrames : 0;

      // Determine quality level
      let quality: 'high' | 'medium' | 'low' = 'high';
      if (dropRate > 0.3 || currentFPS < 6) {
        quality = 'low';
      } else if (dropRate > 0.1 || currentFPS < 10) {
        quality = 'medium';
      }

      // Dynamic quality adjustment - reduce quality if drop rate is high
      if (dropRate > 0.3 && this.currentQuality > VIDEO_STREAM_CONFIG.minQuality) {
        this.qualityDegradeCount++;
        if (this.qualityDegradeCount >= 2) {
          // Reduce quality after 2 consecutive high drop rate periods
          const newQuality = Math.max(
            VIDEO_STREAM_CONFIG.minQuality,
            this.currentQuality - 10
          );

          if (newQuality !== this.currentQuality && this.cdpSession && !this.cdpSessionClosed) {
            try {
              await this.cdpSession.send('Page.stopScreencast');
              await this.cdpSession.send('Page.startScreencast', {
                format: VIDEO_STREAM_CONFIG.format,
                quality: newQuality,
                maxWidth: VIDEO_STREAM_CONFIG.maxWidth,
                everyNthFrame: 1,
              });

              logger.info('[VIDEO_STREAM] Reduced quality due to high drop rate', {
                testId: this.testId,
                oldQuality: this.currentQuality,
                newQuality,
                dropRate: `${(dropRate * 100).toFixed(1)}%`,
              });

              this.currentQuality = newQuality;
              this.qualityDegradeCount = 0;
              // Reset drop counters to measure with new quality
              this.framesDropped = 0;
              this.framesEmitted = 0;
            } catch (error) {
              logger.debug('[VIDEO_STREAM] Failed to adjust quality', {
                testId: this.testId,
                error: error instanceof Error ? error.message : String(error),
              });
            }
          }
        }
      } else if (dropRate < 0.1) {
        // Reset degrade counter if drop rate is acceptable
        this.qualityDegradeCount = 0;
      }

      // Log warning if drop rate is high
      if (dropRate > 0.3) {
        logger.warn('[VIDEO_STREAM] High frame drop rate', {
          testId: this.testId,
          dropRate: `${(dropRate * 100).toFixed(1)}%`,
          framesDropped: this.framesDropped,
          framesEmitted: this.framesEmitted,
          currentQuality: this.currentQuality,
        });
      }

      webSocketService.emitTestVideoStats(this.testId, {
        testId: this.testId,
        sessionId: this.sessionId,
        currentFPS,
        framesEmitted: this.framesEmitted,
        framesDropped: this.framesDropped,
        avgLatency: this.pendingFrames * VIDEO_STREAM_CONFIG.publishTimeout / VIDEO_STREAM_CONFIG.maxPendingFrames,
        quality,
        timestamp: new Date().toISOString(),
      });
    }, VIDEO_STREAM_CONFIG.statsInterval);

    // Cancellation check interval
    this.cancellationCheckInterval = setInterval(async () => {
      if (!this.isStreaming || this.isStopped) {
        return;
      }

      try {
        await checkTestCancelled(this.testId);
      } catch {
        // Test was cancelled
        logger.info('[VIDEO_STREAM] Test cancelled, stopping stream', { testId: this.testId });
        await this.stop('cancelled');
      }
    }, VIDEO_STREAM_CONFIG.cancellationCheckInterval);

    // Heartbeat interval - detect stale streams
    this.heartbeatInterval = setInterval(() => {
      if (!this.isStreaming || this.isStopped) {
        return;
      }

      const now = Date.now();
      const timeSinceLastFrame = now - this.lastFrameTime;

      // If no frames for 30 seconds and we're supposed to be streaming
      if (this.lastFrameTime > 0 && timeSinceLastFrame > VIDEO_STREAM_CONFIG.heartbeatInterval) {
        logger.warn('[VIDEO_STREAM] No frames received, stream may be stale', {
          testId: this.testId,
          timeSinceLastFrame,
          framesEmitted: this.framesEmitted,
        });

        // Check if CDP session is still valid
        if (this.cdpSession && !this.cdpSessionClosed) {
          this.cdpSession.send('Runtime.evaluate', { expression: '1+1' })
            .catch(() => {
              logger.info('[VIDEO_STREAM] CDP session check failed, stopping stream', {
                testId: this.testId,
              });
              this.cdpSessionClosed = true;
              this.stop('error').catch(() => {});
            });
        }
      }
    }, VIDEO_STREAM_CONFIG.heartbeatInterval);

    // Lock renewal interval - for long-running tests
    if (this.redis) {
      this.lockRenewalInterval = setInterval(async () => {
        if (!this.isStreaming || this.isStopped || !this.redis) {
          return;
        }

        try {
          const lockKey = `stream:lock:${this.testId}`;
          const currentValue = await this.redis.get(lockKey);

          // Only renew if we still own the lock
          if (currentValue === this.lockValue) {
            await this.redis.expire(lockKey, VIDEO_STREAM_CONFIG.lockTTL);
            logger.debug('[VIDEO_STREAM] Lock renewed', {
              testId: this.testId,
              ttl: VIDEO_STREAM_CONFIG.lockTTL,
            });
          } else {
            // Lock was taken by another process
            logger.warn('[VIDEO_STREAM] Lost lock ownership, stopping stream', {
              testId: this.testId,
              expectedValue: this.lockValue,
              actualValue: currentValue,
            });
            await this.stop('error');
          }
        } catch (error) {
          logger.warn('[VIDEO_STREAM] Failed to renew lock', {
            testId: this.testId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }, VIDEO_STREAM_CONFIG.lockRenewalInterval);
    }
  }

  /**
   * Stop monitoring intervals
   */
  private stopMonitoring(): void {
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    if (this.cancellationCheckInterval) {
      clearInterval(this.cancellationCheckInterval);
      this.cancellationCheckInterval = null;
    }

    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    if (this.lockRenewalInterval) {
      clearInterval(this.lockRenewalInterval);
      this.lockRenewalInterval = null;
    }
  }

  /**
   * Calculate current FPS based on recent frame timestamps
   */
  private calculateFPS(): number {
    if (this.frameTimestamps.length < 2) {
      return 0;
    }

    const oldest = this.frameTimestamps[0];
    const newest = this.frameTimestamps[this.frameTimestamps.length - 1];
    const duration = (newest - oldest) / 1000; // seconds

    if (duration <= 0) {
      return 0;
    }

    return Math.round((this.frameTimestamps.length - 1) / duration);
  }

  /**
   * Cleanup resources with timeout protection
   */
  private async cleanup(): Promise<void> {
    // Wrap cleanup in timeout to prevent hanging
    const cleanupWithTimeout = async (): Promise<void> => {
      // Remove page close listener
      if (this.page && this.pageCloseHandler) {
        try {
          this.page.off('close', this.pageCloseHandler);
        } catch {
          // Ignore
        }
        this.pageCloseHandler = null;
      }

      // Remove CDP listener
      if (this.cdpSession && this.frameHandler) {
        try {
          this.cdpSession.off('Page.screencastFrame', this.frameHandler);
        } catch {
          // Ignore
        }
        this.frameHandler = null;
      }

      // Detach CDP session
      if (this.cdpSession) {
        try {
          if (!this.cdpSessionClosed) {
            await this.cdpSession.detach();
          }
        } catch {
          // Ignore - session might already be closed
        }
        this.cdpSession = null;
      }

      // Release Redis lock and cleanup
      if (this.redis) {
        try {
          // Only delete lock if we own it
          const lockKey = `stream:lock:${this.testId}`;
          const currentValue = await this.redis.get(lockKey);
          if (currentValue === this.lockValue) {
            await this.redis.del(lockKey);
          }

          // Cleanup catchup buffer
          const catchupKey = `stream:catchup:${this.testId}`;
          await this.redis.del(catchupKey);

          await this.redis.quit();
        } catch {
          // Force disconnect if quit fails
          try {
            this.redis.disconnect();
          } catch {
            // Ignore
          }
        }
        this.redis = null;
        this.redisConnected = false;
      }

      // Clear page reference
      this.page = null;
    };

    try {
      await Promise.race([
        cleanupWithTimeout(),
        new Promise<void>((resolve) => {
          setTimeout(() => {
            logger.warn('[VIDEO_STREAM] Cleanup timeout exceeded, forcing cleanup', {
              testId: this.testId,
              sessionId: this.sessionId,
            });
            resolve();
          }, VIDEO_STREAM_CONFIG.cleanupTimeout);
        }),
      ]);
    } catch (error) {
      logger.warn('[VIDEO_STREAM] Error during cleanup', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    logger.debug('[VIDEO_STREAM] Cleanup completed', {
      testId: this.testId,
      sessionId: this.sessionId,
    });
  }

  /**
   * Get streaming status
   */
  isActive(): boolean {
    return this.isStreaming && !this.isStopped;
  }

  /**
   * Get session ID
   */
  getSessionId(): string {
    return this.sessionId;
  }

  /**
   * Get test ID
   */
  getTestId(): string {
    return this.testId;
  }
}

// Export factory function
export function createVideoStreamService(): VideoStreamService {
  return new VideoStreamService();
}
