/**
 * PageWatcher
 * Detects new browser tabs/popups opened after actions
 * Enables automatic context switching for multi-page flows
 *
 * MANUS ALIGNMENT: Phase A - Multi-Tab / Pop-up Auto Switch
 *
 * HARDENING:
 * - Removable listener + dispose() for leak prevention
 * - Popup queue for multi-popup safety
 * - Idempotent prepareForPopup() with clearable timeout
 * - Avoids about:blank trap in readiness check
 * - Auto-cleanup on page close
 */

import { logger } from '@/utils/core/logger';
import type { BrowserContext, Page } from 'playwright';

export interface NewPageInfo {
  page: Page;
  url: string;
  isPopup: boolean;
}

export class PageWatcher {
  private context: BrowserContext;
  private knownPages: Set<Page> = new Set();
  private disposed = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // Popup detection state (idempotent + clearable)
  // ═══════════════════════════════════════════════════════════════════════════
  private popupPromise: Promise<Page> | null = null;
  private popupResolve: ((page: Page) => void) | null = null;
  private popupTimeoutHandle: ReturnType<typeof setTimeout> | null = null;

  // ═══════════════════════════════════════════════════════════════════════════
  // Popup queue (multi-popup safe)
  // ═══════════════════════════════════════════════════════════════════════════
  private pendingNewPages: Page[] = [];

  // ═══════════════════════════════════════════════════════════════════════════
  // Removable handler reference
  // ═══════════════════════════════════════════════════════════════════════════
  private onPageHandler: ((page: Page) => void) | null = null;

  // Timeout for detecting popup (some popups take time to fully open)
  private readonly POPUP_TIMEOUT_MS = 3000;
  // Max time to wait for URL to become non-about:blank
  private readonly URL_STABILIZE_TIMEOUT_MS = 2000;

  constructor(context: BrowserContext) {
    this.context = context;
    this.initializeKnownPages();
    this.setupPopupListener();
  }

  /**
   * Initialize known pages set with existing pages
   * Attach close handlers for auto-cleanup
   */
  private initializeKnownPages(): void {
    for (const page of this.context.pages()) {
      this.knownPages.add(page);
      this.attachCloseHandler(page);
    }
    logger.debug('[PAGE_WATCHER] Initialized with existing pages', {
      count: this.knownPages.size,
    });
  }

  /**
   * Attach close handler to page for auto-cleanup
   */
  private attachCloseHandler(page: Page): void {
    page.once('close', () => {
      this.knownPages.delete(page);
      // Also remove from pending queue if present
      const idx = this.pendingNewPages.indexOf(page);
      if (idx !== -1) {
        this.pendingNewPages.splice(idx, 1);
      }
      logger.debug('[PAGE_WATCHER] Page auto-closed, removed from tracking', {
        remainingKnown: this.knownPages.size,
        remainingPending: this.pendingNewPages.length,
      });
    });
  }

  /**
   * Setup listener for new page events (popups, target=_blank links)
   * Uses removable handler for dispose()
   */
  private setupPopupListener(): void {
    this.onPageHandler = (newPage: Page) => {
      if (this.disposed) return;

      logger.info('[PAGE_WATCHER] New page detected', {
        url: newPage.url(),
        totalPages: this.context.pages().length,
      });

      // Attach close handler for auto-cleanup
      this.attachCloseHandler(newPage);

      // If waiting for popup, resolve immediately
      if (this.popupResolve) {
        this.resolvePopup(newPage);
      } else {
        // Otherwise queue for later detection
        this.pendingNewPages.push(newPage);
      }
    };

    this.context.on('page', this.onPageHandler);
  }

  /**
   * Resolve pending popup promise with page
   */
  private resolvePopup(page: Page): void {
    if (this.popupResolve) {
      this.popupResolve(page);
    }
    this.clearPopupState();
  }

  /**
   * Clear popup waiting state
   */
  private clearPopupState(): void {
    this.popupResolve = null;
    this.popupPromise = null;
    if (this.popupTimeoutHandle) {
      clearTimeout(this.popupTimeoutHandle);
      this.popupTimeoutHandle = null;
    }
  }

  /**
   * Prepare for potential popup before click action
   * Call this BEFORE executing a click that might open a new tab
   *
   * IDEMPOTENT: If already waiting, does nothing
   */
  prepareForPopup(): void {
    if (this.disposed) return;

    // Idempotent: don't overwrite existing pending promise
    if (this.popupPromise) {
      logger.debug('[PAGE_WATCHER] prepareForPopup called but already waiting');
      return;
    }

    // Check if we already have queued pages from previous events
    if (this.pendingNewPages.length > 0) {
      logger.debug('[PAGE_WATCHER] Already have pending pages, skipping prepare', {
        count: this.pendingNewPages.length,
      });
      return;
    }

    // Create a new promise for popup detection
    this.popupPromise = new Promise<Page>((resolve) => {
      this.popupResolve = resolve;

      // Auto-clear after timeout (clearable)
      this.popupTimeoutHandle = setTimeout(() => {
        if (this.popupResolve === resolve) {
          this.clearPopupState();
          logger.debug('[PAGE_WATCHER] Popup wait timed out');
        }
      }, this.POPUP_TIMEOUT_MS);
    });
  }

  /**
   * Check for new pages after action execution
   * Returns info about new page if one was opened
   *
   * @param timeoutMs - How long to wait for popup (default: 1000ms)
   * @returns NewPageInfo if new page opened, null otherwise
   */
  async detectNewPage(timeoutMs: number = 1000): Promise<NewPageInfo | null> {
    if (this.disposed) return null;

    // ═══════════════════════════════════════════════════════════════════════
    // Method 1: Check pending queue (already arrived pages)
    // ═══════════════════════════════════════════════════════════════════════
    if (this.pendingNewPages.length > 0) {
      const newPage = this.pendingNewPages.shift()!;

      // Wait for page to be ready (URL stabilized)
      await this.waitForPageReady(newPage);

      // Add to known pages
      this.knownPages.add(newPage);

      logger.info('[PAGE_WATCHER] Popup detected from queue', {
        url: newPage.url(),
        remainingInQueue: this.pendingNewPages.length,
      });

      return {
        page: newPage,
        url: newPage.url(),
        isPopup: true,
      };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Method 2: Wait for popup promise if active
    // ═══════════════════════════════════════════════════════════════════════
    if (this.popupPromise) {
      try {
        const newPage = await Promise.race([
          this.popupPromise,
          new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);

        if (newPage) {
          // Wait for page to be ready
          await this.waitForPageReady(newPage);

          // Add to known pages
          this.knownPages.add(newPage);

          logger.info('[PAGE_WATCHER] Popup detected via listener', {
            url: newPage.url(),
          });

          return {
            page: newPage,
            url: newPage.url(),
            isPopup: true,
          };
        }
      } catch {
        // Popup detection failed, continue to Method 3
      } finally {
        this.clearPopupState();
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Method 3: Compare current pages with known pages (fallback)
    // ═══════════════════════════════════════════════════════════════════════
    const currentPages = this.context.pages();
    for (const page of currentPages) {
      if (!this.knownPages.has(page) && !this.pendingNewPages.includes(page)) {
        // Wait for page to be ready
        await this.waitForPageReady(page);

        // Add to known pages
        this.knownPages.add(page);

        // Attach close handler
        this.attachCloseHandler(page);

        logger.info('[PAGE_WATCHER] New page detected via comparison', {
          url: page.url(),
        });

        return {
          page,
          url: page.url(),
          isPopup: false,
        };
      }
    }

    return null;
  }

  /**
   * Wait for page to be ready for interaction
   * Avoids about:blank trap by waiting for URL to stabilize
   */
  private async waitForPageReady(page: Page): Promise<void> {
    try {
      // Wait for DOM content loaded or timeout
      await Promise.race([
        page.waitForLoadState('domcontentloaded', { timeout: 5000 }),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);

      // ═══════════════════════════════════════════════════════════════════════
      // Wait for URL to stabilize (avoid about:blank trap)
      // ═══════════════════════════════════════════════════════════════════════
      const startTime = Date.now();
      while (Date.now() - startTime < this.URL_STABILIZE_TIMEOUT_MS) {
        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank' && currentUrl !== '') {
          break;
        }
        await page.waitForTimeout(100);
      }

      // Small delay for JavaScript to initialize
      await page.waitForTimeout(300);
    } catch (error) {
      logger.debug('[PAGE_WATCHER] Page ready wait error (continuing anyway)', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update known pages set when page closes
   * Call this when switching away from a page (backup method)
   */
  markPageAsClosed(page: Page): void {
    this.knownPages.delete(page);
    const idx = this.pendingNewPages.indexOf(page);
    if (idx !== -1) {
      this.pendingNewPages.splice(idx, 1);
    }
    logger.debug('[PAGE_WATCHER] Marked page as closed', {
      remainingPages: this.knownPages.size,
    });
  }

  /**
   * Get current page count
   */
  getPageCount(): number {
    return this.context.pages().length;
  }

  /**
   * Get all open pages
   */
  getAllPages(): Page[] {
    return this.context.pages();
  }

  /**
   * Dispose of the watcher, removing all listeners
   * Call this when test ends to prevent listener leaks
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    // Remove page listener
    if (this.onPageHandler) {
      this.context.off('page', this.onPageHandler);
      this.onPageHandler = null;
    }

    // Clear popup state
    this.clearPopupState();

    // Clear queues
    this.pendingNewPages = [];

    logger.debug('[PAGE_WATCHER] Disposed', {
      knownPagesCount: this.knownPages.size,
    });
  }

  /**
   * Check if disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }
}
