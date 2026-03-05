/**
 * SnapshotCollector
 * Collects page snapshot with accessibility tree + parent context
 * KEY FEATURE: Each element includes its semantic parent container
 */

// @ts-nocheck - DOM types in page.evaluate() are available in browser context
import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { logger } from '@/utils/core/logger';
import {
  MODAL_OVERLAY_SELECTORS,
  POSITIONAL_CANDIDATES_SELECTOR,
  INTERACTIVE_CHILDREN_SELECTOR,
  MODAL_CLASS_REGEX,
  IRON_CLAD_MODAL_SELECTORS,
  CLOSE_BUTTON_SELECTOR,
} from '@/agent/utils/selectors/modal-detection';
import type { Page } from 'playwright';
import type { LiteElement, LiteSnapshot, ObstacleFact } from '../lite-types';
import { VisualStability } from './visual-stability';

export class SnapshotCollector {
  /**
   * Collect page snapshot with parent context
   * Waits for visual stability before collecting
   *
   * @param page - Playwright page instance
   * @returns Snapshot with elements including parent context
   */
  static async collect(page: Page, options?: { fullPage?: boolean }): Promise<LiteSnapshot> {
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

      // Modal detection constants (passed into browser context)
      const __modalConsts = {
        overlaySelectors: MODAL_OVERLAY_SELECTORS,
        positionalSelector: POSITIONAL_CANDIDATES_SELECTOR,
        interactiveSelector: INTERACTIVE_CHILDREN_SELECTOR,
        classRegexSource: MODAL_CLASS_REGEX.source,
        // Layer 1: Iron-clad modal selectors (zero false positives)
        ironCladSelectors: IRON_CLAD_MODAL_SELECTORS,
        closeButtonSelector: CLOSE_BUTTON_SELECTOR,
        // Feature flags
        enableLayer2: LITE_ENGINE_FLAGS.enableLayer2ObstacleClassification,
        fullPage: options?.fullPage ?? false,
      };

      // Collect snapshot in page context
      // @ts-expect-error - DOM types available in browser context
      const snapshot = await page.evaluate((__mc) => {
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
         * Creates a unique signature for an element based on stable attributes.
         * ✅ FIX BUG 6: Enhanced with id, data-testid, and deeper DOM path (5 levels)
         * to survive full Angular/React re-renders where the component tree is rebuilt.
         */
        function getElementFingerprint(el: any): string {
          const tag = el.tagName.toLowerCase();
          const role = (el.getAttribute('role') || '').replace(/["']/g, '').trim();
          const type = el.getAttribute('type') || '';
          const name = el.getAttribute('name') || '';
          const id = el.getAttribute('id') || '';
          const ariaLabel = el.getAttribute('aria-label') || '';
          const placeholder = el.getAttribute('placeholder') || '';
          const testId = el.getAttribute('data-testid') || el.getAttribute('data-test') || '';
          const text = (el.textContent || '').trim().slice(0, 40);

          // Build a short DOM path (up to 5 ancestors) using tag + child-index at each level.
          // This is scroll/resize-stable and distinguishes identical elements in different
          // containers (e.g. "Забронировать" buttons inside separate tutor cards).
          // 5 levels provides better disambiguation for repeated UI patterns.
          const pathParts: string[] = [];
          let cur: Element | null = el;
          for (let i = 0; i < 5 && cur && cur.parentElement; i++) {
            const parent = cur.parentElement;
            const idx = Array.prototype.indexOf.call(parent.children, cur);
            pathParts.push(`${cur.tagName.toLowerCase()}[${idx}]`);
            cur = parent;
          }
          const domPath = pathParts.join('/');

          return `${tag}|${role}|${type}|${name}|${id}|${ariaLabel}|${placeholder}|${testId}|${text}|${domPath}`;
        }

        /**
         * ✅ FIX: Safe ARIA attribute reader — strips escaped quotes from Angular/framework output.
         * Angular can output aria-expanded="\"true\"" which getAttribute returns as '"true"'.
         * This helper strips those quotes so comparisons work reliably.
         */
        function getCleanAttr(el: Element, attr: string): string | null {
          const raw = el.getAttribute(attr);
          if (raw === null) return null;
          return raw.replace(/["']/g, '').trim() || null;
        }

        /**
         * Detect active modal/overlay
         *
         * Layer 1 (iron-clad): Uses only ARIA/spec signals with zero false positive risk.
         * When Layer 2 is disabled (feature flag off), falls back to the legacy 4-rule
         * coverage heuristic for backward compatibility.
         *
         * Returns ref of modal container if found.
         */
        const detectActiveModal = (): string | undefined => {
          // Phase 0: Check for native <dialog> elements first (showModal() uses ::backdrop, not position:fixed)
          const openDialogs = Array.from(document.querySelectorAll('dialog[open]'));
          for (const dialog of openDialogs) {
            const style = window.getComputedStyle(dialog);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            // Native <dialog> with showModal() is always a top-layer modal
            const existingRef = dialog.getAttribute('data-agent-ref');
            if (existingRef) return existingRef;
            const newRef = `e${win.__agentRefCounter++}`;
            dialog.setAttribute('data-agent-ref', newRef);
            return newRef;
          }

          // ═══════════════════════════════════════════════════════════════
          // LAYER 1: Iron-clad selectors — zero false positives
          // Only matches: [role="dialog"], [role="alertdialog"], [aria-modal="true"],
          // dialog[open], Radix/Headless/Reach dialog roles, .swal2-container
          // ═══════════════════════════════════════════════════════════════
          const ironCladMatches = Array.from(document.querySelectorAll(__mc.ironCladSelectors));
          let bestIronClad: Element | null = null;
          let highestIronCladZ = -1;

          for (const el of ironCladMatches) {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (parseFloat(style.opacity) < 0.1) continue;

            const zIndex = parseInt(style.zIndex, 10) || 0;
            if (zIndex > highestIronCladZ) {
              highestIronCladZ = zIndex;
              bestIronClad = el;
            }
          }

          if (bestIronClad) {
            const existingRef = bestIronClad.getAttribute('data-agent-ref');
            if (existingRef) return existingRef;
            const newRef = `e${win.__agentRefCounter++}`;
            bestIronClad.setAttribute('data-agent-ref', newRef);
            return newRef;
          }

          // ═══════════════════════════════════════════════════════════════
          // UNIVERSAL FALLBACK: Detect non-ARIA popups via position + z-index + coverage
          // Many custom popups (Vue/React/Angular) don't set role="dialog".
          // Catch them via physical signals: fixed/absolute + high z-index + meaningful size.
          // This runs regardless of Layer 2 flag — Step Editor needs it always.
          // ═══════════════════════════════════════════════════════════════
          const positionalModals = Array.from(document.querySelectorAll(__mc.positionalSelector));
          let bestPositional: Element | null = null;
          let highestPositionalZ = -1;
          // @ts-expect-error - window available in browser context
          const vpW2 = window.innerWidth;
          // @ts-expect-error - window available in browser context
          const vpH2 = window.innerHeight;
          const viewportArea2 = vpW2 * vpH2;

          for (const el of positionalModals) {
            const elStyle = window.getComputedStyle(el);
            if (elStyle.display === 'none' || elStyle.visibility === 'hidden') continue;
            if (parseFloat(elStyle.opacity) < 0.1) continue;
            if (elStyle.position !== 'fixed' && elStyle.position !== 'absolute') continue;

            const zIdx = parseInt(elStyle.zIndex, 10);
            if (isNaN(zIdx) || zIdx < 3) continue; // z-index >= 3: catch custom popups (lowered from 10)

            const elRect = el.getBoundingClientRect();
            const elArea = elRect.width * elRect.height;
            const coverage = viewportArea2 > 0 ? elArea / viewportArea2 : 0;

            // Must be meaningful size (>3% viewport) — lowered from 10% to catch
            // small popups, autocomplete dropdowns, context menus, tooltips with forms
            if (coverage < 0.03) continue;

            // ── Q5 FIX: Exclude structural navigation elements (sidebars, headers, footers) ──
            // Sidebars: flush to left/right edge + tall (>70% viewport height)
            const isFlushLeft = elRect.left <= 5;
            const isFlushRight = elRect.right >= vpW2 - 5;
            const isFlushTop = elRect.top <= 5;
            const isFlushBottom = elRect.bottom >= vpH2 - 5;
            const isTall = elRect.height > vpH2 * 0.7;
            const isWide = elRect.width > vpW2 * 0.7;
            const isNarrowVertical = elRect.width < vpW2 * 0.35; // Sidebar: <35% viewport width
            const isNarrowHorizontal = elRect.height < vpH2 * 0.2; // Header/footer: <20% viewport height

            // Sidebar: narrow + tall + flush to left or right edge → navigation, not popup
            if (isNarrowVertical && isTall && (isFlushLeft || isFlushRight)) continue;
            // Header: narrow horizontal + flush to top → sticky header, not popup
            if (isNarrowHorizontal && isWide && isFlushTop) continue;
            // Footer/banner: narrow horizontal + flush to bottom → sticky footer/cookie, not popup
            if (isNarrowHorizontal && isWide && isFlushBottom) continue;
            // Full-screen overlay (coverage >90%) is likely a backdrop, not a popup container
            if (coverage > 0.9) continue;

            const hasInteractive = el.querySelector(__mc.interactiveSelector) !== null;
            const childCount = el.querySelectorAll('*').length;
            if (!hasInteractive && childCount < 5) continue;

            if (zIdx > highestPositionalZ) {
              highestPositionalZ = zIdx;
              bestPositional = el;
            }
          }

          if (bestPositional) {
            const existingRef = bestPositional.getAttribute('data-agent-ref');
            if (existingRef) return existingRef;
            const newRef = `e${win.__agentRefCounter++}`;
            bestPositional.setAttribute('data-agent-ref', newRef);
            return newRef;
          }

          // ═══════════════════════════════════════════════════════════════
          // LEGACY FALLBACK: When Layer 2 is disabled, use legacy coverage heuristic
          // to avoid missing modals that don't have ARIA roles.
          // When Layer 2 is enabled, ambiguous elements are collected as
          // ObstacleFacts and classified by the Observer LLM instead.
          // ═══════════════════════════════════════════════════════════════
          if (!__mc.enableLayer2) {
            // Legacy 4-rule heuristic (kept for backward compatibility)
            const targetedModals = Array.from(document.querySelectorAll(__mc.overlaySelectors));
            const positionalCandidates = Array.from(document.querySelectorAll(__mc.positionalSelector));
            const seen = new WeakSet<Element>();
            const potentialModals: Element[] = [];
            for (const el of [...targetedModals, ...positionalCandidates]) {
              if (seen.has(el)) continue;
              seen.add(el);
              const style = window.getComputedStyle(el);
              if (style.position !== 'fixed' && style.position !== 'absolute') continue;
              if (style.display === 'none' || style.visibility === 'hidden') continue;
              if (parseFloat(style.opacity) < 0.1) continue;
              const zIndex = parseInt(style.zIndex, 10);
              if (isNaN(zIndex) || zIndex < 1) continue;
              potentialModals.push(el);
            }

            if (potentialModals.length === 0) return undefined;

            let bestModal: Element | null = null;
            let highestZIndex = -1;
            // @ts-expect-error - window available in browser context
            const vpW = window.innerWidth;
            // @ts-expect-error - window available in browser context
            const vpH = window.innerHeight;
            const viewportArea = vpW * vpH;

            for (const modal of potentialModals) {
              const style = window.getComputedStyle(modal);
              const zIndex = parseInt(style.zIndex, 10);
              const rect = modal.getBoundingClientRect();
              const modalArea = rect.width * rect.height;
              const coverage = viewportArea > 0 ? modalArea / viewportArea : 0;
              const modalRole = (modal.getAttribute('role') || '').replace(/["']/g, '').trim();
              const classStr = (modal.getAttribute('class') || '').toLowerCase();
              const hasModalRole = modalRole === 'dialog' ||
                modalRole === 'alertdialog' ||
                getCleanAttr(modal, 'aria-modal') === 'true' ||
                modal.classList.contains('modal') ||
                modal.classList.contains('overlay') ||
                modal.classList.contains('popup');
              const hasPopupClass = new RegExp(__mc.classRegexSource, 'i').test(classStr);
              const hasInteractiveChildren = modal.querySelector(__mc.interactiveSelector) !== null;
              const isModal =
                (hasModalRole && coverage > 0.2) ||
                coverage > 0.4 ||
                (hasPopupClass && hasInteractiveChildren && coverage > 0.1) ||
                (hasInteractiveChildren && zIndex > 10 && coverage > 0.15);
              if (isModal && zIndex > highestZIndex) {
                highestZIndex = zIndex;
                bestModal = modal;
              }
            }

            if (bestModal) {
              const existingRef = bestModal.getAttribute('data-agent-ref');
              if (existingRef) return existingRef;
              const newRef = `e${win.__agentRefCounter++}`;
              bestModal.setAttribute('data-agent-ref', newRef);
              return newRef;
            }
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

        // ═══════════════════════════════════════════════════════════════
        // LAYER 2: Collect ObstacleFacts for LLM classification
        // Runs when enableLayer2 is true. Collects structured facts about
        // ALL positioned elements (modals, cookie banners, chat widgets,
        // sticky headers, toast notifications, etc.) for the Observer to classify.
        // ═══════════════════════════════════════════════════════════════
        const collectObstacleFacts = (): any[] => {
          if (!__mc.enableLayer2) return [];

          // @ts-expect-error - window available in browser context
          const vpW = window.innerWidth;
          // @ts-expect-error - window available in browser context
          const vpH = window.innerHeight;
          const viewportArea = vpW * vpH;
          if (viewportArea === 0) return [];

          // Gather candidates: positional elements + iron-clad modal matches
          // POSITIONAL_CANDIDATES_SELECTOR catches ALL positioned elements
          // (cookie banners, chat widgets, toasts are ALL position:fixed/absolute).
          // No need for dismissible selectors — LLM classifies from raw data.
          const positionalCandidates = Array.from(document.querySelectorAll(__mc.positionalSelector));
          const ironCladMatches = Array.from(document.querySelectorAll(__mc.ironCladSelectors));

          // Dedup
          const seen = new WeakSet<Element>();
          const candidates: Element[] = [];
          for (const el of [...ironCladMatches, ...positionalCandidates]) {
            if (seen.has(el)) continue;
            seen.add(el);
            candidates.push(el);
          }

          const facts: any[] = [];

          for (const el of candidates) {
            const style = window.getComputedStyle(el);
            const position = style.position;

            // Must be fixed, absolute, or sticky (positioned elements only)
            if (position !== 'fixed' && position !== 'absolute' && position !== 'sticky') continue;

            // Must be visible
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (parseFloat(style.opacity) < 0.1) continue;

            // Get z-index (allow sticky with z-index 0)
            const zIndex = parseInt(style.zIndex, 10);
            if (isNaN(zIndex)) continue;
            if (position !== 'sticky' && zIndex < 1) continue;

            // Calculate viewport coverage
            const rect = el.getBoundingClientRect();
            const area = rect.width * rect.height;
            const coverage = area / viewportArea;

            // Skip tiny elements (floating icons, small badges)
            if (coverage < 0.03) continue;

            // Get element info — raw facts for LLM classification
            const tag = el.tagName.toLowerCase();
            const className = (el.getAttribute('class') || '').slice(0, 200);
            const textPreview = (el.textContent || '').trim().slice(0, 200);
            const idAttr = (el.getAttribute('id') || '').slice(0, 100);
            const role = (el.getAttribute('role') || '').replace(/["']/g, '').trim() || undefined;
            const ariaModal = (el.getAttribute('aria-modal') || '').replace(/["']/g, '').trim() === 'true' || undefined;

            // Check for close button and interactive children
            const hasCloseButton = el.querySelector(__mc.closeButtonSelector) !== null;
            const hasInteractiveChildren = el.querySelector(__mc.interactiveSelector) !== null;

            // Assign ref if not already present
            let ref = el.getAttribute('data-agent-ref');
            if (!ref) {
              ref = `e${win.__agentRefCounter++}`;
              el.setAttribute('data-agent-ref', ref);
            }

            // ═══════════════════════════════════════════════════════════
            // hintType: ONLY W3C spec signals + geometry (zero regex)
            // All other classification is 100% LLM (Observer Agent Layer 2)
            // ═══════════════════════════════════════════════════════════
            let hintType = 'unknown';

            // W3C ARIA spec signals (zero false positives)
            if (role === 'dialog' || role === 'alertdialog' || ariaModal) {
              hintType = 'modal';
            }
            // Physical layout signals (geometry, not class names)
            else if ((position === 'sticky' || position === 'fixed') && rect.top <= 5 && rect.height < 120) {
              hintType = 'sticky_header';
            } else if ((position === 'sticky' || position === 'fixed') && rect.bottom >= vpH - 5 && rect.height < 120) {
              hintType = 'sticky_footer';
            }

            facts.push({
              ref,
              tag,
              position,
              zIndex,
              coverage: Math.round(coverage * 1000) / 1000, // 3 decimal places
              className,
              textPreview,
              id: idAttr || undefined,
              hasCloseButton,
              hasInteractiveChildren,
              role,
              ariaModal,
              rect: {
                top: Math.round(rect.top),
                left: Math.round(rect.left),
                width: Math.round(rect.width),
                height: Math.round(rect.height),
              },
              hintType,
            });
          }

          // Sort by z-index descending, take top 8
          facts.sort((a: any, b: any) => b.zIndex - a.zIndex);
          return facts.slice(0, 8);
        };

        const obstacleFacts = collectObstacleFacts();

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
          // ── Core interactive elements ──
          'button', 'a', 'input', 'select', 'textarea',

          // ── ARIA widget roles (covers MUI, Ant Design, Chakra, Radix, Headless UI) ──
          '[role="button"]', '[role="link"]', '[role="menuitem"]',
          '[role="checkbox"]', '[role="radio"]', '[role="tab"]',
          // ✅ FIX: Dropdown/listbox/combobox — critical for custom selects (MUI Autocomplete, Ant Select)
          '[role="option"]', '[role="listbox"]', '[role="combobox"]',
          // ✅ FIX: Menus — context menus, dropdown menus, nav menus (MUI Menu, Headless UI Menu)
          '[role="menu"]', '[role="menuitemcheckbox"]', '[role="menuitemradio"]',
          // ✅ FIX: Toggle switches (MUI Switch, Ant Switch, Chakra Switch)
          '[role="switch"]',
          // ✅ FIX: Sliders/range inputs (MUI Slider, Ant Slider, native range)
          '[role="slider"]', '[role="spinbutton"]',
          // ✅ FIX: Search/text roles — contenteditable regions, search fields
          '[role="searchbox"]', '[role="textbox"]',
          // ✅ FIX: Tree navigation (file browsers, nested menus)
          '[role="treeitem"]',
          // ✅ FIX: Alert dialogs with confirm/cancel (browser-like alerts)
          '[role="alertdialog"]',
          // ✅ FIX: Data grid roles (Salesforce, SAP, AG Grid, enterprise tables)
          '[role="rowheader"]', '[role="columnheader"]', '[role="gridcell"]',
          // ✅ FIX: Toolbar containers (action bars, editor toolbars)
          '[role="toolbar"]',

          // ── Attribute-based interactive elements ──
          '[onclick]', '[tabindex]:not([tabindex="-1"])',
          '[data-testid]', '[data-test]',
          // ✅ FIX: Bootstrap/Tailwind toggle triggers
          '[data-toggle]',
          // ✅ FIX: Popup triggers (elements that open menus/listboxes on click)
          '[aria-haspopup]',
          // ✅ FIX: Drag-and-drop targets
          '[draggable="true"]',

          // ── List/nav items (dropdown suggestions, nav lists, autocomplete) ──
          'li',

          // ── Semantic HTML elements ──
          'canvas', // L5: Include canvas for vision escalation trigger
          'h1', 'h2', 'h3', // GoalDetector/GoalExpander/SemanticWeight
          '[contenteditable="true"]', '[contenteditable=""]', // Rich text editors
          'dialog[open]', // Native <dialog> elements
          // ✅ FIX: Native accordion/disclosure (details/summary)
          'summary',
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
         * Secondary pass: Collect framework-bound interactive elements globally.
         * Finds elements with React/Vue/Angular event bindings or cursor:pointer
         * that aren't caught by the standard interactiveSelectors whitelist.
         *
         * Scans container (document.body), capped at MAX_SECONDARY_ELEMENTS.
         * Returns Set of added elements for overlay-aware isInsideModal logic.
         */
        const MAX_SECONDARY_ELEMENTS = 120; // Cap to prevent flooding from global scan

        const collectFrameworkInteractiveElements = (
          container: Element,
          alreadyCollected: Set<Element>,
          collected: Element[]
        ): Set<Element> => {
          const addedElements = new Set<Element>();
          const candidates = container.querySelectorAll('*');
          let added = 0;
          for (const el of candidates) {
            // Q2 FIX: Hard cap on secondary pass elements
            if (added >= MAX_SECONDARY_ELEMENTS) break;

            // Q3 FIX: Skip the container element itself — it's a wrapper, not a clickable target
            if (el === container) continue;

            // Skip if already collected by primary pass
            if (alreadyCollected.has(el)) continue;

            // Skip non-visible elements early
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') continue;
            if (parseFloat(style.opacity) < 0.1) continue;

            // Skip elements too small to be interactive
            const rect = el.getBoundingClientRect();
            if (rect.width < 10 || rect.height < 10) continue;

            // Skip structural/container elements that are too large (likely wrappers, not clickables)
            if (rect.width > 600 && rect.height > 600) continue;

            // ── Tier 1: Framework event bindings (high confidence) ──
            let hasFrameworkBinding = false;
            try {
              const keys = Object.keys(el);
              for (let k = 0; k < keys.length; k++) {
                const key = keys[k];
                if (
                  key.startsWith('__reactFiber$') ||
                  key.startsWith('__reactInternalInstance$') ||
                  key.startsWith('__reactEvents$') ||
                  key.startsWith('__reactProps$')
                ) {
                  // React: check if the fiber/props has an onClick handler
                  try {
                    const propsKey = keys.find(pk => pk.startsWith('__reactProps$'));
                    if (propsKey) {
                      const props = (el as any)[propsKey];
                      if (props && (props.onClick || props.onChange || props.onMouseDown)) {
                        hasFrameworkBinding = true;
                      }
                    } else {
                      // Has React fiber but can't confirm onClick — include conservatively
                      hasFrameworkBinding = true;
                    }
                  } catch {
                    hasFrameworkBinding = true;
                  }
                  break;
                }
              }
              if (!hasFrameworkBinding) {
                // Vue 2: __vue__ instance — require click/input/change listener
                // @ts-expect-error - Vue internals
                const vueInstance = (el as any).__vue__;
                if (vueInstance) {
                  const listeners = vueInstance.$listeners || {};
                  if (listeners.click || listeners.input || listeners.change) {
                    hasFrameworkBinding = true;
                  }
                }
                // Vue 3: __vueParentComponent — require onClick/onInput/onChange prop
                if (!hasFrameworkBinding) {
                  // @ts-expect-error - Vue internals
                  const vue3Component = (el as any).__vueParentComponent;
                  if (vue3Component) {
                    const vnode = vue3Component.vnode;
                    const vProps = vnode && vnode.props;
                    if (vProps && (vProps.onClick || vProps.onInput || vProps.onChange)) {
                      hasFrameworkBinding = true;
                    }
                  }
                }
              }
              if (!hasFrameworkBinding) {
                // Angular: __ngContext__ or _ngHost — require interactive signal
                // @ts-expect-error - Angular internals
                if ((el as any).__ngContext__ || (el as any)._ngHost) {
                  const tag = el.tagName.toLowerCase();
                  const role = (el.getAttribute('role') || '').toLowerCase();
                  const hasTabindex = el.hasAttribute('tabindex');
                  const hasOnclick = el.hasAttribute('onclick');
                  const interactiveRoles = ['button', 'link', 'tab', 'menuitem', 'option', 'switch', 'checkbox', 'radio'];
                  const cls = (el.getAttribute('class') || '').toLowerCase();
                  const hasInteractiveClass = /btn|button|click|link/.test(cls);
                  if (hasTabindex || hasOnclick || interactiveRoles.includes(role) || hasInteractiveClass || tag === 'button' || tag === 'a') {
                    hasFrameworkBinding = true;
                  }
                }
              }
            } catch { /* ignore */ }

            // ── Tier 2: cursor:pointer heuristic (lower confidence, stricter checks) ──
            // Q2 FIX: Only use cursor:pointer for LEAF-like elements to avoid wrapper divs.
            // Must be: cursor:pointer + has OWN direct text (not just inherited) + no child elements with cursor:pointer
            if (!hasFrameworkBinding && style.cursor === 'pointer') {
              // Check for direct text content (not inherited from children)
              let hasOwnText = false;
              for (const child of el.childNodes) {
                if (child.nodeType === 3 /* TEXT_NODE */ && (child.textContent || '').trim().length > 0) {
                  hasOwnText = true;
                  break;
                }
              }
              // Fallback: if no direct TEXT_NODE, check total textContent for short elements
              if (!hasOwnText) {
                const totalText = (el.textContent || '').trim();
                if (totalText.length > 0 && totalText.length < 100) {
                  hasOwnText = true;
                }
              }
              // Leaf-check: no child elements that are also cursor:pointer (avoid parent+child duplication)
              const hasClickableChildren = hasOwnText && el.querySelector(':scope > [style*="cursor"], :scope > [role]') === null;
              if (hasOwnText && hasClickableChildren) {
                const text = (el.textContent || '').trim();
                if (text.length > 0 && text.length < 200) {
                  hasFrameworkBinding = true;
                }
              }
            }

            if (hasFrameworkBinding) {
              collected.push(el);
              alreadyCollected.add(el);
              addedElements.add(el);
              elementShadowDepth.set(el, 0);
              added++;
            }
          }
          return addedElements;
        };

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

        // activeModalElement is already computed above via detectActiveModal + activeModalRef.

        // ═══════════════════════════════════════════════════════════════════════
        // SECONDARY PASS: Framework-bound interactive elements (GLOBAL scan)
        // Custom components (Vue @click, React onClick, Angular (click)) and
        // cursor:pointer leaf elements that aren't caught by querySelectorAll.
        // Scans entire document.body — capped at MAX_SECONDARY_ELEMENTS (60).
        // ═══════════════════════════════════════════════════════════════════════
        const secondaryPassElements = collectFrameworkInteractiveElements(
          document.body,
          seenElements,
          uniqueElements
        );

        // ✅ FIX BUG 5: Track refs used in THIS snapshot pass to prevent duplicates
        // When two elements produce the same fingerprint (e.g. repeated UI cards),
        // the fingerprint map would restore the same ref → duplicate data-agent-ref.
        // This set ensures every element gets a unique ref in each collection pass.
        const usedRefsThisPass = new Set<string>();

        // Process each unique element (including shadow DOM elements)
        uniqueElements.forEach((el: Element) => {
          try {
            // Skip hidden elements
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden') return;
            if (parseFloat(style.opacity) < 0.01) return; // 0.01 instead of 0.1: catch fade-in animations
            // Skip elements inside aria-hidden containers (not accessible to users)
            if (el.closest('[aria-hidden="true"]')) return;
            // Skip non-interactive elements (pointer-events:none = can't be clicked)
            if (style.pointerEvents === 'none') return;

            // Skip if too small
            const rect = el.getBoundingClientRect();
            if (rect.width < 5 || rect.height < 5) return;

            // Skip elements that are fully outside the visible viewport
            // @ts-expect-error - window available in browser context
            const vw = window.innerWidth;
            // @ts-expect-error - window available in browser context
            const vh = window.innerHeight;
            if (__mc.fullPage) {
              // fullPage: skip only horizontally off-screen elements
              if (rect.right < 0 || rect.left > vw) return;
            } else {
              // default: skip everything outside viewport
              if (rect.bottom < 0 || rect.top > vh || rect.right < 0 || rect.left > vw) return;
            }

            // ═══════════════════════════════════════════════════════════════
            // LAYER-AWARE VISIBILITY: Check if element is inside active modal/overlay FIRST.
            // Elements inside the topmost layer (popup/dialog/overlay) should NEVER be
            // filtered out by elementFromPoint — the user interacts with the popup, not the background.
            // This mirrors real user behavior: when a popup is open, you see and click its elements.
            // ═══════════════════════════════════════════════════════════════
            const isInsideModal = activeModalElement
              ? activeModalElement.contains(el)
              : secondaryPassElements.has(el);

            // Universal visibility check via elementFromPoint.
            // The browser tells us exactly what the user sees at the element's center pixel.
            // If the topmost element there is unrelated (neither itself, nor a descendant,
            // nor an ancestor), then this element is visually covered by something —
            // overlay, popup, dropdown, sticky header, toast, etc.
            // ✅ FIX: SKIP hit test for elements inside active modal/popup/overlay.
            // Popups often have backdrops or layered structure where elementFromPoint
            // returns the backdrop instead of the button inside the popup — causing
            // legitimate interactive elements to be lost from the snapshot entirely.
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            // @ts-expect-error - window available in browser context
            const inVp = cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight;
            let hitTestTopEl: Element | null = null;
            let hitTestDone = false;
            if (inVp) {
              try {
                hitTestTopEl = document.elementFromPoint(cx, cy);
                hitTestDone = true;
                if (hitTestTopEl && hitTestTopEl !== el && !el.contains(hitTestTopEl) && !hitTestTopEl.contains(el)) {
                  // For shadow DOM elements, elementFromPoint returns the shadow host
                  // which won't match ancestor/descendant checks above.
                  // Check if the hit element is the shadow host that contains our element.
                  const elRoot = el.getRootNode();
                  const isShadowHostMatch = elRoot instanceof ShadowRoot && elRoot.host === hitTestTopEl;

                  // ✅ FIX: Don't filter out elements that are inside the active modal/popup.
                  // Also check if the hit element itself is inside the same modal (sibling layers within popup).
                  const hitIsInsideSameModal = isInsideModal && activeModalElement && activeModalElement.contains(hitTestTopEl);

                  // Don't return — let element continue with isTopMostAtCenter=false.
                  // buildAllowedSets handles soft penalty (no modal) / hard exclude (modal present).
                }
              } catch {
                // elementFromPoint can fail in edge cases — don't skip
              }
            }

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
            if (existingRef && refPattern.test(existingRef) && !usedRefsThisPass.has(existingRef)) {
              // Case 1: Element already has a valid ref AND it's not already used in this pass
              ref = existingRef;
            } else {
              // Case 2: Check fingerprint map for restoration
              const fingerprint = getElementFingerprint(el);
              const restoredRef = win.__agentFingerprintMap.get(fingerprint);
              if (restoredRef && refPattern.test(restoredRef) && !usedRefsThisPass.has(restoredRef)) {
                // ✅ FIX BUG 5: Only restore if ref isn't already used by another element
                ref = restoredRef;
              } else {
                // Case 3: Assign new ref (fingerprint collision or first time)
                ref = `${refPrefix}${win.__agentRefCounter++}`;
              }
              // Store fingerprint → ref mapping
              win.__agentFingerprintMap.set(fingerprint, ref);
            }

            // ✅ FIX BUG 5: Mark ref as used in this pass to prevent duplicates
            usedRefsThisPass.add(ref);

            if (!existingRef || existingRef !== ref) {
              el.setAttribute('data-agent-ref', ref);
            }

            const input = el as any;
            const isInput = el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';

            // ✅ FIX: Reuse early modal check (computed before hit test above)
            const isInsideActiveModal = isInsideModal;

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

            // Reuse cached elementFromPoint result from visibility check above
            const isTopMostAtCenter: boolean | undefined = hitTestDone
              ? (hitTestTopEl === el || (hitTestTopEl !== null && el.contains(hitTestTopEl)))
              : undefined;

            // SECURITY: Redact sensitive input values to prevent credential leakage
            // Password fields and credential-related inputs should never have values in snapshot
            // ✅ FIX: Use token-level matching for autocomplete (space-separated per spec)
            // to avoid false positives like 'tel' matching 'hotel'
            const autocompleteTokens = new Set(
              (el.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/).filter(Boolean)
            );
            const SENSITIVE_AUTOCOMPLETE = new Set([
              'password', 'current-password', 'new-password',
              'username', 'email', 'tel', 'phone',
            ]);
            const hasSensitiveAutocomplete = [...SENSITIVE_AUTOCOMPLETE].some(s => autocompleteTokens.has(s));
            const isSensitiveInput = isInput && (
              input.type === 'password' ||
              hasSensitiveAutocomplete ||
              /password|passwd|pwd|secret|credential/i.test(el.getAttribute('name') || '') ||
              /password|passwd|pwd|secret|credential/i.test(el.getAttribute('id') || '') ||
              /user|username|login|email|phone|tel|mobile/i.test(el.getAttribute('name') || '') ||
              /user|username|login|email|phone|tel|mobile/i.test(el.getAttribute('id') || '')
            );

            // ═══════════════════════════════════════════════════════════════
            // STEP EDITOR V2: Extract ARIA state
            // ═══════════════════════════════════════════════════════════════
            // ✅ FIX: Use getCleanAttr to strip Angular escaped quotes from ARIA states
            const ariaExpandedRaw = getCleanAttr(el, 'aria-expanded');
            const ariaExpanded = ariaExpandedRaw === 'true' ? true : ariaExpandedRaw === 'false' ? false : undefined;

            const ariaPressedRaw = getCleanAttr(el, 'aria-pressed');
            const ariaPressed = ariaPressedRaw === 'true' ? true : ariaPressedRaw === 'false' ? false : undefined;

            const ariaSelectedRaw = getCleanAttr(el, 'aria-selected');
            const ariaSelected = ariaSelectedRaw === 'true' ? true : ariaSelectedRaw === 'false' ? false : undefined;

            const ariaCheckedRaw = getCleanAttr(el, 'aria-checked');
            const ariaChecked = ariaCheckedRaw === 'true' ? true :
              ariaCheckedRaw === 'false' ? false :
                ariaCheckedRaw === 'mixed' ? 'mixed' : undefined;

            // ═══════════════════════════════════════════════════════════════
            // STEP EDITOR V2: Extract validation state
            // ═══════════════════════════════════════════════════════════════
            const required = input.required || el.hasAttribute('required') || getCleanAttr(el, 'aria-required') === 'true';
            const readOnly = input.readOnly || el.hasAttribute('readonly') || getCleanAttr(el, 'aria-readonly') === 'true';

            // Check invalid via aria-invalid or :invalid pseudo-class
            const ariaInvalid = getCleanAttr(el, 'aria-invalid');
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
              role: (el.getAttribute('role') || el.tagName.toLowerCase()).replace(/["']/g, '').trim(),
              name: ariaLabel ||
                el.getAttribute('title') ||
                el.getAttribute('placeholder') ||
                getReadableElementText(el).slice(0, 50) || '',
              tag: el.tagName.toLowerCase(),
              type: isInput ? input.type : undefined,
              // SECURITY: Never include raw input values in snapshots.
              // Use `hasValue` for state-aware logic (privacy-safe).
              value: undefined,
              href: el.tagName === 'A' ? (el as HTMLAnchorElement).href || undefined : undefined,
              placeholder: isInput ? input.placeholder : undefined,
              checked: input.checked || undefined,
              disabled: input.disabled || el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true',
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

              // Phase 4: Custom component interactivity signals
              // Detect framework event bindings (React/Vue/Angular synthetic events)
              frameworkClickable: (() => {
                try {
                  const keys = Object.keys(el);
                  for (let k = 0; k < keys.length; k++) {
                    const key = keys[k];
                    if (key.startsWith('__reactFiber$') || key.startsWith('__reactInternalInstance$') || key.startsWith('__reactEvents$')) return 'react' as const;
                  }
                  // @ts-expect-error - Vue internals
                  if ((el as any).__vue__ || (el as any).__vueParentComponent) return 'vue' as const;
                  // @ts-expect-error - Angular internals
                  if ((el as any).__ngContext__ || (el as any)._ngHost) return 'angular' as const;
                } catch { /* ignore */ }
                return undefined;
              })(),
              isContentEditable: (el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '') || undefined,
              tabIndex: el.getAttribute('tabindex') !== null ? parseInt(el.getAttribute('tabindex') as string, 10) : undefined,
              hasOnclick: el.hasAttribute('onclick') || undefined,
              hasAriaHaspopup: el.hasAttribute('aria-haspopup') || undefined,
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

          // Priority 4: Fallback - only body text NOT already captured above
          // ✅ FIX: Skip full body text to avoid 50% duplication; only add if no credential
          // texts found in priorities 1-3 (rare edge case fallback)
          if (textParts.length === 0) {
            // @ts-expect-error - document available in browser context
            const bodyText = document.body?.innerText || '';
            if (bodyText) {
              textParts.push(bodyText.slice(0, 5000));
            }
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

        // ═══════════════════════════════════════════════════════════════════════
        // PAGE STRUCTURE DETECTION: Tables, Lists, Pagination
        // ═══════════════════════════════════════════════════════════════════════
        const pageStructure = (() => {
          const tables: Array<{
            ref: string; headers: string[]; rowCount: number; columnCount: number;
            isSortable: boolean; hasPagination: boolean; hasCheckboxes: boolean; hasInlineEditing: boolean;
          }> = [];

          // @ts-expect-error - document available in browser context
          document.querySelectorAll('table, [role="grid"], [role="treegrid"]').forEach((table: Element, tIdx: number) => {
            const tEl = table as HTMLElement;
            const rect = tEl.getBoundingClientRect();
            if (rect.width < 50 || rect.height < 50) return;
            const style = window.getComputedStyle(tEl);
            if (style.display === 'none' || style.visibility === 'hidden') return;

            const headerCells = table.querySelectorAll('thead th, thead td, [role="columnheader"]');
            const headers = Array.from(headerCells).map(h => (h as HTMLElement).textContent?.trim() || '').filter(Boolean).slice(0, 20);
            const rows = table.querySelectorAll('tbody tr, [role="row"]');
            const rowCount = rows.length;
            const columnCount = headers.length || (rows[0]?.querySelectorAll('td, [role="gridcell"]').length || 0);
            const isSortable = Array.from(headerCells).some(h => h.querySelector('button, a, [role="button"]') !== null);
            const hasCheckboxes = table.querySelector('input[type="checkbox"], [role="checkbox"]') !== null;
            const hasInlineEditing = Array.from(table.querySelectorAll('td, [role="gridcell"]')).some(cell => cell.querySelector('input, textarea, select, [contenteditable="true"]') !== null);
            const parent = tEl.parentElement || tEl;
            const hasPagination = parent.querySelector('[aria-label*="pagination" i], [aria-label*="page" i], .pagination, [class*="paginat"]') !== null;
            const ref = tEl.getAttribute('data-agent-ref') || `t${tIdx}`;

            tables.push({ ref, headers, rowCount, columnCount, isSortable, hasPagination, hasCheckboxes, hasInlineEditing });
          });

          const lists: Array<{ ref: string; itemCount: number; isVirtualized: boolean; hasLoadMore: boolean }> = [];

          // @ts-expect-error - document available in browser context
          document.querySelectorAll('ul, ol, [role="list"], [role="listbox"]').forEach((list: Element, lIdx: number) => {
            const lEl = list as HTMLElement;
            const items = list.querySelectorAll(':scope > li, :scope > [role="listitem"], :scope > [role="option"]');
            if (items.length < 3) return;
            const rect = lEl.getBoundingClientRect();
            if (rect.width < 50) return;
            const style = window.getComputedStyle(lEl);
            const isVirtualized = style.overflow === 'auto' || style.overflowY === 'auto' ||
              style.overflowY === 'scroll' || lEl.classList.contains('virtual-list') ||
              lEl.hasAttribute('data-virtualized');
            const ref = lEl.getAttribute('data-agent-ref') || `l${lIdx}`;
            lists.push({ ref, itemCount: items.length, isVirtualized, hasLoadMore: false });
          });

          // Pagination controls
          let pagination: { currentPage?: number; totalPages?: number; nextRef?: string; prevRef?: string } | null = null;
          // @ts-expect-error - document available in browser context
          const pagNav = document.querySelector('[aria-label*="pagination" i], [aria-label*="page" i], .pagination, [class*="paginat"], nav[aria-label*="Page"]');
          if (pagNav) {
            const current = pagNav.querySelector('[aria-current="page"], .active, [class*="active"]');
            const currentPage = current ? parseInt(current.textContent?.trim() || '', 10) : undefined;
            const allPageNums = Array.from(pagNav.querySelectorAll('a, button'))
              .map((e: Element) => parseInt((e as HTMLElement).textContent?.trim() || '', 10))
              .filter((n: number) => !isNaN(n));
            const totalPages = allPageNums.length > 0 ? Math.max(...allPageNums) : undefined;
            const nextBtn = pagNav.querySelector('[aria-label*="next" i], [aria-label*="Next"]') as HTMLElement | null;
            const prevBtn = pagNav.querySelector('[aria-label*="prev" i], [aria-label*="Prev"]') as HTMLElement | null;
            pagination = {
              currentPage: (currentPage && !isNaN(currentPage)) ? currentPage : undefined,
              totalPages,
              nextRef: nextBtn?.getAttribute('data-agent-ref') || undefined,
              prevRef: prevBtn?.getAttribute('data-agent-ref') || undefined,
            };
          }

          // Load More buttons — tag nearest list
          const loadMoreRe = /load\s*more|show\s*more|see\s*more|view\s*all|ещё|показать\s*ещ|көбірек|загрузить\s*ещ/i;
          // @ts-expect-error - document available in browser context
          document.querySelectorAll('button, a, [role="button"]').forEach((el: Element) => {
            const text = (el as HTMLElement).textContent?.trim() || '';
            if (loadMoreRe.test(text) && text.length < 50) {
              // Tag nearest parent list
              for (const l of lists) {
                // @ts-expect-error - document available in browser context
                const listEl = document.querySelector(`[data-agent-ref="${l.ref}"]`);
                if (listEl && (listEl.contains(el) || listEl.parentElement?.contains(el))) {
                  l.hasLoadMore = true;
                  break;
                }
              }
            }
          });

          return { tables, lists, pagination };
        })();

        // ═══════════════════════════════════════════════════════════════════════
        // PAGE ALERTS: Collect visible error/alert/warning text from non-interactive elements.
        // These are invisible to the interactive-only element collection above.
        // Critical for detecting: wrong credentials, validation errors, auth failures,
        // rate limiting, account locked, etc.
        // ═══════════════════════════════════════════════════════════════════════
        const pageAlerts: string[] = [];
        try {
          const alertSelectors = [
            '[role="alert"]',
            '.error-message, .form-error, .field-error, .validation-error',
            '.invalid-feedback',
            '[aria-live="assertive"]',
          ];

          // Broader selectors that need extra filtering to avoid false positives
          const broadSelectors = [
            '[class*="error"]:not(input):not(select):not(textarea):not(button):not(a)',
            '[class*="danger"]:not(input):not(button):not(a)',
            '.alert:not([class*="alert-info"]):not([class*="alert-success"]):not([class*="alert-primary"])',
          ];

          const seenAlertTexts = new Set<string>();

          // Collect from precise selectors first
          for (const selector of alertSelectors) {
            try {
              document.querySelectorAll(selector).forEach((el: Element) => {
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden') return;
                if (parseFloat(style.opacity) < 0.1) return;
                const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                if (text.length >= 3 && text.length <= 300 && !seenAlertTexts.has(text)) {
                  seenAlertTexts.add(text);
                  pageAlerts.push(text.slice(0, 150));
                }
              });
            } catch {
              // Selector may be invalid on some pages
            }
          }

          // Collect from broader selectors (only if we didn't already find alerts)
          if (pageAlerts.length === 0) {
            for (const selector of broadSelectors) {
              try {
                document.querySelectorAll(selector).forEach((el: Element) => {
                  const style = window.getComputedStyle(el);
                  if (style.display === 'none' || style.visibility === 'hidden') return;
                  if (parseFloat(style.opacity) < 0.1) return;
                  // Extra size filter: error messages are typically small elements, not page-wide containers
                  const rect = el.getBoundingClientRect();
                  // @ts-expect-error - window available in browser context
                  if (rect.width > window.innerWidth * 0.9 && rect.height > 200) return; // Skip large containers
                  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
                  if (text.length >= 3 && text.length <= 300 && !seenAlertTexts.has(text)) {
                    seenAlertTexts.add(text);
                    pageAlerts.push(text.slice(0, 150));
                  }
                });
              } catch {
                // Selector may be invalid
              }
            }
          }
        } catch {
          // Page alert collection is non-critical — never break snapshot
        }

        return {
          // @ts-expect-error - window and document available in browser context
          url: window.location.href,
          // @ts-expect-error
          title: document.title,
          elements,
          timestamp: Date.now(),
          activeModalRef, // Include detected modal ref
          obstacleFacts: obstacleFacts.length > 0 ? obstacleFacts : undefined, // Layer 2: positioned element facts for LLM
          transientState, // Include transient state info (loading indicators)
          pageTextForExtraction, // For credential extraction only
          metadata, // P0: Visual content metadata for proactive vision detection
          pageStructure, // Manus: Tables, lists, pagination detection
          pageAlerts: pageAlerts.length > 0 ? pageAlerts.slice(0, 5) : undefined, // Max 5 alerts
        };
      }, __modalConsts);

      // logger.debug('[SNAPSHOT_COLLECTOR] Collected snapshot', {
      //   url: snapshot.url,
      //   elementCount: snapshot.elements.length,
      //   hasActiveModal: !!snapshot.activeModalRef,
      //   isTransient: snapshot.transientState?.isTransient || false,
      //   transientType: snapshot.transientState?.type,
      // });

      // ═══════════════════════════════════════════════════════════════════════
      // IFRAME ELEMENT COLLECTION (same-origin only)
      // ═══════════════════════════════════════════════════════════════════════
      try {
        const frames = page.frames().filter(f => f !== page.mainFrame() && !f.isDetached());
        for (const frame of frames) {
          try {
            let frameName: string;
            try {
              frameName = frame.name() || new URL(frame.url()).pathname.slice(-30);
            } catch {
              frameName = frame.name() || 'iframe';
            }

            const iframeElements = await frame.evaluate((fName: string) => {
              const selectors = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="tab"], [role="option"], [role="combobox"], [role="switch"], [role="menuitem"], [role="slider"], [role="searchbox"], [role="textbox"], [role="gridcell"], [role="rowheader"], [role="columnheader"], [onclick], [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
              const els: any[] = [];
              let idx = 0;
              const MAX_IFRAME_ELEMENTS = 50;

              document.querySelectorAll(selectors).forEach((el) => {
                if (idx >= MAX_IFRAME_ELEMENTS) return;
                const htmlEl = el as HTMLElement;
                const rect = htmlEl.getBoundingClientRect();
                const style = window.getComputedStyle(htmlEl);
                if (style.display === 'none' || style.visibility === 'hidden') return;
                if (rect.width < 5 || rect.height < 5) return;

                const tag = htmlEl.tagName.toLowerCase();
                const role = (htmlEl.getAttribute('role') || (tag === 'a' ? 'link' : tag === 'input' || tag === 'select' || tag === 'textarea' ? 'input' : 'button')).replace(/["']/g, '').trim();
                const name = htmlEl.getAttribute('aria-label') || htmlEl.title || htmlEl.textContent?.trim().slice(0, 80) || htmlEl.getAttribute('placeholder') || '';

                els.push({
                  ref: `f${idx}`,
                  role,
                  name,
                  tag,
                  type: htmlEl.getAttribute('type') || undefined,
                  placeholder: htmlEl.getAttribute('placeholder') || undefined,
                  checked: (htmlEl as HTMLInputElement).checked || undefined,
                  disabled: htmlEl.hasAttribute('disabled') || (htmlEl.getAttribute('aria-disabled') || '').replace(/["']/g, '').trim() === 'true' || undefined,
                  visible: true,
                  context: `iframe: ${fName}`,
                  iframeSource: fName,
                });
                idx++;
              });
              return els;
            }, frameName);

            if (iframeElements.length > 0) {
              (snapshot as any).elements.push(...iframeElements);
            }
          } catch {
            // Cross-origin or detached iframe — skip silently
          }
        }
      } catch {
        // Frame enumeration failed — non-fatal
      }

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
  static format(snapshot: LiteSnapshot, keepRefs?: Set<string>): string {
    if (snapshot.elements.length === 0) {
      return 'No interactive elements found on page.';
    }

    // Filter elements: pruner-based (dynamic) or legacy (priority sort + cap)
    let elements = snapshot.elements;
    if (keepRefs && keepRefs.size > 0) {
      // Pre-LLM pruner: keep only elements the pruner selected (dynamic cap)
      elements = snapshot.elements.filter(el => keepRefs.has(el.ref));
    } else {
      // Legacy fallback: priority sort + hardcoded cap
      const maxElements = LITE_ENGINE_FLAGS.snapshotMaxElements;
      if (maxElements > 0 && snapshot.elements.length > maxElements) {
        const priorityScore = (el: LiteElement): number => {
          // P4: Form inputs — highest priority (user needs to fill these)
          if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') return 4;
          // P4: ARIA input widgets (combobox, slider, spinbutton, switch, searchbox, textbox)
          const inputRoles = ['combobox', 'slider', 'spinbutton', 'switch', 'searchbox', 'textbox'];
          if (inputRoles.includes(el.role)) return 4;
          // P3: Buttons, headings, and actionable elements
          if (el.tag === 'button' || el.role === 'button') return 3;
          if (el.tag === 'h1' || el.tag === 'h2' || el.tag === 'h3') return 3;
          // P3: Dropdown options/menu items — critical for selection flows
          const actionRoles = ['option', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem'];
          if (actionRoles.includes(el.role)) return 3;
          // P2: Links, tabs, summary (accordion triggers)
          if (el.tag === 'a' || el.role === 'link') return 2;
          if (el.role === 'tab' || el.tag === 'summary') return 2;
          // P1: Everything else (containers, listbox, menu, canvas, etc.)
          return 1;
        };
        elements = [...snapshot.elements]
          .sort((a, b) => priorityScore(b) - priorityScore(a))
          .slice(0, maxElements);
      }
    }

    // Group elements by role
    const groups: Record<string, LiteElement[]> = {};

    elements.forEach((el) => {
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

    // Loading state indicator
    if (snapshot.transientState?.isTransient) {
      lines.push(`LOADING_STATE: ${snapshot.transientState.type}${snapshot.transientState.ref ? ` at ${snapshot.transientState.ref}` : ''}${snapshot.transientState.text ? ` ("${snapshot.transientState.text}")` : ''}`);
    }

    // Page structure metadata (tables, lists, pagination)
    if (snapshot.pageStructure) {
      const ps = snapshot.pageStructure;
      for (const t of ps.tables) {
        lines.push(`TABLE: ref=${t.ref} rows=${t.rowCount} cols=${t.columnCount}${t.isSortable ? ' [SORTABLE]' : ''}${t.hasPagination ? ' [PAGINATED]' : ''}${t.hasCheckboxes ? ' [SELECTABLE]' : ''} headers=[${t.headers.join(', ')}]`);
      }
      for (const l of ps.lists) {
        lines.push(`LIST: ref=${l.ref} items=${l.itemCount}${l.isVirtualized ? ' [VIRTUAL]' : ''}${l.hasLoadMore ? ' [HAS_LOAD_MORE]' : ''}`);
      }
      if (ps.pagination) {
        lines.push(`PAGINATION: page=${ps.pagination.currentPage || '?'}/${ps.pagination.totalPages || '?'} nextRef=${ps.pagination.nextRef || 'none'} prevRef=${ps.pagination.prevRef || 'none'}`);
      }
    }

    // Page alerts/errors (non-interactive error messages visible on page)
    // CRITICAL: These are error toasts, validation messages, auth failures that
    // are NOT interactive elements and would otherwise be invisible to the agent.
    if (snapshot.pageAlerts && snapshot.pageAlerts.length > 0) {
      lines.push('[PAGE ALERTS]');
      snapshot.pageAlerts.slice(0, 5).forEach(alert => {
        lines.push(`  ⚠ "${alert}"`);
      });
      lines.push('');
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
        // Manus parity: expose collected-but-hidden element metadata
        if (el.isTopMostAtCenter === false) line += ' [COVERED]';
        if (el.required) line += ' [REQUIRED]';
        if (el.hasValue) line += ' [HAS_VALUE]';
        if (el.readOnly) line += ' [READONLY]';
        if (el.invalid) line += ' [INVALID]';
        if (el.isInsideShadowDOM) line += ' [SHADOW]';
        if (el.ariaExpanded === true) line += ' [EXPANDED]';
        if (el.ariaExpanded === false) line += ' [COLLAPSED]';
        if (el.ariaPressed) line += ' [PRESSED]';
        if (el.ariaSelected) line += ' [SELECTED]';
        if (el.iframeSource) line += ' [IFRAME]';
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
