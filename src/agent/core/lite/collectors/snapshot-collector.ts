/**
 * SnapshotCollector
 * Collects page snapshot with accessibility tree + parent context
 * KEY FEATURE: Each element includes its semantic parent container
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';
import type { LiteElement, LiteSnapshot } from '../lite-types';
import { VisualStability } from './visual-stability';

export class SnapshotCollector {
  /**
   * Collect page snapshot with parent context
   * Waits for visual stability before collecting
   *
   * @param page - Playwright page instance
   * @returns Snapshot with elements including parent context
   */
  static async collect(page: Page): Promise<LiteSnapshot> {
    try {
      // Wait for visual stability first
      await VisualStability.waitForStable(page);

      // Collect snapshot in page context
      // @ts-expect-error - DOM types available in browser context
      const snapshot = await page.evaluate(() => {
        const elements: any[] = [];
        // Keep stable refs across snapshots to enable meaningful diffs.
        // Use monotonic counter stored on window to avoid reassigning refs every time.
        // @ts-expect-error - window available in browser context
        const win = window as any;
        if (typeof win.__agentRefCounter !== 'number') {
          win.__agentRefCounter = 0;
        }

        /**
         * Helper: get parent context for an element
         * Looks for semantic parent containers and extracts identifying info
         */
        const getParentContext = (el: Element): string | undefined => {
          // Look for semantic parent containers
          const parent = el.closest(
            '[data-product], [data-item], .card, .product, .item, ' +
            'article, section, [role="listitem"], [role="article"], ' +
            '.modal, [role="dialog"], form, [data-container], ' +
            'header, footer, aside, nav'
          );

          if (!parent || parent === el) return undefined;

          // Get title from parent
          const title = parent.querySelector(
            'h1, h2, h3, h4, h5, h6, ' +
            '[class*="title"], [class*="name"], [class*="heading"], ' +
            '[data-title], [aria-label]'
          );

          let titleText = title?.textContent?.trim() ||
                         parent.getAttribute('aria-label') ||
                         parent.getAttribute('data-title');

          if (titleText) {
            titleText = titleText.slice(0, 50);
          }

          // Determine parent type
          const parentType =
            parent.matches('.card, .product, .item, [data-product], [data-item]') ? 'Card' :
            parent.matches('article, [role="article"]') ? 'Article' :
            parent.matches('form') ? 'Form' :
            parent.matches('.modal, [role="dialog"]') ? 'Modal' :
            parent.matches('section') ? 'Section' :
            parent.matches('header') ? 'Header' :
            parent.matches('footer') ? 'Footer' :
            parent.matches('nav') ? 'Navigation' :
            parent.matches('aside') ? 'Aside' :
            'Container';

          return titleText
            ? `inside: ${parentType} "${titleText}"`
            : `inside: ${parentType}`;
        };

        // Collect interactive elements
        const selectors = [
          'button', 'a', 'input', 'select', 'textarea',
          '[role="button"]', '[role="link"]', '[role="menuitem"]',
          '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
          '[onclick]', '[tabindex]:not([tabindex="-1"])',
          '[data-testid]', '[data-test]'
        ].join(', ');

        const allElements = document.querySelectorAll(selectors);

        allElements.forEach((el: Element) => {
          try {
            // Skip hidden elements
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (parseFloat(style.opacity) < 0.1) return;

            // Skip if too small
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return;

            // Skip if outside viewport (way off screen)
            // @ts-expect-error - window available in browser context
            if (rect.bottom < -1000 || rect.top > window.innerHeight + 1000) return;

            // Reuse existing ref if present, otherwise assign a new one.
            // This makes refs stable across iterations (unless DOM node is replaced).
            const existingRef = el.getAttribute('data-agent-ref');
            const ref = existingRef && /^e\d+$/.test(existingRef)
              ? existingRef
              : `e${win.__agentRefCounter++}`;
            if (!existingRef || existingRef !== ref) {
              el.setAttribute('data-agent-ref', ref);
            }

            const input = el as any;
            const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';

            elements.push({
              ref,
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              name: el.getAttribute('aria-label') ||
                    el.getAttribute('title') ||
                    el.getAttribute('placeholder') ||
                    el.textContent?.trim().slice(0, 50) || '',
              tag: el.tagName.toLowerCase(),
              type: isInput ? input.type : undefined,
              value: isInput ? input.value : undefined,
              placeholder: isInput ? input.placeholder : undefined,
              checked: input.checked || undefined,
              disabled: input.disabled || el.hasAttribute('disabled'),
              visible: true,
              context: getParentContext(el),  // Parent context
            });
          } catch (err) {
            // Skip element if any error
            console.error('Failed to process element:', err);
          }
        });

        return {
          // @ts-expect-error - window and document available in browser context
          url: window.location.href,
          // @ts-expect-error
          title: document.title,
          elements,
          timestamp: Date.now(),
        };
      });

      logger.debug('[SNAPSHOT_COLLECTOR] Collected snapshot', {
        url: snapshot.url,
        elementCount: snapshot.elements.length,
      });

      return snapshot as LiteSnapshot;
    } catch (error) {
      logger.error('[SNAPSHOT_COLLECTOR] Failed to collect snapshot', {
        error: error instanceof Error ? error.message : String(error),
      });

      // Return empty snapshot on error
      return {
        url: page.url(),
        title: '',
        elements: [],
        timestamp: Date.now(),
      };
    }
  }

  /**
   * Format snapshot for AI prompt
   * Groups elements by role and includes parent context
   *
   * @param snapshot - Snapshot to format
   * @returns Formatted string for AI
   */
  static format(snapshot: LiteSnapshot): string {
    if (snapshot.elements.length === 0) {
      return 'No interactive elements found on page.';
    }

    // Group elements by role
    const groups: Record<string, LiteElement[]> = {};

    snapshot.elements.forEach((el) => {
      const role = el.role.toUpperCase();
      if (!groups[role]) groups[role] = [];
      groups[role].push(el);
    });

    const lines: string[] = [];
    lines.push(`URL: ${snapshot.url}`);
    lines.push(`Title: ${snapshot.title || '(no title)'}`);
    lines.push('');

    // Format each group
    for (const [role, elements] of Object.entries(groups)) {
      lines.push(`[${role}S]`);
      elements.forEach((el) => {
        let line = `  ${el.ref}: "${el.name}"`;
        if (el.context) line += ` (${el.context})`;  // Parent context
        if (el.type) line += ` type=${el.type}`;
        if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
        if (el.disabled) line += ' [DISABLED]';
        if (el.checked) line += ' [CHECKED]';
        if (el.value) line += ` value="${el.value.slice(0, 30)}"`;
        lines.push(line);
      });
      lines.push('');
    }

    return lines.join('\n');
  }
}
