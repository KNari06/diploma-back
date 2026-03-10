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
import { webSocketService } from '@/websocket/core/websocket.service';
import { DomAnalysisExtractorService } from './dom-analysis-extractor.service';
import type { InteractiveNode, PreviewSession } from './preview.types';
import { setupThirdPartyBlocker } from '@/agent/playwright/execution/third-party-blocker';
import { PREVIEW_SESSION_CONFIG } from '@/config/testing/playwright-tuning';

const SESSION_TTL_MS = PREVIEW_SESSION_CONFIG.sessionTtlMs;
const SESSION_CLEANUP_INTERVAL_MS = PREVIEW_SESSION_CONFIG.sessionCleanupIntervalMs;
const SNAPSHOT_THROTTLE_MS = PREVIEW_SESSION_CONFIG.snapshotThrottleMs;
const MAX_SESSIONS = PREVIEW_SESSION_CONFIG.maxSessions;
const SCREENSHOT_CONFIG = PREVIEW_SESSION_CONFIG.screenshot;
const MOUSE_INPUT_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.mouseMs;
const WHEEL_INPUT_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.wheelMs;
const KEYBOARD_TYPE_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.keyboardTypeMs;
const KEYBOARD_PRESS_THROTTLE_MS = PREVIEW_SESSION_CONFIG.inputThrottle.keyboardPressMs;

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
  return (
    /Target page, context or browser has been closed/i.test(msg) ||
    /Target\.disposeBrowserContext.+Failed to find context/i.test(msg)
  );
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
  lastMouseInputAt: number;       // Mouse input throttling timestamp
  lastWheelInputAt: number;       // Wheel input throttling timestamp
  lastKeyboardTypeAt: number;     // Keyboard type throttling timestamp
  lastKeyboardPressAt: number;    // Keyboard press throttling timestamp
  domVersion: number;             // Monotonically increasing DOM version
  contextVersion: number;         // Version for context updates
  contextData: Record<string, any>; // Context data (env + test variables)

  // Recording mode state
  recording: boolean;
  recordingTypingBuffer: {
    text: string;
    elementRef?: string;
    elementLabel: string;
    lastCharAt: number;
    bindingHints?: Record<string, string>;
    /** V10: True if the focused element is multiline (textarea, contenteditable) */
    isMultiline?: boolean;
    /** URL where typing started (guards against cross-page ref collision) */
    pageUrl?: string;
  } | null;
  recordingLastUrl: string;
  /** V10: Drag state tracked between mouse:down and mouse:up */
  recordingDragState: {
    startX: number;
    startY: number;
    startElement: any; // ProbedElement from recording-capture.service
    startedAt: number;
  } | null;
  /** V10: Last emitted type step — for merging consecutive typing in same element */
  recordingLastTypeStep: {
    id: string;
    elementRef?: string;
    value: string;
  } | null;
  /** V10: Last emitted scroll step — for merging consecutive scrolls */
  recordingLastScrollStep: {
    id: string;
    totalDelta: number;
    emittedAt: number;
  } | null;

  /** V11: Callback invoked when session switches to a new page (popup/navigation) */
  onPageSwitch?: (newPage: Page, previousUrl: string) => void;

  /** V11: True while page switch is in progress — blocks DOM tick from collecting stale/empty snapshots */
  pageSwitchInProgress?: boolean;
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
   * Includes 10s timeout per resource to prevent infinite hangs
   */
  private async safeCloseBrowserResources(
    browser?: Browser,
    context?: BrowserContext,
    page?: Page
  ): Promise<void> {
    const CLOSE_TIMEOUT_MS = 10000; // 10 seconds per resource
    const getBrowserPid = (b?: Browser): number | undefined => {
      try {
        const proc = (b as any)?.process?.();
        return proc?.pid;
      } catch {
        return undefined;
      }
    };

    /**
     * Helper: wrap close operation with timeout
     */
    const closeWithTimeout = async (
      closePromise: Promise<void>,
      resourceName: string,
      resourceId?: number
    ): Promise<void> => {
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${resourceName} close timeout (${CLOSE_TIMEOUT_MS}ms)`)), CLOSE_TIMEOUT_MS)
      );

      try {
        await Promise.race([closePromise, timeoutPromise]);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTimeout = errorMessage.includes('timeout');

        if (isTimeout) {
          logger.warn(`[PREVIEW_SESSION] ${resourceName} close timeout, may need force kill`, {
            timeout: CLOSE_TIMEOUT_MS,
            pid: resourceId,
          });
        } else if (!isBenignAlreadyClosedError(error)) {
          logger.warn(`[PREVIEW_SESSION] Error closing ${resourceName}`, {
            error: formatPlaywrightCloseError(error),
          });
        }

        // Don't throw - we want to try closing other resources
      }
    };

    const closePromises: Promise<void>[] = [];

    if (page) {
      closePromises.push(closeWithTimeout(page.close(), 'page'));
    }

    if (context) {
      closePromises.push(closeWithTimeout(context.close(), 'context'));
    }

    if (browser) {
      const browserPid = getBrowserPid(browser);
      closePromises.push(closeWithTimeout(browser.close(), 'browser', browserPid));
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
          await this.stopSessionInternal(existingSessionId);
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
          viewport: PREVIEW_SESSION_CONFIG.viewport,
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        });

        page = await context.newPage();

        // Block third-party requests to prevent slow networkidle waits
        try {
          await setupThirdPartyBlocker(page);
        } catch {
          // Non-fatal: preview should work without blocker
        }

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

        // Compute initial page signature
        const initialUrl = page.url();
        const initialSignature = this.computePageSignature(initialUrl, domAnalysis.interactiveNodes);

        // Create session
        const session: InternalSession = {
          id: sessionId,
          userId,
          projectId,
          startUrl: safeStartUrl,
          pageState: {
            url: initialUrl,
            pageTitle: await page.title().catch(() => undefined),
            domNodes: domAnalysis.interactiveNodes,
            pageText: snapshot.pageTextForExtraction?.slice(0, 3000),
          },
          createdAt: Date.now(),
          lastSeenAt: Date.now(),
          browser,
          context,
          page,
          lastSnapshotEmit: 0,
          lastScreenshotEmitAt: 0,
          lastPageSignature: initialSignature,
          lastMouseInputAt: 0,
          lastWheelInputAt: 0,
          lastKeyboardTypeAt: 0,
          lastKeyboardPressAt: 0,
          domVersion: 1,           // Start at version 1
          contextVersion: 0,
          contextData: {},

          // Recording mode (off by default)
          recording: false,
          recordingTypingBuffer: null,
          recordingLastUrl: safeStartUrl,
          recordingDragState: null,
          recordingLastTypeStep: null,
          recordingLastScrollStep: null,
        };

        // Store session
        this.sessions.set(sessionId, session);
        this.userToSession.set(userId, sessionId);

        // Auto-dismiss native dialogs (alert/confirm/prompt/beforeunload)
        this.attachDialogHandler(page, sessionId);

        // Handle popup / new tab detection
        this.attachPopupHandler(context, sessionId);

        // Handle page crash (renderer process OOM, infinite loop, etc.)
        this.attachCrashHandler(page, sessionId);

        // Handle download attempts (headless can't download — notify frontend)
        this.attachPageDownloadHandler(page, sessionId);

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
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    screenshot?: string;
    changed: boolean;
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
        viewport: PREVIEW_SESSION_CONFIG.viewport,
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      });

      newPage = await newContext.newPage();

      // Block third-party requests to prevent slow networkidle waits
      try {
        await setupThirdPartyBlocker(newPage);
      } catch {
        // Non-fatal: preview should work without blocker
      }

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

      // Auto-dismiss native dialogs on the new page
      this.attachDialogHandler(newPage, sessionId);

      // Re-attach handlers on new context/page
      this.attachPopupHandler(newContext, sessionId);
      this.attachCrashHandler(newPage, sessionId);
      this.attachPageDownloadHandler(newPage, sessionId);

      // Reset internal timers/state to avoid throttling weirdness after reset
      session.lastSnapshotEmit = 0;
      session.lastScreenshotEmitAt = 0;
      session.lastPageSignature = '';
      session.lastMouseInputAt = 0;
      session.lastWheelInputAt = 0;
      session.lastKeyboardTypeAt = 0;
      session.lastKeyboardPressAt = 0;
      session.domVersion = 1; // Reset to version 1 on session reset

      // Reset recording state
      session.recording = false;
      session.recordingTypingBuffer = null;
      session.recordingLastUrl = startUrl;
      session.recordingDragState = null;
      session.recordingLastTypeStep = null;
      session.recordingLastScrollStep = null;

      // Close old resources after swap (do not break reset if close fails)
      await this.safeCloseBrowserResources(undefined, oldContext, oldPage);

      return this.getSnapshot(sessionId, userId, {
        force: true,
        includeDomNodes: true,
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
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    screenshot?: string;
    changed: boolean;
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
        includeDomNodes: true,
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
   * Navigate back in browser history
   */
  async goBack(sessionId: string, userId: string): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const previousUrl = session.page.url();
      logger.info('[PREVIEW_SESSION] Navigating back', { sessionId, currentUrl: previousUrl });

      const response = await session.page.goBack({
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });

      // goBack returns null if there's no history to go back to
      if (!response) {
        logger.debug('[PREVIEW_SESSION] No history to go back', { sessionId });
        return null;
      }

      await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      return this.getSnapshot(sessionId, userId, {
        force: true,
        includeDomNodes: true,
        onlyIfChanged: false,
      });
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] goBack failed', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Navigate forward in browser history
   */
  async goForward(sessionId: string, userId: string): Promise<{
    url: string;
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    try {
      const previousUrl = session.page.url();
      logger.info('[PREVIEW_SESSION] Navigating forward', { sessionId, currentUrl: previousUrl });

      const response = await session.page.goForward({
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });

      if (!response) {
        logger.debug('[PREVIEW_SESSION] No history to go forward', { sessionId });
        return null;
      }

      await session.page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});

      return this.getSnapshot(sessionId, userId, {
        force: true,
        includeDomNodes: true,
        onlyIfChanged: false,
      });
    } catch (error) {
      logger.warn('[PREVIEW_SESSION] goForward failed', {
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

      // Safety-net: close and upload editor trace (idempotent — no-op if already closed)
      try {
        const { EditorTraceService } = await import('./editor-trace.service');
        const meta = await EditorTraceService.close(sessionId);
        if (meta) {
          const { uploadEditorTrace } = await import('./editor-trace-upload');
          uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId: sessionId, traceType: 'editor' }).catch(() => {});
        }
      } catch { /* non-fatal */ }

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
   * Stop a preview session (internal, without lock)
   * IMPORTANT: Only call this when lock is already acquired (e.g., inside startSession)
   * For external calls, use stopSession() which acquires lock
   */
  private async stopSessionInternal(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return; // Idempotent: already deleted
    }

    logger.info('[PREVIEW_SESSION] Stopping session (internal)', { sessionId, userId: session.userId });

    // Safety-net: close and upload editor trace (idempotent — no-op if already closed)
    try {
      const { EditorTraceService } = await import('./editor-trace.service');
      const meta = await EditorTraceService.close(sessionId);
      if (meta) {
        const { uploadEditorTrace } = await import('./editor-trace-upload');
        uploadEditorTrace({ filePath: meta.filePath, userId: meta.userId, previewSessionId: sessionId, traceType: 'editor' }).catch(() => {});
      }
    } catch { /* non-fatal */ }

    try {
      // Safe cleanup of browser resources
      await this.safeCloseBrowserResources(session.browser, session.context, session.page);

      // Fallback force-kill if browser process still alive
      const browserProcess = (session.browser as any)?.process?.();
      if (browserProcess && browserProcess.pid) {
        try {
          // Check if process is still alive
          process.kill(browserProcess.pid, 0); // Signal 0 checks existence without killing
          logger.warn('[PREVIEW_SESSION] Browser process still alive after close, force killing', {
            sessionId,
            pid: browserProcess.pid,
          });
          process.kill(browserProcess.pid, 'SIGKILL');
        } catch (error) {
          // Process already dead or not accessible - this is fine
        }
      }
    } catch (error) {
      logger.error('[PREVIEW_SESSION] Error during stopSessionInternal', {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Remove from maps atomically (even if cleanup failed)
    this.sessions.delete(sessionId);
    this.userToSession.delete(session.userId);

    logger.info('[PREVIEW_SESSION] Session stopped (internal)', { sessionId });
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
      return { width: PREVIEW_SESSION_CONFIG.viewport.width, height: PREVIEW_SESSION_CONFIG.viewport.height, devicePixelRatio: 1 };
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
    if (now - session.lastMouseInputAt < MOUSE_INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled', needsSnapshot: false };
    }

    session.lastMouseInputAt = now;
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

    if (now - session.lastWheelInputAt < WHEEL_INPUT_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastWheelInputAt = now;
    session.lastSeenAt = now;

    try {
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) {
        return { success: false, error: 'Invalid wheel delta' };
      }

      // Apply scroll sensitivity multiplier and prevent extreme values
      const SCROLL_SENSITIVITY = 1.8;
      const safeDeltaX = Math.max(-2000, Math.min(2000, deltaX * SCROLL_SENSITIVITY));
      const safeDeltaY = Math.max(-2000, Math.min(2000, deltaY * SCROLL_SENSITIVITY));

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
    if (now - session.lastKeyboardTypeAt < KEYBOARD_TYPE_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastKeyboardTypeAt = now;
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
    if (now - session.lastKeyboardPressAt < KEYBOARD_PRESS_THROTTLE_MS) {
      return { success: false, error: 'Input throttled' };
    }

    session.lastKeyboardPressAt = now;
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
   * Get current page snapshot with DOM versioning
   * @param options.force - Skip throttling
   * @param options.includeScreenshot - Include JPEG screenshot (default: false for new video-based flow)
   * @param options.onlyIfChanged - Only return full response if page signature changed
   * @param options.includeDomNodes - Force include domNodes even if not changed (default: auto)
   */
  async getSnapshot(
    sessionId: string,
    userId?: string,
    options?: {
      force?: boolean;
      includeScreenshot?: boolean;
      onlyIfChanged?: boolean;
      includeDomNodes?: boolean;
    }
  ): Promise<{
    url: string;
    pageTitle?: string;
    domNodes?: InteractiveNode[];  // Only included when DOM changed or forced
    domVersion: number;
    pageSignature: string;
    screenshot?: string;           // Deprecated: use video:frame instead
    changed: boolean;
  } | null> {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    // V11: Block snapshot collection during page switch to prevent stale/empty DOM emission
    if (session.pageSwitchInProgress) {
      return null;
    }

    const now = Date.now();
    const includeScreenshot = options?.includeScreenshot === true; // Default false now

    // Throttle snapshot collection (unless forced)
    if (!options?.force && now - session.lastSnapshotEmit < SNAPSHOT_THROTTLE_MS) {
      // IMPORTANT:
      // Linting needs domNodes, but collecting a fresh snapshot is expensive.
      // When throttled, return the last known domNodes from session.pageState if explicitly requested.
      const shouldIncludeDomNodes = options?.includeDomNodes === true;
      return {
        url: session.pageState.url,
        pageTitle: session.pageState.pageTitle,
        domNodes: shouldIncludeDomNodes ? session.pageState.domNodes : undefined,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
        changed: false,
      };
    }

    try {
      const snapshot = await SnapshotCollector.collect(session.page);
      const domAnalysis = DomAnalysisExtractorService.extract(snapshot);
      const currentUrl = session.page.url();

      const currentTitle = await session.page.title().catch(() => undefined);

      session.pageState = {
        url: currentUrl,
        pageTitle: currentTitle,
        domNodes: domAnalysis.interactiveNodes,
        pageText: snapshot.pageTextForExtraction?.slice(0, 3000),
      };
      session.lastSnapshotEmit = now;

      // Compute signature for diff detection
      const newSignature = this.computePageSignature(currentUrl, domAnalysis.interactiveNodes);
      const changed = newSignature !== session.lastPageSignature;

      // Increment domVersion only if signature changed
      if (changed) {
        session.domVersion++;
        session.lastPageSignature = newSignature;
      }

      // If onlyIfChanged and no change, return minimal response
      if (options?.onlyIfChanged && !changed) {
        return {
          url: session.pageState.url,
          pageTitle: session.pageState.pageTitle,
          domVersion: session.domVersion,
          pageSignature: session.lastPageSignature,
          changed: false,
        };
      }

      // Capture screenshot if explicitly requested (deprecated for preview)
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

      // Include domNodes only if changed or explicitly requested
      const shouldIncludeDomNodes = options?.includeDomNodes ?? changed;

      return {
        url: session.pageState.url,
        pageTitle: session.pageState.pageTitle,
        domNodes: shouldIncludeDomNodes ? session.pageState.domNodes : undefined,
        domVersion: session.domVersion,
        pageSignature: session.lastPageSignature,
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
   * Get current DOM version for a session
   */
  getDomVersion(sessionId: string, userId?: string): number | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.domVersion ?? null;
  }

  /**
   * Get context data for a session
   */
  getContextData(sessionId: string, userId?: string): { version: number; data: Record<string, any> } | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;
    return {
      version: session.contextVersion,
      data: session.contextData,
    };
  }

  /**
   * Set context data for a session
   */
  setContextData(sessionId: string, userId: string, data: Record<string, any>): { version: number; data: Record<string, any> } | null {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return null;

    session.contextVersion++;
    session.contextData = { ...data };

    return {
      version: session.contextVersion,
      data: session.contextData,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RECORDING STATE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Set recording state for a session
   */
  setRecording(sessionId: string, userId: string, recording: boolean): boolean {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (!session) return false;
    session.recording = recording;
    if (!recording) {
      session.recordingTypingBuffer = null;
      session.recordingDragState = null;
      session.recordingLastTypeStep = null;
      session.recordingLastScrollStep = null;
    }
    return true;
  }

  /**
   * Check if recording is active for a session
   */
  isRecording(sessionId: string, userId?: string): boolean {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recording ?? false;
  }

  /**
   * Get recording typing buffer
   */
  getRecordingBuffer(sessionId: string, userId?: string): InternalSession['recordingTypingBuffer'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingTypingBuffer ?? null;
  }

  /**
   * Set recording typing buffer
   */
  setRecordingBuffer(sessionId: string, userId: string, buffer: InternalSession['recordingTypingBuffer']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingTypingBuffer = buffer;
  }

  /**
   * Get last recorded URL (for navigation detection)
   */
  getRecordingLastUrl(sessionId: string, userId?: string): string | undefined {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastUrl;
  }

  /**
   * Set last recorded URL
   */
  setRecordingLastUrl(sessionId: string, userId: string, url: string): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastUrl = url;
  }

  /**
   * V10: Get recording drag state (for drag & drop detection)
   */
  getRecordingDragState(sessionId: string, userId?: string): InternalSession['recordingDragState'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingDragState ?? null;
  }

  /**
   * V10: Set recording drag state
   */
  setRecordingDragState(sessionId: string, userId: string, state: InternalSession['recordingDragState']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingDragState = state;
  }

  /**
   * V10: Get last emitted type step (for merge detection)
   */
  getRecordingLastTypeStep(sessionId: string, userId?: string): InternalSession['recordingLastTypeStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastTypeStep ?? null;
  }

  /**
   * V10: Set last emitted type step
   */
  setRecordingLastTypeStep(sessionId: string, userId: string, step: InternalSession['recordingLastTypeStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastTypeStep = step;
  }

  /**
   * V10: Get last emitted scroll step (for merge detection)
   */
  getRecordingLastScrollStep(sessionId: string, userId?: string): InternalSession['recordingLastScrollStep'] {
    const session = this.getAuthorizedSession(sessionId, userId);
    return session?.recordingLastScrollStep ?? null;
  }

  /**
   * V10: Set last emitted scroll step
   */
  setRecordingLastScrollStep(sessionId: string, userId: string, step: InternalSession['recordingLastScrollStep']): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) session.recordingLastScrollStep = step;
  }

  /**
   * Attach a dialog handler to auto-dismiss native dialogs (alert/confirm/prompt/beforeunload).
   * Prevents page from hanging on blocking dialogs.
   */
  private attachDialogHandler(page: Page, previewSessionId: string): void {
    page.on('dialog', async (dialog) => {
      try {
        const type = dialog.type();
        const msg = dialog.message();
        logger.info('[PREVIEW_SESSION] Dialog auto-dismissed', {
          previewSessionId,
          type,
          message: msg.slice(0, 200),
        });

        try {
          if (type === 'beforeunload') {
            await dialog.accept();
          } else {
            await dialog.dismiss();
          }
        } catch (dialogError) {
          // Dialog may have already been handled (e.g., by test execution)
          logger.warn('[PREVIEW_SESSION] Failed to dismiss dialog (may already be handled)', {
            previewSessionId,
            type,
            error: dialogError instanceof Error ? dialogError.message : String(dialogError),
          });
          return; // Skip WS notification if dismiss failed
        }

        // Notify frontend (best-effort)
        try {
          webSocketService.emitToRoom('preview', previewSessionId, 'preview:dialog' as any, {
            previewSessionId,
            type,
            message: msg.slice(0, 500),
            action: type === 'beforeunload' ? 'accepted' : 'dismissed',
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Non-critical: frontend notification is optional
        }
      } catch (error) {
        // Outer catch: prevent unhandled promise rejection for any unexpected error
        logger.warn('[PREVIEW_SESSION] Dialog handler error', {
          previewSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  /**
   * Handle new pages (popups, target="_blank" links, window.open).
   * When a new page is created in the BrowserContext, auto-switch the session
   * to the new page so the preview doesn't freeze on the old (backgrounded) page.
   *
   * Strategy:
   * - Wait for new page to reach domcontentloaded (max 10s)
   * - Close the OLD page (we only support one active page)
   * - Swap session.page to the new page
   * - Re-attach dialog handler
   * - Invoke onPageSwitch callback (registered by WS handler to restart video stream)
   * - Notify frontend of page switch
   */
  private attachPopupHandler(context: BrowserContext, previewSessionId: string): void {
    context.on('page', async (newPage: Page) => {
      const session = this.sessions.get(previewSessionId);
      if (!session) return;

      const oldUrl = session.page.url();

      try {
        // Wait for new page to load (best-effort, don't block forever)
        await newPage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});

        let newUrl = newPage.url();

        // Guard: some sites open about:blank, then inject content via document.write().
        // Wait a bit more to see if it navigates away from about:blank.
        if (newUrl === 'about:blank') {
          await new Promise(r => setTimeout(r, 2000));
          await newPage.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
          newUrl = newPage.url();

          // Still blank → close popup and keep old page
          if (newUrl === 'about:blank') {
            logger.info('[PREVIEW_SESSION] Popup stayed at about:blank — closing it', { previewSessionId });
            await newPage.close().catch(() => {});
            return;
          }
        }

        logger.info('[PREVIEW_SESSION] Popup/new tab detected — switching', {
          previewSessionId,
          oldUrl,
          newUrl,
        });

        // V11: Block snapshot collection during page switch to prevent stale/empty DOM
        session.pageSwitchInProgress = true;

        // Close old page (best-effort, don't fail if already closed)
        const oldPage = session.page;
        try {
          await oldPage.close().catch(() => {});
        } catch {
          // Already closed — fine
        }

        // Swap to new page
        session.page = newPage;

        // Attach handlers to new page
        this.attachDialogHandler(newPage, previewSessionId);
        this.attachCrashHandler(newPage, previewSessionId);
        this.attachPageDownloadHandler(newPage, previewSessionId);

        // V11: Wait for new page to be fully loaded before allowing snapshot collection.
        // This prevents race conditions where DOM tick collects empty/partial DOM.
        try {
          await newPage.waitForLoadState('load', { timeout: 8000 });
        } catch {
          // Timeout is acceptable — page may have slow resources. DOM should still be ready.
        }

        // Reset snapshot state so next getSnapshot() forces a fresh collect
        session.lastSnapshotEmit = 0;
        session.lastPageSignature = '';

        // V11: Unblock snapshot collection now that new page is loaded
        session.pageSwitchInProgress = false;

        // Update recording URL baseline if recording
        if (session.recording) {
          session.recordingLastUrl = newUrl;
        }

        // Invoke page switch callback (WS handler uses this to restart video/devtools)
        if (session.onPageSwitch) {
          try {
            session.onPageSwitch(newPage, oldUrl);
          } catch (cbError) {
            logger.warn('[PREVIEW_SESSION] onPageSwitch callback error', {
              previewSessionId,
              error: cbError instanceof Error ? cbError.message : String(cbError),
            });
          }
        }

        // Notify frontend about page switch
        try {
          webSocketService.emitToRoom('preview', previewSessionId, 'preview:page:navigated', {
            previewSessionId,
            url: newUrl,
            previousUrl: oldUrl,
            reason: 'popup',
            timestamp: new Date().toISOString(),
          });
        } catch {
          // Non-critical
        }
      } catch (error) {
        logger.warn('[PREVIEW_SESSION] Popup handler error', {
          previewSessionId,
          error: error instanceof Error ? error.message : String(error),
        });

        // V11: Ensure pageSwitchInProgress is cleared even on error
        if (session) {
          session.pageSwitchInProgress = false;
        }

        // If we can't switch, close the popup to avoid orphaned pages
        try {
          if (!newPage.isClosed()) {
            await newPage.close().catch(() => {});
          }
        } catch {
          // Best effort
        }
      }
    });
  }

  /**
   * V11: Register a callback for page switch events (popup/new tab).
   * The websocket handler uses this to restart video stream + devtools on the new page.
   */
  setOnPageSwitch(sessionId: string, userId: string, callback: (newPage: Page, previousUrl: string) => void): void {
    const session = this.getAuthorizedSession(sessionId, userId);
    if (session) {
      session.onPageSwitch = callback;
    }
  }

  /**
   * Handle page crash (renderer process OOM, infinite loop, GPU crash, etc.)
   * Without this, the session stays in the map with a dead page reference and
   * all subsequent operations fail silently or with cryptic CDP errors.
   */
  private attachCrashHandler(page: Page, previewSessionId: string): void {
    page.once('crash', () => {
      logger.error('[PREVIEW_SESSION] Page crashed — cleaning up session', { previewSessionId });

      // Notify frontend
      try {
        webSocketService.emitToRoom('preview', previewSessionId, 'preview:error' as any, {
          previewSessionId,
          error: 'Page crashed. Please reload the preview.',
          code: 'PAGE_CRASH',
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-critical
      }

      // Destroy entire session (browser process is likely unstable)
      this.stopSession(previewSessionId).catch(() => {});
    });
  }

  /**
   * Handle download attempts in headless preview.
   * Headless Chromium can't actually save files — cancel the download and notify frontend.
   * Called on each page (session start, reset, popup switch).
   */
  private attachPageDownloadHandler(page: Page, previewSessionId: string): void {
    page.on('download', async (download) => {
      const url = download.url();
      const suggestedFilename = download.suggestedFilename();

      logger.info('[PREVIEW_SESSION] Download intercepted (preview mode — cancelled)', {
        previewSessionId,
        url: url.slice(0, 200),
        filename: suggestedFilename,
      });

      // Cancel the download
      try {
        await download.cancel();
      } catch {
        // May already be cancelled
      }

      // Notify frontend
      try {
        webSocketService.emitToRoom('preview', previewSessionId, 'preview:download' as any, {
          previewSessionId,
          url: url.slice(0, 500),
          filename: suggestedFilename,
          message: 'File download is not supported in preview mode.',
          timestamp: new Date().toISOString(),
        });
      } catch {
        // Non-critical
      }
    });
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
    domNodes?: InteractiveNode[];
    domVersion: number;
    pageSignature: string;
    changed: boolean;
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

      return this.getSnapshot(sessionId, userId, { force: true, includeDomNodes: true });
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
