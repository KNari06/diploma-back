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
         * Detect active modal/overlay
         * Visual detection: position fixed/absolute + viewport coverage + z-index
         * Returns ref of modal container if found
         */
        const detectActiveModal = (): string | undefined => {
          // Find all potential overlay containers
          const potentialModals = Array.from(document.querySelectorAll('*')).filter((el: Element) => {
            const style = window.getComputedStyle(el);
            const position = style.position;

            // Must be fixed or absolute
            if (position !== 'fixed' && position !== 'absolute') return false;

            // Must be visible
            if (style.display === 'none' || style.visibility === 'hidden') return false;
            if (parseFloat(style.opacity) < 0.1) return false;

            // ✅ FIX: Get z-index (must be present, allow any positive value)
            // Many sites use z-index: 10-50 for modals, not just 100+
            const zIndex = parseInt(style.zIndex, 10);
            if (isNaN(zIndex) || zIndex < 1) return false;

            return true;
          });

          if (potentialModals.length === 0) return undefined;

          // ✅ FIX: Find modal with highest RELATIVE z-index among all potential modals
          // This works even if site uses low z-index values (10, 20, 50)
          let bestModal: Element | null = null;
          let highestZIndex = -1;

          for (const modal of potentialModals) {
            const style = window.getComputedStyle(modal);
            const zIndex = parseInt(style.zIndex, 10);
            const rect = modal.getBoundingClientRect();

            // Calculate viewport coverage
            // @ts-expect-error - window available in browser context
            const viewportArea = window.innerWidth * window.innerHeight;
            const modalArea = rect.width * rect.height;
            const coverage = modalArea / viewportArea;

            // Check for modal indicators
            const hasModalRole = modal.getAttribute('role') === 'dialog' ||
              modal.getAttribute('aria-modal') === 'true' ||
              modal.classList.contains('modal') ||
              modal.classList.contains('overlay') ||
              modal.classList.contains('popup');

            // Accept if:
            // 1. Has modal role/class AND covers >20% viewport, OR
            // 2. Covers >40% viewport with any z-index
            const isModal = (hasModalRole && coverage > 0.2) || coverage > 0.4;

            // ✅ FIX: Pick modal with highest z-index (relative comparison)
            if (isModal && zIndex > highestZIndex) {
              highestZIndex = zIndex;
              bestModal = modal;
            }
          }

          if (bestModal) {
            // Assign ref to modal if not already present
            const existingRef = bestModal.getAttribute('data-agent-ref');
            if (existingRef) {
              return existingRef;
            }

            const newRef = `e${win.__agentRefCounter++}`;
            bestModal.setAttribute('data-agent-ref', newRef);
            return newRef;
          }

          return undefined;
        };

        // Detect active modal first
        const activeModalRef = detectActiveModal();

        /**
         * Detect transient state (loading indicators)
         * Checks for progressbar, aria-busy, aria-live, loading text, spinners
         * Returns transient state info if page is loading
         */
        const detectTransientState = (): { isTransient: boolean; type?: string; ref?: string; text?: string } => {
          // Loading text patterns (multi-language)
          const loadingPatterns = [
            'loading', 'загрузка', 'please wait', 'подождите',
            'spinner', 'processing', 'обработка', 'loading...',
            'загружается', 'пожалуйста, подождите'
          ];

          // 1. Check for role=progressbar
          const progressbar = document.querySelector('[role="progressbar"]:not([aria-hidden="true"])');
          if (progressbar) {
            const style = window.getComputedStyle(progressbar);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const existingRef = progressbar.getAttribute('data-agent-ref') || `e${win.__agentRefCounter++}`;
              progressbar.setAttribute('data-agent-ref', existingRef);
              return { isTransient: true, type: 'progressbar', ref: existingRef };
            }
          }

          // 2. Check for aria-busy=true on any element
          const busyElement = document.querySelector('[aria-busy="true"]');
          if (busyElement) {
            const style = window.getComputedStyle(busyElement);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const existingRef = busyElement.getAttribute('data-agent-ref') || `e${win.__agentRefCounter++}`;
              busyElement.setAttribute('data-agent-ref', existingRef);
              return { isTransient: true, type: 'aria-busy', ref: existingRef };
            }
          }

          // 3. Check for aria-live regions with "loading" text
          const liveRegions = document.querySelectorAll('[aria-live]');
          for (const region of liveRegions) {
            const text = region.textContent?.toLowerCase() || '';
            if (loadingPatterns.some(p => text.includes(p))) {
              const existingRef = region.getAttribute('data-agent-ref') || `e${win.__agentRefCounter++}`;
              region.setAttribute('data-agent-ref', existingRef);
              return { isTransient: true, type: 'aria-live', ref: existingRef, text: text.slice(0, 50) };
            }
          }

          // 4. Check for skeleton loaders (common pattern)
          const skeleton = document.querySelector('.skeleton, .skeleton-loader, [data-skeleton], .placeholder-glow');
          if (skeleton) {
            const style = window.getComputedStyle(skeleton);
            if (style.display !== 'none' && style.visibility !== 'hidden') {
              const existingRef = skeleton.getAttribute('data-agent-ref') || `e${win.__agentRefCounter++}`;
              skeleton.setAttribute('data-agent-ref', existingRef);
              return { isTransient: true, type: 'skeleton', ref: existingRef };
            }
          }

          // 5. Check for visible spinner elements
          const spinnerSelectors = '.spinner, .loader, .loading, [class*="spinner"], [class*="loader"], [data-loading]';
          const spinners = document.querySelectorAll(spinnerSelectors);
          for (const spinner of spinners) {
            const style = window.getComputedStyle(spinner);
            if (style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.3) {
              // Check if it has animation (typical for spinners)
              const animationName = style.animationName;
              const animationDuration = parseFloat(style.animationDuration);
              if (animationName && animationName !== 'none' && animationDuration > 0) {
                const existingRef = spinner.getAttribute('data-agent-ref') || `e${win.__agentRefCounter++}`;
                spinner.setAttribute('data-agent-ref', existingRef);
                return { isTransient: true, type: 'spinner', ref: existingRef };
              }
            }
          }

          // 6. Check for loading text in visible elements
          const allText = document.body?.innerText?.toLowerCase() || '';
          for (const pattern of loadingPatterns) {
            if (allText.includes(pattern)) {
              // Find the element containing this text
              const walker = document.createTreeWalker(
                document.body,
                NodeFilter.SHOW_TEXT,
                null
              );
              let node: Node | null;
              while ((node = walker.nextNode())) {
                if (node.textContent?.toLowerCase().includes(pattern)) {
                  const parent = node.parentElement;
                  if (parent) {
                    const style = window.getComputedStyle(parent);
                    if (style.display !== 'none' && style.visibility !== 'hidden') {
                      const existingRef = parent.getAttribute('data-agent-ref') || `e${win.__agentRefCounter++}`;
                      parent.setAttribute('data-agent-ref', existingRef);
                      return { isTransient: true, type: 'loading-text', ref: existingRef, text: pattern };
                    }
                  }
                  break;
                }
              }
            }
          }

          return { isTransient: false };
        };

        // Detect transient state
        const transientState = detectTransientState();

        // ✅ FIX: Cache modal element for efficient lookup
        const activeModalElement = activeModalRef
          ? document.querySelector(`[data-agent-ref="${activeModalRef}"]`)
          : null;

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

        // ═══════════════════════════════════════════════════════════════════════
        // WORKSTREAM D: Shadow-Aware Element Collection (with depth + cache)
        // Recursively traverse DOM including open shadow roots
        // Performance bounded to prevent slowdowns on deep web-component pages
        // ═══════════════════════════════════════════════════════════════════════
        const interactiveSelectors = [
          'button', 'a', 'input', 'select', 'textarea',
          '[role="button"]', '[role="link"]', '[role="menuitem"]',
          '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
          '[onclick]', '[tabindex]:not([tabindex="-1"])',
          '[data-testid]', '[data-test]',
          'canvas' // ✅ L5: Include canvas for vision escalation trigger
        ];

        // WORKSTREAM D: Performance limits
        const MAX_SHADOW_DEPTH = 8; // Prevent infinite/deep recursion
        const visitedRoots = new WeakSet<object>(); // Cache visited roots to avoid reprocessing

        /**
         * Recursively collect elements from a root (document or shadow root)
         * Traverses open shadow DOMs for web component support
         * WORKSTREAM D: Bounded by depth and visited cache
         */
        const collectFromRoot = (
          root: Document | ShadowRoot | Element,
          collected: Element[],
          depth: number = 0
        ): void => {
          // WORKSTREAM D: Depth guard
          if (depth > MAX_SHADOW_DEPTH) {
            return;
          }

          // WORKSTREAM D: Visited cache guard
          if (visitedRoots.has(root)) {
            return;
          }
          visitedRoots.add(root);

          // 1. Collect matching elements from this root
          const selectorString = interactiveSelectors.join(', ');
          try {
            // Use querySelectorAll on the root
            const matches = root.querySelectorAll?.(selectorString) || [];
            for (const match of matches) {
              collected.push(match);
            }
          } catch {
            // querySelectorAll may fail on some shadow roots
          }

          // 2. Find all elements with open shadowRoot and recurse
          try {
            const allChildren = root.querySelectorAll?.('*') || [];
            for (const child of allChildren) {
              // Check for open shadow root
              if (child.shadowRoot && !visitedRoots.has(child.shadowRoot)) {
                // Mark shadow host for debugging
                // @ts-expect-error - custom property
                child.__hasShadowRoot = true;
                // Recursively collect from shadow root (with incremented depth)
                collectFromRoot(child.shadowRoot, collected, depth + 1);
              }
            }
          } catch {
            // Shadow root traversal may fail on closed roots - ignore
          }
        };

        // Collect all elements starting from document (depth 0)
        const allElements: Element[] = [];
        collectFromRoot(document, allElements, 0);

        // Deduplicate (element might be collected multiple times)
        const seenElements = new Set<Element>();
        const uniqueElements = allElements.filter(el => {
          if (seenElements.has(el)) return false;
          seenElements.add(el);
          return true;
        });

        // Process each unique element (including shadow DOM elements)
        uniqueElements.forEach((el: Element) => {
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

            // ✅ FIX: Check if element is inside active modal
            const isInsideActiveModal = activeModalElement
              ? activeModalElement.contains(el)
              : false;

            // ═══════════════════════════════════════════════════════════════
            // PHASE D: Detect if element is inside shadow DOM
            // ═══════════════════════════════════════════════════════════════
            let isInsideShadowDOM = false;
            let current: Node | null = el;
            while (current) {
              if (current instanceof ShadowRoot) {
                isInsideShadowDOM = true;
                break;
              }
              current = current.parentNode;
            }

            // ═══════════════════════════════════════════════════════════════
            // Z-Index / Layering signals (no hardcoded thresholds)
            // ═══════════════════════════════════════════════════════════════
            // Parse computed z-index (null if 'auto' or non-numeric)
            const rawZIndex = style.zIndex;
            const parsedZIndex = parseInt(rawZIndex, 10);
            const computedZIndex = isNaN(parsedZIndex) ? null : parsedZIndex;

            // Check if element is positioned (participates in stacking context)
            const isPositioned = style.position !== 'static';

            // Check if element is topmost at its center point (coverage proxy)
            // Only compute if element center is within viewport
            let isTopMostAtCenter: boolean | undefined = undefined;
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            // @ts-expect-error - window available in browser context
            const inViewport = centerX >= 0 && centerX <= window.innerWidth &&
              centerY >= 0 && centerY <= window.innerHeight;

            if (inViewport) {
              try {
                const topEl = document.elementFromPoint(centerX, centerY);
                // Element is topmost if the found element is itself or its descendant
                isTopMostAtCenter = topEl === el || el.contains(topEl);
              } catch {
                // elementFromPoint can fail in edge cases, leave undefined
              }
            }

            // SECURITY: Redact sensitive input values to prevent credential leakage
            // Password fields and credential-related inputs should never have values in snapshot
            const isSensitiveInput = isInput && (
              input.type === 'password' ||
              el.getAttribute('autocomplete')?.includes('password') ||
              el.getAttribute('autocomplete')?.includes('current-password') ||
              el.getAttribute('autocomplete')?.includes('new-password') ||
              // Also redact common identifier fields (username/email/phone) to avoid leaking PII/autofill to LLM
              el.getAttribute('autocomplete')?.includes('username') ||
              el.getAttribute('autocomplete')?.includes('email') ||
              el.getAttribute('autocomplete')?.includes('tel') ||
              el.getAttribute('autocomplete')?.includes('phone') ||
              /password|passwd|pwd|secret|credential/i.test(el.getAttribute('name') || '') ||
              /password|passwd|pwd|secret|credential/i.test(el.getAttribute('id') || '') ||
              /user|username|login|email|phone|tel|mobile/i.test(el.getAttribute('name') || '') ||
              /user|username|login|email|phone|tel|mobile/i.test(el.getAttribute('id') || '')
            );

            elements.push({
              ref,
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              name: el.getAttribute('aria-label') ||
                el.getAttribute('title') ||
                el.getAttribute('placeholder') ||
                el.textContent?.trim().slice(0, 50) || '',
              tag: el.tagName.toLowerCase(),
              type: isInput ? input.type : undefined,
              // SECURITY: Redact value for sensitive fields (password, credentials)
              value: (isInput && !isSensitiveInput) ? input.value : undefined,
              placeholder: isInput ? input.placeholder : undefined,
              checked: input.checked || undefined,
              disabled: input.disabled || el.hasAttribute('disabled'),
              visible: true,
              context: getParentContext(el),  // Parent context
              isInsideActiveModal,  // Mark elements inside modal
              isInsideShadowDOM,    // PHASE D: Mark elements from shadow DOM
              // Semantic attributes for field classification (Level 1 signals)
              autocomplete: isInput ? el.getAttribute('autocomplete') || undefined : undefined,
              inputmode: isInput ? el.getAttribute('inputmode') || undefined : undefined,
              htmlName: el.getAttribute('name') || undefined,
              htmlId: el.getAttribute('id') || undefined,
              // Z-Index / Layering signals (no hardcoded thresholds)
              computedZIndex,
              isPositioned,
              isTopMostAtCenter,
              // Visual Anchors: Bounding box for spatial lookup
              bounds: {
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
              },
            });
          } catch (err) {
            // Skip element if any error
            // No logging needed here - errors are expected for dynamic elements
          }
        });

        return {
          // @ts-expect-error - window and document available in browser context
          url: window.location.href,
          // @ts-expect-error
          title: document.title,
          elements,
          timestamp: Date.now(),
          activeModalRef, // Include detected modal ref
          transientState, // Include transient state info (loading indicators)
        };
      });

      logger.debug('[SNAPSHOT_COLLECTOR] Collected snapshot', {
        url: snapshot.url,
        elementCount: snapshot.elements.length,
        hasActiveModal: !!snapshot.activeModalRef,
        isTransient: snapshot.transientState?.isTransient || false,
        transientType: snapshot.transientState?.type,
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

    // Add active modal indicator if present
    if (snapshot.activeModalRef) {
      lines.push(`ACTIVE_MODAL: ${snapshot.activeModalRef} (Focus on elements inside this modal)`);
    }

    lines.push('');

    // Format each group
    for (const [role, elements] of Object.entries(groups)) {
      lines.push(`[${role}S]`);
      elements.forEach((el) => {
        let line = `  ${el.ref}: "${el.name}"`;

        // ✅ FIX: Mark elements inside active modal
        if (el.isInsideActiveModal) {
          line += ' [INSIDE_MODAL]';
        }

        if (el.context) line += ` (${el.context})`;  // Parent context
        if (el.type) line += ` type=${el.type}`;
        if (el.placeholder) line += ` placeholder="${el.placeholder}"`;
        if (el.disabled) line += ' [DISABLED]';
        if (el.checked) line += ' [CHECKED]';
        // SECURITY: Do not include raw input values in logs/prompts/traces.
        // This avoids leaking emails, passwords, OTPs, or other sensitive data.
        // If needed later, we can add a safe, type-aware mask (e.g., last 2 chars) behind a debug flag.
        lines.push(line);
      });
      lines.push('');
    }

    return lines.join('\n');
  }
}
