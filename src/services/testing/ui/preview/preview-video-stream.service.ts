/**
 * Preview Video Stream Service
 * Manages real-time video streaming for preview sessions via CDP screencast
 *
 * Features:
 * - CDP screencast frame capture (1280x720, JPEG quality 65)
 * - V20: Throttling to ~30 FPS (was ~15) — possible after binary transport removed
 *   the +33% base64 inflation, leaving bandwidth headroom for higher framerate.
 * - V20: Binary frame transport (Socket.IO 4.x native binary, not base64)
 * - No Redis dependency (direct Socket.IO emit)
 * - Backpressure handling + circuit breaker (auto-fallback if subscribers lag)
 * - Automatic cleanup on session end
 */

import { logger } from '@/utils/core/logger';
import { CDPSession, Page } from 'playwright';
import type { Namespace } from 'socket.io';
import type { PreviewVideoFramePayload } from '@/websocket/types/types';
import { PREVIEW_SESSION_CONFIG } from '@/config/testing/playwright-tuning';

// ============================================================================
// CONFIGURATION
// ============================================================================

const PREVIEW_VIDEO_CONFIG = {
  // CDP Screencast settings
  fps: 30,
  maxWidth: PREVIEW_SESSION_CONFIG.viewport.width,
  maxHeight: PREVIEW_SESSION_CONFIG.viewport.height,
  quality: PREVIEW_SESSION_CONFIG.screenshot.quality,
  format: 'jpeg' as const,

  // Throttle settings.
  // V20: 33ms ≈ 30fps cap (was 65ms ≈ 15fps). After binary transport removed the +33%
  // base64 inflation, we have headroom to double the framerate. Backpressure + circuit
  // breaker (below) auto-fall back to slower rates if subscribers can't keep up.
  minFrameIntervalMs: 33,

  // Backpressure handling
  maxPendingFrames: 4,
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
  private circuitBreakerResetTimeout: NodeJS.Timeout | null = null;

  // CDP state
  private cdpSessionClosed = false;
  private frameHandler: ((params: any) => void) | null = null;
  private page: Page | null = null;
  private pageCloseHandler: (() => void) | null = null;
  private pageLoadHandler: (() => void) | null = null;
  private pageFrameNavigatedHandler: ((frame: unknown) => void) | null = null;

  // Deferred frame injection timers (cleared on stop to prevent orphan execution).
  // pageLoadInjectTimer: single slot, replaced on each SPA navigation (not accumulated).
  // initialInjectTimer: one-shot, fired once after start().
  private pageLoadInjectTimer: NodeJS.Timeout | null = null;
  private initialInjectTimer: NodeJS.Timeout | null = null;

  // V13: Hardened first-frame guarantee.
  // After start() (or any main-frame navigation that wipes the screencast
  // pipeline) we MUST get at least one frame to the client — CDP screencast
  // does not emit on statically-rendered pages without paint/damage events,
  // so we cannot rely on it. ensureFirstFrame() retries injectFrame() with
  // backoff until either (a) one of our injects succeeds, or (b) a real CDP
  // frame arrives, or (c) the stream is stopped.
  private gotFirstFrame = false;
  private ensureFirstFrameTimer: NodeJS.Timeout | null = null;
  private ensureFirstFrameAttempts = 0;
  // Last main-frame URL we issued a guarantee for. Used to distinguish "real"
  // navigations (worth re-arming the guarantee) from spurious framenavigated
  // events (sub-frames, hash-only changes, repeated fires).
  private lastGuaranteedUrl: string | null = null;

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
        // Clear previous page-load timer (SPA fires 'load' on each navigation)
        if (this.pageLoadInjectTimer) {
          clearTimeout(this.pageLoadInjectTimer);
        }
        // Small delay to let the paint settle after load
        this.pageLoadInjectTimer = setTimeout(() => {
          this.pageLoadInjectTimer = null;
          if (this.isStreaming && !this.isStopped && !this.cdpSessionClosed) {
            this.injectFrame().catch(() => {});
          }
        }, 300);
      };
      page.on('load', this.pageLoadHandler);

      // V13: Also listen for framenavigated, but ONLY for main-frame
      // transitions to a new URL. Why:
      //   • `load` only fires on a fresh full navigation. If the page was
      //     already loaded by the time we attached our listener (exactly what
      //     happens on session reset — resetSession awaits goto() before
      //     re-starting the stream), `load` will never fire again until the
      //     user navigates.
      //   • framenavigated wakes us up on SPA / pushState transitions where
      //     `load` does not fire.
      //   • Filtering out sub-frames (iframes, ads) and same-URL re-fires
      //     prevents re-arming a healthy stream and duplicating screenshots.
      this.pageFrameNavigatedHandler = ((frame: { parentFrame: () => unknown | null; url: () => string }) => {
        if (!this.isStreaming || this.isStopped || this.cdpSessionClosed) return;
        // Sub-frame navigations — ignore.
        if (frame && typeof frame.parentFrame === 'function' && frame.parentFrame() !== null) return;
        // Same URL as the last guarantee — ignore (avoids dup work and broken seq).
        let frameUrl: string | null = null;
        try { frameUrl = typeof frame.url === 'function' ? frame.url() : null; } catch { frameUrl = null; }
        if (frameUrl && frameUrl === this.lastGuaranteedUrl) return;
        // Real main-frame nav to a new URL — re-arm the first-frame guarantee.
        this.gotFirstFrame = false;
        this.ensureFirstFrameAttempts = 0;
        this.lastGuaranteedUrl = frameUrl;
        this.scheduleFirstFrameAttempt(0);
      }) as (frame: unknown) => void;
      page.on('framenavigated', this.pageFrameNavigatedHandler as (frame: unknown) => void);

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

      // V13: Seed lastGuaranteedUrl with the page's current URL so the
      // immediately-following framenavigated event for THIS same URL does not
      // re-arm the guarantee. We only want main-frame nav to a NEW URL to
      // re-arm.
      try { this.lastGuaranteedUrl = page.url(); } catch { this.lastGuaranteedUrl = null; }

      // V13: Hardened first-frame guarantee.
      // CDP screencast does NOT emit frames on already-loaded / statically-rendered
      // pages — it requires a paint/damage event. Sites that finish rendering
      // before our screencast subscription will sit silent forever waiting for
      // user interaction. The pre-V13 code had a single 500 ms `injectFrame()`
      // attempt with a silent catch, so any transient failure (page in
      // navigation, screenshot busy, frame size cap) meant the entire stream
      // appeared dead until the user clicked.
      //
      // V13 fix: kick off ensureFirstFrame() which retries injectFrame() with
      // backoff (immediate, 250ms, 500ms, 900ms, 1800ms) until either the
      // inject succeeds OR a real CDP screencast frame arrives. The flag is
      // also re-armed on framenavigated, so navigations during the stream's
      // lifetime are covered too.
      this.scheduleFirstFrameAttempt(150);

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

    // V20: Decode base64 → binary bytes once on the backend (~1-2ms per frame).
    // Saves ~33% bandwidth vs sending base64 over the wire AND avoids the
    // ~5-15ms main-thread base64 decode on the frontend.
    let frameBuffer: Buffer;
    try {
      frameBuffer = Buffer.from(params.data, 'base64');
    } catch (decodeError) {
      this.framesDropped++;
      logger.debug('[PREVIEW_VIDEO] Failed to decode CDP base64 frame', {
        previewSessionId: this.previewSessionId,
        error: decodeError instanceof Error ? decodeError.message : String(decodeError),
      });
      return;
    }

    // Check frame size (safety cap) — measured on actual binary bytes, not base64 chars.
    // Note: previously this used params.data.length (base64 char count), which over-counted by ~33%.
    const frameSize = frameBuffer.byteLength;
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
      await this.emitFrame(frameBuffer, params.metadata.deviceWidth, params.metadata.deviceHeight);

      // Success - reset circuit breaker
      this.consecutiveFailures = 0;
      this.framesEmitted++;
      this.lastFrameTime = now;

      // V13: First real CDP frame arrived — first-frame guarantee satisfied.
      // Cancel any pending inject retry to avoid duplicate work / wasted screenshots.
      if (!this.gotFirstFrame) {
        this.gotFirstFrame = true;
        if (this.ensureFirstFrameTimer) {
          clearTimeout(this.ensureFirstFrameTimer);
          this.ensureFirstFrameTimer = null;
        }
      }

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

        // Auto-reset after timeout (clear previous to avoid stacking)
        if (this.circuitBreakerResetTimeout) {
          clearTimeout(this.circuitBreakerResetTimeout);
        }
        this.circuitBreakerResetTimeout = setTimeout(() => {
          this.circuitBreakerResetTimeout = null;
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
   * Emit frame to Socket.IO room (no Redis).
   * V20: Sends raw JPEG bytes as the second emit() argument. Socket.IO 4.x serializes
   * Buffer / ArrayBuffer / Uint8Array as native binary frames (no base64 inflation).
   * The meta object's `data` field is left empty for backward compat with old clients.
   */
  private async emitFrame(frame: Buffer, width: number, height: number): Promise<void> {
    if (!this.nsp) {
      throw new Error('Socket.IO namespace not available');
    }

    const payload: PreviewVideoFramePayload = {
      previewSessionId: this.previewSessionId,
      seq: this.seq,
      format: 'jpeg',
      data: '', // V20: empty — actual bytes sent as binary arg below
      width: Math.min(width, PREVIEW_VIDEO_CONFIG.maxWidth),
      height: Math.min(height, PREVIEW_VIDEO_CONFIG.maxHeight),
      domVersion: this.currentDomVersion,
      timestamp: new Date().toISOString(),
      byteLength: frame.byteLength,
    };

    // Emit with timeout to handle slow consumers
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Emit timeout'));
      }, PREVIEW_VIDEO_CONFIG.publishTimeoutMs);

      try {
        this.nsp!.to(this.room).emit('preview:video:frame', payload, frame);
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

    // Clear circuit breaker reset timeout
    if (this.circuitBreakerResetTimeout) {
      clearTimeout(this.circuitBreakerResetTimeout);
      this.circuitBreakerResetTimeout = null;
    }

    // Clear pending inject timers
    if (this.pageLoadInjectTimer) {
      clearTimeout(this.pageLoadInjectTimer);
      this.pageLoadInjectTimer = null;
    }
    if (this.initialInjectTimer) {
      clearTimeout(this.initialInjectTimer);
      this.initialInjectTimer = null;
    }
    // V13: Cancel any pending first-frame retry
    if (this.ensureFirstFrameTimer) {
      clearTimeout(this.ensureFirstFrameTimer);
      this.ensureFirstFrameTimer = null;
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

    // V13: Remove framenavigated listener
    if (this.page && this.pageFrameNavigatedHandler) {
      try {
        this.page.off('framenavigated', this.pageFrameNavigatedHandler);
      } catch {
        // Ignore
      }
      this.pageFrameNavigatedHandler = null;
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
   * V13: Public re-arm — used by external callers (refresh handler, SPA nav
   * hooks) to restart the first-frame guarantee on an existing live stream
   * after the underlying page repainted but CDP screencast hasn't caught up.
   *
   * Idempotent: safe to call repeatedly. If a real CDP frame arrives during
   * the retry chain, it cancels itself.
   */
  armFirstFrameGuarantee(): void {
    if (!this.isStreaming || this.isStopped || this.cdpSessionClosed) return;
    this.gotFirstFrame = false;
    this.ensureFirstFrameAttempts = 0;
    this.scheduleFirstFrameAttempt(0);
  }

  /**
   * V13: Schedule one attempt of the first-frame guarantee retry chain.
   *
   * Backoff schedule (cumulative): 0ms → 150ms → 400ms → 900ms → 1800ms.
   * After 5 unsuccessful attempts (~3.3s wall time) we stop and emit a warn
   * log instead of silently failing forever. Any real CDP screencast frame
   * arriving in the meantime will set `gotFirstFrame=true` and abort the
   * chain (see handleScreencastFrame).
   *
   * Re-armable: clearing `gotFirstFrame=false` and resetting `attempts=0`
   * allows the helper to be reused after navigations (see framenavigated
   * handler in start()).
   */
  private scheduleFirstFrameAttempt(delayMs: number): void {
    // Drop if we already satisfied the guarantee or the stream is dead.
    if (this.gotFirstFrame || !this.isStreaming || this.isStopped || this.cdpSessionClosed) {
      return;
    }
    // Replace any pending attempt so we don't double-schedule.
    if (this.ensureFirstFrameTimer) {
      clearTimeout(this.ensureFirstFrameTimer);
      this.ensureFirstFrameTimer = null;
    }
    this.ensureFirstFrameTimer = setTimeout(async () => {
      this.ensureFirstFrameTimer = null;
      if (this.gotFirstFrame || !this.isStreaming || this.isStopped || this.cdpSessionClosed) {
        return;
      }

      this.ensureFirstFrameAttempts++;
      const attemptNo = this.ensureFirstFrameAttempts;

      // Try the actual inject. injectFrame() returns true on success, false on
      // any failure (page closed, screenshot threw, frame too large, nsp gone).
      let ok = false;
      try {
        ok = await this.injectFrame();
      } catch (err) {
        // injectFrame already swallows internally, but defend against future changes.
        ok = false;
        logger.debug('[PREVIEW_VIDEO] First-frame attempt threw', {
          previewSessionId: this.previewSessionId,
          attempt: attemptNo,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if (ok) {
        this.gotFirstFrame = true;
        logger.debug('[PREVIEW_VIDEO] First frame guaranteed via inject', {
          previewSessionId: this.previewSessionId,
          attempts: attemptNo,
        });
        return;
      }

      // Schedule next attempt or give up loudly.
      // Schedule cumulative ladder: 150 → 400 → 900 → 1800 ms (relative to previous).
      const ladder = [250, 500, 900, 1800];
      const nextDelay = ladder[attemptNo - 1];
      if (nextDelay !== undefined) {
        this.scheduleFirstFrameAttempt(nextDelay);
      } else {
        // 5 attempts (initial + 4 retries) all failed AND CDP screencast also
        // hasn't emitted a frame. Surface this loudly — pre-V13 this was a
        // silent debug log, hiding exactly the bug we're trying to fix.
        logger.warn('[PREVIEW_VIDEO] First-frame guarantee exhausted — stream may appear blank until user interacts', {
          previewSessionId: this.previewSessionId,
          attempts: attemptNo,
        });
      }
    }, delayMs);
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

      // V13: TOCTOU re-check — between the screenshot await and the emit
      // below, stop()/cleanup() may have run on another microtask and nulled
      // out this.nsp. Without this guard the emit would NPE.
      if (!this.isStreaming || this.isStopped || !this.nsp) {
        return false;
      }

      this.seq++;
      this.framesEmitted++;
      this.lastFrameTime = Date.now();
      this.frameTimestamps.push(this.lastFrameTime);
      if (this.frameTimestamps.length > 30) {
        this.frameTimestamps.shift();
      }

      // V20: Send binary frame instead of base64 (saves 33% bandwidth)
      const payload: PreviewVideoFramePayload = {
        previewSessionId: this.previewSessionId,
        seq: this.seq,
        format: 'jpeg',
        data: '', // empty — bytes sent as binary arg
        width: PREVIEW_VIDEO_CONFIG.maxWidth,
        height: PREVIEW_VIDEO_CONFIG.maxHeight,
        domVersion: this.currentDomVersion,
        timestamp: new Date().toISOString(),
        byteLength: buf.byteLength,
      };

      this.nsp.to(this.room).emit('preview:video:frame', payload, buf);

      // V13: Any successful inject satisfies the first-frame guarantee.
      // Cancel pending retries so they don't fire after we've already delivered.
      if (!this.gotFirstFrame) {
        this.gotFirstFrame = true;
        if (this.ensureFirstFrameTimer) {
          clearTimeout(this.ensureFirstFrameTimer);
          this.ensureFirstFrameTimer = null;
        }
      }

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

  // Per-session mutex to prevent concurrent startStream() from creating orphaned CDP sessions.
  // Without this, two rapid page switches can race: both call stopStream() then create a new
  // stream, but only the last one gets registered — the first becomes a zombie with an open
  // CDP session that can never be cleaned up.
  private startLocks = new Map<string, Promise<boolean>>();

  private constructor() {}

  static getInstance(): PreviewVideoStreamRegistry {
    if (!PreviewVideoStreamRegistry.instance) {
      PreviewVideoStreamRegistry.instance = new PreviewVideoStreamRegistry();
    }
    return PreviewVideoStreamRegistry.instance;
  }

  /**
   * Start video stream for a preview session.
   * Uses a per-session promise chain (mutex) so concurrent calls for the same
   * previewSessionId are serialised — the second caller waits for the first to
   * finish before it stops-and-replaces, preventing orphaned CDP sessions.
   */
  async startStream(
    previewSessionId: string,
    userId: string,
    room: string,
    page: Page,
    nsp: Namespace
  ): Promise<boolean> {
    // Chain onto any in-flight start for this session (resolves immediately if none)
    const prev = this.startLocks.get(previewSessionId) ?? Promise.resolve(false);

    const next = prev
      // Swallow errors from the previous call so this one always runs
      .catch(() => false)
      .then(async () => {
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
      });

    this.startLocks.set(previewSessionId, next);

    try {
      return await next;
    } finally {
      // Clean up lock entry if it's still ours (no newer call queued)
      if (this.startLocks.get(previewSessionId) === next) {
        this.startLocks.delete(previewSessionId);
      }
    }
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
   * V13: Re-arm the first-frame guarantee for an existing stream.
   * Use after page reload / refresh / SPA navigation when the existing CDP
   * screencast may emit no frames until something repaints. Idempotent and
   * cheap if a real frame arrives in the meantime — the helper internally
   * cancels its retry chain on the first successful frame.
   */
  armFirstFrameGuarantee(previewSessionId: string): void {
    const stream = this.streams.get(previewSessionId);
    if (stream) {
      stream.armFirstFrameGuarantee();
    }
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
    this.startLocks.clear();
  }
}

// Export singleton getter
export const getPreviewVideoStreamRegistry = () => PreviewVideoStreamRegistry.getInstance();
