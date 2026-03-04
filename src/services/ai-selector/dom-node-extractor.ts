/**
 * DOM Node Extractor
 * Extracts enhanced DOM nodes with bounding boxes and metadata
 */

import { logger } from '@/utils/core/logger';
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

          // Interactive roles (expanded: include all ARIA widget roles)
          const interactiveRoles = [
            'button', 'link', 'checkbox', 'radio', 'textbox', 'searchbox',
            'combobox', 'listbox', 'option', 'menuitem', 'menuitemcheckbox',
            'menuitemradio', 'tab', 'switch', 'slider', 'spinbutton',
            'treeitem', 'gridcell',
          ];
          if (role && interactiveRoles.includes(role)) return true;

          // contenteditable — editable regions (rich text editors, inline editors)
          const contenteditable = element.getAttribute('contenteditable');
          if (contenteditable === 'true' || contenteditable === '') return true;

          // tabindex >= 0 — explicitly focusable (developer-declared interactive)
          const tabindex = element.getAttribute('tabindex');
          if (tabindex !== null && parseInt(tabindex, 10) >= 0) return true;

          // aria-expanded / aria-haspopup — dropdown/disclosure triggers
          if (element.hasAttribute('aria-expanded') || element.hasAttribute('aria-haspopup')) return true;

          // Elements with click handlers (inline)
          // @ts-ignore
          if (element.onclick || element.hasAttribute('onclick')) return true;

          // Phase 4: Framework event bindings (React/Vue/Angular synthetic events)
          // These elements appear non-interactive by DOM attributes but have JS event handlers
          try {
            const keys = Object.keys(element);
            for (let k = 0; k < keys.length; k++) {
              const key = keys[k];
              if (
                key.startsWith('__reactFiber$') ||
                key.startsWith('__reactInternalInstance$') ||
                key.startsWith('__reactEvents$')
              ) return true;
            }
            // @ts-ignore - browser context
            if (element.__vue__ || element.__vueParentComponent) return true;
            // @ts-ignore - browser context
            if (element.__ngContext__ || element._ngHost) return true;
          } catch (_) {
            // Ignore access errors (cross-origin, frozen objects)
          }

          // Clickable by CSS cursor (last resort — catches CSS-driven custom buttons)
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

        /**
         * ✅ FIX: Create counter and visited set INSIDE page.evaluate() using closure
         * This ensures they exist in browser context and are shared across all recursive calls
         * Set and Map cannot be serialized when passed as parameters to page.evaluate()
         */
        let nodeCounter = 0;
        const visited = new Set<any>(); // ✅ FIX: Create Set in closure, not as parameter

        /**
         * ✅ NEW: Recursively traverse Shadow DOM to extract nodes
         * Handles nested Shadow DOM, closed Shadow DOM (skips), and visited set
         * Uses closure to access nodeCounter and visited (no need to pass them as parameters)
         */
        function extractFromShadowDOM(
          root: any, // Document | ShadowRoot (browser context)
          shadowHost: any | undefined,
          depth: number,
          maxDepth: number
        ): any[] {
          const nodes: any[] = [];

          // Prevent infinite loops and excessive depth
          if (depth > maxDepth) {
            return nodes;
          }

          // Get all elements in current root
          // @ts-ignore - browser context
          const allElements = Array.from(root.querySelectorAll('*'));

          for (const el of allElements) {
            const element: any = el;

            // Skip if already visited (prevent duplicates)
            if (visited.has(element)) continue;
            visited.add(element);

            // Check if element has Shadow DOM
            let shadowRoot: any = null;
            try {
              shadowRoot = element.shadowRoot;
            } catch (e) {
              // Closed Shadow DOM - skip (can't access)
              // @ts-ignore
            }

            // Recurse into Shadow DOM if exists (BEFORE processing current element)
            if (shadowRoot) {
              const shadowNodes = extractFromShadowDOM(
                shadowRoot,
                element, // Current element becomes shadow host for children
                depth + 1,
                maxDepth
              );
              nodes.push(...shadowNodes);
            }

            // Process current element
            if (visibleOnly && !isVisible(element)) continue;
            if (interactiveOnly && !isInteractive(element)) continue;

            // Get bounding box
            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            // Extract node data
            const tag = element.tagName.toLowerCase();
            const text = element.textContent?.trim().substring(0, 200) || '';
            const attributes = getAttributes(element);
            const role = element.getAttribute('role') || undefined;

            // Resolve associated <label> text (critical for embeddings accuracy)
            // Follows: <label for="id"> → aria-labelledby → wrapping <label>
            let resolvedLabel = '';
            const elId = element.getAttribute('id');
            if (elId) {
              // @ts-ignore - browser context
              const labelFor = document.querySelector('label[for="' + elId + '"]');
              if (labelFor) resolvedLabel = labelFor.textContent?.trim() || '';
            }
            if (!resolvedLabel) {
              const ariaLabelledBy = element.getAttribute('aria-labelledby');
              if (ariaLabelledBy) {
                // @ts-ignore - browser context
                const labelEl = document.getElementById(ariaLabelledBy);
                if (labelEl) resolvedLabel = labelEl.textContent?.trim() || '';
              }
            }
            if (!resolvedLabel) {
              const parentLabel = element.closest('label');
              if (parentLabel) resolvedLabel = parentLabel.textContent?.trim() || '';
            }
            if (resolvedLabel) {
              attributes['__resolvedLabel'] = resolvedLabel.substring(0, 200);
            }

            // Container titles (Phase 7: expanded semantic container detection)
            // Detects fieldset legends, form/section headings, ARIA group labels, landmarks
            const LANDMARK_ROLES_SET = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'];
            const SEMANTIC_TAGS_SET = ['FIELDSET', 'FORM', 'SECTION', 'ARTICLE', 'NAV', 'ASIDE', 'DIALOG', 'HEADER', 'FOOTER', 'MAIN'];

            const cTitles: string[] = [];
            let nearestLandmark = '';
            let par = element.parentElement;
            let d = 0;
            while (par && d < 8) {
              const parRole = (par.getAttribute('role') || '').toLowerCase();
              const parAriaLabel = par.getAttribute('aria-label');
              const parTag = par.tagName;

              // Track nearest landmark
              if (!nearestLandmark) {
                if (parRole && LANDMARK_ROLES_SET.includes(parRole)) nearestLandmark = parRole;
                else if (parTag === 'NAV') nearestLandmark = 'navigation';
                else if (parTag === 'MAIN') nearestLandmark = 'main';
                else if (parTag === 'HEADER') nearestLandmark = 'banner';
                else if (parTag === 'FOOTER') nearestLandmark = 'contentinfo';
                else if (parTag === 'ASIDE') nearestLandmark = 'complementary';
              }

              // Extract container title
              if (parTag === 'FIELDSET') {
                const leg = par.querySelector('legend');
                if (leg?.textContent?.trim()) cTitles.push(leg.textContent.trim());
              } else if (SEMANTIC_TAGS_SET.includes(parTag) || (parRole && ['group', 'region', 'form', 'navigation', 'banner', 'main', 'complementary', 'search'].includes(parRole))) {
                if (parAriaLabel?.trim()) {
                  cTitles.push(parAriaLabel.trim());
                } else {
                  const hd = par.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
                  if (hd?.textContent?.trim()) cTitles.push(hd.textContent.trim());
                }
              }

              par = par.parentElement;
              d++;
            }
            if (cTitles.length > 0) {
              attributes['__containerTitles'] = cTitles.slice(0, 5).join('|');
            }
            if (nearestLandmark) {
              attributes['__nearestLandmark'] = nearestLandmark;
            }

            // isTopMostAtCenter (for overlay/modal detection)
            let topMost = false;
            if (rect.width > 0 && rect.height > 0) {
              const cx = rect.left + rect.width / 2;
              const cy = rect.top + rect.height / 2;
              // @ts-ignore - browser context
              const topEl = document.elementFromPoint(cx, cy);
              topMost = topEl === element || element.contains(topEl);
            }
            attributes['__isTopMostAtCenter'] = topMost ? 'true' : 'false';

            // ✅ FIX: Use closure to access and increment counter
            // This ensures unique nodeId across all recursive calls
            const nodeId = `node-${nodeCounter}`;
            nodeCounter++; // Increment for next node

            nodes.push({
              nodeId,
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
              shadowHost: shadowHost ? {
                tag: shadowHost.tagName.toLowerCase(),
                id: shadowHost.id || undefined,
                attributes: getAttributes(shadowHost),
              } : undefined,
            });
          }

          return nodes;
        }

        // ✅ NEW: Extract from regular DOM and Shadow DOM
        // ✅ FIX: nodeCounter and visited are in closure, no need to pass them as parameters
        // @ts-ignore - browser context
        const nodes = extractFromShadowDOM(document, undefined, 0, 5);

        return nodes;
      },
      { visibleOnly, interactiveOnly }
    );
  }
}
