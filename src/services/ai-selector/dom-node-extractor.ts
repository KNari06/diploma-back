/**
 * DOM Node Extractor
 * Extracts enhanced DOM nodes with bounding boxes and metadata
 */

import { logger } from '@/utils/logger';
import { Page } from 'playwright';
import type { DOMNode } from './types';

// ═══════════════════════════════════════════════════════════════════════════
// DOM NODE EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

export class DOMNodeExtractor {
  /**
   * Extract all interactive DOM nodes with bounding boxes
   * Uses page.evaluate() for fast extraction
   */
  static async extractNodes(
    page: Page,
    options: {
      visibleOnly?: boolean; // Only visible elements
      interactiveOnly?: boolean; // Only interactive elements
    } = {}
  ): Promise<DOMNode[]> {
    const { visibleOnly = true, interactiveOnly = false } = options;

    logger.info('[DOM_NODE_EXTRACTOR] Extracting DOM nodes', {
      visibleOnly,
      interactiveOnly,
    });

    const startTime = Date.now();

    try {
      const nodes = await this.extractNodesFast(page, { visibleOnly, interactiveOnly });
      logger.info('[DOM_NODE_EXTRACTOR] Nodes extracted', {
        count: nodes.length,
        duration: `${Date.now() - startTime}ms`,
      });
      return nodes;
    } catch (error) {
      logger.error('[DOM_NODE_EXTRACTOR] Failed to extract nodes', { error });
      return [];
    }
  }

  /**
   * Extract nodes using page.evaluate()
   * Fast and efficient for most use cases
   */
  private static async extractNodesFast(
    page: Page,
    options: { visibleOnly: boolean; interactiveOnly: boolean }
  ): Promise<DOMNode[]> {
    const { visibleOnly, interactiveOnly } = options;

    return await page.evaluate(
      ({ visibleOnly, interactiveOnly }) => {
        /**
         * Check if element is visible
         * @ts-ignore - browser context
         */
        function isVisible(element: any): boolean {
          // @ts-ignore - browser context
          const style = window.getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            rect.width > 0 &&
            rect.height > 0 &&
            // Check if in viewport
            // @ts-ignore - browser context
            rect.top < window.innerHeight &&
            rect.bottom > 0 &&
            // @ts-ignore - browser context
            rect.left < window.innerWidth &&
            rect.right > 0
          );
        }

        /**
         * Check if element is interactive
         * @ts-ignore - browser context
         */
        function isInteractive(element: any): boolean {
          const tag = element.tagName.toLowerCase();
          const role = element.getAttribute('role');

          // Interactive tags
          const interactiveTags = ['a', 'button', 'input', 'select', 'textarea'];
          if (interactiveTags.includes(tag)) return true;

          // Interactive roles
          const interactiveRoles = ['button', 'link', 'checkbox', 'radio', 'textbox'];
          if (role && interactiveRoles.includes(role)) return true;

          // Elements with click handlers
          // @ts-ignore
          if (element.onclick || element.hasAttribute('onclick')) return true;

          // Clickable elements
          // @ts-ignore
          if (window.getComputedStyle(element).cursor === 'pointer') return true;

          return false;
        }

        /**
         * Get all attributes as object
         * @ts-ignore - browser context
         */
        function getAttributes(element: any): Record<string, string> {
          const attrs: Record<string, string> = {};
          for (let i = 0; i < element.attributes.length; i++) {
            const attr = element.attributes[i];
            attrs[attr.name] = attr.value;
          }
          return attrs;
        }

        // Get all elements
        // @ts-ignore - browser context
        const allElements = Array.from(document.querySelectorAll('*'));

        // Filter and extract nodes
        const nodes: any[] = [];
        let nodeIndex = 0;

        for (const el of allElements) {
          const element: any = el;

          // Skip if not visible (when visibleOnly = true)
          if (visibleOnly && !isVisible(element)) continue;

          // Skip if not interactive (when interactiveOnly = true)
          if (interactiveOnly && !isInteractive(element)) continue;

          // Get bounding box
          const rect = element.getBoundingClientRect();

          // Skip elements with no size
          if (rect.width === 0 || rect.height === 0) continue;

          // Extract node data
          const tag = element.tagName.toLowerCase();
          const text = element.textContent?.trim().substring(0, 200) || '';
          const attributes = getAttributes(element);
          const role = element.getAttribute('role') || undefined;

          nodes.push({
            nodeId: `node-${nodeIndex}`,
            tag,
            text,
            attributes,
            boundingBox: {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              width: Math.round(rect.width),
              height: Math.round(rect.height),
            },
            isVisible: isVisible(element),
            role,
          });

          nodeIndex++;
        }

        return nodes;
      },
      { visibleOnly, interactiveOnly }
    );
  }
}
