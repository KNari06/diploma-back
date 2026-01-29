/**
 * Preview Session Service
 * Manages server-side browser preview sessions for step editor
 * 1 session per user with TTL auto-cleanup
 */

import { SnapshotCollector } from '@/agent/core/lite/collectors/snapshot-collector';
import { logger } from '@/utils/core/logger';
import { sanitizeUrl } from '@/utils/validation/validation';
import { randomUUID } from 'crypto';
import { Browser, BrowserContext, Page, chromium } from 'playwright';
import { DomAnalysisExtractorService } from './dom-analysis-extractor.service';
import type { InteractiveNode, PreviewSession } from './preview.types';

// Configuration (balanced limits to avoid OOM)
const SESSION_TTL_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_CLEANUP_INTERVAL_MS = 60 * 1000; // Check every minute
const SNAPSHOT_THROTTLE_MS = 500; // Min time between snapshot emissions
const MAX_SESSIONS = 20; // Safety limit (balanced: ~2-4GB RAM max)

// Screenshot configuration
const SCREENSHOT_CONFIG = {
  quality: 60,           // JPEG quality (0-100)
  maxSizeBytes: 900_000, // Skip if larger than 900KB
  throttleMs: 500,       // Min time between screenshot emissions per session
};

// Input throttle (anti-flood for mouse/keyboard events)
const INPUT_THROTTLE_MS = 50; // Min 50ms between input events (20 events/sec max)

/**
 * Sanitize Playwright close errors.
 * Playwright sometimes appends huge Chromium "Browser logs" to the error message.
 * Those logs are rarely actionable for our backend cleanup logic and can spam logs.
 */
function formatPlaywrightCloseError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const withoutBrowserLogs = raw.split('\nBrowser logs:\n')[0] || raw;
  const singleLine = withoutBrowserLogs.replace(/\s+/g, ' ').trim();
  // Cap to keep logs readable
  return singleLine.length > 300 ? `${singleLine.slice(0, 300)}…` : singleLine;
}

/**
 * Heuristic: close errors that commonly happen when the page/context/browser
 * is already closed (benign during cleanup).
 */
function isBenignAlreadyClosedError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return /Target page, context or browser has been closed/i.test(msg);
}

/**
 * Internal session state (extends PreviewSession with Playwright objects)
 */
interface InternalSession extends PreviewSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  lastSnapshotEmit: number;
  lastScreenshotEmitAt: number;  // Last screenshot emission timestamp
  lastPageSignature: string;      // Hash for diff detection (url+domMetrics)
  lastInputAt: number;            // Input throttling timestamp
}

/**
 * Preview Session Manager
 * Singleton service that manages browser preview sessions
 */
export class PreviewSessionService {
  private static instance: PreviewSessionService;
  private sessions: Map<string, InternalSession> = new Map();
  private userToSession: Map<string, string> = new Map(); // userId -> sessionId
  private cleanupInterval: NodeJS.Timeout | null = null;
  // Per-user locks to prevent race conditions on concurrent start/stop
  private userLocks: Map<string, Promise<void>> = new Map();

  private constructor() {
    this.startCleanupInterval();
  }

  static getInstance(): PreviewSessionService {
    if (!PreviewSessionService.instance) {
      PreviewSessionService.instance = new PreviewSessionService();
    }
    return PreviewSessionService.instance;
  }

  /**
   * Acquire per-user lock to prevent race conditions
   * Returns a promise that resolves when the lock is acquired
   */
  private async acquireUserLock(userId: string): Promise<() => void> {
    // Wait for any existing operation to complete
    const existingLock = this.userLocks.get(userId);
    if (existingLock) {
      await existingLock.catch(() => { }); // Ignore errors from previous operation
    }

    // Create new lock promise
    let releaseLock: () => void = () => { };
    const lockPromise = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    this.userLocks.set(userId, lockPromise);

    // Return release function
    return () => {
      releaseLock();
      // Clean up lock after short delay to prevent immediate race
      setTimeout(() => {
        if (this.userLocks.get(userId) === lockPromise) {
          this.userLocks.delete(userId);
        }
      }, 100);
    };
  }

  /**
   * Helper to safely close browser resources
   * Guarantees cleanup even if errors occur
   */
  private async safeCloseBrowserResources(
    browser?: Browser,
    context?: BrowserContext,
    page?: Page
  ): Promise<void> {
    const closePromises: Promise<void>[] = [];

    if (page) {
      closePromises.push(page.close().catch((error) => {
        const level = isBenignAlreadyClosedError(error) ? 'debug' : 'warn';
        logger[level]('[PREVIEW_SESSION] Error closing page', {
          error: formatPlaywrightCloseError(error),
        });
      }));
    }

    if (context) {
      closePromises.push(context.close().catch((error) => {
        const level = isBenignAlreadyClosedError(error) ? 'debug' : 'warn';
        logger[level]('[PREVIEW_SESSION] Error closing context', {
          error: formatPlaywrightCloseError(error),
        });
      }));
    }

    if (browser) {
      closePromises.push(browser.close().catch((error) => {
        const level = isBenignAlreadyClosedError(error) ? 'debug' : 'warn';
        logger[level]('[PREVIEW_SESSION] Error closing browser', {
          error: formatPlaywrightCloseError(error),
        });
      }));
    }

    await Promise.all(closePromises);
  }

  /**
   * Start a new preview session for a user
   * Closes existing session if user already has one
   */
  async startSession(params: {
    userId: string;
    projectId: string;
    startUrl: string;
  }): Promise<{
    previewSessionId: string;
    url: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
  }> {
    const { userId, projectId, startUrl } = params;
    const safeStartUrl = sanitizeUrl(startUrl);

    // Acquire per-user lock to prevent race conditions
    const releaseLock = await this.acquireUserLock(userId);

    try {
      // Check session limit
      if (this.sessions.size >= MAX_SESSIONS) {
        throw new Error('Maximum preview sessions reached. Try again later.');
      }

      // Close existing session for this user (under lock)
      const existingSessionId = this.userToSession.get(userId);
      if (existingSessionId) {
        try {
          await this.stopSession(existingSessionId);
        } catch (stopError) {
          // Log but don't fail - we still want to create new session
          logger.warn('[PREVIEW_SESSION] Error stopping existing session, continuing', {
            userId,
            existingSessionId,
            error: stopError instanceof Error ? stopError.message : String(stopError),
          });
        }
      }

      logger.info('[PREVIEW_SESSION] Starting new session', { userId, projectId, startUrl: safeStartUrl });

      // Local variables for guaranteed cleanup
      let browser: Browser | undefined;
      let context: BrowserContext | undefined;
      let page: Page | undefined;

      try {
        // Launch browser
        browser = await chromium.launch({
          headless: true,
          args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        context = await browser.newContext({
          viewport: { width: 1280, height: 720 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        page = await context.newPage();

        // Navigate to start URL
        await page.goto(safeStartUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        });

        // Wait for network idle
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {
          // Ignore timeout - page might have long-polling
        });

        // Collect initial snapshot
        const snapshot = await SnapshotCollector.collect(page);
        const domAnalysis = DomAnalysisExtractorService.extract(snapshot);

        // Generate session ID
        const sessionId = `preview_${randomUUID()}`;

        // Create session
        const session: InternalSession = {
          id: sessionId,
          userId,
          projectId,
          startUrl: safeStartUrl,
          pageState: {
            url: page.url(),
            domNodes: domAnalysis.interactiveNodes,
          },
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          browser,
          context,
          page,
          lastSnapshotEmit: 0,
          lastScreenshotEmitAt: 0,
          lastPageSignature: '',
          lastInputAt: 0,
        };

        // Store session
        this.sessions.set(sessionId, session);
        this.userToSession.set(userId, sessionId);

        logger.info('[PREVIEW_SESSION] Session started', {
          sessionId,
          url: page.url(),
          nodeCount: domAnalysis.interactiveNodes.length,
        });

        return {
          previewSessionId: sessionId,
          url: page.url(),
          domNodes: domAnalysis.interactiveNodes,
        };
      } catch (error) {
        // CRITICAL: Cleanup browser resources if session creation failed
        // This prevents resource leaks when goto/snapshot fails
        logger.error('[PREVIEW_SESSION] Failed to start session, cleaning up resources', {
          userId,
          error: error instanceof Error ? error.message : String(error),
        });

        await this.safeCloseBrowserResources(browser, context, page);

        throw error;
      }
    } finally {
      // Always release the lock
      releaseLock();
    }
  }

  /**
   * Reset session (clear context/cookies/storage) and return to startUrl
   */
  async resetSession(params: {
    sessionId: string;
    userId: string;
  }): Promise<{
    url: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
  } | null> {
    const { sessionId, userId } = params;

    // Acquire lock using the session owner to avoid race conditions
    // (we must not swap context/page concurrently with other operations)
    const sessionBeforeLock = this.getAuthorizedSession(sessionId, userId);
    if (!sessionBeforeLock) return null;
    const ownerUserId = sessionBeforeLock.userId;

    const releaseLock = await this.acquireUserLock(ownerUserId);

    // Local vars to prevent leaks on partial failure
    let newContext: BrowserContext | undefined;
    let newPage: Page | undefined;

    try {
      // Re-fetch session under lock to ensure it still exists and is owned
      const session = this.getAuthorizedSession(sessionId, userId);
      if (!session) return null;

      logger.info('[PREVIEW_SESSION] Resetting session', { sessionId });

      const browser = session.browser;
      const startUrl = session.startUrl;

      // IMPORTANT: Do reset atomically.
      // 1) Create + load a fresh context/page successfully.
      // 2) Swap session references.
      // 3) Close old resources after swap.
      newContext = await browser.newContext({
        viewport: { width: 1280, height: 720 },
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      newPage = await newContext.newPage();

      await newPage.goto(startUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Best-effort: some apps keep long-polling, so avoid long waits
      await newPage.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      // Save old resources (close after swap)
      const oldContext = session.context;
      const oldPage = session.page;

      // Swap to new resources
      session.context = newContext;
      session.page = newPage;

      // Reset internal timers/state to avoid throttling weirdness after reset
      session.lastSnapshotEmit = 0;
      session.lastScreenshotEmitAt = 0;
      session.lastPageSignature = '';
      session.lastInputAt = 0;

      // Close old resources after swap (do not break reset if close fails)
      await this.safeCloseBrowserResources(undefined, oldContext, oldPage);

      return this.getSnapshot(sessionId, userId, {
        force: true,
        includeScreenshot: true,
        onlyIfChanged: false,
      });
    } catch (error) {
      logger.error('[PREVIEW_SESSION] Session reset failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });

      // Cleanup partially-created resources if we failed before swapping
      await this.safeCloseBrowserResources(undefined, newContext, newPage).catch(() => {});
      return null;
    } finally {
      releaseLock();
    }
  }

  /**
   * Refresh current page
   */
  async refreshPage(sessionId: string, userId: string): Promise<{
    url: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      logger.info('[PREVIEW_SESSION] Refreshing page', { sessionId, url: session.page.url() });

      await session.page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // Optional: wait for network idle
      await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      return this.getSnapshot(sessionId, userId, {
        force: true,
        includeScreenshot: true,
        onlyIfChanged: false
      });
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Page refresh failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Stop a preview session
   */
  async stopSession(sessionId: string, userId?: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    if (userId && session.userId !== userId) {
      throw new Error('Forbidden: preview session does not belong to user');
    }

    // Acquire lock to prevent race with concurrent startSession
    const releaseLock = await this.acquireUserLock(session.userId);

    try {
      logger.info('[PREVIEW_SESSION] Stopping session', { sessionId });

      // Safe cleanup of browser resources
      await this.safeCloseBrowserResources(session.browser, session.context, session.page);

      // Remove from maps
      this.sessions.delete(sessionId);
      this.userToSession.delete(session.userId);

      logger.info('[PREVIEW_SESSION] Session stopped', { sessionId });
    } finally {
      releaseLock();
    }
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): InternalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastSeenAt = Date.now();
    }
    return session;
  }

  /**
   * Validate that session exists and is owned by user
   * Updates lastSeenAt only for authorized access.
   */
  isSessionOwned(sessionId: string, userId: string): boolean {
    if (!sessionId || !userId) return false;
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    if (session.userId !== userId) return false;
    session.lastSeenAt = Date.now();
    return true;
  }

  /**
   * Get session by ID and validate ownership (if userId provided)
   * Updates lastSeenAt only for authorized access.
   */
  private getAuthorizedSession(sessionId: string, userId?: string): InternalSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) return undefined;

    if (userId && session.userId !== userId) {
      logger.warn('[PREVIEW_SESSION] Unauthorized session access attempt', {
        sessionId,
        attemptedUserId: userId,
        ownerUserId: session.userId,
      });
      return undefined;
    }

    session.lastSeenAt = Date.now();
    return session;
  }

  /**
   * Get session for user
   */
  getSessionForUser(userId: string): InternalSession | undefined {
    const sessionId = this.userToSession.get(userId);
    if (!sessionId) return undefined;
    return this.getSession(sessionId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // INTERACTIVE CONTROL METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get viewport metadata for coordinate mapping
   */
  getViewportMetadata(
    sessionId: string,
    userId?: string
  ): { width: number; height: number; devicePixelRatio: number } | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    const viewport = session.page.viewportSize();
    if (!viewport) {
      return { width: 1280, height: 720, devicePixelRatio: 1 };
    }

    return {
      width: viewport.width,
      height: viewport.height,
      devicePixelRatio: 1, // Always 1 for headless (no deviceScaleFactor)
    };
  }

  /**
   * Execute mouse action in preview session
   * @returns {success, needsSnapshot} - needsSnapshot=true if action likely changed page
   */
  async executeMouseAction(params: {
    sessionId: string;
    userId: string;
    action: 'move' | 'click' | 'down' | 'up';
    x: number;
    y: number;
    button?: 'left' | 'right' | 'middle';
    clickCount?: number;
  }): Promise<{ success: boolean; error?: string; needsSnapshot: boolean }> {
    const { sessionId, userId, action, x, y, button = 'left', clickCount = 1 } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized', needsSnapshot: false };
    }

    const now = Date.now();

    // Throttle input events (anti-DoS)
    if (now - session.lastInputAt < INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled', needsSnapshot: false };
    }

    session.lastInputAt = now;
    session.lastSeenAt = now;

    try {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return { success: false, error: 'Invalid coordinates', needsSnapshot: false };
      }

      const viewport = session.page.viewportSize();
      if (!viewport) {
        return { success: false, error: 'Viewport unavailable', needsSnapshot: false };
      }

      // Clamp coordinates to viewport bounds
      const clampedX = Math.max(0, Math.min(x, viewport.width - 1));
      const clampedY = Math.max(0, Math.min(y, viewport.height - 1));
      const safeButton: 'left' | 'right' | 'middle' = button === 'right' || button === 'middle' ? button : 'left';
      const safeClickCount = Number.isInteger(clickCount) && clickCount > 0 && clickCount <= 2 ? clickCount : 1;

      switch (action) {
        case 'move':
          await session.page.mouse.move(clampedX, clampedY);
          return { success: true, needsSnapshot: false };

        case 'click':
          await session.page.mouse.click(clampedX, clampedY, { button: safeButton, clickCount: safeClickCount });
          return { success: true, needsSnapshot: true };

        case 'down':
          await session.page.mouse.move(clampedX, clampedY);
          await session.page.mouse.down({ button: safeButton });
          return { success: true, needsSnapshot: false };

        case 'up':
          await session.page.mouse.move(clampedX, clampedY);
          await session.page.mouse.up({ button: safeButton });
          return { success: true, needsSnapshot: true };

        default:
          return { success: false, error: `Unknown action: ${action}`, needsSnapshot: false };
      }
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Mouse action failed', {
        sessionId,
        action,
        x,
        y,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Mouse action failed',
        needsSnapshot: false,
      };
    }
  }

  /**
   * Execute mouse wheel scroll
   */
  async executeMouseWheel(params: {
    sessionId: string;
    userId: string;
    deltaX: number;
    deltaY: number;
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, userId, deltaX, deltaY } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    const now = Date.now();

    if (now - session.lastInputAt < INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastInputAt = now;
    session.lastSeenAt = now;

    try {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        return { success: false, error: 'Invalid wheel delta' };
      }

      // Prevent extreme values (accidental or abuse)
      const safeDeltaX = Math.max(-2000, Math.min(2000, deltaX));
      const safeDeltaY = Math.max(-2000, Math.min(2000, deltaY));

      await session.page.mouse.wheel(safeDeltaX, safeDeltaY);
      return { success: true };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Mouse wheel failed', {
        sessionId,
        deltaX,
        deltaY,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Wheel action failed',
      };
    }
  }

  /**
   * Execute keyboard type (insert text)
   */
  async executeKeyboardType(params: {
    sessionId: string;
    userId: string;
    text: string;
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, userId, text } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    // Length limit (prevent abuse)
    if (text.length > 500) {
      return { success: false, error: 'Text too long (max 500 chars)' };
    }

    const now = Date.now();
    if (now - session.lastInputAt < INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastInputAt = now;
    session.lastSeenAt = now;

    try {
      await session.page.keyboard.type(text);
      return { success: true };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Keyboard type failed', {
        sessionId,
        textLength: text.length,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Type action failed',
      };
    }
  }

  /**
   * Execute keyboard key press with modifiers
   */
  async executeKeyboardPress(params: {
    sessionId: string;
    userId: string;
    key: string;
    modifiers?: ('Control' | 'Shift' | 'Alt' | 'Meta')[];
  }): Promise<{ success: boolean; error?: string }> {
    const { sessionId, userId, key, modifiers } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return { success: false, error: 'Session not found or unauthorized' };
    }

    const now = Date.now();
    if (now - session.lastInputAt < INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastInputAt = now;
    session.lastSeenAt = now;

    const safeModifiers = Array.isArray(modifiers) ? modifiers : [];

    try {
      // Hold modifiers
      if (safeModifiers.length > 0) {
        for (const mod of safeModifiers) {
          await session.page.keyboard.down(mod);
        }
      }

      // Press key
      await session.page.keyboard.press(key);

      return { success: true };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Keyboard press failed', {
        sessionId,
        key,
        modifiers,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Press action failed',
      };
    } finally {
      // Ensure we always release modifiers (avoid sticky modifier state after errors)
      if (safeModifiers.length > 0) {
        for (const mod of [...safeModifiers].reverse()) {
          await session.page.keyboard.up(mod).catch(() => { });
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBUG / PROBE METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Probe element at given viewport coordinates (debug tool)
   * Returns element info at (x, y) to verify coordinate mapping from frontend
   */
  async probeElementAt(params: {
    sessionId: string;
    userId: string;
    x: number;
    y: number;
  }): Promise<{
    element?: {
      tag: string;
      id?: string;
      className?: string;
      text?: string;
      ariaLabel?: string;
      ref?: string;
    };
  }> {
    const { sessionId, userId, x, y } = params;
    const session = this.getAuthorizedSession(sessionId, userId);

    if (!session) {
      return {};
    }

    try {
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return {};
      }

      const viewport = session.page.viewportSize();
      if (!viewport) {
        return {};
      }

      // Clamp coordinates to viewport bounds
      const clampedX = Math.max(0, Math.min(x, viewport.width - 1));
      const clampedY = Math.max(0, Math.min(y, viewport.height - 1));

      // Query element at point in page context
      const elementInfo = await session.page.evaluate(
        ({ px, py }) => {
          // @ts-ignore - document is available in browser context
          const el = document.elementFromPoint(px, py);
          if (!el) return null;

          // Extract basic info
          const tag = el.tagName?.toLowerCase() || '';
          const id = el.id || undefined;
          const className = el.className && typeof el.className === 'string'
            ? el.className.slice(0, 100)
            : undefined;
          const text = el.textContent?.trim().slice(0, 50) || undefined;
          const ariaLabel = el.getAttribute('aria-label') || undefined;
          const ref = el.getAttribute('data-agent-ref') || undefined;

          return { tag, id, className, text, ariaLabel, ref };
        },
        { px: clampedX, py: clampedY }
      );

      return { element: elementInfo || undefined };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Probe element failed', {
        sessionId,
        x,
        y,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SNAPSHOT METHODS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Compute page signature for diff detection
   * Returns hash of URL + DOM node count + interactive element count
   */
  private computePageSignature(url: string, domNodes: InteractiveNode[]): string {
    const data = `${url}|${domNodes.length}|${domNodes.map(n => n.ref).join(',')}`;
    // Simple hash - just use first 16 chars of base64
    return Buffer.from(data).toString('base64').substring(0, 32);
  }

  /**
   * Capture screenshot as JPEG base64 (no data: prefix)
   * Returns null if capture fails or size exceeds limit
   */
  private async captureScreenshot(page: Page): Promise<string | null> {
    try {
      const buffer = await page.screenshot({
        type: 'jpeg',
        quality: SCREENSHOT_CONFIG.quality,
        fullPage: false, // Viewport only
      });

      // Check size limit
      if (buffer.length > SCREENSHOT_CONFIG.maxSizeBytes) {
        logger.debug('[PREVIEW_SESSION] Screenshot too large, skipping', {
          size: buffer.length,
          maxSize: SCREENSHOT_CONFIG.maxSizeBytes,
        });
        return null;
      }

      return buffer.toString('base64');
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Screenshot capture failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get current page snapshot
   * @param options.force - Skip throttling
   * @param options.includeScreenshot - Include JPEG screenshot (default: true)
   * @param options.onlyIfChanged - Only return if page signature changed (for apply)
   */
  async getSnapshot(
    sessionId: string,
    userId?: string,
    options?: { force?: boolean; includeScreenshot?: boolean; onlyIfChanged?: boolean }
  ): Promise<{
    url: string;
    domNodes: InteractiveNode[];
    screenshot?: string;
    changed?: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    const now = Date.now();
    const includeScreenshot = options?.includeScreenshot !== false;

    // Throttle snapshot collection (unless forced)
    if (!options?.force && now - session.lastSnapshotEmit < SNAPSHOT_THROTTLE_MS) {
      return {
        url: session.pageState.url,
        domNodes: session.pageState.domNodes,
        changed: false,
      };
    }

    try {
      const snapshot = await SnapshotCollector.collect(session.page);
      const domAnalysis = DomAnalysisExtractorService.extract(snapshot);
      const currentUrl = session.page.url();

      session.pageState = {
        url: currentUrl,
        domNodes: domAnalysis.interactiveNodes,
      };
      session.lastSnapshotEmit = now;

      // Compute signature for diff detection
      const newSignature = this.computePageSignature(currentUrl, domAnalysis.interactiveNodes);
      const changed = newSignature !== session.lastPageSignature;
      session.lastPageSignature = newSignature;

      // If onlyIfChanged and no change, skip
      if (options?.onlyIfChanged && !changed) {
        return {
          url: session.pageState.url,
          domNodes: session.pageState.domNodes,
          changed: false,
        };
      }

      // Capture screenshot if requested and throttle allows
      let screenshot: string | undefined;
      if (includeScreenshot) {
        const canEmitScreenshot = now - session.lastScreenshotEmitAt >= SCREENSHOT_CONFIG.throttleMs;
        if (canEmitScreenshot || options?.force) {
          const captured = await this.captureScreenshot(session.page);
          if (captured) {
            screenshot = captured;
            session.lastScreenshotEmitAt = now;
          }
        }
      }

      return {
        url: session.pageState.url,
        domNodes: session.pageState.domNodes,
        screenshot,
        changed,
      };
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Failed to get snapshot', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Get page from session (for action execution)
   */
  getPage(sessionId: string, userId?: string): Page | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.page || null;
  }

  /**
   * Navigate to URL in session
   */
  async navigate(sessionId: string, url: string, userId?: string): Promise<{
    url: string;
    domNodes: InteractiveNode[];
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const safeUrl = sanitizeUrl(url);
      await session.page.goto(safeUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      await session.page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => { });

      return this.getSnapshot(sessionId, userId, { force: true });
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] Navigation failed', {
        sessionId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Cleanup expired sessions
   */
  private async cleanupExpiredSessions(): Promise<void> {
    const now = Date.now();
    const expiredSessions: string[] = [];

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastSeenAt > SESSION_TTL_MS) {
        expiredSessions.push(sessionId);
      }
    }

    for (const sessionId of expiredSessions) {
      logger.info('[PREVIEW_SESSION] Cleaning up expired session', { sessionId });
      await this.stopSession(sessionId);
    }

    if (expiredSessions.length > 0) {
      logger.info('[PREVIEW_SESSION] Cleanup complete', {
        expiredCount: expiredSessions.length,
        remainingSessions: this.sessions.size,
      });
    }
  }

  /**
   * Start cleanup interval
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions().catch((error) => {
        logger.error('[PREVIEW_SESSION] Cleanup error', { error });
      });
    }, SESSION_CLEANUP_INTERVAL_MS);
  }

  /**
   * Stop all sessions and cleanup (for graceful shutdown)
   */
  async shutdown(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      await this.stopSession(sessionId);
    }

    logger.info('[PREVIEW_SESSION] Shutdown complete');
  }

  /**
   * Get session count (for monitoring)
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}

// Export singleton getter
export const getPreviewSessionService = () => PreviewSessionService.getInstance();
