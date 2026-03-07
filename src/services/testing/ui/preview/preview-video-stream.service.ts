/**
 * Preview Video Stream Service
 * Manages real-time video streaming for preview sessions via CDP screencast
 *
 * Features:
 * - CDP screencast frame capture (1280x720, JPEG quality 60)
 * - Throttling to ~10 FPS
 * - No Redis dependency (direct Socket.IO emit)
 * - Backpressure handling
 * - Automatic cleanup on session end
 */

import { logger } from '@/utils/core/logger';
import { CDPSession, Page } from 'playwright';
import type { Namespace } from 'socket.io';
import type { PreviewVideoFramePayload } from '@/websocket/types/types';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PREVIEW_VIDEO_CONFIG = {
  // CDP Screencast settings
  fps: 10,
  maxWidth: 1280,
  maxHeight: 720,
  quality: 60,
  format: 'jpeg' as const,

  // Throttle settings (target ~10 fps = 100ms between frames)
  minFrameIntervalMs: 90, // Slightly less than 100ms to account for processing

  // Backpressure handling
  maxPendingFrames: 3,
  publishTimeoutMs: 200,
  circuitBreakerThreshold: 5,
  circuitBreakerResetMs: 3000,

  // Safety limits
  maxFrameSizeBytes: 3 * 1024 * 1024, // 3MB safety cap (no 900KB limit per plan)

  // Monitoring
  statsIntervalMs: 10000,
};

// ============================================================================
// PREVIEW VIDEO STREAM SERVICE
// ============================================================================

/**
 * Manages video streaming for a single preview session
 * Emits directly to Socket.IO room (no Redis)
 */
export class PreviewVideoStreamService {
  private cdpSession: CDPSession | null = null;
  private isStreaming = false;
  private isStopped = false;
  private previewSessionId: string;
  private userId: string;
  private room: string;

  // Socket.IO namespace for direct emit
  private nsp: Namespace | null = null;

  // Frame tracking (seq starts at 0 or inherits from previous stream on page switch)
  private seq = 0;
  private lastFrameTime = 0;
  private pendingFrames = 0;
  private currentDomVersion = 1;

  // Metrics
  private framesEmitted = 0;
  private framesDropped = 0;
  private frameTimestamps: number[] = [];

  // Circuit breaker
  private consecutiveFailures = 0;
  private isPaused = false;

  // CDP state
  private cdpSessionClosed = false;
  private frameHandler: ((params: any) => void) | null = null;
  private page: Page | null = null;
  private pageCloseHandler: (() => void) | null = null;
  private pageLoadHandler: (() => void) | null = null;

  // Stats interval
  private statsInterval: NodeJS.Timeout | null = null;

  constructor(previewSessionId: string, userId: string, room: string, initialSeq?: number) {
    this.previewSessionId = previewSessionId;
    this.userId = userId;
    this.room = room;
    if (initialSeq !== undefined) {
      this.seq = initialSeq;
    }
  }

  /** Get current seq value (for passing to replacement stream on page switch) */
  getSeq(): number {
    return this.seq;
  }

  /**
   * Start video streaming for a page
   */
  async start(page: Page, nsp: Namespace): Promise<boolean> {
    if (this.isStreaming || this.isStopped) {
      return false;
    }

    this.page = page;
    this.nsp = nsp;

    try {
      // Setup page close handler
      this.pageCloseHandler = () => {
        logger.debug('[PREVIEW_VIDEO] Page closed, stopping stream', {
          previewSessionId: this.previewSessionId,
        });
        this.cdpSessionClosed = true;
        this.stop().catch(() => {});
      };
      page.once('close', this.pageCloseHandler);

      // V11: After same-page navigation, CDP screencast may lag or emit stale frames.
      // Inject a fresh screenshot-based frame after the page finishes loading.
      this.pageLoadHandler = () => {
        // Small delay to let the paint settle after load
        setTimeout(() => {
          if (this.isStreaming && !this.isStopped && !this.cdpSessionClosed) {
            this.injectFrame().catch(() => {});
          }
        }, 300);
      };
      page.on('load', this.pageLoadHandler);

      // Create CDP session
      const context = page.context();
      this.cdpSession = await context.newCDPSession(page);

      // Setup frame handler
      this.frameHandler = this.handleScreencastFrame.bind(this);
      this.cdpSession.on('Page.screencastFrame', this.frameHandler);

      // Start screencast
      await this.cdpSession.send('Page.startScreencast', {
        format: PREVIEW_VIDEO_CONFIG.format,
        quality: PREVIEW_VIDEO_CONFIG.quality,
        maxWidth: PREVIEW_VIDEO_CONFIG.maxWidth,
        maxHeight: PREVIEW_VIDEO_CONFIG.maxHeight,
        everyNthFrame: 1,
      });

      this.isStreaming = true;

      // Start stats monitoring
      this.startStatsInterval();

      logger.info('[PREVIEW_VIDEO] Started streaming', {
        previewSessionId: this.previewSessionId,
        room: this.room,
        fps: PREVIEW_VIDEO_CONFIG.fps,
        quality: PREVIEW_VIDEO_CONFIG.quality,
        resolution: `${PREVIEW_VIDEO_CONFIG.maxWidth}x${PREVIEW_VIDEO_CONFIG.maxHeight}`,
      });

      // V11: Inject an immediate screenshot frame after start.
      // CDP screencast may not emit frames on already-loaded/static pages,
      // so we guarantee at least one frame reaches the frontend.
      setTimeout(() => {
        if (this.isStreaming && !this.isStopped && !this.cdpSessionClosed) {
          this.injectFrame().catch(() => {});
        }
      }, 500);

      return true;
    } catch (error) {
      logger.warn('[PREVIEW_VIDEO] Failed to start streaming', {
        previewSessionId: this.previewSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.cleanup();
      return false;
    }
  }

  /**
   * Stop video streaming
   */
  async stop(): Promise<void> {
    if (this.isStopped) {
      return;
    }

    this.isStopped = true;
    this.isStreaming = false;

    logger.info('[PREVIEW_VIDEO] Stopping streaming', {
      previewSessionId: this.previewSessionId,
      framesEmitted: this.framesEmitted,
      framesDropped: this.framesDropped,
    });

    // Stop CDP screencast
    if (this.cdpSession && !this.cdpSessionClosed) {
      try {
        await this.cdpSession.send('Page.stopScreencast');
      } catch (error) {
        logger.debug('[PREVIEW_VIDEO] Error stopping screencast (may already be closed)', {
          previewSessionId: this.previewSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    await this.cleanup();
  }

  /**
   * Update current DOM version (called when DOM changes)
   */
  setDomVersion(version: number): void {
    this.currentDomVersion = version;
  }

  /**
   * Handle incoming screencast frame from CDP
   */
  private async handleScreencastFrame(params: {
    data: string;
    metadata: {
      offsetTop: number;
      pageScaleFactor: number;
      deviceWidth: number;
      deviceHeight: number;
      scrollOffsetX: number;
      scrollOffsetY: number;
      timestamp?: number;
    };
    sessionId: number;
  }): Promise<void> {
    // Early exit checks
    if (!this.isStreaming || this.isStopped || this.cdpSessionClosed) {
      return;
    }

    const now = Date.now();

    // Always ACK the frame to keep CDP happy
    if (this.cdpSession && !this.cdpSessionClosed) {
      try {
        await this.cdpSession.send('Page.screencastFrameAck', { sessionId: params.sessionId });
      } catch (ackError) {
        if (ackError instanceof Error &&
            (ackError.message.includes('Target closed') ||
             ackError.message.includes('Session closed') ||
             ackError.message.includes('Protocol error'))) {
          this.cdpSessionClosed = true;
          this.stop().catch(() => {});
          return;
        }
      }
    }

    // Throttle to ~10 FPS
    if (now - this.lastFrameTime < PREVIEW_VIDEO_CONFIG.minFrameIntervalMs) {
      return; // Skip frame (not counted as drop, just throttled)
    }

    // Check frame size (safety cap)
    const frameSize = params.data.length;
    if (frameSize > PREVIEW_VIDEO_CONFIG.maxFrameSizeBytes) {
      this.framesDropped++;
      logger.debug('[PREVIEW_VIDEO] Dropping oversized frame', {
        previewSessionId: this.previewSessionId,
        frameSize,
        maxSize: PREVIEW_VIDEO_CONFIG.maxFrameSizeBytes,
      });
      return;
    }

    // Check backpressure
    if (this.pendingFrames >= PREVIEW_VIDEO_CONFIG.maxPendingFrames) {
      this.framesDropped++;
      return;
    }

    // Check circuit breaker
    if (this.isPaused) {
      this.framesDropped++;
      return;
    }

    // Emit frame
    this.seq++;
    this.pendingFrames++;
    this.frameTimestamps.push(now);

    // Keep only last 30 timestamps for FPS calculation
    if (this.frameTimestamps.length > 30) {
      this.frameTimestamps.shift();
    }

    try {
      await this.emitFrame(params.data, params.metadata.deviceWidth, params.metadata.deviceHeight);

      // Success - reset circuit breaker
      this.consecutiveFailures = 0;
      this.framesEmitted++;
      this.lastFrameTime = now;

      // Resume if was paused
      if (this.isPaused) {
        this.isPaused = false;
        logger.debug('[PREVIEW_VIDEO] Resumed after circuit breaker reset', {
          previewSessionId: this.previewSessionId,
        });
      }
    } catch (error) {
      // Failure - increment circuit breaker
      this.consecutiveFailures++;
      this.framesDropped++;

      if (this.consecutiveFailures >= PREVIEW_VIDEO_CONFIG.circuitBreakerThreshold && !this.isPaused) {
        this.isPaused = true;
        logger.warn('[PREVIEW_VIDEO] Circuit breaker triggered', {
          previewSessionId: this.previewSessionId,
          consecutiveFailures: this.consecutiveFailures,
        });

        // Auto-reset after timeout
        setTimeout(() => {
          if (this.isStreaming && !this.isStopped) {
            this.isPaused = false;
            this.consecutiveFailures = 0;
          }
        }, PREVIEW_VIDEO_CONFIG.circuitBreakerResetMs);
      }
    } finally {
      this.pendingFrames--;
    }
  }

  /**
   * Emit frame to Socket.IO room (no Redis)
   */
  private async emitFrame(data: string, width: number, height: number): Promise<void> {
    if (!this.nsp) {
      throw new Error('Socket.IO namespace not available');
    }

    const payload: PreviewVideoFramePayload = {
      previewSessionId: this.previewSessionId,
      seq: this.seq,
      format: 'jpeg',
      data,
      width: Math.min(width, PREVIEW_VIDEO_CONFIG.maxWidth),
      height: Math.min(height, PREVIEW_VIDEO_CONFIG.maxHeight),
      domVersion: this.currentDomVersion,
      timestamp: new Date().toISOString(),
    };

    // Emit with timeout to handle slow consumers
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Emit timeout'));
      }, PREVIEW_VIDEO_CONFIG.publishTimeoutMs);

      try {
        this.nsp!.to(this.room).emit('preview:video:frame', payload);
        clearTimeout(timeout);
        resolve();
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
      }
    });
  }

  /**
   * Start stats monitoring interval
   */
  private startStatsInterval(): void {
    this.statsInterval = setInterval(() => {
      if (!this.isStreaming || this.isStopped) {
        return;
      }

      const currentFPS = this.calculateFPS();
      const totalFrames = this.framesEmitted + this.framesDropped;
      const dropRate = totalFrames > 0 ? this.framesDropped / totalFrames : 0;

      // Log warning if drop rate is high
      if (dropRate > 0.3) {
        logger.warn('[PREVIEW_VIDEO] High frame drop rate', {
          previewSessionId: this.previewSessionId,
          dropRate: `${(dropRate * 100).toFixed(1)}%`,
          framesDropped: this.framesDropped,
          framesEmitted: this.framesEmitted,
          currentFPS,
        });
      }

      logger.debug('[PREVIEW_VIDEO] Stats', {
        previewSessionId: this.previewSessionId,
        currentFPS,
        framesEmitted: this.framesEmitted,
        framesDropped: this.framesDropped,
      });
    }, PREVIEW_VIDEO_CONFIG.statsIntervalMs);
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
    const duration = (newest - oldest) / 1000;

    if (duration <= 0) {
      return 0;
    }

    return Math.round((this.frameTimestamps.length - 1) / duration);
  }

  /**
   * Cleanup resources
   */
  private async cleanup(): Promise<void> {
    // Clear stats interval
    if (this.statsInterval) {
      clearInterval(this.statsInterval);
      this.statsInterval = null;
    }

    // Remove page close listener
    if (this.page && this.pageCloseHandler) {
      try {
        this.page.off('close', this.pageCloseHandler);
      } catch {
        // Ignore
      }
      this.pageCloseHandler = null;
    }

    // Remove page load listener
    if (this.page && this.pageLoadHandler) {
      try {
        this.page.off('load', this.pageLoadHandler);
      } catch {
        // Ignore
      }
      this.pageLoadHandler = null;
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

    // Clear references
    this.page = null;
    this.nsp = null;

    logger.debug('[PREVIEW_VIDEO] Cleanup completed', {
      previewSessionId: this.previewSessionId,
    });
  }

  /**
   * Inject a manual screenshot frame into the video stream.
   * Used after page reload/navigation when CDP screencast may lag behind.
   */
  async injectFrame(): Promise<boolean> {
    if (!this.isStreaming || this.isStopped || !this.page || !this.nsp) {
      return false;
    }

    try {
      const buf = await this.page.screenshot({
        type: 'jpeg',
        quality: PREVIEW_VIDEO_CONFIG.quality,
      });
      const base64 = buf.toString('base64');

      this.seq++;
      this.framesEmitted++;
      this.lastFrameTime = Date.now();
      this.frameTimestamps.push(this.lastFrameTime);
      if (this.frameTimestamps.length > 30) {
        this.frameTimestamps.shift();
      }

      const payload: PreviewVideoFramePayload = {
        previewSessionId: this.previewSessionId,
        seq: this.seq,
        format: 'jpeg',
        data: base64,
        width: PREVIEW_VIDEO_CONFIG.maxWidth,
        height: PREVIEW_VIDEO_CONFIG.maxHeight,
        domVersion: this.currentDomVersion,
        timestamp: new Date().toISOString(),
      };

      this.nsp.to(this.room).emit('preview:video:frame', payload);

      logger.debug('[PREVIEW_VIDEO] Injected manual frame after navigation', {
        previewSessionId: this.previewSessionId,
        seq: this.seq,
      });

      return true;
    } catch (error) {
      logger.debug('[PREVIEW_VIDEO] Failed to inject frame', {
        previewSessionId: this.previewSessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if stream is active
   */
  isActive(): boolean {
    return this.isStreaming && !this.isStopped;
  }

  /**
   * Get session ID
   */
  getPreviewSessionId(): string {
    return this.previewSessionId;
  }
}

// ============================================================================
// STREAM REGISTRY
// ============================================================================

/**
 * Registry to manage active preview video streams
 */
export class PreviewVideoStreamRegistry {
  private static instance: PreviewVideoStreamRegistry;
  private streams = new Map<string, PreviewVideoStreamService>();

  private constructor() {}

  static getInstance(): PreviewVideoStreamRegistry {
    if (!PreviewVideoStreamRegistry.instance) {
      PreviewVideoStreamRegistry.instance = new PreviewVideoStreamRegistry();
    }
    return PreviewVideoStreamRegistry.instance;
  }

  /**
   * Start video stream for a preview session
   */
  async startStream(
    previewSessionId: string,
    userId: string,
    room: string,
    page: Page,
    nsp: Namespace
  ): Promise<boolean> {
    // Capture seq from old stream before stopping (for continuity on page switch)
    const oldStream = this.streams.get(previewSessionId);
    const inheritedSeq = oldStream ? oldStream.getSeq() : undefined;

    // Stop existing stream if any
    await this.stopStream(previewSessionId);

    const stream = new PreviewVideoStreamService(previewSessionId, userId, room, inheritedSeq);

    if (inheritedSeq !== undefined) {
      logger.info('[PREVIEW_VIDEO] Stream restart with inherited seq', {
        previewSessionId,
        inheritedSeq,
      });
    }

    const started = await stream.start(page, nsp);

    if (started) {
      this.streams.set(previewSessionId, stream);
    }

    return started;
  }

  /**
   * Stop video stream for a preview session
   */
  async stopStream(previewSessionId: string): Promise<void> {
    const stream = this.streams.get(previewSessionId);
    if (stream) {
      await stream.stop();
      this.streams.delete(previewSessionId);
    }
  }

  /**
   * Update DOM version for a stream
   */
  setDomVersion(previewSessionId: string, version: number): void {
    const stream = this.streams.get(previewSessionId);
    if (stream) {
      stream.setDomVersion(version);
    }
  }

  /**
   * Get active stream
   */
  getStream(previewSessionId: string): PreviewVideoStreamService | undefined {
    return this.streams.get(previewSessionId);
  }

  /**
   * Inject a manual screenshot frame for a preview session
   */
  async injectFrame(previewSessionId: string): Promise<boolean> {
    const stream = this.streams.get(previewSessionId);
    if (stream) {
      return stream.injectFrame();
    }
    return false;
  }

  /**
   * Check if stream exists
   */
  hasStream(previewSessionId: string): boolean {
    return this.streams.has(previewSessionId);
  }

  /**
   * Get count of active streams
   */
  getStreamCount(): number {
    return this.streams.size;
  }

  /**
   * Stop all streams (for shutdown)
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.streams.keys()).map((id) => this.stopStream(id));
    await Promise.all(stopPromises);
  }
}

// Export singleton getter
export const getPreviewVideoStreamRegistry = () => PreviewVideoStreamRegistry.getInstance();
