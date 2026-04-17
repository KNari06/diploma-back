/**
 * ═══════════════════════════════════════════════════════════════════════════
 * STATE MANAGER — Browser context pool + auth state caching
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Manages browser contexts for flow exploration:
 * - Creates isolated BrowserContext per flow (cookie/session isolation)
 * - Caches auth state after first successful login (via storageState)
 * - Provides authenticated contexts for auth-gated flows
 *
 * Uses Playwright's storageState() API for session persistence.
 */

import type { Browser, BrowserContext } from 'playwright';
import { logger } from '@/utils/core/logger';
import { DESKTOP_USER_AGENT } from './types';
import { BROWSER_EXTRA_HEADERS, BROWSER_STEALTH_SCRIPT } from '@/config/testing/playwright-tuning';

export class StateManager {
  private cachedAuthState: string | null = null;
  private authStateJson: object | null = null;
  private activeContexts: Set<BrowserContext> = new Set();

  constructor(private readonly browser: Browser) {}

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXT CREATION
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Create a clean browser context (no cookies, no auth state).
   * Used for flows that don't require authentication.
   */
  async createCleanContext(): Promise<BrowserContext> {
    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
      userAgent: DESKTOP_USER_AGENT,
      extraHTTPHeaders: { ...BROWSER_EXTRA_HEADERS },
    });
    await context.addInitScript(BROWSER_STEALTH_SCRIPT);
    this.activeContexts.add(context);
    return context;
  }

  /**
   * Create an authenticated browser context.
   * If auth state is cached, initializes context with saved cookies/storage.
   * If no cached state, returns a clean context (caller should handle login).
   */
  async createAuthenticatedContext(): Promise<BrowserContext> {
    if (this.authStateJson) {
      try {
        const context = await this.browser.newContext({
          viewport: { width: 1280, height: 720 },
          ignoreHTTPSErrors: true,
          userAgent: DESKTOP_USER_AGENT,
          extraHTTPHeaders: { ...BROWSER_EXTRA_HEADERS },
          storageState: this.authStateJson as any,
        });
        await context.addInitScript(BROWSER_STEALTH_SCRIPT);
        this.activeContexts.add(context);
        logger.debug('[STATE_MANAGER] Created authenticated context from cached state');
        return context;
      } catch (error) {
        logger.warn('[STATE_MANAGER] Failed to restore auth state, creating clean context', {
          error: error instanceof Error ? error.message : String(error),
        });
        // Fall through to clean context
      }
    }

    // No cached auth state — return clean context
    return this.createCleanContext();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // AUTH STATE MANAGEMENT
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Pre-seed the auth state from an externally-supplied storageState object
   * (e.g. a user-exported fixture). After this, createAuthenticatedContext()
   * returns pre-authenticated contexts and FlowRunner skips performLogin()
   * thanks to hasAuthState() returning true.
   *
   * Safe to call even when the fixture is empty — we still mark the state
   * as present so the login flow is skipped (the engine decides whether
   * to preload based on isAuthFixtureNonEmpty before calling us).
   */
  preloadAuthState(state: object): void {
    this.authStateJson = state;
    try {
      this.cachedAuthState = JSON.stringify(state);
    } catch {
      // Non-serializable state should never reach here (validator rejects
      // it), but degrade gracefully instead of crashing the whole run.
      this.cachedAuthState = null;
    }
    logger.info('[STATE_MANAGER] Auth state preloaded from fixture');
  }

  /**
   * Save the auth state from a context after successful login.
   * Subsequent calls to createAuthenticatedContext() will use this state.
   */
  async saveAuthState(context: BrowserContext): Promise<void> {
    try {
      const state = await context.storageState();
      this.authStateJson = state;
      this.cachedAuthState = JSON.stringify(state);
      logger.info('[STATE_MANAGER] Auth state cached', {
        cookies: state.cookies?.length || 0,
        origins: state.origins?.length || 0,
      });
    } catch (error) {
      logger.warn('[STATE_MANAGER] Failed to save auth state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Whether auth state has been cached.
   */
  hasAuthState(): boolean {
    return this.authStateJson !== null;
  }

  /**
   * Clear cached auth state (e.g., if session expired).
   */
  clearAuthState(): void {
    this.cachedAuthState = null;
    this.authStateJson = null;
    logger.debug('[STATE_MANAGER] Auth state cleared');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CONTEXT LIFECYCLE
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Close a browser context and remove from tracking.
   */
  async closeContext(context: BrowserContext): Promise<void> {
    try {
      this.activeContexts.delete(context);
      await context.close();
    } catch {
      // Context may already be closed
    }
  }

  /**
   * Close all active contexts (cleanup on exploration completion).
   */
  async closeAll(): Promise<void> {
    const contexts = Array.from(this.activeContexts);
    this.activeContexts.clear();

    await Promise.allSettled(
      contexts.map((ctx) => ctx.close().catch(() => {})),
    );

    logger.debug('[STATE_MANAGER] All contexts closed', { count: contexts.length });
  }

  /**
   * Number of active contexts.
   */
  activeCount(): number {
    return this.activeContexts.size;
  }
}
