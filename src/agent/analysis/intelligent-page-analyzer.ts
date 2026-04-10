/**
 * IntelligentPageAnalyzer
 * Analyzes web pages using GPT-4 Vision + DOM analysis
 * Understands page context, type, and available actions
 */

import { buildLogicAnalysisPrompt, buildPageAnalysisPrompt } from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { AISelectorEngine } from '@/services/ai-selector/ai-selector-engine.service';
import { DOMNodeExtractor } from '@/services/ai-selector/dom-node-extractor';
import { analyzeDOMStructure } from '@/services/testing/ui/autonomous/dom-analyzer.service';
import { logger } from '@/utils/core/logger';
import {
  MODAL_OVERLAY_SELECTORS,
  POSITIONAL_CANDIDATES_SELECTOR,
} from '@/agent/utils/selectors/modal-detection';
import { Page } from 'playwright';
import {
    DOMAnalysis,
    PageContext,
    PageType,
    VisionAnalysis,
} from '../types/intelligent-testing.types';
import { buildHistorySummary } from '../utils/context/context-compressor';
import { getSharedOpenAIClient } from '@/services/ai/core/openai.service';

const openai = getSharedOpenAIClient();

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

  // Close / dismiss detection (scoring-based)
  // Notes:
  // - Avoid overly broad tokens like "x" (too noisy).
  // - Avoid dangerous tokens like "exit/выход" (can mean logout).
  closeButtonStrongTokens: [
    'close', 'dismiss', 'закрыть', 'закр', 'dismiss',
    'modal-close', 'close-modal', 'dialog-close', 'overlay-close',
  ],
  closeButtonWeakTokens: [
    'cancel', 'отмена', 'no thanks', 'not now', 'later', 'skip', 'dismiss',
    'не сейчас', 'нет спасибо', 'позже', 'пропустить',
  ],
  dangerousCloseTokens: [
    'logout', 'log out', 'sign out', 'exit account', 'выход', 'выйти', 'выход из аккаунта',
  ],
  closeIconChars: ['×', '✕', '✖'],
  maxCloseButtonTextLength: 20, // Maximum text length for close/dismiss button text selector

  // Cookie consent / banner buttons (often no explicit "close")
  cookieActionTokens: {
    decline: ['reject', 'decline', 'deny', 'disagree', 'reject all', 'отклонить', 'отказать', 'не согласен', 'запретить', 'запретить все'],
    accept: ['accept', 'agree', 'allow', 'ok', 'got it', 'accept all', 'принять', 'согласен', 'разрешить', 'понятно', 'ок', 'принять все', 'разрешить все'],
    settings: ['manage', 'preferences', 'settings', 'options', 'настройки', 'параметры', 'предпочтения', 'управлять'],
  },

  // Modal type detection keywords
  modalTypeKeywords: {
    cookie: ['cookie', 'cookies', 'gdpr', 'consent', 'privacy', 'policy', 'tracking', 'analytics', 'куки', 'cookie-файл', 'согласие', 'конфиденц', 'политика'],
    newsletter: ['newsletter', 'subscribe', 'subscription', 'sign up', 'email', 'discount', 'coupon', 'promo', 'offer', 'подпис', 'рассыл', 'скидк', 'промокод', 'акци'],
    popup: ['popup', 'pop-up', 'modal', 'dialog', 'overlay', 'lightbox', 'drawer', 'sheet', 'всплыва', 'оверле'],
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
    },
    state?: any, // TestState - optional for backward compatibility
    hints?: Array<{ description: string; action?: string; target?: string; value?: string; priority?: string }>,
    errorCollector?: any // ErrorCollectorService - optional
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
      const enhancedDomAnalysis = await this.enhanceDOMWithAISelectors(
        page,
        domAnalysis,
        url
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

      // ✅ NEW: Build enriched context for logic analysis
      const pageTitle = await page.title().catch(() => undefined);
      const historySummary = state ? await this.buildHistorySummaryFromState(state) : undefined;
      const errorSignalsSummary = errorCollector ? errorCollector.getSummary() : undefined;

      const enrichedContext = {
        goal,
        historySummary,
        url,
        pageTitle,
        hints,
        errorSignals: errorSignalsSummary,
      };

      // ✅ OPTIMIZED: Run Vision and Logic analysis in parallel (if Vision needed)
      let visionAnalysis: VisionAnalysis;
      let logicAnalysis: any;

      if (shouldUseVisionResult) {
        logger.info('[INTELLIGENT_ANALYZER] Using GPT-4 Vision for analysis', { url });
        const visionStartTime = Date.now();

        // ✅ ENHANCED: Prepare DOM context for Vision analysis
        const domContext = {
          formsCount: domAnalysis.forms.length,
          buttonsCount: domAnalysis.buttons.length,
          inputsCount: domAnalysis.inputs.length,
          linksCount: domAnalysis.links.length,
          hasModals: (domAnalysis.modals?.length || 0) > 0,
          interactiveElementsCount:
            domAnalysis.buttons.length +
            domAnalysis.inputs.length +
            domAnalysis.links.length +
            (domAnalysis.checkboxes?.length || 0) +
            (domAnalysis.radios?.length || 0),
        };

        // ✅ OPTIMIZED: Run Vision and Logic in parallel
        const [visionResult, logicResult] = await Promise.all([
          this.analyzeWithVision(screenshot, url, goal, previousContext, domContext),
          // Start Logic analysis early (can use DOM-only data initially)
          this.analyzeLogic('unknown', [], domAnalysis, enrichedContext),
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
          domAnalysis,
          enrichedContext
        );
      }

      // ✅ ENHANCED: Match Vision-DOM and enhance DOM in parallel with error handling
      let matchedVision: VisionAnalysis;
      let enhancedDomWithModals: DOMAnalysis;

      try {
        [matchedVision, enhancedDomWithModals] = await Promise.all([
          this.matchVisionElementsWithDOMSelectors(page, visionAnalysis, enhancedDomAnalysis),
          // ✅ FIX: Safe access to modals (may be undefined)
          this.enhanceDOMWithVisionModals(page, enhancedDomAnalysis, visionAnalysis?.modals || []),
        ]);
      } catch (error) {
        logger.error('[INTELLIGENT_ANALYZER] Vision-DOM matching failed', {
          error: error instanceof Error ? error.message : String(error),
          url,
        });
        // Fallback: use original data
        matchedVision = visionAnalysis;
        enhancedDomWithModals = enhancedDomAnalysis;
      }

      visionAnalysis = matchedVision;
      const finalEnhancedDom = enhancedDomWithModals;

      // ✅ ENHANCED: Update Logic analysis with Vision elements (if Vision was used)
      // ✅ FIX: Validate visionAnalysis before using it
      if (shouldUseVisionResult && visionAnalysis && visionAnalysis.elements && visionAnalysis.elements.length > 0) {
        // Re-run Logic with Vision elements for better accuracy
        try {
          // ✅ ENHANCED: Add pageDescription and warnings from Vision to enrichedContext
          const enrichedContextWithVision = {
            ...enrichedContext,
            pageDescription: visionAnalysis.description,
            warnings: visionAnalysis.warnings,
          };

          logicAnalysis = await this.analyzeLogic(
            visionAnalysis.pageType || 'unknown',
            visionAnalysis.elements.filter(el => el && el.type && el.purpose), // ✅ FIX: Filter invalid elements
            finalEnhancedDom,
            enrichedContextWithVision
          );
        } catch (error) {
          logger.warn('[INTELLIGENT_ANALYZER] Logic analysis with Vision elements failed, using previous result', {
            error: error instanceof Error ? error.message : String(error),
          });
          // Keep previous logicAnalysis
        }
      }

      logger.info('[INTELLIGENT_ANALYZER] Logic analysis completed', {
        url,
        requiredActions: logicAnalysis.requiredActions.length,
        possibleActions: logicAnalysis.possibleActions.length,
      });

      // ✅ ENHANCED: Build complete context with validation
      const context: PageContext = {
        url,
        pageType: visionAnalysis?.pageType || 'unknown',
        timestamp: Date.now(),
        vision: visionAnalysis || {
          pageType: 'unknown',
          description: 'Vision analysis unavailable',
          elements: [],
          suggestions: [],
          warnings: [],
        },
        dom: finalEnhancedDom, // ✅ Use AI-enhanced DOM analysis
        screenshot: mode !== 'fast' ? screenshot : undefined,
        requiredActions: logicAnalysis?.requiredActions || [],
        possibleActions: logicAnalysis?.possibleActions || [],
        // ✅ FIX: Safe filter for critical elements (handle missing priority)
        criticalElements: (visionAnalysis?.elements || []).filter(
          el => el && el.priority === 'critical'
        ),
        warnings: visionAnalysis?.warnings || [],
        errorSignals: errorCollector ? errorCollector.getErrors() : undefined,
        skipHints: logicAnalysis?.skipHints || [],
        navigationActions: logicAnalysis?.navigationActions || [],
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
          checkboxes: undefined,
          radios: undefined,
          interactiveElements: undefined,
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
   * ///improvement: Enhanced SPA loading detection with configurable thresholds and retry logic
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
    const checkIframes = config?.checkIframes ?? false;
    const checkShadowDOM = config?.checkShadowDOM ?? false;

    const timeLeftMs = () => Math.max(0, maxWaitTime - (Date.now() - startTime));
    const clampTimeout = (ms: number) => Math.max(0, Math.min(ms, timeLeftMs()));

    try {
      // Ensure DOM is at least initialized (cheap + avoids evaluate on about:blank races)
      await page.waitForLoadState('domcontentloaded', { timeout: clampTimeout(2000) }).catch(() => null);

      // ✅ FIX 2: Better network idle detection - settle approach for long-polling/websockets
      logger.debug('[INTELLIGENT_ANALYZER] Waiting for network to settle', {
        url: page.url(),
      });

      // Try networkidle first, but with settle fallback
      const netTimeout = clampTimeout(networkIdleTimeout);
      await Promise.race([
        page.waitForLoadState('networkidle', { timeout: netTimeout }),
        // Fallback: Wait for network to settle (no new requests for N ms)
        this.waitForNetworkSettle(page, networkSettleTime, netTimeout),
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
        if (timeLeftMs() <= 0) break;
        try {
          // ✅ FIX 3: Use 'visible' instead of 'attached' for interactive elements
          await page.waitForSelector('button, input, a, [role="button"], [onclick], select, textarea', {
            timeout: clampTimeout(3000),
            state: 'visible', // Changed from 'attached' - ensures element is visible and interactive
          });
          elementsFound = true;
          logger.debug('[INTELLIGENT_ANALYZER] Interactive elements found', {
            attempt,
            url: page.url(),
          });
          break;
        } catch (error) {
          // Optional: check if interactive elements are inside iframes
          if (!elementsFound && checkIframes && timeLeftMs() > 0) {
            const frames = page.frames().filter(f => f !== page.mainFrame());
            for (const frame of frames) {
              if (timeLeftMs() <= 0) break;
              try {
                await frame.waitForSelector('button, input, a, [role="button"], [onclick], select, textarea', {
                  timeout: clampTimeout(1000),
                  state: 'visible',
                });
                elementsFound = true;
                logger.debug('[INTELLIGENT_ANALYZER] Interactive elements found in iframe', {
                  attempt,
                  url: page.url(),
                  frameUrl: frame.url(),
                });
                break;
              } catch {
                // Continue checking other frames
              }
            }
            if (elementsFound) break;
          }

          if (attempt < elementRetries) {
            logger.debug('[INTELLIGENT_ANALYZER] Elements not found yet, retrying', {
              attempt,
              maxRetries: elementRetries,
              url: page.url(),
            });
            const delay = clampTimeout(elementRetryDelay);
            if (delay > 0) {
              await page.waitForTimeout(delay);
            }
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
            ({ minContentElements, minTextLength, checkShadowDOM }: { minContentElements: number; minTextLength: number; checkShadowDOM: boolean }) => {
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
              let hasTextContent = appText.trim().length > minTextLength;

              // 4. Check for interactive elements (buttons, inputs, links)
              const interactiveElements = appRoot.querySelectorAll('button, input, a, select, textarea, [role="button"], [onclick]');
              let hasInteractiveContent = interactiveElements.length > 0;

              // Optional: include open shadow roots for content detection
              if (checkShadowDOM && (!hasTextContent || !hasInteractiveContent)) {
                const hosts = Array.from(appRoot.querySelectorAll('*')).slice(0, 200);
                for (const host of hosts) {
                  const sr = (host as any).shadowRoot;
                  if (!sr) continue;
                  if (!hasInteractiveContent) {
                    const found = sr.querySelector('button, input, a, select, textarea, [role="button"], [onclick]');
                    if (found) hasInteractiveContent = true;
                  }
                  if (!hasTextContent) {
                    const t = (sr.textContent || '').trim();
                    if (t.length > minTextLength) hasTextContent = true;
                  }
                  if (hasTextContent && hasInteractiveContent) break;
                }
              }

              // ✅ FIX 4: Use configurable minContentElements (passed as argument)
              // Page is considered loaded if:
              // - Has at least N real content elements (not skeletons), OR
              // - Has substantial text content, OR
              // - Has interactive elements
              const isContentLoaded = realContentElements >= minContentElements || hasTextContent || hasInteractiveContent;

              return isContentLoaded;
            },
            { minContentElements, minTextLength, checkShadowDOM },
            { timeout: clampTimeout(2000) }
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
          }, { timeout: clampTimeout(2000) }).catch(() => null),

          // Fallback: wait 1 second for any late-loading content
          (async () => {
            const t = clampTimeout(1000);
            if (t > 0) await page.waitForTimeout(t);
          })(),
        ]);
      } else {
        // If no elements found, wait a bit more for late-loading content
        const t = clampTimeout(2000);
        if (t > 0) await page.waitForTimeout(t);
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

    const onRequest = () => {
      lastRequestTime = Date.now();
    };
    page.on('request', onRequest);

    try {
      // Wait until no new requests for settleTime
      while (Date.now() - startTime < maxTimeout) {
        const timeSinceLastRequest = Date.now() - lastRequestTime;
        if (timeSinceLastRequest >= settleTime) {
          return; // Network settled
        }
        await page.waitForTimeout(100); // Check every 100ms
      }
    } finally {
      // Prevent listener leaks across repeated analyzer calls
      page.off('request', onRequest);
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
      return await page.evaluate((selector) => {
        // Quick check: use full set of targeted modal selectors
        // @ts-ignore - browser context
        const modals = document.querySelectorAll(selector);
        let count = 0;
        modals.forEach((el: any) => {
          // @ts-ignore - browser context
          const style = window.getComputedStyle(el);
          if (style.display !== 'none' && style.visibility !== 'hidden') count++;
        });
        return count;
      }, MODAL_OVERLAY_SELECTORS);
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
          // Two-pass: targeted selectors + positional candidates
          // @ts-ignore - browser context
          const targetedModals = Array.from(document.querySelectorAll(config.overlaySelectors));
          // @ts-ignore - browser context
          const positionalCandidates = Array.from(document.querySelectorAll(config.positionalSelector));

          // @ts-ignore - browser context
          const viewportWidth = window.innerWidth;
          // @ts-ignore - browser context
          const viewportHeight = window.innerHeight;

          const seen = new WeakSet();
          let count = 0;

          for (const el of [...targetedModals, ...positionalCandidates] as any[]) {
            if (seen.has(el)) continue;
            seen.add(el);

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
        }, { zIndexThreshold, minModalSize, overlaySizeRatio, overlaySelectors: MODAL_OVERLAY_SELECTORS, positionalSelector: POSITIONAL_CANDIDATES_SELECTOR });

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
        checkboxes: undefined,
        radios: undefined,
        interactiveElements: undefined,
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
    url: string
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
        buttonsToEnhance.map(async (button, index) => {
          if (!button.text) return button;

          // ✅ FIX: Make intent more specific to ensure unique cache keys
          // Include button text and index to differentiate similar buttons
          // Always include index to ensure uniqueness even if text is the same
          // Note: aria-label is already included in button.text by dom-analyzer.service.ts
          const buttonIdentifier = button.text || `button-${index}`;
          const intent = `Click "${buttonIdentifier}" button (index: ${index})`;

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
   * ✅ ENHANCED: Match Vision AI elements with real DOM selectors
   * Vision AI sees elements visually but doesn't know selectors
   * DOM analysis has selectors but doesn't know which element is which
   * We match them using multiple strategies: text, purpose, aria-label, data-attributes, position
   */
  private static async matchVisionElementsWithDOMSelectors(
    page: Page,
    visionAnalysis: VisionAnalysis,
    domAnalysis: DOMAnalysis
  ): Promise<VisionAnalysis> {
    // Import PageElement type
    type PageElement = import('../types/intelligent-testing.types').PageElement;

    // ✅ FIX: Validate inputs
    if (!visionAnalysis || !visionAnalysis.elements) {
      logger.warn('[INTELLIGENT_ANALYZER] Invalid visionAnalysis, returning as-is', {
        hasVisionAnalysis: !!visionAnalysis,
        hasElements: !!(visionAnalysis?.elements),
      });
      return visionAnalysis || {
        pageType: 'unknown',
        description: 'Invalid Vision analysis',
        elements: [],
        suggestions: [],
        warnings: [],
      };
    }

    if (!domAnalysis) {
      logger.warn('[INTELLIGENT_ANALYZER] Invalid domAnalysis, returning Vision as-is');
      return visionAnalysis;
    }

    logger.info('[INTELLIGENT_ANALYZER] Matching Vision elements with DOM selectors', {
      visionElements: visionAnalysis.elements.length,
      domButtons: domAnalysis.buttons?.length || 0,
      domInputs: domAnalysis.inputs?.length || 0,
      domLinks: domAnalysis.links?.length || 0,
    });

    const matchedElements: PageElement[] = [];
    const usedSelectors = new Set<string>(); // ✅ NEW: Track used selectors to avoid duplicates

    for (const visionElement of visionAnalysis.elements) {
      let matchedSelector: string | undefined;
      let matchConfidence: 'high' | 'medium' | 'low' = 'low';
      const matchStrategies: string[] = [];

      // ✅ ENHANCED: Strategy 1 - Match buttons by text (exact, contains, fuzzy)
      if (visionElement.type === 'button' && visionElement.text) {
        const visionText = visionElement.text.toLowerCase().trim();
        const candidates = domAnalysis.buttons
          .filter(btn => !usedSelectors.has(btn.selector)) // ✅ NEW: Avoid duplicates
          .map(btn => {
            const btnText = btn.text.toLowerCase().trim();
            let score = 0;
            let strategy = '';

            // Exact match (highest confidence)
            if (btnText === visionText) {
              score = 100;
              strategy = 'exact_text';
            }
            // Contains match (high confidence)
            else if (btnText.includes(visionText) || visionText.includes(btnText)) {
              score = 80;
              strategy = 'contains_text';
            }
            // Fuzzy match (partial words)
            else {
              const visionWords = visionText.split(/\s+/);
              const btnWords = btnText.split(/\s+/);
              const commonWords = visionWords.filter(w => btnWords.includes(w));
              if (commonWords.length > 0 && commonWords.length / Math.max(visionWords.length, btnWords.length) > 0.5) {
                score = 60;
                strategy = 'fuzzy_text';
              }
            }

            return { button: btn, score, strategy };
          })
          .filter(c => c.score > 0)
          .sort((a, b) => b.score - a.score);

        if (candidates.length > 0) {
          const bestMatch = candidates[0];
          matchedSelector = bestMatch.button.selector;
          matchConfidence = bestMatch.score >= 80 ? 'high' : bestMatch.score >= 60 ? 'medium' : 'low';
          matchStrategies.push(bestMatch.strategy);
          usedSelectors.add(matchedSelector);
          logger.debug('[INTELLIGENT_ANALYZER] Matched button', {
            visionText: visionElement.text,
            selector: matchedSelector,
            confidence: matchConfidence,
            strategy: bestMatch.strategy,
          });
        }
      }

      // ✅ ENHANCED: Strategy 2 - Match inputs by purpose, type, name, placeholder, aria-label
      if (!matchedSelector && visionElement.type === 'input') {
        const purpose = visionElement.purpose.toLowerCase();
        const candidates = domAnalysis.inputs
          .filter(input => !usedSelectors.has(input.selector))
          .map(input => {
            let score = 0;
            let strategy = '';

            const inputType = (input.type || '').toLowerCase();
            const inputName = (input.name || '').toLowerCase();
            const inputPlaceholder = (input.placeholder || '').toLowerCase();

            // Exact purpose match
            if (purpose === inputType || purpose === inputName) {
              score = 100;
              strategy = 'exact_purpose';
            }
            // Contains match
            else if (
              purpose.includes(inputType) || inputType.includes(purpose) ||
              purpose.includes(inputName) || inputName.includes(purpose) ||
              purpose.includes(inputPlaceholder) || inputPlaceholder.includes(purpose)
            ) {
              score = 80;
              strategy = 'contains_purpose';
            }
            // Semantic match (email, password, search, etc.)
            else {
              const semanticMatches: Record<string, string[]> = {
                email: ['email', 'e-mail', 'mail', 'username'],
                password: ['password', 'pass', 'pwd', 'secret'],
                search: ['search', 'query', 'find', 'lookup'],
                phone: ['phone', 'tel', 'telephone', 'mobile'],
                name: ['name', 'fullname', 'full_name', 'fname', 'lname'],
              };

              for (const [key, synonyms] of Object.entries(semanticMatches)) {
                if (purpose.includes(key) || synonyms.some(s => purpose.includes(s))) {
                  if (inputType.includes(key) || inputName.includes(key) || inputPlaceholder.includes(key)) {
                    score = 70;
                    strategy = 'semantic_match';
                    break;
                  }
                }
              }
            }

            return { input, score, strategy };
          })
          .filter(c => c.score > 0)
          .sort((a, b) => b.score - a.score);

        if (candidates.length > 0) {
          const bestMatch = candidates[0];
          matchedSelector = bestMatch.input.selector;
          matchConfidence = bestMatch.score >= 80 ? 'high' : bestMatch.score >= 60 ? 'medium' : 'low';
          matchStrategies.push(bestMatch.strategy);
          usedSelectors.add(matchedSelector);
          logger.debug('[INTELLIGENT_ANALYZER] Matched input', {
            purpose: visionElement.purpose,
            selector: matchedSelector,
            confidence: matchConfidence,
            strategy: bestMatch.strategy,
          });
        }
      }

      // ✅ ENHANCED: Strategy 3 - Match links by text (exact, contains, fuzzy)
      if (!matchedSelector && visionElement.type === 'link' && visionElement.text) {
        const visionText = visionElement.text.toLowerCase().trim();
        const candidates = domAnalysis.links
          .filter(link => !usedSelectors.has(link.selector))
          .map(link => {
            const linkText = link.text.toLowerCase().trim();
            let score = 0;
            let strategy = '';

            if (linkText === visionText) {
              score = 100;
              strategy = 'exact_text';
            } else if (linkText.includes(visionText) || visionText.includes(linkText)) {
              score = 80;
              strategy = 'contains_text';
            } else {
              const visionWords = visionText.split(/\s+/);
              const linkWords = linkText.split(/\s+/);
              const commonWords = visionWords.filter(w => linkWords.includes(w));
              if (commonWords.length > 0 && commonWords.length / Math.max(visionWords.length, linkWords.length) > 0.5) {
                score = 60;
                strategy = 'fuzzy_text';
              }
            }

            return { link, score, strategy };
          })
          .filter(c => c.score > 0)
          .sort((a, b) => b.score - a.score);

        if (candidates.length > 0) {
          const bestMatch = candidates[0];
          matchedSelector = bestMatch.link.selector;
          matchConfidence = bestMatch.score >= 80 ? 'high' : bestMatch.score >= 60 ? 'medium' : 'low';
          matchStrategies.push(bestMatch.strategy);
          usedSelectors.add(matchedSelector);
          logger.debug('[INTELLIGENT_ANALYZER] Matched link', {
            visionText: visionElement.text,
            selector: matchedSelector,
            confidence: matchConfidence,
            strategy: bestMatch.strategy,
          });
        }
      }

      // ✅ NEW: Strategy 4 - Try aria-label and data-attributes matching via page.evaluate
      if (!matchedSelector && visionElement.text) {
        try {
          const ariaMatches = await page.evaluate(
            ({ text }) => {
              const results: Array<{ selector: string; confidence: number }> = [];
              const searchText = text.toLowerCase().trim();

              // Search by aria-label
              // @ts-ignore - browser context
              const ariaElements = document.querySelectorAll(`[aria-label]`);
              ariaElements.forEach((el: any) => {
                const ariaLabel = (el.getAttribute('aria-label') || '').toLowerCase().trim();
                if (ariaLabel === searchText || ariaLabel.includes(searchText) || searchText.includes(ariaLabel)) {
                  // Generate selector
                  let selector = '';
                  if (el.id) selector = `#${el.id}`;
                  else if (el.getAttribute('data-testid')) selector = `[data-testid="${el.getAttribute('data-testid')}"]`;
                  else selector = `[aria-label="${el.getAttribute('aria-label')}"]`;

                  if (selector) {
                    results.push({
                      selector,
                      confidence: ariaLabel === searchText ? 90 : 70,
                    });
                  }
                }
              });

              // Search by data-testid, data-cy, data-test
              ['data-testid', 'data-cy', 'data-test'].forEach(attr => {
                // @ts-ignore - browser context
                const dataElements = document.querySelectorAll(`[${attr}]`);
                dataElements.forEach((el: any) => {
                  const dataValue = (el.getAttribute(attr) || '').toLowerCase().trim();
                  if (dataValue.includes(searchText) || searchText.includes(dataValue)) {
                    const selector = `[${attr}="${el.getAttribute(attr)}"]`;
                    if (!results.some(r => r.selector === selector)) {
                      results.push({ selector, confidence: 75 });
                    }
                  }
                });
              });

              return results;
            },
            { text: visionElement.text }
          );

          if (ariaMatches.length > 0) {
            // Sort by confidence and pick best match not already used
            const bestAriaMatch = ariaMatches
              .filter(m => !usedSelectors.has(m.selector))
              .sort((a, b) => b.confidence - a.confidence)[0];

            if (bestAriaMatch) {
              matchedSelector = bestAriaMatch.selector;
              matchConfidence = bestAriaMatch.confidence >= 80 ? 'high' : 'medium';
              matchStrategies.push('aria_label_or_data_attr');
              usedSelectors.add(matchedSelector);
              logger.debug('[INTELLIGENT_ANALYZER] Matched by aria-label/data-attr', {
                visionText: visionElement.text,
                selector: matchedSelector,
                confidence: matchConfidence,
              });
            }
          }
        } catch (error) {
          logger.debug('[INTELLIGENT_ANALYZER] Aria-label matching failed', { error });
        }
      }

      // ✅ OPTIMIZED: Strategy 5 - Fallback to text selector (batch check)
      if (!matchedSelector && visionElement.text) {
        // Store for batch processing
        (visionElement as any)._needsTextCheck = true;
        (visionElement as any)._textSelector = `text="${visionElement.text}"`;
        (visionElement as any)._typeSelector = visionElement.type === 'button'
          ? `role=button[name="${visionElement.text}"]`
          : visionElement.type === 'link'
          ? `role=link[name="${visionElement.text}"]`
          : `text="${visionElement.text}"`;
      }

      // Add element with matched selector
      matchedElements.push({
        ...visionElement,
        selector: matchedSelector || visionElement.selector || '',
        // ✅ NEW: Store matching metadata for debugging
        ...(matchStrategies.length > 0 && { _matchMetadata: { strategies: matchStrategies, confidence: matchConfidence } }),
      });
    }

    // ✅ ENHANCED: Batch check all text selectors at once (one page.evaluate call)
    const elementsNeedingTextCheck = matchedElements
      .map((el, index) => ({ element: el, index }))
      .filter((item) => !item.element.selector && (visionAnalysis.elements[item.index] as any)?._needsTextCheck);

    if (elementsNeedingTextCheck.length > 0) {
      try {
        const selectorsToCheck = elementsNeedingTextCheck.map(item => ({
          textSelector: (visionAnalysis.elements[item.index] as any)?._textSelector,
          typeSelector: (visionAnalysis.elements[item.index] as any)?._typeSelector,
          text: visionAnalysis.elements[item.index].text,
        }));

        const selectorResults = await page.evaluate((selectors) => {
          const results: Array<{ textSelector: string; typeSelector: string; found: boolean; count: number }> = [];

          for (const sel of selectors) {
            let found = false;
            let count = 0;

            // Try type selector first (more specific)
            if (sel.typeSelector) {
              try {
                // @ts-ignore - browser context
                const elements = document.querySelectorAll(sel.typeSelector);
                count = elements.length;
                if (count > 0) {
                  found = true;
                }
              } catch {
                // Invalid selector, skip
              }
            }

            // Fallback to text selector
            if (!found && sel.textSelector) {
              try {
                // @ts-ignore - browser context
                const elements = document.querySelectorAll(sel.textSelector);
                count = elements.length;
                if (count > 0) {
                  found = true;
                }
              } catch {
                // Invalid selector, skip
              }
            }

            results.push({
              textSelector: sel.textSelector || '',
              typeSelector: sel.typeSelector || '',
              found,
              count,
            });
          }

          return results;
        }, selectorsToCheck);

        // Update matched elements with batch results
        for (let i = 0; i < elementsNeedingTextCheck.length; i++) {
          const item = elementsNeedingTextCheck[i];
          const result = selectorResults[i];

          if (result.found && result.count === 1 && !usedSelectors.has(result.typeSelector || result.textSelector)) {
            // ✅ NEW: Prefer type selector, fallback to text selector
            const finalSelector = result.typeSelector || result.textSelector;
            matchedElements[item.index].selector = finalSelector;
            usedSelectors.add(finalSelector);
            logger.debug('[INTELLIGENT_ANALYZER] Found selector by batch check', {
              text: visionAnalysis.elements[item.index].text,
              selector: finalSelector,
              count: result.count,
            });
          } else if (result.found && result.count > 1) {
            // ✅ NEW: Multiple matches - log warning but still use selector
            logger.warn('[INTELLIGENT_ANALYZER] Multiple elements match text selector', {
              text: visionAnalysis.elements[item.index].text,
              selector: result.typeSelector || result.textSelector,
              count: result.count,
              note: 'Selector may match multiple elements - consider using more specific selector',
            });
            // Still use it but with lower confidence
            if (!usedSelectors.has(result.typeSelector || result.textSelector)) {
              matchedElements[item.index].selector = result.typeSelector || result.textSelector;
              usedSelectors.add(result.typeSelector || result.textSelector);
            }
          }
        }
      } catch (error) {
        logger.debug('[INTELLIGENT_ANALYZER] Batch selector check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // ✅ NEW: Final validation - check for duplicate selectors and log warnings
    const selectorCounts = new Map<string, number>();
    matchedElements.forEach((el) => {
      if (el.selector) {
        selectorCounts.set(el.selector, (selectorCounts.get(el.selector) || 0) + 1);
      }
    });

    const duplicates = Array.from(selectorCounts.entries()).filter((entry) => entry[1] > 1);
    if (duplicates.length > 0) {
      logger.warn('[INTELLIGENT_ANALYZER] Duplicate selectors detected', {
        duplicates: duplicates.map(([selector, count]) => ({ selector, count })),
        note: 'Multiple Vision elements matched to the same DOM selector - may cause issues',
      });
    }

    // ✅ NEW: Log matching statistics
    const matchStats = {
      total: matchedElements.length,
      matched: matchedElements.filter(el => el.selector).length,
      unmatched: matchedElements.filter(el => !el.selector).length,
      highConfidence: matchedElements.filter(el => (el as any)?._matchMetadata?.confidence === 'high').length,
      mediumConfidence: matchedElements.filter(el => (el as any)?._matchMetadata?.confidence === 'medium').length,
      lowConfidence: matchedElements.filter(el => (el as any)?._matchMetadata?.confidence === 'low' || !(el as any)?._matchMetadata).length,
    };

    logger.info('[INTELLIGENT_ANALYZER] Vision-DOM matching completed', {
      ...matchStats,
      matchRate: `${Math.round((matchStats.matched / matchStats.total) * 100)}%`,
      duplicatesCount: duplicates.length,
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
      // ✅ FIX: Pass config values as parameters to page.evaluate() (browser context can't access Node.js variables)
      const config = {
        zIndexThreshold: MODAL_DETECTION_CONFIG.zIndexThreshold,
        overlaySizeRatio: MODAL_DETECTION_CONFIG.overlaySizeRatio,
        minModalSize: MODAL_DETECTION_CONFIG.minModalSize,
        closeButtonStrongTokens: MODAL_DETECTION_CONFIG.closeButtonStrongTokens,
        closeButtonWeakTokens: MODAL_DETECTION_CONFIG.closeButtonWeakTokens,
        dangerousCloseTokens: MODAL_DETECTION_CONFIG.dangerousCloseTokens,
        closeIconChars: MODAL_DETECTION_CONFIG.closeIconChars,
        maxCloseButtonTextLength: MODAL_DETECTION_CONFIG.maxCloseButtonTextLength,
        cookieActionTokens: MODAL_DETECTION_CONFIG.cookieActionTokens,
        modalTypeKeywords: MODAL_DETECTION_CONFIG.modalTypeKeywords,
        // Shared modal detection selectors
        overlaySelectors: MODAL_OVERLAY_SELECTORS,
        positionalSelector: POSITIONAL_CANDIDATES_SELECTOR,
      };

      const detected = await page.evaluate((config) => {
        const modals: Array<{
          type: 'cookie_banner' | 'newsletter' | 'popup' | 'other';
          closeSelector?: string;
        }> = [];

        const normalize = (s: string): string =>
          (s || '')
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .trim();

        const includesAny = (haystack: string, needles: readonly string[]): boolean => {
          const h = normalize(haystack);
          return needles.some((n) => n && h.includes(normalize(n)));
        };

        const getAttr = (el: any, name: string): string => (el?.getAttribute?.(name) || '').toString();

        const getElementClassLower = (el: any): string => {
          let className = '';
          if (typeof el.className === 'string') {
            className = el.className.toLowerCase();
          } else if (el.className && typeof el.className === 'object') {
            if ('baseVal' in el.className) {
              className = (el.className.baseVal || '').toLowerCase();
            } else if ('value' in el.className) {
              className = (el.className.value || '').toLowerCase();
            } else if (typeof el.className.toString === 'function') {
              className = el.className.toString().toLowerCase();
            }
          }
          return className;
        };

        const buildBestSelector = (btn: any, modalEl: any): string | undefined => {
          try {
            const btnId = btn.id ? String(btn.id) : '';
            if (btnId) return `#${btnId}`;

            // Prefer test ids
            const dataTestId = getAttr(btn, 'data-testid') || getAttr(btn, 'data-test') || getAttr(btn, 'data-cy') || getAttr(btn, 'data-qa');
            if (dataTestId) return `[data-testid="${dataTestId}"], [data-test="${dataTestId}"], [data-cy="${dataTestId}"], [data-qa="${dataTestId}"]`;

            const aria = getAttr(btn, 'aria-label');
            if (aria) {
              const modalId = modalEl?.id ? `#${modalEl.id} ` : '';
              return `${modalId}[aria-label="${aria}"]`;
            }

            const title = getAttr(btn, 'title');
            if (title) {
              const modalId = modalEl?.id ? `#${modalEl.id} ` : '';
              return `${modalId}[title="${title}"]`;
            }

            const txt = (btn.textContent || '').trim();
            if (txt && txt.length <= config.maxCloseButtonTextLength) {
              const escapedText = txt.replace(/"/g, '\\"');
              return `button:has-text("${escapedText}")`;
            }

            const btnClass = getElementClassLower(btn);
            const classParts = btnClass.split(' ').filter(Boolean);
            const closeish = classParts.find((c) => c.includes('close') || c.includes('dismiss') || c.includes('modal-close'));
            if (closeish) return `button.${closeish}`;
          } catch {
            // ignore
          }
          return undefined;
        };

        const scoreCloseCandidate = (btn: any, modalEl: any, modalText: string, modalType: string): number => {
          const btnTextRaw = (btn.textContent || '').trim();
          const btnText = normalize(btnTextRaw);
          const aria = normalize(getAttr(btn, 'aria-label'));
          const title = normalize(getAttr(btn, 'title'));
          const id = normalize(btn.id || '');
          const cls = normalize(getElementClassLower(btn));
          const dataTestId = normalize(getAttr(btn, 'data-testid') || getAttr(btn, 'data-test') || getAttr(btn, 'data-cy') || getAttr(btn, 'data-qa'));

          const allText = `${btnText} ${aria} ${title} ${id} ${cls} ${dataTestId}`;

          // Base score
          let score = 0;

          // Penalize dangerous "close" candidates (logout/exit)
          if (includesAny(allText, config.dangerousCloseTokens)) {
            score -= 100;
          }

          // Strong signals
          if (includesAny(allText, config.closeButtonStrongTokens)) score += 60;

          // Weak signals (only small bonus; can be "cancel" in forms)
          if (includesAny(allText, config.closeButtonWeakTokens)) score += 10;

          // Icon-only close buttons
          const hasSvg = !!btn.querySelector?.('svg');
          const hasIconChar = config.closeIconChars.some((c: string) => btnTextRaw === c);
          const isXChar = btnTextRaw.length <= 2 && /[×✕✖]/.test(btnTextRaw);
          if (hasSvg && (!btnText || btnText.length <= 1)) score += 25;
          if (hasIconChar || isXChar) score += 20;

          // Prefer buttons with aria-label/title explicitly mentioning close
          if (includesAny(aria, config.closeButtonStrongTokens)) score += 30;
          if (includesAny(title, config.closeButtonStrongTokens)) score += 15;

          // Position/size heuristics (close usually small, top-right in modal)
          try {
            const b = btn.getBoundingClientRect();
            const m = modalEl.getBoundingClientRect();
            const isInside = b.left >= m.left && b.top >= m.top && b.right <= m.right && b.bottom <= m.bottom;
            if (!isInside) score -= 30;

            const nearTop = b.top - m.top < Math.max(40, m.height * 0.25);
            const nearRight = m.right - b.right < Math.max(40, m.width * 0.25);
            if (nearTop) score += 10;
            if (nearRight) score += 10;

            const smallish = (b.width * b.height) < 2500; // ~50x50
            if (smallish) score += 10;
          } catch {
            // ignore
          }

          // Cookie banner: prefer reject/decline or accept if no close
          if (modalType === 'cookie_banner') {
            const hasReject = includesAny(allText, config.cookieActionTokens.decline);
            const hasAccept = includesAny(allText, config.cookieActionTokens.accept);
            const hasSettings = includesAny(allText, config.cookieActionTokens.settings);
            if (hasReject) score += 35;
            if (hasAccept) score += 25;
            if (hasSettings) score -= 10; // usually opens another screen, doesn't dismiss
          }

          // Newsletter: prefer "no thanks / not now" over submit
          if (modalType === 'newsletter') {
            const typeAttr = normalize(getAttr(btn, 'type'));
            if (typeAttr === 'submit') score -= 10;
            if (btnText.includes('subscribe') || btnText.includes('подпис')) score -= 15; // avoid subscribing
          }

          return score;
        };

        // ✅ PERF FIX: Two-pass modal detection instead of querySelectorAll('*')
        // Pass 1: Targeted selectors (cheap), Pass 2: Positional candidates (limited)
        // @ts-ignore - browser context
        const targetedModals = Array.from(document.querySelectorAll(config.overlaySelectors));
        // @ts-ignore - browser context
        const positionalCandidates = Array.from(document.querySelectorAll(config.positionalSelector));

        // @ts-ignore - browser context
        const viewportWidth = window.innerWidth;
        // @ts-ignore - browser context
        const viewportHeight = window.innerHeight;

        const seen = new WeakSet();
        const potentialModals: any[] = [];

        for (const el of [...targetedModals, ...positionalCandidates] as any[]) {
          if (seen.has(el)) continue;
          seen.add(el);

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
          const className = getElementClassLower(el);
          const id = (el.id || '').toLowerCase();
          const hasModalKeywords = className.includes('modal') || className.includes('popup') ||
                                   className.includes('dialog') || className.includes('overlay') ||
                                   id.includes('modal') || id.includes('popup') || id.includes('dialog');

          // If element matches modal characteristics
          if ((hasModalRole || hasModalKeywords || (hasHighZIndex && isFixedOrAbsolute && hasOverlay)) &&
              el.offsetWidth > config.minModalSize && el.offsetHeight > config.minModalSize) {
            potentialModals.push(el);
          }
        }

        // Process each potential modal
        for (const modalEl of potentialModals) {
          // Determine modal type dynamically using configuration
          const modalText = normalize(modalEl.textContent || '');
          const modalClass = normalize(getElementClassLower(modalEl));
          const modalId = normalize(modalEl.id || '');

          // Determine modal type using configured keywords
          let modalType: 'cookie_banner' | 'newsletter' | 'popup' | 'other' = 'other';

          // Check for cookie/GDPR keywords
          const hasCookieKeywords = config.modalTypeKeywords.cookie.some(keyword =>
            modalText.includes(keyword) || modalClass.includes(keyword) || modalId.includes(keyword)
          );
          if (hasCookieKeywords) {
            modalType = 'cookie_banner';
          }
          // Check for newsletter/subscribe keywords
          else {
            const hasNewsletterKeywords = config.modalTypeKeywords.newsletter.some(keyword =>
              modalText.includes(keyword) || modalClass.includes(keyword) || modalId.includes(keyword)
            );
            if (hasNewsletterKeywords) {
              modalType = 'newsletter';
            }
            // Check for popup/modal keywords
            else {
              const hasPopupKeywords = config.modalTypeKeywords.popup.some(keyword =>
                modalClass.includes(keyword) || modalId.includes(keyword)
              );
              if (hasPopupKeywords) {
                modalType = 'popup';
              }
            }
          }

          // ✅ NEW: Find best close/dismiss selector using scoring
          // @ts-ignore - browser context
          const candidates = Array.from(
            modalEl.querySelectorAll('button, [role="button"], a[href="#"], a[href="javascript:void(0)"], [aria-label], [title]')
          );
          let closeSelector: string | undefined;
          let bestScore = -9999;
          for (const btn of candidates as any[]) {
            // Skip hidden/disabled
            try {
              // @ts-ignore - browser context
              const s = window.getComputedStyle(btn);
              if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') continue;
              if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            } catch {
              // ignore
            }

            const score = scoreCloseCandidate(btn, modalEl, modalText, modalType);
            if (score > bestScore) {
              const sel = buildBestSelector(btn, modalEl);
              if (sel) {
                bestScore = score;
                closeSelector = sel;
              }
            }
          }

          // If we didn't find a close selector but it's a cookie banner, try to pick a consent action button
          if (!closeSelector && modalType === 'cookie_banner') {
            for (const btn of candidates as any[]) {
              const txt = normalize((btn.textContent || '').trim());
              const aria = normalize(getAttr(btn, 'aria-label'));
              const all = `${txt} ${aria}`.trim();
              if (!all) continue;

              const isReject = includesAny(all, config.cookieActionTokens.decline);
              const isAccept = includesAny(all, config.cookieActionTokens.accept);
              if (isReject || isAccept) {
                const sel = buildBestSelector(btn, modalEl);
                if (sel) {
                  closeSelector = sel;
                  break;
                }
              }
            }
          }

          modals.push({
            type: modalType,
            closeSelector,
          });
        }

        return modals;
      }, config);
      // Best-effort: validate selectors exist in Playwright context
      if (detected && detected.length > 0) {
        for (const m of detected) {
          if (!m.closeSelector) continue;
          try {
            const count = await page.locator(m.closeSelector).count();
            if (count === 0) {
              m.closeSelector = undefined;
            }
          } catch {
            m.closeSelector = undefined;
          }
        }
      }

      return detected;
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
    previousContext?: string,
    domContext?: {
      formsCount: number;
      buttonsCount: number;
      inputsCount: number;
      linksCount: number;
      hasModals: boolean;
      interactiveElementsCount: number;
    }
  ): Promise<VisionAnalysis> {
    try {
      const prompt = buildPageAnalysisPrompt({ url, goal, previousContext, domContext });

      const response = await openai.chat.completions.create({
        model: AI_TASK_MODELS.pageAnalysisVision,
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
        max_completion_tokens: 2000,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('Empty response from Vision API');
      }

      const parsed = JSON.parse(content);

      // ✅ ENHANCED: Validate and sanitize Vision analysis response
      const validatedElements = (parsed.elements || []).filter((el: any) => {
        // Filter out invalid elements
        return el && typeof el === 'object' && el.type && el.purpose;
      }).map((el: any) => ({
        type: el.type || 'other',
        purpose: el.purpose || '',
        text: el.text || '',
        required: el.required || false,
        priority: el.priority || 'medium',
        selector: el.selector || '', // May be empty, will be matched later
        isCTA: el.isCTA === true ? true : undefined, // ✅ NEW: Parse isCTA flag
      }));

      return {
        pageType: parsed.pageType || 'unknown',
        description: parsed.description || 'No description',
        elements: validatedElements,
        suggestions: parsed.suggestions || [],
        warnings: parsed.warnings || [],
        modals: (parsed.modals || []).filter((modal: any) => modal && typeof modal === 'object'), // ✅ FIX: Validate modals
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
    domAnalysis: DOMAnalysis,
    enrichedContext?: {
      goal?: string;
      historySummary?: string;
      pageDescription?: string;
      warnings?: string[];
      url?: string;
      pageTitle?: string;
      hints?: Array<{ description: string; action?: string; target?: string; value?: string; priority?: string }>;
      errorSignals?: string;
    }
  ): Promise<{
    requiredActions: string[];
    possibleActions: string[];
    skipHints?: string[];
    navigationActions?: string[];
  }> {
    try {
      // Build critical elements summary
      const criticalElements = elements.filter(el => el.priority === 'critical');
      const criticalElementsSummary = criticalElements.length > 0
        ? JSON.stringify(criticalElements.map(el => ({ type: el.type, purpose: el.purpose, text: el.text })), null, 2)
        : '';

      // Build navigation/CTA buttons summary
      const ctaButtons = elements.filter(el => el.isCTA);
      const navButtonsSummary = ctaButtons.length > 0
        ? ctaButtons.map(btn => `${btn.purpose}: "${btn.text}" (${btn.type})`).join('\n')
        : '';

      // Build forms summary
      const formsSummary = domAnalysis.forms.length > 0
        ? domAnalysis.forms.map((form, idx) => {
            const requiredFields = form.fields.filter(f => f.required);
            return `Form ${idx + 1}: ${form.fields.length} fields (${requiredFields.length} required)`;
          }).join('\n')
        : '';

      // Build hints summary
      const hintsSummary = enrichedContext?.hints && enrichedContext.hints.length > 0
        ? enrichedContext.hints.map((h, i) => `${i + 1}. ${h.description}${h.priority === 'high' ? ' [HIGH PRIORITY]' : ''}`).join('\n')
        : '';

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
        goal: enrichedContext?.goal,
        historySummary: enrichedContext?.historySummary,
        pageDescription: enrichedContext?.pageDescription,
        warnings: enrichedContext?.warnings,
        criticalElements: criticalElementsSummary,
        navButtonsSummary,
        formsSummary,
        url: enrichedContext?.url,
        pageTitle: enrichedContext?.pageTitle,
        hints: hintsSummary,
        errorSignals: enrichedContext?.errorSignals,
      });

      const response = await openai.chat.completions.create({
        model: AI_TASK_MODELS.elementAnalysis,
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
        max_completion_tokens: 1000,
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
        skipHints: parsed.skipHints || [],
        navigationActions: parsed.navigationActions || [],
      };
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] Logic analysis failed', { error });
      return {
        requiredActions: [],
        possibleActions: [],
        skipHints: [],
        navigationActions: [],
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Build history summary from test state
   */
  private static async buildHistorySummaryFromState(state: any): Promise<string> {
    try {
      return buildHistorySummary(state);
    } catch (error) {
      logger.warn('[INTELLIGENT_ANALYZER] Failed to build history summary', { error });
      return '';
    }
  }

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
