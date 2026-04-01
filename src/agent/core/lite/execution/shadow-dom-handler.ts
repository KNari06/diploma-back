/**
 * ShadowDOMHandler
 * Handles interactions with Shadow DOM elements
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import type { Page, Locator, ElementHandle } from 'playwright';
import { logger } from '@/utils/core/logger';

/**
 * Recursive shadow DOM traversal function (reused across methods)
 * Injected into page.evaluateHandle() to find elements by ref inside shadow roots
 */
const FIND_IN_SHADOW_DOM_SCRIPT = `(refValue) => {
  function findInNode(node) {
    if (node.nodeType === 1) {
      if (node.getAttribute('data-agent-ref') === refValue) return node;
    }
    const children = node.childNodes;
    for (let i = 0; i < children.length; i++) {
      const found = findInNode(children[i]);
      if (found) return found;
    }
    if (node.nodeType === 1 && node.shadowRoot) {
      const shadowFound = findInNode(node.shadowRoot);
      if (shadowFound) return shadowFound;
    }
    return null;
  }
  return findInNode(document.body);
}`;

export class ShadowDOMHandler {
  /**
   * Find element inside Shadow DOM by ref
   * Penetrates shadow roots to find data-agent-ref elements
   *
   * ✅ FIX: Returns Locator when possible, falls back to ElementHandle-based search
   * Previously returned a standard CSS locator that CANNOT pierce shadow DOM boundaries,
   * making the entire shadow DOM fallback path useless.
   *
   * @param page - Playwright page
   * @param ref - Element reference (data-agent-ref value)
   * @returns Locator for the element, or null if not found
   */
  static async findInShadowDOM(page: Page, ref: string): Promise<Locator | null> {
    try {
      // Playwright's default CSS locator engine pierces open shadow DOM
      const standardLocator = page.locator(`[data-agent-ref="${ref}"]`);
      const count = await standardLocator.count();

      if (count > 0) {
        logger.debug('[SHADOW_DOM] Found element with standard selector', { ref });
        return standardLocator.first();
      }

      logger.debug('[SHADOW_DOM] Element not found with standard selector', { ref });
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
   * Find element via manual shadow DOM traversal as ElementHandle
   * Used when standard Playwright locator can't find the element (closed shadow roots, etc.)
   */
  private static async findElementHandle(page: Page, ref: string): Promise<ElementHandle | null> {
    try {
      const handle = await page.evaluateHandle(FIND_IN_SHADOW_DOM_SCRIPT, ref);
      const element = handle.asElement();
      if (element) {
        logger.debug('[SHADOW_DOM] Found element via manual traversal', { ref });
        return element;
      }
      return null;
    } catch (error) {
      logger.debug('[SHADOW_DOM] Manual traversal failed', {
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
      // Try locator first
      const locator = await this.findInShadowDOM(page, ref);
      if (locator) {
        await locator.click({ timeout: 5000 });
        logger.debug('[SHADOW_DOM] Clicked element via locator', { ref });
        return true;
      }

      // ✅ FIX: Fallback to ElementHandle for closed shadow roots
      const element = await this.findElementHandle(page, ref);
      if (element) {
        await element.click({ timeout: 5000 });
        logger.debug('[SHADOW_DOM] Clicked element via ElementHandle', { ref });
        return true;
      }

      return false;
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
      // Try locator first
      const locator = await this.findInShadowDOM(page, ref);
      if (locator) {
        await locator.fill(value, { timeout: 5000 });
        // Post-fill event reinforcement for Angular/React/Vue reactive forms
        try {
          await locator.evaluate((el, val) => {
            const input = el as HTMLInputElement;
            if (input.value !== val) {
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set || Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
              )?.set;
              if (setter) setter.call(input, val); else input.value = val;
            }
            input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            input.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, value);
        } catch { /* non-critical */ }
        logger.debug('[SHADOW_DOM] Filled element via locator', { ref, value: value.slice(0, 30) });
        return true;
      }

      // ✅ FIX: Fallback to ElementHandle for closed shadow roots
      const element = await this.findElementHandle(page, ref);
      if (element) {
        await element.fill(value, { timeout: 5000 });
        try {
          await element.evaluate((el: any, val: string) => {
            if (el.value !== val) {
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype, 'value'
              )?.set || Object.getOwnPropertyDescriptor(
                window.HTMLTextAreaElement.prototype, 'value'
              )?.set;
              if (setter) setter.call(el, val); else el.value = val;
            }
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          }, value);
        } catch { /* non-critical */ }
        logger.debug('[SHADOW_DOM] Filled element via ElementHandle', { ref, value: value.slice(0, 30) });
        return true;
      }

      return false;
    } catch (error) {
      logger.error('[SHADOW_DOM] Failed to fill element', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Toggle (click) element that may be inside Shadow DOM
   * Used for checkboxes, switches, radio buttons inside shadow roots
   */
  static async toggle(page: Page, ref: string): Promise<boolean> {
    try {
      const locator = await this.findInShadowDOM(page, ref);
      if (locator) {
        await locator.click({ timeout: 5000 });
        try {
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        logger.debug('[SHADOW_DOM] Toggled element via locator', { ref });
        return true;
      }

      // ✅ FIX: ElementHandle fallback
      const element = await this.findElementHandle(page, ref);
      if (element) {
        await element.click({ timeout: 5000 });
        try {
          await element.evaluate((el: any) => {
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        logger.debug('[SHADOW_DOM] Toggled element via ElementHandle', { ref });
        return true;
      }

      return false;
    } catch (error) {
      logger.error('[SHADOW_DOM] Failed to toggle element', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Clear an input field that may be inside Shadow DOM
   */
  static async clear(page: Page, ref: string): Promise<boolean> {
    try {
      const locator = await this.findInShadowDOM(page, ref);
      if (locator) {
        await locator.clear({ timeout: 5000 });
        try {
          await locator.evaluate((el) => {
            el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
          });
        } catch { /* non-critical */ }
        logger.debug('[SHADOW_DOM] Cleared element via locator', { ref });
        return true;
      }

      // ✅ FIX: ElementHandle fallback
      const element = await this.findElementHandle(page, ref);
      if (element) {
        await element.evaluate((el: any) => {
          if ('value' in el) el.value = '';
          el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          el.dispatchEvent(new Event('blur', { bubbles: true, cancelable: true }));
        });
        logger.debug('[SHADOW_DOM] Cleared element via ElementHandle', { ref });
        return true;
      }

      return false;
    } catch (error) {
      logger.error('[SHADOW_DOM] Failed to clear element', {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Set range/slider value on element that may be inside Shadow DOM
   */
  static async setRange(page: Page, ref: string, value: string): Promise<boolean> {
    return this.setNativeValue(page, ref, value, 'range');
  }

  /**
   * Set date/time value on element that may be inside Shadow DOM
   */
  static async selectDate(page: Page, ref: string, value: string): Promise<boolean> {
    return this.setNativeValue(page, ref, value, 'date');
  }

  /**
   * V9: Shared implementation for setRange/selectDate.
   * Uses shared native-input-helpers utility to avoid 4× code duplication.
   */
  private static async setNativeValue(
    page: Page, ref: string, value: string, label: string,
  ): Promise<boolean> {
    try {
      const { setNativeInputValue } = await import('@/agent/playwright/core/native-input-helpers');

      const locator = await this.findInShadowDOM(page, ref);
      if (locator) {
        await setNativeInputValue(locator, value);
        logger.debug(`[SHADOW_DOM] Set ${label} value via locator`, { ref, value });
        return true;
      }

      // ElementHandle fallback: evaluate inline (ElementHandle.evaluate has different signature than Locator)
      const element = await this.findElementHandle(page, ref);
      if (element) {
        await element.evaluate((el: any, val: string) => {
          const nativeSetter = Object.getOwnPropertyDescriptor(
            window.HTMLInputElement.prototype, 'value',
          )?.set;
          if (nativeSetter) nativeSetter.call(el, val); else el.value = val;
          if (typeof el.focus === 'function') el.focus();
          const eventOpts = { bubbles: true, cancelable: true, composed: true };
          try {
            el.dispatchEvent(new InputEvent('input', { ...eventOpts, data: val, inputType: 'insertText' }));
          } catch (_e) {
            el.dispatchEvent(new Event('input', eventOpts));
          }
          el.dispatchEvent(new Event('change', eventOpts));
          el.dispatchEvent(new Event('blur', eventOpts));
        }, value);
        logger.debug(`[SHADOW_DOM] Set ${label} value via ElementHandle`, { ref, value });
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`[SHADOW_DOM] Failed to set ${label} value`, {
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Check if page has Shadow DOM elements
   */
  static async hasShadowDOM(page: Page): Promise<boolean> {
    try {
      const hasShadow = await page.evaluate(() => {
        function checkNode(node: any): boolean {
          if (node.nodeType === 1) {
            const el = node as any;
            if ((el as any).shadowRoot) return true;
          }

          const children = node.childNodes;
          for (let i = 0; i < children.length; i++) {
            if (checkNode(children[i])) return true;
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
