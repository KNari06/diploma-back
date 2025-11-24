/**
 * IntelligentPageAnalyzer
 * Analyzes web pages using GPT-4 Vision + DOM analysis
 * Understands page context, type, and available actions
 */

import { buildLogicAnalysisPrompt, buildPageAnalysisPrompt } from '@/ai/prompts/index';
import { env } from '@/config/env';
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
    previousContext?: string
  ): Promise<PageContext> {
    const startTime = Date.now();
    const url = page.url();

    logger.info('[INTELLIGENT_ANALYZER] Starting page analysis', {
      url,
      goal,
      mode,
    });

    try {
      // ✅ NEW: Wait for modals to appear (many sites show modals with delay)
      await this.waitForModals(page);

      // Parallel analysis for speed
      logger.info('[INTELLIGENT_ANALYZER] Starting parallel screenshot & DOM capture', { url });
      const [screenshot, domAnalysis] = await Promise.all([
        this.captureScreenshot(page, mode),
        this.analyzeDOMFull(page),
      ]);
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

      // Vision analysis (conditional based on mode)
      let visionAnalysis: VisionAnalysis;

      if (mode === 'full' || (mode === 'balanced' && await this.shouldUseVision(domAnalysis))) {
        logger.info('[INTELLIGENT_ANALYZER] Using GPT-4 Vision for analysis', { url });
        const visionStartTime = Date.now();
        visionAnalysis = await this.analyzeWithVision(
          screenshot,
          url,
          goal,
          previousContext
        );
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
      }

      // ✅ IMPROVED: Enhance DOM analysis with Vision AI modal detection
      // Vision AI sees modals visually, DOM analysis finds selectors
      const enhancedDomAnalysis = await this.enhanceDOMWithVisionModals(
        page,
        domAnalysis,
        visionAnalysis.modals
      );

      // Understand logical dependencies
      logger.info('[INTELLIGENT_ANALYZER] Starting logic analysis', { url });
      const logicStartTime = Date.now();
      const logicAnalysis = await this.analyzeLogic(
        visionAnalysis.pageType,
        visionAnalysis.elements,
        enhancedDomAnalysis
      );
      logger.info('[INTELLIGENT_ANALYZER] Logic analysis completed', {
        url,
        duration: `${Date.now() - logicStartTime}ms`,
        requiredActions: logicAnalysis.requiredActions.length,
        possibleActions: logicAnalysis.possibleActions.length,
      });

      // Build complete context
      const context: PageContext = {
        url,
        pageType: visionAnalysis.pageType,
        timestamp: Date.now(),
        vision: visionAnalysis,
        dom: enhancedDomAnalysis, // ✅ Use enhanced DOM analysis with merged modals
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
   * ✅ NEW: Wait for modals to appear before analysis
   * Many sites show modals with delay (2-5 seconds after page load)
   * This ensures we capture modals that appear after initial page load
   */
  private static async waitForModals(page: Page): Promise<void> {
    const startTime = Date.now();
    const maxWaitTime = 5000; // Maximum 5 seconds
    const checkInterval = 500; // Check every 500ms
    let lastModalCount = 0;

    logger.info('[INTELLIGENT_ANALYZER] Waiting for modals to appear', {
      url: page.url(),
      maxWaitTime: `${maxWaitTime}ms`,
    });

    while (Date.now() - startTime < maxWaitTime) {
      try {
        // Check for modals using DOM analysis
        const modalCount = await page.evaluate(() => {
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
            const hasHighZIndex = zIndex > 100;

            // Check for overlay (large element with background)
            // @ts-ignore - browser context
            const hasOverlay = style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                              // @ts-ignore - browser context
                              (el.offsetWidth > window.innerWidth * 0.5 || el.offsetHeight > window.innerHeight * 0.5);

            // Check for modal-like attributes
            const role = el.getAttribute('role');
            const ariaModal = el.getAttribute('aria-modal');
            const hasModalRole = role === 'dialog' || role === 'alertdialog' || ariaModal === 'true';

            // Check for modal-like classes/ids
            const className = el.className?.toLowerCase() || '';
            const id = el.id?.toLowerCase() || '';
            const hasModalKeywords = className.includes('modal') || className.includes('popup') ||
                                     className.includes('dialog') || className.includes('overlay') ||
                                     id.includes('modal') || id.includes('popup') || id.includes('dialog');

            // If element matches modal characteristics
            if ((hasModalRole || hasModalKeywords || (hasHighZIndex && isFixedOrAbsolute && hasOverlay)) &&
                el.offsetWidth > 100 && el.offsetHeight > 100) {
              count++;
            }
          }

          return count;
        });

        // If modals appeared, wait a bit more for them to fully render
        if (modalCount > lastModalCount) {
          logger.info('[INTELLIGENT_ANALYZER] Modal detected, waiting for full render', {
            modalCount,
            elapsed: `${Date.now() - startTime}ms`,
          });
          lastModalCount = modalCount;
          // Wait additional 500ms for modal to fully render (animations, etc.)
          await page.waitForTimeout(500);
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
          const hasHighZIndex = zIndex > 100; // Modals usually have high z-index
          // @ts-ignore - browser context
          const hasOverlay = style.backgroundColor !== 'rgba(0, 0, 0, 0)' &&
                            // @ts-ignore - browser context
                            (el.offsetWidth > window.innerWidth * 0.5 || el.offsetHeight > window.innerHeight * 0.5);

          // Check for modal-like attributes
          const role = el.getAttribute('role');
          const ariaModal = el.getAttribute('aria-modal');
          const hasModalRole = role === 'dialog' || role === 'alertdialog' || ariaModal === 'true';

          // Check for modal-like classes/ids (dynamic, not hardcoded)
          const className = el.className?.toLowerCase() || '';
          const id = el.id?.toLowerCase() || '';
          const hasModalKeywords = className.includes('modal') || className.includes('popup') ||
                                   className.includes('dialog') || className.includes('overlay') ||
                                   id.includes('modal') || id.includes('popup') || id.includes('dialog');

          // If element matches modal characteristics
          if ((hasModalRole || hasModalKeywords || (hasHighZIndex && isFixedOrAbsolute && hasOverlay)) &&
              el.offsetWidth > 100 && el.offsetHeight > 100) { // Must be reasonably sized
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
            const btnClass = btn.className?.toLowerCase() || '';
            const btnId = btn.id?.toLowerCase() || '';

            // Dynamic patterns for close buttons
            const closeKeywords = ['close', 'закрыть', 'dismiss', 'cancel', 'отмена', '×', '✕', 'x'];
            const hasCloseText = closeKeywords.some(keyword =>
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
              } else if (btnText && btnText.length <= 10) {
                // Escape special characters for selector
                const escapedText = btnText.replace(/"/g, '\\"');
                closeSelector = `button:has-text("${escapedText}")`;
              } else if (btnClass) {
                const classes = btnClass.split(' ').filter((c: string) => c && (c.includes('close') || c.includes('dismiss')));
                if (classes.length > 0) {
                  closeSelector = `button.${classes[0]}`;
                }
              }

              if (closeSelector) break;
            }
          }

          // Determine modal type dynamically
          const modalText = modalEl.textContent?.toLowerCase() || '';
          const modalClass = modalEl.className?.toLowerCase() || '';
          const modalId = modalEl.id?.toLowerCase() || '';

          let modalType: 'cookie_banner' | 'newsletter' | 'popup' | 'other' = 'other';

          // Check for cookie/GDPR keywords
          if (modalText.includes('cookie') || modalText.includes('gdpr') || modalText.includes('consent') ||
              modalClass.includes('cookie') || modalClass.includes('gdpr') || modalClass.includes('consent') ||
              modalId.includes('cookie') || modalId.includes('gdpr')) {
            modalType = 'cookie_banner';
          }
          // Check for newsletter/subscribe keywords
          else if (modalText.includes('newsletter') || modalText.includes('subscribe') || modalText.includes('email') ||
                   modalClass.includes('newsletter') || modalClass.includes('subscribe') ||
                   modalId.includes('newsletter') || modalId.includes('subscribe')) {
            modalType = 'newsletter';
          }
          // Check for popup/modal keywords
          else if (modalClass.includes('popup') || modalClass.includes('modal') || modalClass.includes('dialog') ||
                   modalId.includes('popup') || modalId.includes('modal') || modalId.includes('dialog')) {
            modalType = 'popup';
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
   * Decide if Vision should be used in balanced mode
   * Use Vision for important pages, skip for simple ones
   */
  private static async shouldUseVision(domAnalysis: DOMAnalysis): Promise<boolean> {
    // Use Vision if page has complex interactions
    const hasComplexForms = domAnalysis.forms.length > 1;
    const hasManyButtons = domAnalysis.buttons.length > 5;
    const hasModals = (domAnalysis.modals?.length || 0) > 0;

    return hasComplexForms || hasManyButtons || hasModals;
  }
}
