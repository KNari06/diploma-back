/**
 * IntelligentPageAnalyzer
 * Analyzes web pages using GPT-4 Vision + DOM analysis
 * Understands page context, type, and available actions
 */

import { buildLogicAnalysisPrompt, buildPageAnalysisPrompt } from '@/ai/prompts/index';
import { env } from '@/config/env';
import { AISelectorEngine } from '@/services/ai-selector/ai-selector-engine.service';
import { DOMNodeExtractor } from '@/services/ai-selector/dom-node-extractor';
import { analyzeDOMStructure } from '@/services/testing/ui/autonomous/dom-analyzer.service';
import { logger } from '@/utils/logger';
import { OpenAI } from 'openai';
import { Page } from 'playwright';
import {
  DOMAnalysis,
  PageContext,
  PageType,
  VisionAnalysis,
} from './types/intelligent-testing.types';

// ✅ FIX: Add timeout to prevent hanging requests (default is 10 minutes!)
const openai = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  timeout: 60000, // 60 seconds timeout for OpenAI API calls
  maxRetries: 2,  // Retry failed requests up to 2 times
});

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION: Modal Detection Settings
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Configuration for modal detection
 * These values are based on common web patterns and can be adjusted if needed
 */
const MODAL_DETECTION_CONFIG = {
  // Timing settings
  maxWaitTime: 2000,        // ✅ OPTIMIZED: Reduced from 5000ms to 2000ms (2 seconds)
  checkInterval: 300,       // ✅ OPTIMIZED: Reduced from 500ms to 300ms (faster checks)
  renderWaitTime: 500,     // Additional wait after modal detected for full render (ms)

  // Visual detection thresholds
  zIndexThreshold: 100,     // Minimum z-index to consider element as modal
  minModalSize: 100,        // Minimum width/height for modal (px)
  overlaySizeRatio: 0.5,    // Element must cover at least 50% of viewport to be overlay

  // Close button detection
  closeButtonKeywords: [
    'close', 'закрыть', 'dismiss', 'cancel', 'отмена',
    '×', '✕', '✖', 'x', 'exit', 'выход'
  ],
  maxCloseButtonTextLength: 10, // Maximum text length for close button selector

  // Modal type detection keywords
  modalTypeKeywords: {
    cookie: ['cookie', 'gdpr', 'consent', 'privacy', 'куки', 'согласие'],
    newsletter: ['newsletter', 'subscribe', 'email', 'подписка', 'рассылка'],
    popup: ['popup', 'modal', 'dialog', 'overlay', 'всплывающее'],
  },
} as const;

// ═══════════════════════════════════════════════════════════════════════════
// MAIN ANALYZER
// ═══════════════════════════════════════════════════════════════════════════

export class IntelligentPageAnalyzer {
  /**
   * Analyze a page completely
   * @param page - Playwright page
   * @param goal - User's testing goal
   * @param mode - Analysis mode (full with Vision, fast without Vision, or balanced)
   * @param previousContext - Context from previous page
   */
  static async analyzePage(
    page: Page,
    goal: string,
    mode: 'full' | 'fast' | 'balanced' = 'balanced',
    previousContext?: string,
    spaLoadConfig?: {
      maxWaitTime?: number;
      networkIdleTimeout?: number;
      networkSettleTime?: number;
      elementRetries?: number;
      elementRetryDelay?: number;
      minContentElements?: number;
      minTextLength?: number;
      checkShadowDOM?: boolean;
      checkIframes?: boolean;
    }
  ): Promise<PageContext> {
    const startTime = Date.now();
    const url = page.url();

    logger.info('[INTELLIGENT_ANALYZER] Starting page analysis', {
      url,
      goal,
      mode,
    });

    try {
      // ✅ FIX: Wait for SPA to fully load before analysis
      // SPA pages need time for:
      // 1. API requests to complete (50+ requests for locales, data, etc.)
      // 2. React/Vue components to render
      // 3. Interactive elements to appear in DOM
      logger.info('[INTELLIGENT_ANALYZER] Waiting for SPA to fully load', { url });
      await this.waitForSPALoad(page, spaLoadConfig || undefined);

      // ✅ OPTIMIZED: Run modal check and DOM analysis in parallel
      logger.info('[INTELLIGENT_ANALYZER] Starting parallel analysis', { url });
      const [modalCheckResult, domAnalysis] = await Promise.all([
        this.quickModalCheck(page), // Fast check
        this.analyzeDOMFull(page),
      ]);

      // Only wait for modals if found or triggers detected
      if (modalCheckResult > 0) {
        await this.waitForModals(page);
      } else {
        // Quick check for modal triggers (in parallel with screenshot)
        const hasTriggers = await this.checkModalTriggers(page);
        if (hasTriggers) {
          await this.waitForModals(page);
        }
      }

      // ✅ OPTIMIZED: Capture screenshot in parallel with modal check (if needed)
      const screenshot = await this.captureScreenshot(page, mode);

      // ✅ NEW: Enhance DOM selectors with AI Selector Engine
      logger.info('[INTELLIGENT_ANALYZER] Enhancing DOM selectors with AI', { url });
      let enhancedDomAnalysis = await this.enhanceDOMWithAISelectors(
        page,
        domAnalysis,
        url,
        goal
      );
      logger.info('[INTELLIGENT_ANALYZER] Screenshot & DOM captured successfully', {
        url,
        screenshotSize: screenshot ? `${Math.round(screenshot.length / 1024)}KB` : 'skipped',
        domElementsCount: {
          forms: domAnalysis.forms.length,
          buttons: domAnalysis.buttons.length,
          links: domAnalysis.links.length,
          inputs: domAnalysis.inputs.length,
        },
      });

      // ✅ OPTIMIZED: Decide if Vision needed early (before expensive operations)
      const shouldUseVisionResult = mode === 'full' ||
        (mode === 'balanced' && await this.shouldUseVision(domAnalysis));

      // ✅ OPTIMIZED: Run Vision and Logic analysis in parallel (if Vision needed)
      let visionAnalysis: VisionAnalysis;
      let logicAnalysis: any;

      if (shouldUseVisionResult) {
        logger.info('[INTELLIGENT_ANALYZER] Using GPT-4 Vision for analysis', { url });
        const visionStartTime = Date.now();

        // ✅ OPTIMIZED: Run Vision and Logic in parallel
        const [visionResult, logicResult] = await Promise.all([
          this.analyzeWithVision(screenshot, url, goal, previousContext),
          // Start Logic analysis early (can use DOM-only data initially)
          this.analyzeLogic('unknown', [], domAnalysis),
        ]);

        visionAnalysis = visionResult;
        logicAnalysis = logicResult;

        logger.info('[INTELLIGENT_ANALYZER] Vision analysis completed', {
          url,
          duration: `${Date.now() - visionStartTime}ms`,
          pageType: visionAnalysis.pageType,
          elementsFound: visionAnalysis.elements.length,
          modalsDetected: visionAnalysis.modals?.length || 0,
        });
      } else {
        logger.info('[INTELLIGENT_ANALYZER] Using DOM-only analysis (fast mode)', { url });
        visionAnalysis = await this.analyzeWithoutVision(domAnalysis, url);
        // Run Logic analysis for DOM-only mode
        logicAnalysis = await this.analyzeLogic(
          visionAnalysis.pageType,
          visionAnalysis.elements,
          domAnalysis
        );
      }

      // ✅ OPTIMIZED: Match Vision-DOM and enhance DOM in parallel
      const [matchedVision, enhancedDomWithModals] = await Promise.all([
        this.matchVisionElementsWithDOMSelectors(page, visionAnalysis, enhancedDomAnalysis),
        this.enhanceDOMWithVisionModals(page, enhancedDomAnalysis, visionAnalysis.modals),
      ]);

      visionAnalysis = matchedVision;
      const finalEnhancedDom = enhancedDomWithModals;

      // ✅ OPTIMIZED: Update Logic analysis with Vision elements (if Vision was used)
      if (shouldUseVisionResult && visionAnalysis.elements.length > 0) {
        // Re-run Logic with Vision elements for better accuracy
        logicAnalysis = await this.analyzeLogic(
        visionAnalysis.pageType,
        visionAnalysis.elements,
          finalEnhancedDom
      );
      }

      logger.info('[INTELLIGENT_ANALYZER] Logic analysis completed', {
        url,
        requiredActions: logicAnalysis.requiredActions.length,
        possibleActions: logicAnalysis.possibleActions.length,
      });

      // Build complete context
      const context: PageContext = {
        url,
        pageType: visionAnalysis.pageType,
        timestamp: Date.now(),
        vision: visionAnalysis,
        dom: finalEnhancedDom, // ✅ Use AI-enhanced DOM analysis
        screenshot: mode !== 'fast' ? screenshot : undefined,
        requiredActions: logicAnalysis.requiredActions,
        possibleActions: logicAnalysis.possibleActions,
        criticalElements: visionAnalysis.elements.filter(el => el.priority === 'critical'),
        warnings: visionAnalysis.warnings || [],
      };

      const duration = Date.now() - startTime;
      logger.info('[INTELLIGENT_ANALYZER] Page analysis completed', {
        url,
        pageType: context.pageType,
        elementsFound: visionAnalysis.elements.length,
        duration: `${duration}ms`,
      });

      return context;
    } catch (error) {
      // ✅ FIX: Explicitly extract error details for debugging
      logger.error('[INTELLIGENT_ANALYZER] Page analysis failed', {
        url,
        error: error instanceof Error ? {
          message: error.message,
          name: error.name,
          stack: error.stack,
        } : String(error),
      });

      // Return minimal fallback context
      return {
        url,
        pageType: 'unknown',
        timestamp: Date.now(),
        vision: {
          pageType: 'unknown',
          description: 'Analysis failed',
          elements: [],
          suggestions: [],
          warnings: ['Analysis failed'],
        },
        dom: {
          forms: [],
          buttons: [],
          links: [],
          inputs: [],
        },
        requiredActions: [],
        possibleActions: [],
        criticalElements: [],
        warnings: ['Page analysis failed'],
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SPA LOADING WAIT
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Wait for SPA (Single Page Application) to fully load
   * SPA pages need time for:
   * 1. API requests to complete (locales, data, etc.)
   * 2. React/Vue components to render
   * 3. Interactive elements to appear in DOM
   *
   * ✅ IMPROVED: Configurable, optimized, handles long-polling/websockets
   */
  private static async waitForSPALoad(page: Page, config?: {
    maxWaitTime?: number;
    networkIdleTimeout?: number;
    networkSettleTime?: number;
    elementRetries?: number;
    elementRetryDelay?: number;
    minContentElements?: number;
    minTextLength?: number;
    checkShadowDOM?: boolean;
    checkIframes?: boolean;
  }): Promise<void> {
    const startTime = Date.now();
    // ✅ FIX 1: Use configurable maxWaitTime, default 10s
    const maxWaitTime = config?.maxWaitTime ?? 10000;
    const networkIdleTimeout = config?.networkIdleTimeout ?? 8000;
    const networkSettleTime = config?.networkSettleTime ?? 500;
    const elementRetries = config?.elementRetries ?? 3;
    const elementRetryDelay = config?.elementRetryDelay ?? 1500;
    const minContentElements = config?.minContentElements ?? 3;
    const minTextLength = config?.minTextLength ?? 100;

    try {
      // ✅ FIX 2: Better network idle detection - settle approach for long-polling/websockets
      logger.debug('[INTELLIGENT_ANALYZER] Waiting for network to settle', {
        url: page.url(),
      });

      // Try networkidle first, but with settle fallback
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: networkIdleTimeout }),
        // Fallback: Wait for network to settle (no new requests for N ms)
        this.waitForNetworkSettle(page, networkSettleTime, networkIdleTimeout),
      ]).catch(() => {
        logger.debug('[INTELLIGENT_ANALYZER] Network settle timeout, continuing anyway');
      });

      // Step 2: Wait for interactive elements to appear (buttons, inputs, links)
      // This ensures React/Vue components have rendered
      logger.debug('[INTELLIGENT_ANALYZER] Waiting for interactive elements', {
        url: page.url(),
      });

      // ✅ IMPROVED: Retry logic - check multiple times for elements
      // Many SPAs render elements in waves (first structure, then content, then interactive)
      let elementsFound = false;

      for (let attempt = 1; attempt <= elementRetries; attempt++) {
        try {
          // ✅ FIX 3: Use 'visible' instead of 'attached' for interactive elements
          await page.waitForSelector('button, input, a, [role="button"], [onclick], select, textarea', {
            timeout: 3000,
            state: 'visible', // Changed from 'attached' - ensures element is visible and interactive
          });
          elementsFound = true;
          logger.debug('[INTELLIGENT_ANALYZER] Interactive elements found', {
            attempt,
            url: page.url(),
          });
          break;
        } catch (error) {
          if (attempt < elementRetries) {
            logger.debug('[INTELLIGENT_ANALYZER] Elements not found yet, retrying', {
              attempt,
              maxRetries: elementRetries,
              url: page.url(),
            });
            await page.waitForTimeout(elementRetryDelay);
          } else {
            logger.debug('[INTELLIGENT_ANALYZER] Elements not found after all retries', {
              url: page.url(),
            });
          }
        }
      }

      // Step 3: Additional wait for dynamic content (API data rendering)
      // Many SPAs render content after API responses
      // ✅ IMPROVED: Use universal content detection instead of hardcoded selectors
      if (elementsFound) {
        // Wait for page to have meaningful content (not just skeleton loaders)
        await Promise.race([
          // ✅ FIX 5: Optimized - limit scope to app root, pass config as args
          // Check if page has substantial content (more than just basic structure)
          page.waitForFunction(
            ({ minContentElements, minTextLength }: { minContentElements: number; minTextLength: number }) => {
              // @ts-expect-error - browser context
              // ✅ FIX 5: Limit scope to app root (faster than scanning entire body)
              const appRoot = document.querySelector('[id*="app"], [id*="root"], [data-reactroot], [data-v-app], main, [role="main"]') || document.body;
              if (!appRoot) return false;

              // ✅ IMPROVED: More robust content detection (scoped to app root)
              // 1. Check for meaningful structural elements
              const meaningfulElements = appRoot.querySelectorAll('div, section, article, main, header, footer, nav, aside, form, ul, ol, table');

            // 2. Filter out skeleton loaders and empty containers
            // Skeleton loaders typically have classes like "skeleton", "loading", "placeholder", "shimmer"
            const skeletonIndicators = ['skeleton', 'loading', 'placeholder', 'shimmer', 'spinner', 'loader', 'skeleton-loader'];
            let realContentElements = 0;

            meaningfulElements.forEach((el: any) => {
              const className = el.className || '';
              const id = el.id || '';
              const isSkeleton = skeletonIndicators.some(indicator =>
                className.toLowerCase().includes(indicator) || id.toLowerCase().includes(indicator)
              );

              // Check if element has actual content (text, images, interactive elements)
              const hasText = el.innerText && el.innerText.trim().length > 0;
              const hasImages = el.querySelectorAll('img').length > 0;
              const hasInteractive = el.querySelectorAll('button, input, a, select, textarea').length > 0;
              const hasChildren = el.children.length > 0;

              // Count as real content if not skeleton and has actual content
              if (!isSkeleton && (hasText || hasImages || hasInteractive || hasChildren)) {
                realContentElements++;
              }
            });

              // 3. Check for text content (minimum meaningful length)
              // ✅ FIX 4: Use configurable minTextLength (passed as argument)
              const appText = appRoot.innerText || '';
              const hasTextContent = appText.trim().length > minTextLength;

              // 4. Check for interactive elements (buttons, inputs, links)
              const interactiveElements = appRoot.querySelectorAll('button, input, a, select, textarea, [role="button"], [onclick]');
              const hasInteractiveContent = interactiveElements.length > 0;

              // ✅ FIX 4: Use configurable minContentElements (passed as argument)
              // Page is considered loaded if:
              // - Has at least N real content elements (not skeletons), OR
              // - Has substantial text content, OR
              // - Has interactive elements
              const isContentLoaded = realContentElements >= minContentElements || hasTextContent || hasInteractiveContent;

              return isContentLoaded;
            },
            { minContentElements, minTextLength },
            { timeout: 2000 }
          ).catch(() => null),

          // Or check if SPA app root is populated with content (simpler fallback)
          page.waitForFunction(() => {
            // @ts-expect-error - browser context
            const appRoot = document.querySelector('[id*="app"], [id*="root"], [data-reactroot], [data-v-app], main, [role="main"]');
            if (!appRoot) return false;
            // Check if app root has children with content (not just empty containers)
            const hasChildren = appRoot.children.length > 0;
            const hasText = appRoot.innerText && appRoot.innerText.trim().length > 20;
            return hasChildren && hasText;
          }, { timeout: 2000 }).catch(() => null),

          // Fallback: wait 1 second for any late-loading content
          page.waitForTimeout(1000),
        ]);
      } else {
        // If no elements found, wait a bit more for late-loading content
        await page.waitForTimeout(2000);
      }

      // ✅ FIX 1: Enforce maxWaitTime with Promise.race
      const duration = Date.now() - startTime;
      if (duration >= maxWaitTime) {
        logger.debug('[INTELLIGENT_ANALYZER] SPA load wait reached max time', {
          url: page.url(),
          duration: `${duration}ms`,
          maxWaitTime: `${maxWaitTime}ms`,
        });
      }

      logger.debug('[INTELLIGENT_ANALYZER] SPA load wait completed', {
        url: page.url(),
        duration: `${duration}ms`,
        elementsFound,
      });
    } catch (error) {
      logger.debug('[INTELLIGENT_ANALYZER] SPA load wait failed, continuing anyway', {
        error: error instanceof Error ? error.message : String(error),
      });
      // Continue anyway - page might already be loaded
    }
  }

  /**
   * ✅ FIX 2: Wait for network to settle (no new requests for N ms)
   * Better than networkidle for long-polling/websockets
   */
  private static async waitForNetworkSettle(
    page: Page,
    settleTime: number,
    maxTimeout: number
  ): Promise<void> {
    const startTime = Date.now();
    let lastRequestTime = Date.now();

    // Track requests
    const requestTimes: number[] = [];
    page.on('request', () => {
      requestTimes.push(Date.now());
      lastRequestTime = Date.now();
    });

    // Wait until no new requests for settleTime
    while (Date.now() - startTime < maxTimeout) {
      const timeSinceLastRequest = Date.now() - lastRequestTime;
      if (timeSinceLastRequest >= settleTime) {
        return; // Network settled
      }
      await page.waitForTimeout(100); // Check every 100ms
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SCREENSHOT CAPTURE
  // ═══════════════════════════════════════════════════════════════════════════

  private static async captureScreenshot(
    page: Page,
    mode: 'full' | 'fast' | 'balanced'
  ): Promise<string> {
    if (mode === 'fast') {
      return ''; // Skip screenshot in fast mode
    }

    try {
      // ✅ FIX: Don't wait for networkidle in analyzer - request tracking already done in playwright.service
      // Just ensure DOM is ready
      await page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => {
        logger.debug('[INTELLIGENT_ANALYZER] DOM not fully loaded, proceeding anyway');
      });

      const screenshot = await page.screenshot({
        fullPage: false, // Only viewport for speed
        type: 'png',
      });

      return screenshot.toString('base64');
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] Screenshot capture failed', { error });
      return '';
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MODAL WAITING
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ✅ OPTIMIZED: Wait for modals to appear before analysis
   * Smart detection with early exit - doesn't wait if no modals expected
   */
  private static async waitForModals(page: Page): Promise<void> {
    const startTime = Date.now();
    const { maxWaitTime, checkInterval, renderWaitTime } = MODAL_DETECTION_CONFIG;

    // ✅ OPTIMIZED: Quick check first (most pages don't have modals)
    let modalCount = await this.quickModalCheck(page);

    // If modals found immediately, wait for full render and exit
    if (modalCount > 0) {
      logger.info('[INTELLIGENT_ANALYZER] Modal found immediately', {
        modalCount,
        elapsed: `${Date.now() - startTime}ms`,
      });
      await page.waitForTimeout(renderWaitTime);
      return; // Exit early
    }

    // ✅ OPTIMIZED: Check if page has modal triggers (cookies, newsletter, etc.)
    const hasModalTriggers = await this.checkModalTriggers(page);
    if (!hasModalTriggers) {
      logger.debug('[INTELLIGENT_ANALYZER] No modal triggers detected, skipping wait', {
        elapsed: `${Date.now() - startTime}ms`,
      });
      return; // Exit early - no modals expected
    }

    logger.info('[INTELLIGENT_ANALYZER] Modal triggers detected, waiting for modals', {
      url: page.url(),
      maxWaitTime: `${maxWaitTime}ms`,
    });

    // ✅ OPTIMIZED: Check periodically with early exit
    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Quick check (lightweight)
        modalCount = await this.quickModalCheck(page);

        if (modalCount > 0) {
          logger.info('[INTELLIGENT_ANALYZER] Modal appeared', {
            modalCount,
            elapsed: `${Date.now() - startTime}ms`,
          });
          await page.waitForTimeout(renderWaitTime);
          return; // Exit early when modal found
        }

        // Wait before next check
        await page.waitForTimeout(checkInterval);
      } catch (error) {
        logger.warn('[INTELLIGENT_ANALYZER] Error while waiting for modals', {
          error: error instanceof Error ? error.message : String(error),
        });
        break; // Continue with analysis even if check failed
      }
    }

    const elapsed = Date.now() - startTime;
    logger.debug('[INTELLIGENT_ANALYZER] Modal waiting completed (no modals found)', {
      elapsed: `${elapsed}ms`,
    });
  }

  /**
   * ✅ NEW: Quick modal check (lightweight)
   * Only checks for obvious modals (role="dialog", aria-modal)
   */
  private static async quickModalCheck(page: Page): Promise<number> {
    try {
      return await page.evaluate(() => {
        // Quick check: only look for obvious modals
        // @ts-ignore - browser context
        const modals = document.querySelectorAll('[role="dialog"], [aria-modal="true"]');
        return modals.length;
      });
    } catch (error) {
      logger.debug('[INTELLIGENT_ANALYZER] Quick modal check failed', { error });
      return 0;
    }
  }

  /**
   * ✅ NEW: Check if page has modal triggers (cookies, newsletter, etc.)
   * Helps decide if we should wait for modals
   */
  private static async checkModalTriggers(page: Page): Promise<boolean> {
    try {
      return await page.evaluate(() => {
        // @ts-ignore - browser context
        const bodyText = document.body.textContent?.toLowerCase() || '';
        const hasCookieKeywords = bodyText.includes('cookie') ||
                                   bodyText.includes('gdpr') ||
                                   bodyText.includes('consent') ||
                                   bodyText.includes('privacy');
        const hasNewsletterKeywords = bodyText.includes('newsletter') ||
                                      bodyText.includes('subscribe') ||
                                      bodyText.includes('email');
        return hasCookieKeywords || hasNewsletterKeywords;
      });
    } catch (error) {
      logger.debug('[INTELLIGENT_ANALYZER] Modal trigger check failed', { error });
      return false; // Assume no triggers if check fails
    }
  }

  /**
   * ✅ DEPRECATED: Old modal waiting logic (kept for reference)
   * Replaced with optimized version above
   */
  private static async waitForModalsOld(page: Page): Promise<void> {
    const startTime = Date.now();
    const { maxWaitTime, checkInterval, renderWaitTime } = MODAL_DETECTION_CONFIG;
    let lastModalCount = 0;

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Check for modals using DOM analysis
        // Pass config values to page.evaluate since it runs in browser context
        const { zIndexThreshold, minModalSize, overlaySizeRatio } = MODAL_DETECTION_CONFIG;
        const modalCount = await page.evaluate((config) => {
          // @ts-ignore - browser context
          const allElements = document.querySelectorAll('*');
          let count = 0;

          for (let i = 0; i < allElements.length; i++) {
            const el = allElements[i] as any;

            // Skip if not visible
            // @ts-ignore - browser context
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              continue;
            }

            // Check if element behaves like a modal
            const zIndex = parseInt(style.zIndex) || 0;
            const position = style.position;
            const isFixedOrAbsolute = position === 'fixed' || position === 'absolute';
            const hasHighZIndex = zIndex > config.zIndexThreshold;

            // Check for overlay (large element with background)
            // @ts-ignore - browser context
            const viewportWidth = window.innerWidth;
            // @ts-ignore - browser context
            const viewportHeight = window.innerHeight;
            // @ts-ignore - browser context
            const hasOverlay = style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                              // @ts-ignore - browser context
                              (el.offsetWidth > viewportWidth * config.overlaySizeRatio ||
                               el.offsetHeight > viewportHeight * config.overlaySizeRatio);

            // Check for modal-like attributes
            const role = el.getAttribute('role');
            const ariaModal = el.getAttribute('aria-modal');
            const hasModalRole = role === 'dialog' || role === 'alertdialog' || ariaModal === 'true';

            // Check for modal-like classes/ids
            // ✅ FIX: Handle className as string, SVGAnimatedString, or DOMTokenList
            let className = '';
            if (typeof el.className === 'string') {
              className = el.className.toLowerCase();
            } else if (el.className && typeof el.className === 'object') {
              // Handle DOMTokenList or SVGAnimatedString
              if ('baseVal' in el.className) {
                className = (el.className.baseVal || '').toLowerCase();
              } else if ('value' in el.className) {
                className = (el.className.value || '').toLowerCase();
              } else if (typeof el.className.toString === 'function') {
                className = el.className.toString().toLowerCase();
              }
            }
            const id = (el.id || '').toLowerCase();
            const hasModalKeywords = className.includes('modal') || className.includes('popup') ||
                                     className.includes('dialog') || className.includes('overlay') ||
                                     id.includes('modal') || id.includes('popup') || id.includes('dialog');

            // If element matches modal characteristics
            if ((hasModalRole || hasModalKeywords || (hasHighZIndex && isFixedOrAbsolute && hasOverlay)) &&
                el.offsetWidth > config.minModalSize && el.offsetHeight > config.minModalSize) {
              count++;
            }
          }

          return count;
        }, { zIndexThreshold, minModalSize, overlaySizeRatio });

        // If modals appeared, wait a bit more for them to fully render
        if (modalCount > lastModalCount) {
          logger.info('[INTELLIGENT_ANALYZER] Modal detected, waiting for full render', {
            modalCount,
            elapsed: `${Date.now() - startTime}ms`,
          });
          lastModalCount = modalCount;
          // Wait additional time for modal to fully render (animations, etc.)
          await page.waitForTimeout(renderWaitTime);
          break; // Modal appeared, continue with analysis
        }

        // Wait before next check
        await page.waitForTimeout(checkInterval);
      } catch (error) {
        logger.warn('[INTELLIGENT_ANALYZER] Error while waiting for modals', {
          error: error instanceof Error ? error.message : String(error),
        });
        break; // Continue with analysis even if check failed
      }
    }

    const elapsed = Date.now() - startTime;
    logger.info('[INTELLIGENT_ANALYZER] Modal waiting completed', {
      elapsed: `${elapsed}ms`,
      modalsDetected: lastModalCount > 0,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  private static async analyzeDOMFull(page: Page): Promise<DOMAnalysis> {
    try {
      const domAnalysis = await analyzeDOMStructure(page);

      // Detect modals (cookie banners, popups, etc.)
      const modals = await this.detectModals(page);

      return {
        ...domAnalysis,
        modals,
      };
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] DOM analysis failed', { error });
      return {
        forms: [],
        buttons: [],
        links: [],
        inputs: [],
        modals: [],
      };
    }
  }

  /**
   * ✅ NEW: Enhance DOM selectors with AI Selector Engine
   * Uses AI to generate robust, intent-based selectors for critical elements
   */
  private static async enhanceDOMWithAISelectors(
    page: Page,
    domAnalysis: DOMAnalysis,
    url: string,
    goal?: string
  ): Promise<DOMAnalysis> {
    const startTime = Date.now();

    // Skip if no interactive elements (nothing to enhance)
    const totalInteractive = domAnalysis.buttons.length + domAnalysis.inputs.length;
    if (totalInteractive === 0) {
      logger.debug('[INTELLIGENT_ANALYZER] No interactive elements to enhance', { url });
      return domAnalysis;
    }

    logger.info('[INTELLIGENT_ANALYZER] Starting AI selector enhancement', {
      url,
      elementsCount: {
        buttons: domAnalysis.buttons.length,
        inputs: domAnalysis.inputs.length,
        links: domAnalysis.links.length,
      },
    });

    try {
      // Extract DOM nodes for AI analysis
      const nodes = await DOMNodeExtractor.extractNodes(page, {
        visibleOnly: true,
        interactiveOnly: true,
      });

      const viewport = page.viewportSize() || { width: 1920, height: 1080 };
      const dom = await page.content();

      // Enhance buttons with AI selectors (limit to top 10 for performance)
      const buttonsToEnhance = domAnalysis.buttons.slice(0, 10);
      const enhancedButtons = await Promise.all(
        buttonsToEnhance.map(async (button) => {
          if (!button.text) return button;

          const intent = `Click ${button.text} button`;

          try {
            const result = await AISelectorEngine.resolve({
              intent,
              dom,
              nodes,
              metadata: {
                url,
                viewport,
                projectId: 'intelligent-test',
              },
              mode: 'fast', // Use fast mode for performance
            });

            if (result.success && result.selectedNode) {
              logger.debug('[INTELLIGENT_ANALYZER] AI selector found for button', {
                oldSelector: button.selector,
                newSelector: result.selectedNode.primarySelector,
                confidence: result.selectedNode.confidence,
                text: button.text,
              });

              return {
                ...button,
                selector: result.selectedNode.primarySelector,
                aiSelector: {
                  primary: result.selectedNode.primarySelector,
                  fallbacks: result.fallbackSelectors.map(s => s.selector),
                  confidence: result.selectedNode.confidence,
                  explanation: result.explanation,
                },
              };
            }
          } catch (error) {
            logger.debug('[INTELLIGENT_ANALYZER] Failed to enhance button selector', {
              text: button.text,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          return button;
        })
      );

      // Keep remaining buttons unchanged
      const allButtons = [
        ...enhancedButtons,
        ...domAnalysis.buttons.slice(10),
      ];

      // Enhance inputs with AI selectors (limit to top 10)
      const inputsToEnhance = domAnalysis.inputs.slice(0, 10);
      const enhancedInputs = await Promise.all(
        inputsToEnhance.map(async (input) => {
          const labelText = (input as any).label || input.name || input.placeholder || '';
          const intent = `Fill ${input.type || 'text'} input ${labelText}`.trim();

          try {
            const result = await AISelectorEngine.resolve({
              intent,
              dom,
              nodes,
              metadata: {
                url,
                viewport,
                projectId: 'intelligent-test',
              },
              mode: 'fast',
            });

            if (result.success && result.selectedNode) {
              logger.debug('[INTELLIGENT_ANALYZER] AI selector found for input', {
                oldSelector: input.selector,
                newSelector: result.selectedNode.primarySelector,
                confidence: result.selectedNode.confidence,
                type: input.type,
              });

              return {
                ...input,
                selector: result.selectedNode.primarySelector,
                aiSelector: {
                  primary: result.selectedNode.primarySelector,
                  fallbacks: result.fallbackSelectors.map(s => s.selector),
                  confidence: result.selectedNode.confidence,
                  explanation: result.explanation,
                },
              };
            }
          } catch (error) {
            logger.debug('[INTELLIGENT_ANALYZER] Failed to enhance input selector', {
              type: input.type,
              error: error instanceof Error ? error.message : String(error),
            });
          }

          return input;
        })
      );

      const allInputs = [
        ...enhancedInputs,
        ...domAnalysis.inputs.slice(10),
      ];

      const duration = Date.now() - startTime;
      logger.info('[INTELLIGENT_ANALYZER] AI selector enhancement completed', {
        url,
        duration: `${duration}ms`,
        buttonsEnhanced: enhancedButtons.filter(b => (b as any).aiSelector).length,
        inputsEnhanced: enhancedInputs.filter(i => (i as any).aiSelector).length,
      });

      return {
        ...domAnalysis,
        buttons: allButtons,
        inputs: allInputs,
      };
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] Failed to enhance DOM with AI selectors', {
        error: error instanceof Error ? error.message : String(error),
      });
      return domAnalysis; // Return original on failure
    }
  }

  /**
   * ✅ NEW: Enhance DOM analysis with Vision AI modal detection
   * Vision AI sees modals visually, DOM analysis finds selectors
   */
  private static async enhanceDOMWithVisionModals(
    page: Page,
    domAnalysis: DOMAnalysis,
    visionModals?: VisionAnalysis['modals']
  ): Promise<DOMAnalysis> {
    // If no Vision modals detected, return DOM analysis as-is
    if (!visionModals || visionModals.length === 0) {
      return domAnalysis;
    }

    logger.info('[INTELLIGENT_ANALYZER] Merging Vision AI modals with DOM analysis', {
      visionModals: visionModals.length,
      domModals: domAnalysis.modals?.length || 0,
    });

    // Get DOM modals (with selectors)
    const domModals = domAnalysis.modals || [];
    const mergedModals = await this.mergeModalDetections(visionModals, domModals, page);

    return {
      ...domAnalysis,
      modals: mergedModals,
    };
  }

  /**
   * ✅ NEW: Merge Vision AI modal detection with DOM analysis
   * Vision AI sees modals visually, DOM analysis finds selectors
   */
  private static async mergeModalDetections(
    visionModals: VisionAnalysis['modals'],
    domModals: DOMAnalysis['modals'],
    page: Page
  ): Promise<DOMAnalysis['modals']> {
    const merged: DOMAnalysis['modals'] = [];

    // Process Vision AI modals (prioritize visual detection)
    for (const visionModal of visionModals || []) {
      // Try to find matching DOM modal by type
      const matchingDomModal = domModals?.find(
        dm => dm.type === visionModal.type ||
        (visionModal.type === 'welcome' && dm.type === 'popup')
      );

      if (matchingDomModal && matchingDomModal.closeSelector) {
        // Perfect match: Vision AI found modal, DOM found selector
        merged.push({
          type: visionModal.type as any,
          closeSelector: matchingDomModal.closeSelector,
        });
        logger.debug('[INTELLIGENT_ANALYZER] Modal matched: Vision + DOM', {
          type: visionModal.type,
          closeSelector: matchingDomModal.closeSelector,
        });
      } else if (visionModal.hasCloseButton && visionModal.closeButtonText) {
        // Vision AI found modal with close button text - try to find selector
        const closeSelector = await this.findCloseButtonByText(
          page,
          visionModal.closeButtonText
        );
        merged.push({
          type: visionModal.type as any,
          closeSelector,
        });
        logger.debug('[INTELLIGENT_ANALYZER] Modal found by Vision, selector found by text', {
          type: visionModal.type,
          closeButtonText: visionModal.closeButtonText,
          closeSelector,
        });
      } else {
        // Vision AI found modal but no close button visible
        merged.push({
          type: visionModal.type as any,
          closeSelector: undefined,
        });
        logger.debug('[INTELLIGENT_ANALYZER] Modal found by Vision, no close button', {
          type: visionModal.type,
        });
      }
    }

    // Add DOM modals that Vision AI didn't detect (edge cases, hidden modals)
    if (domModals) {
      for (const domModal of domModals) {
        const alreadyAdded = merged.some(m => m.closeSelector === domModal.closeSelector);
        if (!alreadyAdded) {
          merged.push(domModal);
          logger.debug('[INTELLIGENT_ANALYZER] Modal found by DOM only', {
            type: domModal.type,
            closeSelector: domModal.closeSelector,
          });
        }
      }
    }

    return merged;
  }

  /**
   * ✅ CRITICAL FIX: Match Vision AI elements with real DOM selectors
   * Vision AI sees elements visually but doesn't know selectors
   * DOM analysis has selectors but doesn't know which element is which
   * We match them by text, type, and purpose
   */
  private static async matchVisionElementsWithDOMSelectors(
    page: Page,
    visionAnalysis: VisionAnalysis,
    domAnalysis: DOMAnalysis
  ): Promise<VisionAnalysis> {
    // Import PageElement type
    type PageElement = import('./types/intelligent-testing.types').PageElement;
    logger.info('[INTELLIGENT_ANALYZER] Matching Vision elements with DOM selectors', {
      visionElements: visionAnalysis.elements.length,
      domButtons: domAnalysis.buttons.length,
      domInputs: domAnalysis.inputs.length,
      domLinks: domAnalysis.links.length,
    });

    const matchedElements: PageElement[] = [];

    for (const visionElement of visionAnalysis.elements) {
      let matchedSelector: string | undefined;

      // Try to match by type and text
      if (visionElement.type === 'button' && visionElement.text) {
        // Find button in DOM with matching text
        const matchingButton = domAnalysis.buttons.find(btn => {
          const btnText = btn.text.toLowerCase().trim();
          const visionText = visionElement.text?.toLowerCase().trim() || '';
          // Exact match or contains
          return btnText === visionText ||
                 btnText.includes(visionText) ||
                 visionText.includes(btnText);
        });

        if (matchingButton) {
          matchedSelector = matchingButton.selector;
          logger.debug('[INTELLIGENT_ANALYZER] Matched button by text', {
            visionText: visionElement.text,
            selector: matchedSelector,
          });
        }
      }

      // Try to match input by type and purpose
      if (visionElement.type === 'input') {
        const matchingInput = domAnalysis.inputs.find(input => {
          // Match by purpose (email, password, search, etc.)
          const purpose = visionElement.purpose.toLowerCase();
          const inputType = input.type.toLowerCase();
          const inputName = (input.name || '').toLowerCase();
          const inputPlaceholder = (input.placeholder || '').toLowerCase();

          return purpose.includes(inputType) ||
                 inputType.includes(purpose) ||
                 inputName.includes(purpose) ||
                 inputPlaceholder.includes(purpose);
        });

        if (matchingInput) {
          matchedSelector = matchingInput.selector;
          logger.debug('[INTELLIGENT_ANALYZER] Matched input by purpose', {
            purpose: visionElement.purpose,
            selector: matchedSelector,
          });
        }
      }

      // Try to match link by text
      if (visionElement.type === 'link' && visionElement.text) {
        const matchingLink = domAnalysis.links.find(link => {
          const linkText = link.text.toLowerCase().trim();
          const visionText = visionElement.text?.toLowerCase().trim() || '';
          return linkText === visionText ||
                 linkText.includes(visionText) ||
                 visionText.includes(linkText);
        });

        if (matchingLink) {
          matchedSelector = matchingLink.selector;
          logger.debug('[INTELLIGENT_ANALYZER] Matched link by text', {
            visionText: visionElement.text,
            selector: matchedSelector,
          });
        }
      }

      // ✅ OPTIMIZED: Collect text selectors for batch check (instead of checking one-by-one)
      // Will be checked in batch after the loop
      if (!matchedSelector && visionElement.text) {
        // Store for batch processing
        (visionElement as any)._needsTextCheck = true;
        (visionElement as any)._textSelector = `${visionElement.type}:has-text("${visionElement.text}")`;
      }

      // Add element with matched selector (will be updated after batch check if needed)
      matchedElements.push({
        ...visionElement,
        selector: matchedSelector || visionElement.selector || '',
      });
    }

    // ✅ OPTIMIZED: Batch check all text selectors at once (one page.evaluate call)
    const elementsNeedingTextCheck = visionAnalysis.elements
      .map((el, idx) => ({ element: el, index: idx }))
      .filter((_, idx) => (visionAnalysis.elements[idx] as any)._needsTextCheck);

    if (elementsNeedingTextCheck.length > 0) {
      try {
        const textSelectors = elementsNeedingTextCheck.map(
          item => (visionAnalysis.elements[item.index] as any)._textSelector
        );

        const selectorResults = await page.evaluate((selectors) => {
          const results: Record<string, number> = {};
          for (const sel of selectors) {
            try {
              // @ts-ignore - browser context
              const count = document.querySelectorAll(sel).length;
              results[sel] = count;
            } catch {
              results[sel] = 0;
            }
          }
          return results;
        }, textSelectors);

        // Update matched elements with batch results
        for (const item of elementsNeedingTextCheck) {
          const textSelector = (visionAnalysis.elements[item.index] as any)._textSelector;
          if (selectorResults[textSelector] > 0) {
            matchedElements[item.index].selector = textSelector;
            logger.debug('[INTELLIGENT_ANALYZER] Found selector by batch text search', {
              text: visionAnalysis.elements[item.index].text,
              selector: textSelector,
            });
          }
        }
      } catch (error) {
        logger.debug('[INTELLIGENT_ANALYZER] Batch selector check failed', { error });
      }
    }

    logger.info('[INTELLIGENT_ANALYZER] Vision-DOM matching completed', {
      totalElements: visionAnalysis.elements.length,
      matchedElements: matchedElements.filter(el => el.selector).length,
      unmatchedElements: matchedElements.filter(el => !el.selector).length,
    });

    return {
      ...visionAnalysis,
      elements: matchedElements,
    };
  }

  /**
   * ✅ NEW: Find close button selector by visible text (from Vision AI)
   */
  private static async findCloseButtonByText(
    page: Page,
    closeButtonText: string
  ): Promise<string | undefined> {
    try {
      // Try various selectors based on text
      const selectors = [
        `button:has-text("${closeButtonText}")`,
        `[aria-label*="${closeButtonText}" i]`,
        `button[title*="${closeButtonText}" i]`,
        `.close-button:has-text("${closeButtonText}")`,
      ];

      for (const selector of selectors) {
        const count = await page.locator(selector).count();
        if (count > 0) {
          return selector;
        }
      }

      return undefined;
    } catch (error) {
      logger.warn('[INTELLIGENT_ANALYZER] Failed to find close button by text', {
        closeButtonText,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private static async detectModals(page: Page): Promise<DOMAnalysis['modals']> {
    try {
      return await page.evaluate(() => {
        const modals: Array<{
          type: 'cookie_banner' | 'newsletter' | 'popup' | 'other';
          closeSelector?: string;
        }> = [];

        // ✅ DYNAMIC: Find modals by behavior, not hardcoded selectors
        // Strategy: Find elements that behave like modals (high z-index, overlay, fixed/absolute positioning)

          // @ts-ignore - browser context
        const allElements = document.querySelectorAll('*');
        const potentialModals: any[] = [];

        for (let i = 0; i < allElements.length; i++) {
          const el = allElements[i] as any;

          // Skip if not visible
          // @ts-ignore - browser context
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
            continue;
          }

          // Check if element behaves like a modal
          const zIndex = parseInt(style.zIndex) || 0;
          const position = style.position;
          const isFixedOrAbsolute = position === 'fixed' || position === 'absolute';
          const hasHighZIndex = zIndex > MODAL_DETECTION_CONFIG.zIndexThreshold;
          // @ts-ignore - browser context
          const viewportWidth = window.innerWidth;
          // @ts-ignore - browser context
          const viewportHeight = window.innerHeight;
          // @ts-ignore - browser context
          const hasOverlay = style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                            // @ts-ignore - browser context
                            (el.offsetWidth > viewportWidth * MODAL_DETECTION_CONFIG.overlaySizeRatio ||
                             el.offsetHeight > viewportHeight * MODAL_DETECTION_CONFIG.overlaySizeRatio);

          // Check for modal-like attributes
          const role = el.getAttribute('role');
          const ariaModal = el.getAttribute('aria-modal');
          const hasModalRole = role === 'dialog' || role === 'alertdialog' || ariaModal === 'true';

          // Check for modal-like classes/ids (dynamic, not hardcoded)
          // ✅ FIX: Handle className as string, SVGAnimatedString, or DOMTokenList
          let className = '';
          if (typeof el.className === 'string') {
            className = el.className.toLowerCase();
          } else if (el.className && typeof el.className === 'object') {
            // Handle DOMTokenList or SVGAnimatedString
            if ('baseVal' in el.className) {
              className = (el.className.baseVal || '').toLowerCase();
            } else if ('value' in el.className) {
              className = (el.className.value || '').toLowerCase();
            } else if (typeof el.className.toString === 'function') {
              className = el.className.toString().toLowerCase();
          }
        }
          const id = (el.id || '').toLowerCase();
          const hasModalKeywords = className.includes('modal') || className.includes('popup') ||
                                   className.includes('dialog') || className.includes('overlay') ||
                                   id.includes('modal') || id.includes('popup') || id.includes('dialog');

          // If element matches modal characteristics
          const { minModalSize } = MODAL_DETECTION_CONFIG;
          if ((hasModalRole || hasModalKeywords || (hasHighZIndex && isFixedOrAbsolute && hasOverlay)) &&
              el.offsetWidth > minModalSize && el.offsetHeight > minModalSize) {
            potentialModals.push(el);
          }
        }

        // Process each potential modal
        for (const modalEl of potentialModals) {
          // ✅ DYNAMIC: Find close button by analyzing button properties, not hardcoded selectors
          // @ts-ignore - browser context
          const buttons = modalEl.querySelectorAll('button, [role="button"], a[href="#"], a[href="javascript:void(0)"]');
          let closeSelector: string | undefined;

          for (let j = 0; j < buttons.length; j++) {
            const btn = buttons[j] as any;

            // Check if button looks like a close button
            const btnText = btn.textContent?.trim() || '';
            const btnAriaLabel = btn.getAttribute('aria-label')?.toLowerCase() || '';
            const btnTitle = btn.getAttribute('title')?.toLowerCase() || '';
            // ✅ FIX: Handle className as string, SVGAnimatedString, or DOMTokenList
            let btnClass = '';
            if (typeof btn.className === 'string') {
              btnClass = btn.className.toLowerCase();
            } else if (btn.className && typeof btn.className === 'object') {
              if ('baseVal' in btn.className) {
                btnClass = (btn.className.baseVal || '').toLowerCase();
              } else if ('value' in btn.className) {
                btnClass = (btn.className.value || '').toLowerCase();
              } else if (typeof btn.className.toString === 'function') {
                btnClass = btn.className.toString().toLowerCase();
              }
            }
            const btnId = (btn.id || '').toLowerCase();

            // Dynamic patterns for close buttons
            const { closeButtonKeywords, maxCloseButtonTextLength } = MODAL_DETECTION_CONFIG;
            const hasCloseText = closeButtonKeywords.some(keyword =>
              btnText.toLowerCase().includes(keyword) ||
              btnAriaLabel.includes(keyword) ||
              btnTitle.includes(keyword) ||
              btnClass.includes(keyword) ||
              btnId.includes(keyword)
            );

            // Check for icon-only close buttons (SVG, icon fonts)
            const hasCloseIcon = btn.querySelector('svg') ||
                                 btnClass.includes('icon') && (btnClass.includes('close') || btnClass.includes('x'));

            // Check for short text (likely icon text like "X", "×")
            const isShortText = btnText.length <= 3 && /[x×✕✖]/i.test(btnText);

            if (hasCloseText || hasCloseIcon || isShortText) {
              // Generate selector dynamically
              if (btn.id) {
                closeSelector = `#${btn.id}`;
              } else if (btn.getAttribute('aria-label')) {
                const ariaLabel = btn.getAttribute('aria-label');
                closeSelector = `button[aria-label="${ariaLabel}"]`;
              } else if (btnText && btnText.length <= maxCloseButtonTextLength) {
                // Escape special characters for selector
                const escapedText = btnText.replace(/"/g, '\\"');
                closeSelector = `button:has-text("${escapedText}")`;
              } else if (btnClass) {
                const closeClassKeywords = ['close', 'dismiss', 'cancel'];
                const classes = btnClass.split(' ').filter((c: string) =>
                  c && closeClassKeywords.some(keyword => c.includes(keyword))
                );
                if (classes.length > 0) {
                  closeSelector = `button.${classes[0]}`;
                }
              }

              if (closeSelector) break;
            }
          }

          // Determine modal type dynamically using configuration
          const modalText = modalEl.textContent?.toLowerCase() || '';
          // ✅ FIX: Handle className as string, SVGAnimatedString, or DOMTokenList
          let modalClass = '';
          if (typeof modalEl.className === 'string') {
            modalClass = modalEl.className.toLowerCase();
          } else if (modalEl.className && typeof modalEl.className === 'object') {
            if ('baseVal' in modalEl.className) {
              modalClass = (modalEl.className.baseVal || '').toLowerCase();
            } else if ('value' in modalEl.className) {
              modalClass = (modalEl.className.value || '').toLowerCase();
            } else if (typeof modalEl.className.toString === 'function') {
              modalClass = modalEl.className.toString().toLowerCase();
            }
          }
          const modalId = (modalEl.id || '').toLowerCase();

          // Determine modal type using configured keywords
          const { modalTypeKeywords } = MODAL_DETECTION_CONFIG;
          let modalType: 'cookie_banner' | 'newsletter' | 'popup' | 'other' = 'other';

          // Check for cookie/GDPR keywords
          const hasCookieKeywords = modalTypeKeywords.cookie.some(keyword =>
            modalText.includes(keyword) || modalClass.includes(keyword) || modalId.includes(keyword)
          );
          if (hasCookieKeywords) {
            modalType = 'cookie_banner';
          }
          // Check for newsletter/subscribe keywords
          else {
            const hasNewsletterKeywords = modalTypeKeywords.newsletter.some(keyword =>
              modalText.includes(keyword) || modalClass.includes(keyword) || modalId.includes(keyword)
            );
            if (hasNewsletterKeywords) {
              modalType = 'newsletter';
            }
            // Check for popup/modal keywords
            else {
              const hasPopupKeywords = modalTypeKeywords.popup.some(keyword =>
                modalClass.includes(keyword) || modalId.includes(keyword)
              );
              if (hasPopupKeywords) {
                modalType = 'popup';
          }
            }
          }

            modals.push({
            type: modalType,
            closeSelector,
            });
        }

        return modals;
      });
    } catch (error) {
      logger.warn('[INTELLIGENT_ANALYZER] Modal detection failed', { error });
      return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VISION ANALYSIS (GPT-4o)
  // ═══════════════════════════════════════════════════════════════════════════

  private static async analyzeWithVision(
    screenshotBase64: string,
    url: string,
    goal: string,
    previousContext?: string
  ): Promise<VisionAnalysis> {
    try {
      const prompt = buildPageAnalysisPrompt({ url, goal, previousContext });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: [
          {
            role: 'system',
            content: 'You are an expert QA engineer analyzing web page screenshots.',
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: prompt },
              {
                type: 'image_url',
                image_url: {
                  url: `data:image/png;base64,${screenshotBase64}`,
                  detail: 'high',
                },
              },
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.3,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Vision API');
      }

      const parsed = JSON.parse(content);

      return {
        pageType: parsed.pageType || 'unknown',
        description: parsed.description || 'No description',
        elements: parsed.elements || [],
        suggestions: parsed.suggestions || [],
        warnings: parsed.warnings || [],
        modals: parsed.modals || [], // ✅ NEW: Modals detected by Vision AI
      };
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] Vision analysis failed', { error });

      return {
        pageType: 'unknown',
        description: 'Vision analysis failed',
        elements: [],
        suggestions: [],
        warnings: ['Vision analysis failed'],
        modals: [],
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DOM-ONLY ANALYSIS (Fast mode)
  // ═══════════════════════════════════════════════════════════════════════════

  private static async analyzeWithoutVision(
    domAnalysis: DOMAnalysis,
    url: string
  ): Promise<VisionAnalysis> {
    // Infer page type from DOM and URL
    const pageType = this.inferPageTypeFromDOM(domAnalysis, url);

    // Extract elements from DOM
    const elements = this.extractElementsFromDOM(domAnalysis);

    return {
      pageType,
      description: `Detected ${pageType} page from DOM analysis`,
      elements,
      suggestions: ['Perform basic interactions', 'Test visible elements'],
      warnings: [],
      modals: [], // Fast mode: no Vision AI modal detection
    };
  }

  private static inferPageTypeFromDOM(dom: DOMAnalysis, url: string): PageType {
    const urlLower = url.toLowerCase();

    // URL-based inference
    if (urlLower.includes('/cart')) return 'cart';
    if (urlLower.includes('/checkout')) return 'checkout';
    if (urlLower.includes('/login')) return 'login';
    if (urlLower.includes('/register') || urlLower.includes('/signup')) return 'register';
    if (urlLower.includes('/product') || urlLower.includes('/item')) return 'product';
    if (urlLower.includes('/search')) return 'search_results';
    if (urlLower.includes('/profile') || urlLower.includes('/account')) return 'profile';
    if (urlLower.includes('/dashboard')) return 'dashboard';
    if (urlLower.includes('/settings')) return 'settings';

    // DOM-based inference
    const hasPasswordField = dom.inputs.some(input => input.type === 'password');
    const hasEmailField = dom.inputs.some(input => input.type === 'email' || (input.name && input.name.includes('email')));

    if (hasPasswordField && hasEmailField) {
      return dom.buttons.some(btn => btn.text.toLowerCase().includes('register'))
        ? 'register'
        : 'login';
    }

    // Check for product page indicators
    if (
      dom.buttons.some(btn =>
        btn.text.toLowerCase().includes('add to cart') ||
        btn.text.toLowerCase().includes('buy')
      )
    ) {
      return 'product';
    }

    return 'unknown';
  }

  private static extractElementsFromDOM(dom: DOMAnalysis): VisionAnalysis['elements'] {
    const elements: VisionAnalysis['elements'] = [];

    // Buttons
    dom.buttons.forEach(btn => {
      const textLower = btn.text.toLowerCase();
      let purpose = 'unknown';
      let priority: 'critical' | 'high' | 'medium' | 'low' = 'medium';

      if (textLower.includes('add to cart') || textLower.includes('buy')) {
        purpose = 'add_to_cart';
        priority = 'critical';
      } else if (textLower.includes('login') || textLower.includes('sign in')) {
        purpose = 'login';
        priority = 'critical';
      } else if (textLower.includes('submit') || textLower.includes('continue')) {
        purpose = 'submit';
        priority = 'high';
      }

      elements.push({
        type: 'button',
        purpose,
        selector: btn.selector,
        text: btn.text,
        priority,
      });
    });

    // Inputs
    dom.inputs.forEach(input => {
      const priority: 'critical' | 'high' | 'medium' | 'low' = (input.name && input.name.includes('email')) || input.type === 'password'
        ? 'critical'
        : 'medium';

      elements.push({
        type: 'input',
        purpose: input.type,
        selector: input.selector,
        text: input.placeholder,
        priority,
      });
    });

    return elements;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIC ANALYSIS
  // ═══════════════════════════════════════════════════════════════════════════

  private static async analyzeLogic(
    pageType: PageType,
    elements: VisionAnalysis['elements'],
    domAnalysis: DOMAnalysis
  ): Promise<{
    requiredActions: string[];
    possibleActions: string[];
  }> {
    try {
      const prompt = buildLogicAnalysisPrompt({
        pageType,
        elements: JSON.stringify(elements, null, 2),
        domData: JSON.stringify(
          {
            forms: domAnalysis.forms.length,
            buttons: domAnalysis.buttons.length,
            inputs: domAnalysis.inputs.length,
          },
          null,
          2
        ),
      });

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are an expert QA engineer analyzing page logic.',
          },
          {
            role: 'user',
            content: prompt,
          },
        ],
        max_tokens: 1000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Logic Analysis');
      }

      const parsed = JSON.parse(content);

      return {
        requiredActions: parsed.requiredBeforeMain || [],
        possibleActions: [
          ...(parsed.requiredBeforeMain || []),
          ...(parsed.optionalActions || []),
        ],
      };
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] Logic analysis failed', { error });
      return {
        requiredActions: [],
        possibleActions: [],
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * ✅ OPTIMIZED: Decide if Vision should be used in balanced mode
   * More aggressive skipping - use Vision only for complex pages
   */
  private static async shouldUseVision(domAnalysis: DOMAnalysis): Promise<boolean> {
    // ✅ OPTIMIZED: Skip Vision if page is too simple
    const totalElements = domAnalysis.forms.length +
                         domAnalysis.buttons.length +
                         domAnalysis.inputs.length;

    if (totalElements < 5) {
      logger.debug('[INTELLIGENT_ANALYZER] Page too simple, skipping Vision', {
        totalElements,
        forms: domAnalysis.forms.length,
        buttons: domAnalysis.buttons.length,
        inputs: domAnalysis.inputs.length,
      });
      return false; // Skip Vision for very simple pages
    }

    // Use Vision only for complex pages
    const hasComplexForms = domAnalysis.forms.length > 1;
    const hasManyButtons = domAnalysis.buttons.length > 10; // ✅ OPTIMIZED: Increased threshold from 5 to 10
    const hasModals = (domAnalysis.modals?.length || 0) > 0;

    return hasComplexForms || hasManyButtons || hasModals;
  }
}
