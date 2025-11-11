/**
 * IntelligentPageAnalyzer
 * Analyzes web pages using GPT-4 Vision + DOM analysis
 * Understands page context, type, and available actions
 */

import { Page } from 'playwright';
import { OpenAI } from 'openai';
import { env } from '@/config/env';
import { logger } from '@/utils/logger';
import {
  PageContext,
  VisionAnalysis,
  DOMAnalysis,
  PageType,
} from './types/intelligent-testing.types';
import { buildPageAnalysisPrompt, buildLogicAnalysisPrompt } from '@/ai/prompts/intelligent-testing-prompts';
import { analyzeDOMStructure } from '@/services/dom-analyzer.service';

const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

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
      // Parallel analysis for speed
      const [screenshot, domAnalysis] = await Promise.all([
        this.captureScreenshot(page, mode),
        this.analyzeDOMFull(page),
      ]);

      // Vision analysis (conditional based on mode)
      let visionAnalysis: VisionAnalysis;

      if (mode === 'full' || (mode === 'balanced' && await this.shouldUseVision(domAnalysis))) {
        logger.info('[INTELLIGENT_ANALYZER] Using GPT-4 Vision for analysis');
        visionAnalysis = await this.analyzeWithVision(
          screenshot,
          url,
          goal,
          previousContext
        );
      } else {
        logger.info('[INTELLIGENT_ANALYZER] Using DOM-only analysis (fast mode)');
        visionAnalysis = await this.analyzeWithoutVision(domAnalysis, url);
      }

      // Understand logical dependencies
      const logicAnalysis = await this.analyzeLogic(
        visionAnalysis.pageType,
        visionAnalysis.elements,
        domAnalysis
      );

      // Build complete context
      const context: PageContext = {
        url,
        pageType: visionAnalysis.pageType,
        timestamp: Date.now(),
        vision: visionAnalysis,
        dom: domAnalysis,
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
      logger.error('[INTELLIGENT_ANALYZER] Page analysis failed', { error, url });

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
      // Wait for page to be stable
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {
        logger.warn('[INTELLIGENT_ANALYZER] Network not idle, proceeding anyway');
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

  private static async detectModals(page: Page): Promise<DOMAnalysis['modals']> {
    try {
      return await page.evaluate(() => {
        const modals: Array<{
          type: 'cookie_banner' | 'newsletter' | 'popup' | 'other';
          closeSelector?: string;
        }> = [];

        // Cookie banners
        const cookieSelectors = [
          '[class*="cookie"]',
          '[id*="cookie"]',
          '[class*="gdpr"]',
          '[class*="consent"]',
        ];

        for (const selector of cookieSelectors) {
          // @ts-expect-error - browser context
          const el = document.querySelector(selector);
          if (el) {
            // @ts-expect-error - browser context
            const acceptBtn = el.querySelector(
              'button:has-text("Accept"), button:has-text("Agree"), button:has-text("OK"), .accept, .agree'
            );
            modals.push({
              type: 'cookie_banner',
              closeSelector: acceptBtn ? selector : undefined,
            });
            break;
          }
        }

        // Newsletter popups
        const newsletterSelectors = [
          '[class*="newsletter"]',
          '[class*="subscribe"]',
          '[class*="popup"]',
        ];

        for (const selector of newsletterSelectors) {
          // @ts-expect-error - browser context
          const el = document.querySelector(selector);
          if (el) {
            // @ts-expect-error - browser context
            const closeBtn = el.querySelector(
              'button:has-text("Close"), button:has-text("Dismiss"), .close, [aria-label*="close"]'
            );
            modals.push({
              type: 'newsletter',
              closeSelector: closeBtn ? selector : undefined,
            });
            break;
          }
        }

        return modals;
      });
    } catch (error) {
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
      };
    } catch (error) {
      logger.error('[INTELLIGENT_ANALYZER] Vision analysis failed', { error });

      return {
        pageType: 'unknown',
        description: 'Vision analysis failed',
        elements: [],
        suggestions: [],
        warnings: ['Vision analysis failed'],
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
    const hasEmailField = dom.inputs.some(input => input.type === 'email' || input.name.includes('email'));

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
      const priority: 'critical' | 'high' | 'medium' | 'low' = input.name.includes('email') || input.type === 'password'
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
