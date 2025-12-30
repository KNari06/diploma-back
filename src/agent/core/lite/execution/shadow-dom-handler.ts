/**
 * ShadowDOMHandler
 * Handles interactions with Shadow DOM elements
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import type { Page, Locator } from 'playwright';
import { logger } from '@/utils/core/logger';

export class ShadowDOMHandler {
  /**
   * Find element inside Shadow DOM by ref
   * Penetrates shadow roots to find data-agent-ref elements
   *
   * @param page - Playwright page
   * @param ref - Element reference (data-agent-ref value)
   * @returns Locator for the element, or null if not found
   */
  static async findInShadowDOM(page: Page, ref: string): Promise<Locator | null> {
    try {
      // Try standard selector first (works for open shadow DOM)
      const standardLocator = page.locator(`[data-agent-ref="${ref}"]`);
      const count = await standardLocator.count();

      if (count > 0) {
        logger.debug('[SHADOW_DOM] Found element with standard selector', { ref });
        return standardLocator.first();
      }

      // If not found, try to penetrate shadow DOM manually
      const elementHandle = await page.evaluateHandle((refValue) => {
        // Recursive function to search through shadow roots
        function findInNode(node: any): any {
          // Check current node if it's an element
          if (node.nodeType === 1) { // Element node
            const el = node as any;
            if (el.getAttribute('data-agent-ref') === refValue) {
              return el;
            }
          }

          // Check child nodes
          const children = node.childNodes;
          for (let i = 0; i < children.length; i++) {
            const found = findInNode(children[i]);
            if (found) return found;
          }

          // Check shadow root if exists
          if (node.nodeType === 1) { // Element node
            const el = node as any;
            if ((el as any).shadowRoot) {
              const shadowFound = findInNode((el as any).shadowRoot);
              if (shadowFound) return shadowFound;
            }
          }

          return null;
        }

        // @ts-expect-error - document available in browser context
        return findInNode(document.body);
      }, ref);

      const element = elementHandle.asElement();

      if (element) {
        logger.debug('[SHADOW_DOM] Found element inside shadow DOM', { ref });
        return page.locator(`[data-agent-ref="${ref}"]`).first();
      }

      logger.debug('[SHADOW_DOM] Element not found in shadow DOM', { ref });
      return null;
    } catch (error) {
      logger.error('[SHADOW_DOM] Error finding element in shadow DOM', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Click element that may be inside Shadow DOM
   *
   * @param page - Playwright page
   * @param ref - Element reference
   * @returns Success status
   */
  static async click(page: Page, ref: string): Promise<boolean> {
    try {
      const locator = await this.findInShadowDOM(page, ref);

      if (!locator) {
        return false;
      }

      await locator.click({ timeout: 5000 });
      logger.debug('[SHADOW_DOM] Clicked element', { ref });
      return true;
    } catch (error) {
      logger.error('[SHADOW_DOM] Failed to click element', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Fill element that may be inside Shadow DOM
   *
   * @param page - Playwright page
   * @param ref - Element reference
   * @param value - Value to fill
   * @returns Success status
   */
  static async fill(page: Page, ref: string, value: string): Promise<boolean> {
    try {
      const locator = await this.findInShadowDOM(page, ref);

      if (!locator) {
        return false;
      }

      await locator.fill(value, { timeout: 5000 });
      logger.debug('[SHADOW_DOM] Filled element', { ref, value: value.slice(0, 30) });
      return true;
    } catch (error) {
      logger.error('[SHADOW_DOM] Failed to fill element', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if page has Shadow DOM elements
   *
   * @param page - Playwright page
   * @returns True if Shadow DOM is present
   */
  static async hasShadowDOM(page: Page): Promise<boolean> {
    try {
      const hasShadow = await page.evaluate(() => {
        function checkNode(node: any): boolean {
          if (node.nodeType === 1) { // Element node
            const el = node as any;
            if ((el as any).shadowRoot) {
              return true;
            }
          }

          const children = node.childNodes;
          for (let i = 0; i < children.length; i++) {
            if (checkNode(children[i])) {
              return true;
            }
          }

          return false;
        }

        // @ts-expect-error - document available in browser context
        return checkNode(document.body);
      });

      return hasShadow;
    } catch (error) {
      logger.error('[SHADOW_DOM] Failed to check for shadow DOM', {
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}
