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

      // ✅ P1: Inject Shadow DOM flags into page context before evaluation
      await page.evaluate(() => {
        // @ts-expect-error - window available in browser context
        if (typeof window.__LITE_ENGINE_FLAGS === 'undefined') {
          // @ts-expect-error - window available in browser context
          window.__LITE_ENGINE_FLAGS = {
            enableShadowDOMSupport: true,
            shadowDOMMaxDepth: 5,
          };
        }
      });

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

        // ✅ TASK 10: Fingerprint-based ref stability for React re-renders
        // Persist refs across DOM rebuilds using element fingerprints
        if (!win.__agentFingerprintMap) {
          win.__agentFingerprintMap = new Map();
        }

        /**
         * TASK 10: Get element fingerprint for ref stability
         * Creates a unique signature for an element based on stable attributes
         */
        function getElementFingerprint(el: any): string {
          const tag = el.tagName.toLowerCase();
          const role = el.getAttribute('role') || '';
          const type = el.getAttribute('type') || '';
          const name = el.getAttribute('name') || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const text = (el.textContent || '').trim().slice(0, 30);
          const parentTag = el.parentElement?.tagName.toLowerCase() || '';
          const parentId = el.parentElement?.getAttribute('id') || '';

          return `${tag}|${role}|${type}|${name}|${ariaLabel}|${placeholder}|${text}|${parentTag}|${parentId}`;
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
        // STEP EDITOR V2: Label extraction helper
        // ═══════════════════════════════════════════════════════════════════════
        const getLabelText = (el: Element): string | undefined => {
          // 1. Try aria-labelledby
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labelParts = labelledBy.split(/\s+/).map(id => {
              const labelEl = document.getElementById(id);
              return labelEl?.textContent?.trim();
            }).filter(Boolean);
            if (labelParts.length > 0) {
              return labelParts.join(' ').slice(0, 100);
            }
          }

          // 2. Try <label for="id">
          const elId = el.getAttribute('id');
          if (elId) {
            const labelFor = document.querySelector(`label[for="${elId}"]`);
            if (labelFor?.textContent?.trim()) {
              return labelFor.textContent.trim().slice(0, 100);
            }
          }

          // 3. Try wrapping <label> ancestor
          const wrappingLabel = el.closest('label');
          if (wrappingLabel) {
            // Get label text excluding the input's own text
            const clone = wrappingLabel.cloneNode(true) as HTMLElement;
            const inputs = clone.querySelectorAll('input, select, textarea');
            inputs.forEach(inp => inp.remove());
            const text = clone.textContent?.trim();
            if (text) return text.slice(0, 100);
          }

          // 4. Try implicit label (text in same form-group/container)
          const formGroup = el.closest('.form-group, .form-field, .field, .input-group, .form-control, [data-field]');
          if (formGroup) {
            const labelEl = formGroup.querySelector('label, .label, [class*="label"]');
            if (labelEl && !labelEl.contains(el)) {
              const text = labelEl.textContent?.trim();
              if (text) return text.slice(0, 100);
            }
          }

          return undefined;
        };

        // ═══════════════════════════════════════════════════════════════════════
        // STEP EDITOR V2: Parent chain extraction helper
        // ═══════════════════════════════════════════════════════════════════════
        const CONTAINER_SELECTORS = 'form, dialog, [role="dialog"], section, article, aside, nav, header, footer, main, fieldset, .card, .modal, .panel';
        const MAX_PARENT_CHAIN_DEPTH = 6;

        const getParentRefChain = (el: Element): { chain: string[]; containerRef?: string; containerTitles: string[] } => {
          const chain: string[] = [];
          const containerTitles: string[] = [];
          let containerRef: string | undefined;
          let current: Element | null = el.parentElement;
          let depth = 0;

          while (current && depth < MAX_PARENT_CHAIN_DEPTH) {
            const ref = current.getAttribute('data-agent-ref');
            if (ref) {
              chain.push(ref);

              // Check if this is a key container
              if (!containerRef && current.matches(CONTAINER_SELECTORS)) {
                containerRef = ref;

                // Try to get container title
                const legend = current.querySelector(':scope > legend, :scope > .legend');
                const heading = current.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > [class*="title"], :scope > [class*="heading"]');
                const title = legend?.textContent?.trim() || heading?.textContent?.trim() ||
                  current.getAttribute('aria-label') || current.getAttribute('title');
                if (title) {
                  containerTitles.push(title.slice(0, 50));
                }
              }
            }
            current = current.parentElement;
            depth++;
          }

          return { chain, containerRef, containerTitles };
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

        // ═══════════════════════════════════════════════════════════════════════
        // P1 FEATURE: Enhanced Shadow DOM Support
        // ═══════════════════════════════════════════════════════════════════════
        // @ts-expect-error - window.__LITE_ENGINE_FLAGS available from config
        const SHADOW_DOM_ENABLED = typeof window.__LITE_ENGINE_FLAGS !== 'undefined'
          ? window.__LITE_ENGINE_FLAGS.enableShadowDOMSupport !== false
          : true; // Default: enabled

        // @ts-expect-error - window.__LITE_ENGINE_FLAGS available from config
        const MAX_SHADOW_DEPTH = typeof window.__LITE_ENGINE_FLAGS !== 'undefined'
          ? window.__LITE_ENGINE_FLAGS.shadowDOMMaxDepth || 5
          : 5; // Default: 5 levels

        const visitedRoots = new WeakSet<object>(); // Cache visited roots to avoid reprocessing

        // Track shadow depth for each element
        const elementShadowDepth = new WeakMap<Element, number>();

        // P1: Guard against circular references in shadow host chain
        const visitedShadowHosts = new WeakSet<Element>();

        /**
         * Recursively collect elements from a root (document or shadow root)
         * Traverses open shadow DOMs for web component support
         * P1 FEATURE: Enhanced with depth tracking, slotted content detection, unique ref prefixing
         */
        const collectFromRoot = (
          root: Document | ShadowRoot | Element,
          collected: Element[],
          depth: number = 0
        ): void => {
          // Depth guard (configurable)
          if (depth > MAX_SHADOW_DEPTH) {
            return;
          }

          // Visited cache guard
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
              // ✅ P1: Track shadow depth for this element
              elementShadowDepth.set(match, depth);
            }
          } catch {
            // querySelectorAll may fail on some shadow roots
          }

          // 2. Find all elements with open shadowRoot and recurse (if enabled)
          if (SHADOW_DOM_ENABLED) {
            try {
              const allChildren = root.querySelectorAll?.('*') || [];
              for (const child of allChildren) {
                // Check for open shadow root
                if (child.shadowRoot && !visitedRoots.has(child.shadowRoot)) {
                  // P1: Guard against circular shadow host references
                  if (visitedShadowHosts.has(child)) {
                    continue; // Skip if already processed this host
                  }
                  visitedShadowHosts.add(child);

                  // Mark shadow host for debugging
                  // @ts-expect-error - custom property
                  child.__hasShadowRoot = true;
                  // Recursively collect from shadow root (with incremented depth)
                  collectFromRoot(child.shadowRoot, collected, depth + 1);
                }
              }
            } catch {
              // Shadow root traversal may fail on closed roots - ignore gracefully
            }
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

            // ✅ P1: Detect if element is inside shadow DOM for ref prefixing
            let isInsideShadowDOM = false;
            let shadowDepth = 0;
            let current: Node | null = el;
            while (current) {
              if (current instanceof ShadowRoot) {
                isInsideShadowDOM = true;
                shadowDepth++;
              }
              current = current.parentNode;
            }

            // ✅ TASK 10: Fingerprint-based ref stability
            // Priority: (1) existing data-agent-ref, (2) restore from fingerprint, (3) assign new
            const refPrefix = isInsideShadowDOM ? 's' : 'e';
            const refPattern = isInsideShadowDOM ? /^s\d+$/ : /^e\d+$/;
            const existingRef = el.getAttribute('data-agent-ref');

            let ref: string;
            if (existingRef && refPattern.test(existingRef)) {
              // Case 1: Element already has a valid ref, reuse it
              ref = existingRef;
            } else {
              // Case 2: Check fingerprint map for restoration
              const fingerprint = getElementFingerprint(el);
              const restoredRef = win.__agentFingerprintMap.get(fingerprint);
              if (restoredRef && refPattern.test(restoredRef)) {
                ref = restoredRef;
              } else {
                // Case 3: Assign new ref
                ref = `${refPrefix}${win.__agentRefCounter++}`;
              }
              // Store fingerprint → ref mapping
              win.__agentFingerprintMap.set(fingerprint, ref);
            }

            if (!existingRef || existingRef !== ref) {
              el.setAttribute('data-agent-ref', ref);
            }

            const input = el as any;
            const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';

            // ✅ FIX: Check if element is inside active modal
            const isInsideActiveModal = activeModalElement
              ? activeModalElement.contains(el)
              : false;

            // ✅ P1: Detect slotted content (light DOM content rendered in shadow DOM slot)
            // @ts-expect-error - assignedSlot is available on HTMLElement
            const isSlotted = !!(el as HTMLElement).assignedSlot;
            // @ts-expect-error - assignedSlot is available on HTMLElement
            const slotName = isSlotted ? ((el as HTMLElement).assignedSlot?.name || 'default') : undefined;

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

            // ═══════════════════════════════════════════════════════════════
            // STEP EDITOR V2: Extract ARIA state
            // ═══════════════════════════════════════════════════════════════
            const ariaExpandedRaw = el.getAttribute('aria-expanded');
            const ariaExpanded = ariaExpandedRaw === 'true' ? true : ariaExpandedRaw === 'false' ? false : undefined;

            const ariaPressedRaw = el.getAttribute('aria-pressed');
            const ariaPressed = ariaPressedRaw === 'true' ? true : ariaPressedRaw === 'false' ? false : undefined;

            const ariaSelectedRaw = el.getAttribute('aria-selected');
            const ariaSelected = ariaSelectedRaw === 'true' ? true : ariaSelectedRaw === 'false' ? false : undefined;

            const ariaCheckedRaw = el.getAttribute('aria-checked');
            const ariaChecked = ariaCheckedRaw === 'true' ? true :
              ariaCheckedRaw === 'false' ? false :
                ariaCheckedRaw === 'mixed' ? 'mixed' : undefined;

            // ═══════════════════════════════════════════════════════════════
            // STEP EDITOR V2: Extract validation state
            // ═══════════════════════════════════════════════════════════════
            const required = input.required || el.hasAttribute('required') || el.getAttribute('aria-required') === 'true';
            const readOnly = input.readOnly || el.hasAttribute('readonly') || el.getAttribute('aria-readonly') === 'true';

            // Check invalid via aria-invalid or :invalid pseudo-class
            const ariaInvalid = el.getAttribute('aria-invalid');
            let invalid = ariaInvalid === 'true';
            if (!invalid && isInput) {
              try {
                invalid = (el as HTMLInputElement).validity?.valid === false;
              } catch {
                // validity may not be available
              }
            }

            // hasValue (for state-aware actions - don't store actual value for privacy)
            const hasValue = isInput && !isSensitiveInput && !!input.value;

            // ═══════════════════════════════════════════════════════════════
            // STEP EDITOR V2: Extract labels
            // ═══════════════════════════════════════════════════════════════
            const ariaLabel = el.getAttribute('aria-label') || undefined;
            const labelText = getLabelText(el);

            // ═══════════════════════════════════════════════════════════════
            // STEP EDITOR V2: Extract parent chain
            // ═══════════════════════════════════════════════════════════════
            const { chain: parentRefChain, containerRef, containerTitles } = getParentRefChain(el);

            /**
             * Best-effort: get human-readable visible text for an element.
             * We prefer `innerText` because it tends to preserve visual spacing/newlines
             * between inline children better than `textContent` (which can concatenate).
             * Fallback to `textContent` for non-HTMLElement nodes or when `innerText` is empty.
             */
            const getReadableElementText = (node: Element): string => {
              try {
                const asHtmlEl = node as unknown as HTMLElement;
                const raw = (typeof asHtmlEl.innerText === 'string' && asHtmlEl.innerText.trim().length > 0)
                  ? asHtmlEl.innerText
                  : (node.textContent || '');

                // Normalize whitespace for UI labels: collapse to single spaces and trim.
                // This avoids "glued" strings like "Опытныйрепетитор" when there are many inline spans.
                return raw.replace(/\s+/g, ' ').trim();
              } catch {
                return (node.textContent || '').replace(/\s+/g, ' ').trim();
              }
            };

            elements.push({
              ref,
              role: el.getAttribute('role') || el.tagName.toLowerCase(),
              name: ariaLabel ||
                el.getAttribute('title') ||
                el.getAttribute('placeholder') ||
                getReadableElementText(el).slice(0, 50) || '',
              tag: el.tagName.toLowerCase(),
              type: isInput ? input.type : undefined,
              // SECURITY: Never include raw input values in snapshots.
              // Use `hasValue` for state-aware logic (privacy-safe).
              value: undefined,
              placeholder: isInput ? input.placeholder : undefined,
              checked: input.checked || undefined,
              disabled: input.disabled || el.hasAttribute('disabled'),
              visible: true,
              context: getParentContext(el),  // Parent context (legacy, keep for compatibility)
              isInsideActiveModal,  // Mark elements inside modal
              isInsideShadowDOM,    // PHASE D: Mark elements from shadow DOM
              // ✅ P1: Shadow DOM enhancement fields
              isSlotted,            // True if element is slotted content (light DOM in shadow slot)
              slotName,             // Name of the slot (default, named, or undefined)
              shadowDepth,          // Shadow DOM nesting depth (0 = light DOM, 1+ = shadow)
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
              // ═══════════════════════════════════════════════════════════════
              // STEP EDITOR V2: New fields
              // ═══════════════════════════════════════════════════════════════
              // ARIA state
              ariaExpanded,
              ariaPressed,
              ariaSelected,
              ariaChecked,
              // Validation state
              required: required || undefined,
              readOnly: readOnly || undefined,
              invalid: invalid || undefined,
              hasValue: hasValue || undefined,
              // Labels
              ariaLabel,
              labelText,
              // Hierarchy
              parentRefChain: parentRefChain.length > 0 ? parentRefChain : undefined,
              containerRef,
              containerTitles: containerTitles.length > 0 ? containerTitles : undefined,
            });
          } catch (err) {
            // Skip element if any error
            // No logging needed here - errors are expected for dynamic elements
          }
        });

        // ═══════════════════════════════════════════════════════════════════════
        // PHASE 0.1: Enhanced page text extraction for credential detection
        // Prioritizes <pre>, <code>, <li>, and <td> blocks where demo credentials
        // are commonly displayed on practice/test pages
        // ═══════════════════════════════════════════════════════════════════════
        const extractPageTextForCredentials = (): string => {
          const textParts: string[] = [];

          // Priority 1: <pre> and <code> blocks (highest - demo credentials often here)
          // @ts-expect-error - document available in browser context
          document.querySelectorAll('pre, code').forEach(el => {
            const text = el.textContent?.trim();
            if (text && text.length > 0 && text.length < 2000) {
              textParts.push(`[code] ${text}`);
            }
          });

          // Priority 2: List items and table cells (common for credential listings)
          // @ts-expect-error - document available in browser context
          document.querySelectorAll('li, td, th').forEach(el => {
            const text = el.textContent?.trim();
            // Only include if contains credential keywords and is reasonable length
            if (text && text.length >= 8 && text.length < 200 &&
                /username|user|login|email|password|pass|pwd|credential|demo|test/i.test(text)) {
              textParts.push(text);
            }
          });

          // Priority 3: Paragraphs and divs with credential keywords
          // @ts-expect-error - document available in browser context
          document.querySelectorAll('p, div').forEach(el => {
            const text = el.textContent?.trim();
            // Only include if contains credential keywords and is reasonable length
            if (text && text.length >= 10 && text.length < 500 &&
                /username|password|login|credential|demo|test|use.*:|email:|pass:/i.test(text)) {
              textParts.push(text);
            }
          });

          // Priority 4: All visible text as fallback (for edge cases)
          // @ts-expect-error - document available in browser context
          const bodyText = document.body?.innerText || '';
          if (bodyText) {
            textParts.push(bodyText);
          }

          // Join and limit to 10k chars
          return textParts.join('\n').slice(0, 10000);
        };

        const pageTextForExtraction = extractPageTextForCredentials();

        // ═══════════════════════════════════════════════════════════════════════
        // P0 FEATURE: Proactive Vision Detection
        // Detect canvas/SVG content to enable early vision escalation
        // ═══════════════════════════════════════════════════════════════════════
        const detectVisualContentMetadata = (): any => {
          // Find visible canvas elements
          // @ts-expect-error - document available in browser context
          const canvases = Array.from(document.querySelectorAll('canvas')).filter((c: Element) => {
            const style = window.getComputedStyle(c);
            return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1;
          });

          // Find visible SVG elements
          // @ts-expect-error - document available in browser context
          const svgs = Array.from(document.querySelectorAll('svg')).filter((s: Element) => {
            const style = window.getComputedStyle(s);
            return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity) > 0.1;
          });

          // @ts-expect-error - window available in browser context
          const viewportArea = window.innerWidth * window.innerHeight;

          // Calculate canvas coverage
          let canvasArea = 0;
          for (const canvas of canvases) {
            const rect = canvas.getBoundingClientRect();
            const area = rect.width * rect.height;
            canvasArea += area / viewportArea;
          }

          // Calculate SVG coverage
          let svgArea = 0;
          for (const svg of svgs) {
            const rect = svg.getBoundingClientRect();
            const area = rect.width * rect.height;
            svgArea += area / viewportArea;
          }

          // Count interactive elements
          // @ts-expect-error - document available in browser context
          const interactiveElements = document.querySelectorAll(
            'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="button"]:not([aria-disabled="true"]), [onclick]'
          );

          const interactiveElementCount = interactiveElements.length;
          const isDOMWeak = interactiveElementCount < 10;
          const hasSignificantCanvas = canvasArea > 0.3; // >30% viewport
          const hasSignificantSVG = svgArea > 0.2; // >20% viewport

          // Recommend vision if:
          // - DOM is weak (<10 interactive elements), OR
          // - Significant canvas coverage (>30%), OR
          // - Significant SVG coverage (>20%)
          const recommendVision = isDOMWeak || hasSignificantCanvas || hasSignificantSVG;

          return {
            hasCanvas: canvases.length > 0,
            hasSVG: svgs.length > 0,
            canvasArea: Math.min(canvasArea, 1.0), // Cap at 100%
            svgArea: Math.min(svgArea, 1.0), // Cap at 100%
            isDOMWeak,
            interactiveElementCount,
            recommendVision,
          };
        };

        const metadata = detectVisualContentMetadata();

        // ✅ TASK 10: Cleanup stale fingerprint map entries (>1000 entries)
        if (win.__agentFingerprintMap.size > 1000) {
          const currentRefs = new Set();
          for (const el of elements) {
            currentRefs.add(el.ref);
          }

          // Remove fingerprints whose refs are not in current DOM
          const fingerprintsToDelete: string[] = [];
          for (const [fingerprint, ref] of win.__agentFingerprintMap.entries()) {
            if (!currentRefs.has(ref)) {
              fingerprintsToDelete.push(fingerprint);
            }
          }

          for (const fingerprint of fingerprintsToDelete) {
            win.__agentFingerprintMap.delete(fingerprint);
          }
        }

        return {
          // @ts-expect-error - window and document available in browser context
          url: window.location.href,
          // @ts-expect-error
          title: document.title,
          elements,
          timestamp: Date.now(),
          activeModalRef, // Include detected modal ref
          transientState, // Include transient state info (loading indicators)
          pageTextForExtraction, // For credential extraction only
          metadata, // P0: Visual content metadata for proactive vision detection
        };
      });

      // logger.debug('[SNAPSHOT_COLLECTOR] Collected snapshot', {
      //   url: snapshot.url,
      //   elementCount: snapshot.elements.length,
      //   hasActiveModal: !!snapshot.activeModalRef,
      //   isTransient: snapshot.transientState?.isTransient || false,
      //   transientType: snapshot.transientState?.type,
      // });

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
