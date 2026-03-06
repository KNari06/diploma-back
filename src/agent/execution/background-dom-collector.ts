/**
 * Background DOM Collector
 *
 * Lightweight utility to extract InteractiveNode[] from a Playwright Page
 * for use in background/CI test execution (without preview session dependency).
 *
 * Features:
 * - Collects interactive elements with all attributes needed for resolution
 * - Injects temporary data-agent-ref attributes for targeting
 * - No preview session or WebSocket dependency
 * - Compatible with LLM-based element resolution
 */

import type { InteractiveNode } from '@/services/testing/ui/preview/preview.types';
import { logger } from '@/utils/core/logger';
import type { Page } from 'playwright';

/** Maximum interactive nodes to collect (higher limit for background runs) */
const MAX_NODES_BACKGROUND = 500;

/** Attribute name for temporary refs */
const TEMP_REF_ATTR = 'data-agent-ref';

/** Max time to wait for network idle before collecting DOM (ms) */
const NETWORK_IDLE_TIMEOUT_MS = 3000;

/** Max time to wait for DOM stability (no mutations) (ms) */
const DOM_STABILITY_TIMEOUT_MS = 1500;

/** Interval to check DOM stability (ms) */
const DOM_STABILITY_CHECK_INTERVAL_MS = 200;

/**
 * Browser-side script to extract interactive elements
 * Returns array of element data with all needed attributes
 */
const EXTRACT_SCRIPT = `
(function extractInteractiveNodes() {
  const MAX_NODES = ${MAX_NODES_BACKGROUND};
  const MAX_TEXT_LENGTH = 100;
  const MAX_PARENT_CHAIN = 6;

  // Interactive element selectors (synced with snapshot-collector.ts)
  const INTERACTIVE_SELECTORS = [
    // ── Core interactive elements ──
    'a[href]',
    'button',
    'input:not([type="hidden"])',
    'select',
    'textarea',
    // ── ARIA widget roles (covers MUI, Ant Design, Chakra, Radix, Headless UI) ──
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="listbox"]',
    '[role="combobox"]',
    '[role="menu"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="switch"]',
    '[role="slider"]',
    '[role="spinbutton"]',
    '[role="searchbox"]',
    '[role="textbox"]',
    '[role="treeitem"]',
    '[role="alertdialog"]',
    // ── Attribute-based interactive elements ──
    '[onclick]',
    '[tabindex]:not([tabindex="-1"])',
    '[data-testid]',
    '[data-test]',
    '[data-toggle]',
    '[aria-haspopup]',
    '[draggable="true"]',
    // ── Semantic elements ──
    '[contenteditable="true"]',
    '[contenteditable=""]',
    'dialog[open]',
    'summary',
  ];

  // Collect elements from main document + shadow DOMs recursively
  function collectFromRoot(root) {
    var found = Array.from(root.querySelectorAll(INTERACTIVE_SELECTORS.join(',')));
    // Traverse shadow roots recursively
    var allEls = root.querySelectorAll('*');
    for (var i = 0; i < allEls.length; i++) {
      var sr = allEls[i].shadowRoot;
      if (sr) {
        found = found.concat(collectFromRoot(sr));
      }
    }
    return found;
  }

  var elements = collectFromRoot(document);

  // Phase 4: Second pass — find framework-clickable elements not caught by CSS selectors
  // Detect React/Vue/Angular event bindings on non-interactive elements
  function detectFrameworkClickable(el) {
    // React: __reactFiber$ or __reactInternalInstance$ or __reactEvents$
    var keys = Object.keys(el);
    for (var k = 0; k < keys.length; k++) {
      if (keys[k].startsWith('__reactFiber$') || keys[k].startsWith('__reactInternalInstance$') || keys[k].startsWith('__reactEvents$')) return 'react';
    }
    // Vue: __vue__ or __vueParentComponent
    if (el.__vue__ || el.__vueParentComponent) return 'vue';
    // Angular: __ngContext__ or _ngHost
    if (el.__ngContext__ || el._ngHost) return 'angular';
    return null;
  }

  // Collect framework-clickable divs/spans that have cursor:pointer and non-zero size
  var existingSet = new Set(elements);
  var candidates = document.querySelectorAll('div, span, li, td, th, label, p');
  for (var c = 0; c < Math.min(candidates.length, 2000); c++) {
    var el = candidates[c];
    if (existingSet.has(el)) continue; // Already collected
    if (!el.offsetWidth && !el.offsetHeight) continue; // Not visible

    var framework = detectFrameworkClickable(el);
    var computedStyle = framework ? null : window.getComputedStyle(el);
    var hasCursorPointer = computedStyle ? computedStyle.cursor === 'pointer' : false;

    if (framework || hasCursorPointer) {
      // Also require non-trivial size (at least 10x10px)
      var rect = el.getBoundingClientRect();
      if (rect.width >= 10 && rect.height >= 10) {
        elements.push(el);
        existingSet.add(el);
      }
    }
  }

  const results = [];

  // Generate unique ref for each element
  let refCounter = 1;

  for (let i = 0; i < Math.min(elements.length, MAX_NODES); i++) {
    const el = elements[i];

    // Skip if not visible or disabled and not visible
    const isVisible = !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const isDisabled = el.hasAttribute('disabled') || (el.getAttribute('aria-disabled') || '').replace(/["']/g, '').trim() === 'true';
    if (!isVisible && isDisabled) continue;

    // Phase 4: Detect framework event bindings
    const frameworkClickable = detectFrameworkClickable(el);

    // Inject temporary ref
    const ref = 'bg-' + refCounter++;
    el.setAttribute('${TEMP_REF_ATTR}', ref);

    // Get bounding box
    const rect = el.getBoundingClientRect();
    const boundingBox = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };

    // Check if element is topmost at center
    let isTopMostAtCenter = false;
    if (rect.width > 0 && rect.height > 0) {
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      const topEl = document.elementFromPoint(centerX, centerY);
      isTopMostAtCenter = topEl === el || el.contains(topEl);
    }

    // Get label text (from <label>, aria-labelledby, or wrapping label)
    let labelText = '';
    const id = el.getAttribute('id');
    if (id) {
      const label = document.querySelector('label[for="' + id + '"]');
      if (label) labelText = label.textContent?.trim() || '';
    }
    if (!labelText) {
      const ariaLabelledBy = el.getAttribute('aria-labelledby');
      if (ariaLabelledBy) {
        const labelEl = document.getElementById(ariaLabelledBy);
        if (labelEl) labelText = labelEl.textContent?.trim() || '';
      }
    }
    if (!labelText) {
      const parentLabel = el.closest('label');
      if (parentLabel) labelText = parentLabel.textContent?.trim() || '';
    }

    // Get container titles (form legend, fieldset legend, section heading, ARIA groups)
    // Phase 7: Expanded container detection — depth 8, semantic containers, landmarks
    const LANDMARK_ROLES = ['banner', 'navigation', 'main', 'complementary', 'contentinfo', 'search', 'form', 'region'];
    const SEMANTIC_TAGS = ['FIELDSET', 'FORM', 'SECTION', 'ARTICLE', 'NAV', 'ASIDE', 'DIALOG', 'HEADER', 'FOOTER', 'MAIN'];

    const containerTitles = [];
    let nearestLandmark = '';
    let parent = el.parentElement;
    let depth = 0;
    while (parent && depth < 8) {
      const parentRole = (parent.getAttribute('role') || '').toLowerCase();
      const parentAriaLabel = parent.getAttribute('aria-label');
      const parentTag = parent.tagName;

      // Track nearest landmark role
      if (!nearestLandmark) {
        // Explicit ARIA landmark role
        if (parentRole && LANDMARK_ROLES.includes(parentRole)) {
          nearestLandmark = parentRole;
        }
        // Implicit landmark from semantic HTML tags
        else if (parentTag === 'NAV') nearestLandmark = 'navigation';
        else if (parentTag === 'MAIN') nearestLandmark = 'main';
        else if (parentTag === 'HEADER') nearestLandmark = 'banner';
        else if (parentTag === 'FOOTER') nearestLandmark = 'contentinfo';
        else if (parentTag === 'ASIDE') nearestLandmark = 'complementary';
      }

      // Extract container title from semantic containers
      if (parentTag === 'FIELDSET') {
        const legend = parent.querySelector('legend');
        if (legend?.textContent?.trim()) containerTitles.push(legend.textContent.trim());
      } else if (SEMANTIC_TAGS.includes(parentTag) || (parentRole && ['group', 'region', 'form', 'navigation', 'banner', 'main', 'complementary', 'search'].includes(parentRole))) {
        // Try aria-label first (most specific for ARIA containers)
        if (parentAriaLabel?.trim()) {
          containerTitles.push(parentAriaLabel.trim());
        } else {
          // Fall back to heading text
          const heading = parent.querySelector(':scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > h5, :scope > h6');
          if (heading?.textContent?.trim()) containerTitles.push(heading.textContent.trim());
        }
      }
      // Skip plain <div> without role/aria-label (smart filter)
      // Only extract from divs that have semantic meaning

      parent = parent.parentElement;
      depth++;
    }

    // Build node data
    const node = {
      ref,
      tag: el.tagName.toLowerCase(),
      role: (el.getAttribute('role') || '').replace(/["']/g, '').trim() || undefined,
      type: el.getAttribute('type') || undefined,
      inputType: el.getAttribute('type') || undefined,
      text: el.textContent?.trim().substring(0, MAX_TEXT_LENGTH) || undefined,
      labelText: labelText.substring(0, MAX_TEXT_LENGTH) || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      name: el.getAttribute('name') || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      id: el.getAttribute('id') || undefined,
      testIdAttr: el.getAttribute('data-testid') || el.getAttribute('data-test') || undefined,
      autocomplete: el.getAttribute('autocomplete') || undefined,
      boundingBox,
      isVisible,
      isInteractive: true,
      isDisabled,
      isTopMostAtCenter,

      // ARIA state
      // ✅ FIX: Use el.checked (runtime property) instead of hasAttribute('checked') (HTML default)
      // hasAttribute('checked') returns true for initially-checked boxes even after user unchecks them
      checked: el.checked === true ? true : undefined,
      ariaExpanded: (el.getAttribute('aria-expanded') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-expanded') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined),
      ariaPressed: (el.getAttribute('aria-pressed') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-pressed') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined),
      ariaSelected: (el.getAttribute('aria-selected') || '').replace(/["']/g, '').trim() === 'true' ? true : ((el.getAttribute('aria-selected') || '').replace(/["']/g, '').trim() === 'false' ? false : undefined),

      // Validation state
      required: el.hasAttribute('required') || (el.getAttribute('aria-required') || '').replace(/["']/g, '').trim() === 'true',
      readOnly: el.hasAttribute('readonly') || (el.getAttribute('aria-readonly') || '').replace(/["']/g, '').trim() === 'true',
      invalid: (el.getAttribute('aria-invalid') || '').replace(/["']/g, '').trim() === 'true' || el.matches(':invalid'),
      hasValue: !!(el.value && el.value.length > 0),

      // Container info (Phase 7: expanded detection)
      containerTitles: containerTitles.filter(Boolean).slice(0, 5),
      nearestLandmark: nearestLandmark || undefined,
      // Phase 4: Framework event binding detection
      frameworkClickable: frameworkClickable || undefined,
      // Phase 4: Additional interactivity signals
      isContentEditable: el.getAttribute('contenteditable') === 'true' || el.getAttribute('contenteditable') === '' || undefined,
      tabIndex: el.getAttribute('tabindex') !== null ? parseInt(el.getAttribute('tabindex'), 10) : undefined,
      hasOnclick: el.hasAttribute('onclick') || undefined,
      hasAriaHaspopup: el.hasAttribute('aria-haspopup') || undefined,
    };

    results.push(node);
  }

  return results;
})();
`;

/**
 * Collect interactive nodes from current page state
 * Injects temporary data-agent-ref attributes for targeting
 *
 * @param page - Playwright Page
 * @returns Array of InteractiveNode with temporary refs
 */
export async function collectInteractiveNodes(page: Page): Promise<InteractiveNode[]> {
  try {
    const startTime = Date.now();

    // CRITICAL: Remove stale bg-X refs from previous resolution steps
    // Without this, multi-step tests accumulate duplicate refs causing wrong element targeting
    await cleanupTemporaryRefs(page);

    // Step 1: Wait for network idle (SPAs may still be fetching data)
    await waitForPageStability(page);

    // Step 2: Collect from main frame
    const mainNodes = await page.evaluate(EXTRACT_SCRIPT) as InteractiveNode[];

    // Step 3: Collect from accessible iframes
    const iframeNodes = await collectFromIframes(page);

    const nodes = [...mainNodes, ...iframeNodes];
    const elapsed = Date.now() - startTime;

    logger.info('[BACKGROUND_DOM_COLLECTOR] Collected interactive nodes', {
      nodeCount: nodes.length,
      mainFrameNodes: mainNodes.length,
      iframeNodes: iframeNodes.length,
      elapsedMs: elapsed,
    });

    return nodes;
  } catch (error) {
    logger.error('[BACKGROUND_DOM_COLLECTOR] Failed to collect nodes', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

/**
 * Wait for page stability before DOM collection.
 * Combines network idle + DOM mutation stability.
 * Non-fatal: if timeouts expire, we proceed with current state.
 */
async function waitForPageStability(page: Page): Promise<void> {
  // 1. Wait for network idle (best-effort, don't block on long-polling/websockets)
  try {
    await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS });
  } catch {
    // Network idle timeout is non-fatal — SPAs with long-polling will always timeout
    logger.debug('[BACKGROUND_DOM_COLLECTOR] Network idle timeout (non-fatal), proceeding');
  }

  // 2. Wait for DOM stability: no mutations for DOM_STABILITY_CHECK_INTERVAL_MS
  // Uses string-based evaluate to avoid TS "Cannot find MutationObserver/document" errors
  // (this code runs in browser context via Playwright)
  try {
    await page.evaluate(`
      new Promise((resolve) => {
        var lastMutationTime = Date.now();
        var deadline = Date.now() + ${DOM_STABILITY_TIMEOUT_MS};
        var intervalMs = ${DOM_STABILITY_CHECK_INTERVAL_MS};
        var observer = new MutationObserver(function() { lastMutationTime = Date.now(); });
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        function check() {
          var now = Date.now();
          if (now - lastMutationTime >= intervalMs || now >= deadline) {
            observer.disconnect();
            resolve();
          } else {
            setTimeout(check, 50);
          }
        }
        setTimeout(check, intervalMs);
      })
    `);
  } catch {
    logger.debug('[BACKGROUND_DOM_COLLECTOR] DOM stability wait timeout (non-fatal)');
  }
}

/**
 * Collect interactive nodes from accessible iframes.
 * Only collects from same-origin iframes (cross-origin will throw and be skipped).
 *
 * @param page - Playwright Page
 * @returns InteractiveNode[] from all accessible iframes
 */
async function collectFromIframes(page: Page): Promise<InteractiveNode[]> {
  const allIframeNodes: InteractiveNode[] = [];

  try {
    const frames = page.frames();

    for (const frame of frames) {
      // Skip main frame (already collected)
      if (frame === page.mainFrame()) continue;

      // Skip detached frames
      if (frame.isDetached()) continue;

      try {
        // Try to evaluate in the frame — will fail for cross-origin
        const frameNodes = await frame.evaluate(EXTRACT_SCRIPT) as InteractiveNode[];

        if (frameNodes.length > 0) {
          // Prefix refs with frame identifier to avoid collisions with main frame refs
          const frameId = frame.name() || frame.url().slice(-20);
          for (const node of frameNodes) {
            if (node.ref) {
              node.ref = `iframe-${frameId}-${node.ref}`;
            }
            // Mark as coming from iframe for context
            if (!node.containerTitles) node.containerTitles = [];
            node.containerTitles.push(`iframe: ${frame.name() || frame.url()}`);
          }

          allIframeNodes.push(...frameNodes);

          logger.debug('[BACKGROUND_DOM_COLLECTOR] Collected from iframe', {
            frameName: frame.name(),
            frameUrl: frame.url().slice(0, 100),
            nodeCount: frameNodes.length,
          });
        }
      } catch {
        // Cross-origin or detached iframe — skip silently
        logger.debug('[BACKGROUND_DOM_COLLECTOR] Skipped iframe (cross-origin or error)', {
          frameName: frame.name(),
          frameUrl: frame.url().slice(0, 60),
        });
      }
    }
  } catch (error) {
    logger.debug('[BACKGROUND_DOM_COLLECTOR] Iframe collection failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return allIframeNodes;
}

/**
 * Clean up temporary data-agent-ref attributes after resolution
 * Call this after test execution completes
 *
 * @param page - Playwright Page
 */
export async function cleanupTemporaryRefs(page: Page): Promise<void> {
  try {
    await page.evaluate((attrName: string) => {
      // @ts-expect-error - runs in browser context
      const elements = document.querySelectorAll(`[${attrName}^="bg-"]`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      elements.forEach((el: any) => el.removeAttribute(attrName));
    }, TEMP_REF_ATTR);

    logger.debug('[BACKGROUND_DOM_COLLECTOR] Cleaned up temporary refs');
  } catch (error) {
    // Cleanup failure is non-fatal
    logger.debug('[BACKGROUND_DOM_COLLECTOR] Cleanup failed (non-fatal)', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get page signature for cache invalidation
 * Simple hash of form/input structure
 */
export async function getPageSignature(page: Page): Promise<string> {
  try {
    return await page.evaluate(() => {
      // @ts-expect-error - runs in browser context
      const inputs = document.querySelectorAll('input, select, textarea, button, [role="button"]');
      const elements: string[] = [];

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputs.forEach((el: any) => {
        const tag = el.tagName?.toLowerCase() || '';
        const type = el.getAttribute?.('type') || '';
        const name = el.getAttribute?.('name') || '';
        const id = el.id || '';
        const role = el.getAttribute?.('role') || '';
        elements.push(`${tag}:${type}:${name}:${id}:${role}`);
      });

      return elements.sort().join('|').slice(0, 500);
    });
  } catch {
    return '';
  }
}
