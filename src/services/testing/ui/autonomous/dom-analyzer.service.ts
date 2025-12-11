import { logger } from '@/utils/logger';
import { Page } from 'playwright';

/**
 * Page type detection and wait strategies
 */
interface WaitForDOMOptions {
  /**
   * Force specific strategy instead of auto-detection
   * - 'auto': Auto-detect page type (default)
   * - 'spa': Always use SPA wait strategy
   * - 'static': Always use static page wait strategy
   */
  strategy?: 'auto' | 'spa' | 'static';
  /**
   * Maximum wait time for SPA strategy (ms)
   * @default 8000
   */
  maxWaitTime?: number;
  /**
   * Network settle time - no new requests for N ms (SPA only)
   * @default 500
   */
  networkSettleTime?: number;
  /**
   * Timeout for waiting interactive elements (SPA only)
   * @default 3000
   */
  elementTimeout?: number;
}

/**
 * Detect if page is a Single Page Application (SPA)
 * Uses DOM-based detection (fast, no network monitoring needed)
 */
async function detectSPA(page: Page): Promise<boolean> {
  try {
    return await page.evaluate(() => {
      // 1. Check for framework globals (React, Vue, Angular, Svelte, Solid, Preact)
      // @ts-expect-error - browser context (window properties)
      if (window.React || window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return true;
      // @ts-expect-error - browser context
      if (window.Vue || window.__VUE__) return true;
      // @ts-expect-error - browser context
      if (window.ng || window.angular) return true;
      // @ts-expect-error - browser context
      if (window.__REDUX_DEVTOOLS_EXTENSION__) return true; // Redux = likely React
      // @ts-expect-error - browser context
      if (window.__SVELTE__ || window.svelte) return true; // Svelte
      // @ts-expect-error - browser context
      if (window.Solid || window.__SOLID_DEVTOOLS__) return true; // Solid.js
      // @ts-expect-error - browser context
      if (window.Preact || window.preact) return true; // Preact

      // 2. Check for framework data attributes
      // @ts-expect-error - browser context (document available in page.evaluate)
      if (document.querySelector('[data-reactroot], [data-react-helmet]')) return true;
      // @ts-expect-error - browser context
      if (document.querySelector('[data-v-app], [data-v-]')) return true;
      // @ts-expect-error - browser context
      if (document.querySelector('[ng-app], [ng-controller], [ng-version]')) return true;
      // @ts-expect-error - browser context
      if (document.querySelector('[data-svelte-h], [data-sveltekit-preload-data]')) return true; // Svelte/SvelteKit

      // 3. Check for SPA app root structure
      // SPA typically have: empty/minimal body with app root that gets populated
      // @ts-expect-error - browser context
      const body = document.body;
      const hasAppRoot = body.querySelector('[id*="app"], [id*="root"], [id*="__next"], [role="main"]');

      if (hasAppRoot) {
        // Check if body is mostly empty (SPA pattern)
        const bodyIsMinimal = body.children.length <= 2 || body.innerText.trim().length < 100;

        // Check if app root exists but might be empty (still loading)
        const appRoot = hasAppRoot as any; // HTMLElement in browser context
        const appRootIsEmpty = !appRoot.innerText || appRoot.innerText.trim().length < 50;

        // SPA indicator: has app root AND (body is minimal OR app root is empty)
        if (bodyIsMinimal || appRootIsEmpty) return true;
      }

      // 4. Check for SPA routing indicators
      // @ts-expect-error - browser context
      if (window.history && window.history.pushState) {
        // @ts-expect-error - browser context
        if (document.querySelector('[data-router], [data-route]')) {
          return true;
        }
      }

      return false;
    });
  } catch (error) {
    logger.debug('[DOM_ANALYZER] SPA detection failed, assuming SPA (safe fallback)', {
      error: error instanceof Error ? error.message : String(error),
    });
    // ✅ FALLBACK: If detection fails, assume SPA (safer)
    return true;
  }
}

/**
 * Wait for static page to be ready
 * Fast strategy for traditional HTML pages
 */
async function waitForStaticPage(page: Page): Promise<void> {
  try {
    // Wait for DOM to be fully loaded
    await page.waitForLoadState('load', { timeout: 5000 }).catch(() => {
      // If load timeout, at least ensure domcontentloaded
      logger.debug('[DOM_ANALYZER] Load timeout, using domcontentloaded fallback');
    });

    // Small buffer for any late scripts
    await page.waitForTimeout(200);
  } catch (error) {
    logger.debug('[DOM_ANALYZER] Static page wait failed, continuing anyway', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Wait for SPA to be ready for DOM analysis
 * Full strategy for React/Vue/Angular applications
 */
async function waitForSPAPage(
  page: Page,
  config: {
    maxWaitTime: number;
    networkSettleTime: number;
    elementTimeout: number;
  }
): Promise<void> {
  const startTime = Date.now();
  const { maxWaitTime, networkSettleTime, elementTimeout } = config;

  try {
    // ✅ EDGE CASE: Check if page is already loaded (fast path)
    const isAlreadyLoaded = await page.evaluate(() => {
      // @ts-expect-error - browser context
      const body = document.body;
      if (!body) return false;

      // Check if page has substantial content already
      const hasText = body.innerText?.trim().length > 100;
      // ✅ NEW: Include all interactive elements in check
      const hasInteractive = body.querySelectorAll('button, input, a, select, textarea, area, output, meter, progress, dialog, menu, menuitem, embed, object').length > 0;
      // @ts-expect-error - browser context
      const isComplete = document.readyState === 'complete';

      return isComplete && (hasText || hasInteractive);
    });

    if (isAlreadyLoaded) {
      logger.debug('[DOM_ANALYZER] Page already loaded, skipping wait');
      return;
    }

    // Step 1: Wait for network to settle (not full networkidle - too slow)
    logger.debug('[DOM_ANALYZER] Waiting for network to settle', {
      url: page.url(),
    });

    try {
      // Try networkidle first (fast if available)
      await page.waitForLoadState('networkidle', { timeout: 3000 });
    } catch {
      // Fallback: Wait for network to settle (no new requests for N ms)
      await waitForNetworkSettle(page, networkSettleTime, 3000);
    }

    // Step 2: Wait for interactive elements to appear
    logger.debug('[DOM_ANALYZER] Waiting for interactive elements', {
      url: page.url(),
    });

    try {
      // ✅ NEW: Include all interactive elements in wait selector
      await page.waitForSelector('button, input, a, [role="button"], [onclick], select, textarea, area, output, meter, progress, dialog, menu, menuitem, embed, object', {
        timeout: elementTimeout,
        state: 'visible',
      });
    } catch {
      // ✅ EDGE CASE: Elements not found - could be:
      // 1. Still loading (wait a bit more)
      // 2. Empty page (no interactive elements)
      // 3. Lazy loading components
      logger.debug('[DOM_ANALYZER] Interactive elements not found, waiting for late content');

      // Check if page has ANY content (not completely empty)
      const hasContent = await page.evaluate(() => {
        // @ts-expect-error - browser context
        const body = document.body;
        return body && (body.innerText?.trim().length > 0 || body.children.length > 0);
      });

      if (hasContent) {
        // Page has content but no interactive elements yet - wait for lazy loading
        await page.waitForTimeout(1500);
      } else {
        // Empty page - minimal wait
        await page.waitForTimeout(500);
      }
    }

    // Step 3: Quick check for content (not skeleton loaders)
    await Promise.race([
      page.waitForFunction(
        () => {
          // @ts-expect-error - browser context
          const appRoot = document.querySelector('[id*="app"], [id*="root"], [data-reactroot], [data-v-app], main, [role="main"]') || document.body;
          if (!appRoot) return false;

          // Check for real content (not just skeleton)
          const text = appRoot.innerText || '';
          const hasText = text.trim().length > 50;
          // ✅ NEW: Include all interactive elements in check
          const hasInteractive = appRoot.querySelectorAll('button, input, a, select, textarea, area, output, meter, progress, dialog, menu, menuitem, embed, object').length > 0;

          return hasText || hasInteractive;
        },
        { timeout: 2000 }
      ).catch(() => null),
      page.waitForTimeout(1000), // Fallback timeout
    ]);

    const duration = Date.now() - startTime;
    logger.debug('[DOM_ANALYZER] SPA wait completed', {
      url: page.url(),
      duration: `${duration}ms`,
    });
  } catch (error) {
    logger.debug('[DOM_ANALYZER] SPA wait failed, continuing anyway', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Wait for network to settle (no new requests for N ms)
 * Better than networkidle for long-polling/websockets
 */
async function waitForNetworkSettle(
  page: Page,
  settleTime: number,
  maxTimeout: number
): Promise<void> {
  const startTime = Date.now();
  let lastRequestTime = Date.now();
  let inFlightRequests = 0;

  const onRequest = () => {
    inFlightRequests++;
    lastRequestTime = Date.now();
  };

  const onResponse = () => {
    inFlightRequests--;
    lastRequestTime = Date.now();
  };

  page.on('request', onRequest);
  page.on('response', onResponse);

  try {
    while (Date.now() - startTime < maxTimeout) {
      const timeSinceLastRequest = Date.now() - lastRequestTime;
      if (timeSinceLastRequest >= settleTime && inFlightRequests === 0) {
        break;
      }
      await page.waitForTimeout(100);
    }
  } finally {
    page.off('request', onRequest);
    page.off('response', onResponse);
  }
}

/**
 * Wait for DOM to be ready for analysis
 * Auto-detects page type (SPA vs static) and applies appropriate strategy
 *
 * @returns Page type detected and wait time
 */
async function waitForDOMReady(
  page: Page,
  options: WaitForDOMOptions = {}
): Promise<{ pageType: 'spa' | 'static'; waitTime: number }> {
  const startTime = Date.now();
  const {
    strategy = 'auto',
    maxWaitTime = 8000,
    networkSettleTime = 500,
    elementTimeout = 3000,
  } = options;

  let pageType: 'spa' | 'static' = 'static';

  try {
    // Determine page type
    if (strategy === 'auto') {
      pageType = (await detectSPA(page)) ? 'spa' : 'static';
      logger.debug('[DOM_ANALYZER] Auto-detected page type', {
        pageType,
        url: page.url(),
      });
    } else {
      pageType = strategy;
      logger.debug('[DOM_ANALYZER] Using forced strategy', {
        pageType,
        url: page.url(),
      });
    }

    // Apply appropriate wait strategy
    if (pageType === 'spa') {
      await waitForSPAPage(page, {
        maxWaitTime,
        networkSettleTime,
        elementTimeout,
      });
    } else {
      await waitForStaticPage(page);
    }

    const waitTime = Date.now() - startTime;
    return { pageType, waitTime };
  } catch (error) {
    logger.warn('[DOM_ANALYZER] DOM ready wait failed, continuing anyway', {
      error: error instanceof Error ? error.message : String(error),
      url: page.url(),
    });
    const waitTime = Date.now() - startTime;
    return { pageType: 'spa', waitTime }; // ✅ FALLBACK: Assume SPA (safer)
  }
}

/**
 * DOM analysis result
 */
export interface DOMAnalysisResult {
  forms: Array<{
    id?: string;
    action?: string;
    method?: string;
    fields: Array<{
      name: string;
      type: string;
      required: boolean;
      selector: string;
      placeholder?: string;
      value?: string;
    }>;
  }>;
  buttons: Array<{
    text: string;
    selector: string;
    type: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
    inIframe?: boolean; // ✅ NEW: Mark if element is in iframe
  }>;
  links: Array<{
    text: string;
    href: string;
    selector: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
    inIframe?: boolean; // ✅ NEW: Mark if element is in iframe
    download?: string; // ✅ NEW: Download filename if link has download attribute
  }>;
  inputs: Array<{
    type: string;
    name?: string;
    placeholder?: string;
    selector: string;
    required: boolean;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
    inIframe?: boolean; // ✅ NEW: Mark if element is in iframe
    datalist?: string; // ✅ NEW: ID of associated datalist element (for input[list])
  }>;
  checkboxes?: Array<{
    name?: string;
    label?: string;
    selector: string;
    checked: boolean;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
    inIframe?: boolean; // ✅ NEW: Mark if element is in iframe
  }>;
  radios?: Array<{
    name?: string;
    label?: string;
    selector: string;
    checked: boolean;
    value?: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
    inIframe?: boolean; // ✅ NEW: Mark if element is in iframe
  }>;
  interactiveElements?: Array<{
    tag: string;
    text?: string;
    selector: string;
    role?: string;
    tabindex?: number;
    reason: 'onclick' | 'cursor-pointer' | 'tabindex' | 'role';
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
    inIframe?: boolean; // ✅ NEW: Mark if element is in iframe
  }>;
  // ✅ NEW: Hidden but potentially interactive elements (for debug/insights, NOT for test generation)
  hiddenInteractive?: Array<{
    tag: string;
    text?: string;
    selector: string;
    role?: string;
    tabindex?: number;
    reason: 'onclick' | 'tabindex' | 'role' | 'aria-attribute';
    hiddenReason: 'visibility-hidden' | 'display-none' | 'opacity-low' | 'off-screen' | 'pointer-events-none';
    inShadowDOM?: boolean;
    inIframe?: boolean;
  }>;
}

/**
 * Calculate priority score for an element based on selector quality
 * Higher score = more important/stable element
 * Priority: data-testid > data-cy > role > label > text > id > CSS
 */
function calculateElementPriority(element: {
  selector: string;
  [key: string]: any;
}): number {
  const selector = element.selector || '';
  let score = 0;

  // ✅ Priority 1: data-testid (testid="...") - highest priority
  if (selector.startsWith('testid=')) {
    score += 1000;
  }
  // ✅ Priority 2: data-cy ([data-cy="..."]) - test-friendly
  else if (selector.includes('[data-cy=')) {
    score += 900;
  }
  // ✅ Priority 3: role=button[name="..."], role=link, etc. - semantic and stable
  else if (selector.startsWith('role=')) {
    score += 800;
    // Bonus for role with name (more specific)
    if (selector.includes('[name=')) {
      score += 50;
    }
  }
  // ✅ Priority 4: label="..." - accessible and stable
  else if (selector.startsWith('label=')) {
    score += 700;
  }
  // ✅ Priority 5: text="..." - readable but less stable
  else if (selector.startsWith('text=')) {
    score += 600;
  }
  // ✅ Priority 6: ID (#id) - stable but CSS-based
  else if (selector.startsWith('#')) {
    score += 500;
  }
  // ✅ Priority 7: CSS selectors (lowest priority)
  else {
    score += 100;
  }

  // ✅ Bonus: Elements not in Shadow DOM or iframe (more accessible)
  if (!element.inShadowDOM && !element.inIframe) {
    score += 10;
  }

  return score;
}

/**
 * Prioritize and limit elements array
 * Sorts by priority (data-testid > role > label > text > id) before applying limit
 *
 * @returns Prioritized and limited array
 */
function prioritizeAndLimit<T extends { selector: string; [key: string]: any }>(
  elements: T[],
  limit: number
): T[] {
  if (elements.length <= limit) {
    return elements;
  }

  // Sort by priority (highest first)
  const prioritized = [...elements].sort((a, b) => {
    const scoreA = calculateElementPriority(a);
    const scoreB = calculateElementPriority(b);

    // If scores are equal, maintain original order (stable sort)
    if (scoreA === scoreB) {
      return 0;
    }

    return scoreB - scoreA; // Descending order
  });

  // Take top N elements
  const limited = prioritized.slice(0, limit);

  // ✅ DEBUG: Log prioritization stats (only if elements were cut)
  if (elements.length > limit) {
    const highPriorityInLimited = limited.filter(el => {
      const score = calculateElementPriority(el);
      return score >= 800; // data-testid, data-cy, or role
    }).length;

    const highPriorityInOriginal = elements.filter(el => {
      const score = calculateElementPriority(el);
      return score >= 800;
    }).length;

    logger.debug('[DOM_ANALYZER] Element prioritization applied', {
      totalElements: elements.length,
      limitedTo: limit,
      highPriorityInOriginal,
      highPriorityInLimited,
      highPriorityPreserved: highPriorityInLimited === Math.min(highPriorityInOriginal, limit),
    });
  }

  return limited;
}

/**
 * Merge DOM results from main DOM, Shadow DOM, and iframes
 * Removes duplicates using O(1) Set lookup
 * ✅ NEW: Prioritizes elements by selector quality before applying limits
 */
function mergeDOMResults(
  mainDOM: {
    forms: any[];
    buttons: any[];
    links: any[];
    inputs: any[];
    checkboxes?: any[];
    radios?: any[];
    interactiveElements?: any[];
    hiddenInteractive?: any[];
  },
  shadowDOMResult: {
    buttons: any[];
    links: any[];
    inputs: any[];
    checkboxes?: any[];
    radios?: any[];
    interactiveElements?: any[];
    hiddenInteractive?: any[];
  },
  iframeResult: {
    buttons: any[];
    links: any[];
    inputs: any[];
    checkboxes?: any[];
    radios?: any[];
    interactiveElements?: any[];
    forms?: any[];
    hiddenInteractive?: any[];
  }
): DOMAnalysisResult {
  // Create Sets of selectors from main DOM for O(1) deduplication
  const buttonSelectors = new Set(
    mainDOM.buttons
      .map(btn => btn.selector)
      .filter((sel): sel is string => typeof sel === 'string' && sel.length > 0)
  );
  const linkSelectors = new Set(
    mainDOM.links
      .map(link => link.selector)
      .filter((sel): sel is string => typeof sel === 'string' && sel.length > 0)
  );
  const inputSelectors = new Set(
    mainDOM.inputs
      .map(input => input.selector)
      .filter((sel): sel is string => typeof sel === 'string' && sel.length > 0)
  );
  const checkboxSelectors = new Set(
    (mainDOM.checkboxes || [])
      .map(cb => cb.selector)
      .filter((sel): sel is string => typeof sel === 'string' && sel.length > 0)
  );
  const radioSelectors = new Set(
    (mainDOM.radios || [])
      .map(radio => radio.selector)
      .filter((sel): sel is string => typeof sel === 'string' && sel.length > 0)
  );
  const interactiveElementSelectors = new Set(
    (mainDOM.interactiveElements || [])
      .map(el => el.selector)
      .filter((sel): sel is string => typeof sel === 'string' && sel.length > 0)
  );

  // Merge with Shadow DOM and iframe results (O(n) instead of O(n²))
  const allButtons = [
    ...mainDOM.buttons,
    ...(shadowDOMResult?.buttons || []).filter(shadowBtn =>
      shadowBtn?.selector && !buttonSelectors.has(shadowBtn.selector)
    ),
    ...(iframeResult?.buttons || []).filter(iframeBtn =>
      iframeBtn?.selector && !buttonSelectors.has(iframeBtn.selector)
    ),
  ];

  const allLinks = [
    ...mainDOM.links,
    ...(shadowDOMResult?.links || []).filter(shadowLink =>
      shadowLink?.selector && !linkSelectors.has(shadowLink.selector)
    ),
    ...(iframeResult?.links || []).filter(iframeLink =>
      iframeLink?.selector && !linkSelectors.has(iframeLink.selector)
    ),
  ];

  const allInputs = [
    ...mainDOM.inputs,
    ...(shadowDOMResult?.inputs || []).filter(shadowInput =>
      shadowInput?.selector && !inputSelectors.has(shadowInput.selector)
    ),
    ...(iframeResult?.inputs || []).filter(iframeInput =>
      iframeInput?.selector && !inputSelectors.has(iframeInput.selector)
    ),
  ];

  const allCheckboxes = [
    ...(mainDOM.checkboxes || []),
    ...(shadowDOMResult?.checkboxes || []).filter(shadowCb =>
      shadowCb?.selector && !checkboxSelectors.has(shadowCb.selector)
    ),
    ...(iframeResult?.checkboxes || []).filter(iframeCb =>
      iframeCb?.selector && !checkboxSelectors.has(iframeCb.selector)
    ),
  ];

  const allRadios = [
    ...(mainDOM.radios || []),
    ...(shadowDOMResult?.radios || []).filter(shadowRadio =>
      shadowRadio?.selector && !radioSelectors.has(shadowRadio.selector)
    ),
    ...(iframeResult?.radios || []).filter(iframeRadio =>
      iframeRadio?.selector && !radioSelectors.has(iframeRadio.selector)
    ),
  ];

  const allInteractiveElements = [
    ...(mainDOM.interactiveElements || []),
    ...(shadowDOMResult?.interactiveElements || []).filter(shadowEl =>
      shadowEl?.selector && !interactiveElementSelectors.has(shadowEl.selector)
    ),
    ...(iframeResult?.interactiveElements || []).filter(iframeEl =>
      iframeEl?.selector && !interactiveElementSelectors.has(iframeEl.selector)
    ),
  ];

  const allForms = [
    ...mainDOM.forms,
    ...(iframeResult?.forms || []),
  ];

  // ✅ NEW: Prioritize elements by selector quality before applying limits
  // This ensures important elements (data-testid, role, etc.) are not cut off
  return {
    forms: allForms, // Forms don't need prioritization (usually few)
    buttons: prioritizeAndLimit(allButtons, 20),
    links: prioritizeAndLimit(allLinks, 30),
    inputs: prioritizeAndLimit(allInputs, 30),
    checkboxes: allCheckboxes.length > 0 ? prioritizeAndLimit(allCheckboxes, 50) : undefined,
    radios: allRadios.length > 0 ? prioritizeAndLimit(allRadios, 50) : undefined,
    interactiveElements: allInteractiveElements.length > 0 ? prioritizeAndLimit(allInteractiveElements, 30) : undefined,
  };
}

/**
 * Calculate and log DOM analysis metrics
 */
function calculateMetrics(result: DOMAnalysisResult): void {
  const shadowDOMButtons = result.buttons.filter(b => b.inShadowDOM).length;
  const shadowDOMLinks = result.links.filter(l => l.inShadowDOM).length;
  const shadowDOMInputs = result.inputs.filter(i => i.inShadowDOM).length;
  const shadowDOMCheckboxes = result.checkboxes?.filter(c => c.inShadowDOM).length || 0;
  const shadowDOMRadios = result.radios?.filter(r => r.inShadowDOM).length || 0;
  const shadowDOMInteractive = result.interactiveElements?.filter(e => e.inShadowDOM).length || 0;

  const iframeButtons = result.buttons.filter(b => b.inIframe).length;
  const iframeLinks = result.links.filter(l => l.inIframe).length;
  const iframeInputs = result.inputs.filter(i => i.inIframe).length;
  const iframeCheckboxes = result.checkboxes?.filter(c => c.inIframe).length || 0;
  const iframeRadios = result.radios?.filter(r => r.inIframe).length || 0;
  const iframeInteractive = result.interactiveElements?.filter(e => e.inIframe).length || 0;

  // ✅ NEW: Count hidden interactive elements by reason
  const hiddenByReason = {
    'visibility-hidden': result.hiddenInteractive?.filter(h => h.hiddenReason === 'visibility-hidden').length || 0,
    'display-none': result.hiddenInteractive?.filter(h => h.hiddenReason === 'display-none').length || 0,
    'opacity-low': result.hiddenInteractive?.filter(h => h.hiddenReason === 'opacity-low').length || 0,
    'off-screen': result.hiddenInteractive?.filter(h => h.hiddenReason === 'off-screen').length || 0,
    'pointer-events-none': result.hiddenInteractive?.filter(h => h.hiddenReason === 'pointer-events-none').length || 0,
  };

  logger.info('DOM analysis completed', {
    formsCount: result.forms.length,
    buttonsCount: result.buttons.length,
    linksCount: result.links.length,
    inputsCount: result.inputs.length,
    checkboxesCount: result.checkboxes?.length || 0,
    radiosCount: result.radios?.length || 0,
    interactiveElementsCount: result.interactiveElements?.length || 0,
    hiddenInteractiveCount: result.hiddenInteractive?.length || 0, // ✅ NEW: Hidden interactive count
    totalFields: result.forms.reduce((sum, f) => sum + f.fields.length, 0),
    shadowDOMCount: {
      buttons: shadowDOMButtons,
      links: shadowDOMLinks,
      inputs: shadowDOMInputs,
      checkboxes: shadowDOMCheckboxes,
      radios: shadowDOMRadios,
      interactiveElements: shadowDOMInteractive,
      total: shadowDOMButtons + shadowDOMLinks + shadowDOMInputs + shadowDOMCheckboxes + shadowDOMRadios + shadowDOMInteractive,
    },
    iframeCount: {
      buttons: iframeButtons,
      links: iframeLinks,
      inputs: iframeInputs,
      checkboxes: iframeCheckboxes,
      radios: iframeRadios,
      interactiveElements: iframeInteractive,
      total: iframeButtons + iframeLinks + iframeInputs + iframeCheckboxes + iframeRadios + iframeInteractive,
    },
    hiddenInteractiveByReason: hiddenByReason, // ✅ NEW: Breakdown by reason
    visibilityFiltered: true,
    duplicatesHandled: true,
    shadowDOMSupported: true,
    iframeSupported: true,
  });
}

/**
 * Analyze DOM structure and extract interactive elements
 *
 * @param page - Playwright page
 * @param options - Optional wait configuration
 * @returns DOM analysis result
 */
export async function analyzeDOMStructure(
  page: Page,
  options?: WaitForDOMOptions
): Promise<DOMAnalysisResult> {
  try {
    logger.info('Analyzing DOM structure');

    // ✅ NEW: Wait for DOM to be ready (auto-detects SPA vs static)
    const { pageType, waitTime } = await waitForDOMReady(page, options);
    logger.debug('[DOM_ANALYZER] DOM ready, starting analysis', {
      pageType,
      waitTime: `${waitTime}ms`,
      url: page.url(),
    });

    const result = await page.evaluate(() => {
      /**
       * ✅ OPTIMIZED: Cache for getComputedStyle results
       * Prevents multiple expensive calls for the same element
       * Uses WeakMap for automatic garbage collection
       */
      const styleCache = new WeakMap<any, any>();

      /**
       * ✅ OPTIMIZED: Get computed style with caching
       * Returns cached style if available, otherwise computes and caches
       */
      function getCachedComputedStyle(element: any): any {
        if (styleCache.has(element)) {
          return styleCache.get(element);
        }

        try {
          // @ts-expect-error - browser context
          const style = window.getComputedStyle(element);
          styleCache.set(element, style);
          return style;
        } catch (e) {
          // Element might be detached or not in DOM
          return null;
        }
      }

      /**
       * Check if element is visible (not hidden by CSS)
       * ✅ OPTIMIZED: Uses cached computed style
       * ✅ SAFETY: Added error handling for edge cases
       * ✅ FIX: Proper opacity check (numeric, not string)
       * ✅ FIX: Check pointer-events (elements with pointer-events: none are not clickable)
       *
       * Note: This function checks visual visibility. For interactive elements,
       * we also check for event handlers even if element is visually hidden.
       */
      function isVisible(element: any): boolean {
        try {
          const style = getCachedComputedStyle(element);
          if (!style) return false;

          // Check basic visibility properties
          if (style.display === 'none') return false;
          if (style.visibility === 'hidden') return false;

          // ✅ FIX: Check opacity as number (not string comparison)
          // opacity: 0.01 is technically visible but practically invisible
          // We use a threshold of 0.01 to catch truly invisible elements
          const opacity = parseFloat(style.opacity);
          if (isNaN(opacity) || opacity < 0.01) return false;

          // ✅ FIX: Check pointer-events
          // Elements with pointer-events: none cannot be clicked/interacted with
          // Even if they have event handlers, they won't receive pointer events
          if (style.pointerEvents === 'none') return false;

          // Check dimensions
          if (!element || element.offsetWidth <= 0 || element.offsetHeight <= 0) {
            return false;
          }

          return true;
        } catch (e) {
          // Element might be detached or not in DOM
          return false;
        }
      }

      /**
       * Check if element is hidden but potentially interactive
       * Used to collect hidden elements with event handlers for debug/insights
       * ✅ EDGE CASE: Elements with visibility: hidden + opacity: 0.01 + event handlers
       * ✅ EDGE CASE: Elements with display: none but with onclick handlers
       *
       * Returns: { isHidden: boolean, hiddenReason?: string }
       */
      function isHiddenButInteractive(element: any): { isHidden: boolean; hiddenReason?: string } {
        try {
          const style = getCachedComputedStyle(element);
          if (!style) return { isHidden: false };

          // Check if element is hidden
          let isHidden = false;
          let hiddenReason: string | undefined;

          if (style.display === 'none') {
            isHidden = true;
            hiddenReason = 'display-none';
          } else if (style.visibility === 'hidden') {
            isHidden = true;
            hiddenReason = 'visibility-hidden';
          } else {
            const opacity = parseFloat(style.opacity);
            if (!isNaN(opacity) && opacity < 0.05) {
              isHidden = true;
              hiddenReason = 'opacity-low';
            }
          }

          // Check dimensions (off-screen)
          if (!isHidden && (!element || element.offsetWidth <= 0 || element.offsetHeight <= 0)) {
            isHidden = true;
            hiddenReason = 'off-screen';
          }

          // Check pointer-events
          if (!isHidden && style.pointerEvents === 'none') {
            isHidden = true;
            hiddenReason = 'pointer-events-none';
          }

          // If hidden, check if it has interactive properties
          if (isHidden) {
            // Check for event handlers
            // @ts-ignore - browser context
            const hasOnclick = element.onclick || element.hasAttribute('onclick') || element.hasAttribute('data-onclick');

            // Check for data-* attributes
            const hasDataHandler = element.hasAttribute('data-click') ||
                                  element.hasAttribute('data-action') ||
                                  element.hasAttribute('data-handler');

            // Check for tabindex (focusable)
            const tabindex = element.getAttribute('tabindex');
            const hasTabindex = tabindex !== null && parseInt(tabindex) >= 0;

            // Check for ARIA role
            const role = element.getAttribute('role');
            const hasInteractiveRole = role && ['button', 'link', 'menuitem', 'tab', 'option'].includes(role);

            // Check for ARIA attributes
            const hasAriaAttributes = element.hasAttribute('aria-label') ||
                                      element.hasAttribute('aria-labelledby') ||
                                      element.hasAttribute('aria-expanded') ||
                                      element.hasAttribute('aria-pressed');

            // If has any interactive property, return true
            if (hasOnclick || hasDataHandler || hasTabindex || hasInteractiveRole || hasAriaAttributes) {
              return { isHidden: true, hiddenReason };
            }
          }

          return { isHidden: false };
        } catch (e) {
          return { isHidden: false };
        }
      }

      /**
       * Escape special characters for CSS/Playwright selector values
       * Used in: [data-testid="..."], role=button[name="..."], text="...", label="..."
       *
       * ✅ SAFETY: Handles null/undefined
       * ✅ ESCAPES: Quotes, backslashes, and other special characters that could break selectors
       */
      function escapeSelector(text: string | null | undefined): string {
        if (!text || typeof text !== 'string') {
          return ''; // Return empty string for null/undefined
        }

        // Escape backslash first (must be first to avoid double-escaping)
        // Then escape double quotes (used in CSS attribute selectors and Playwright)
        // Also escape newlines, carriage returns, tabs (can break selectors)
        return text
          .replace(/\\/g, '\\\\')  // Escape backslash first
          .replace(/"/g, '\\"')    // Escape double quotes
          .replace(/\n/g, '\\n')   // Escape newlines
          .replace(/\r/g, '\\r')   // Escape carriage returns
          .replace(/\t/g, '\\t');  // Escape tabs
      }

      /**
       * ✅ NEW: Escape CSS identifier for use in attribute selectors
       * Used in: label[for="${id}"], input[name="${name}"]
       * Prevents CSS selector injection attacks
       * Uses CSS.escape() if available, otherwise manual escaping
       */
      function escapeCSSIdentifier(id: string | null | undefined): string {
        if (!id || typeof id !== 'string') {
          return '';
        }

        // ✅ OPTIMIZED: Use native CSS.escape() if available (browser standard)
        // @ts-expect-error - browser context (CSS.escape is a standard API)
        if (typeof CSS !== 'undefined' && CSS.escape) {
          try {
            // @ts-expect-error - browser context
            return CSS.escape(id);
          } catch {
            // Fallback to manual escaping if CSS.escape fails
          }
        }

        // ✅ FALLBACK: Manual escaping for CSS identifiers
        // Escape special characters: ", ', ], \, and other control characters
        return id
          .replace(/\\/g, '\\\\')  // Escape backslash first
          .replace(/"/g, '\\"')    // Escape double quotes
          .replace(/'/g, "\\'")    // Escape single quotes
          .replace(/\]/g, '\\]')   // Escape closing bracket
          .replace(/\[/g, '\\[')   // Escape opening bracket (for safety)
          .replace(/\n/g, '\\n')   // Escape newlines
          .replace(/\r/g, '\\r')   // Escape carriage returns
          .replace(/\t/g, '\\t');  // Escape tabs
      }

      /**
       * Check if class looks like dynamic/generated (CSS-in-JS)
       * Used to filter out unstable classes when creating unique selectors
       *
       * ✅ Coverage: ~95% of modern CSS-in-JS patterns
       * Covers:
       * - styled-components, emotion, styled-jsx, JSS, Linaria
       * - CSS Modules, Tailwind CSS, Atomic CSS (Stylex)
       * - Vanilla Extract, Panda CSS, Stitches, Compiled
       * - Generic utility classes and hashes
       */
      function isDynamicClass(className: string): boolean {
        if (!className || className.length === 0) return true;

        // 1. CSS-in-JS library prefixes (styled-components, emotion, JSS, etc.)
        // Matches: sc-*, css-*, jsx-*, emotion-*, jss-*, linaria-*, makeStyles_*, _*
        if (/^(css-|sc-|jsx-|emotion-|jss-|linaria-|makeStyles|makeVars|_)/.test(className)) {
          return true;
        }

        // 2. Atomic CSS / Stylex (Facebook)
        // Matches: x1abc123, x1a2b3c4d (starts with 'x' + digit + hash)
        if (/^x\d[a-z0-9]{5,}$/i.test(className)) {
          return true;
        }

        // 3. Tailwind CSS modifiers (pseudo-classes, responsive, dark mode)
        // Matches: hover:*, focus:*, dark:*, md:*, lg:*, etc.
        if (/:/.test(className)) {
          return true;
        }

        // 4. Tailwind/Atomic utility classes (very short, generic)
        // Matches: p-4, m-2, flex, grid, etc. (1-4 chars, or pattern like "p-4")
        if (/^[a-z]{1,4}(-[a-z0-9]+)?$/i.test(className) && className.length < 8) {
          return true;
        }

        // 5. CSS Modules pattern: [name]__[local]--[hash]
        // Matches: Button__root, component__element, Button--abc123
        if (/__/.test(className) || (/.+--[a-f0-9]{4,}$/i.test(className))) {
          return true;
        }

        // 6. Generic state/utility classes (too common, not unique)
        // Common in Bootstrap, Material-UI, Ant Design, etc.
        if (/^(btn|button|input|form|card|badge|alert|modal|active|focus|hover|disabled|selected|checked|open|closed|visible|hidden|show|hide|error|success|warning|info|primary|secondary|tertiary|danger|light|dark)$/i.test(className)) {
          return true;
        }

        // 7. Hex hash patterns (6+ hex characters = likely generated)
        // Matches: abc123, 1a2b3c4d, a1b2c3d4e5f6
        if (/^[a-f0-9]{6,}$/i.test(className)) {
          return true;
        }

        // 8. Base64-like hash patterns (long alphanumeric with separators)
        // Matches: abc123-def456, a1b2_c3d4, etc.
        if (/^[a-z0-9_-]{12,}$/i.test(className) && /[0-9]/.test(className) && /[a-f]/i.test(className)) {
          return true;
        }

        // 9. Very long class names (>30 chars) = likely generated
        // Note: BEM-like classes are usually <30 chars
        if (className.length > 30) {
          return true;
        }

        // 10. Classes with special chars (spaces, brackets, etc.) = invalid/dynamic
        // Matches: "class with spaces", "[class]", etc.
        if (/[\s\[\]{}()]/.test(className)) {
          return true;
        }

        return false;
      }

      /**
       * ✅ Generate Playwright API selector (minimal CSS - only data-cy and #id fallback)
       * Priority: testid= > data-cy > getByRole > getByLabel > getByText > ID (via role=)
       * Format: testid="login", role=button[name="Login"], text="Login", label="Email", [data-cy="..."]
       * ✅ REMOVED: CSS class selectors, nth-of-type, tag-only (unstable)
       * ✅ OPTIMIZED: data-testid uses Playwright API (testid=) instead of CSS
       * Uses closure to access selectorCounts (no need to pass as parameter)
       */
      /**
       * ✅ IMPROVED: Normalize whitespace in text content
       * Removes multiple spaces, tabs, newlines and trims
       */
      function normalizeText(text: string | null | undefined): string {
        if (!text) return '';
        return text.trim().replace(/\s+/g, ' ');
      }

      /**
       * ✅ IMPROVED: Get accessible name for element
       * Follows ARIA specification priority order
       * Returns null if no accessible name found
       */
      function getAccessibleName(element: any, root: any): string | null {
        // 1. aria-labelledby (highest priority)
        if (element.hasAttribute('aria-labelledby')) {
          const ids = element.getAttribute('aria-labelledby').trim().split(/\s+/);
          const labels: string[] = [];
          for (const id of ids) {
            try {
              const escapedId = escapeCSSIdentifier(id);
              if (escapedId) {
                const labelEl = root.querySelector(`#${escapedId}`);
                if (labelEl) {
                  const labelText = normalizeText(labelEl.textContent);
                  if (labelText) labels.push(labelText);
                }
              }
            } catch {
              // Invalid selector, skip
            }
          }
          if (labels.length > 0) {
            return labels.join(' ');
          }
        }

        // 2. aria-label
        if (element.hasAttribute('aria-label')) {
          const ariaLabel = normalizeText(element.getAttribute('aria-label'));
          if (ariaLabel) return ariaLabel;
        }

        // 3. label[for] (for form elements)
        if (element.id && (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT')) {
          try {
            const escapedId = escapeCSSIdentifier(element.id);
            if (escapedId) {
              const labelEl = root.querySelector(`label[for="${escapedId}"]`);
              if (labelEl) {
                const labelText = normalizeText(labelEl.textContent);
                if (labelText) return labelText;
              }
            }
          } catch {
            // Invalid selector, skip
          }
        }

        // 4. Parent <label> element
        if (element.parentElement?.tagName === 'LABEL') {
          // Clone label and remove input to get clean text
          const labelClone = element.parentElement.cloneNode(true) as any;
          const inputInLabel = labelClone.querySelector('input, select, textarea');
          if (inputInLabel) inputInLabel.remove();
          const labelText = normalizeText(labelClone.textContent);
          if (labelText) return labelText;
        }

        // 5. title attribute
        if (element.hasAttribute('title')) {
          const title = normalizeText(element.getAttribute('title'));
          if (title) return title;
        }

        // 6. alt attribute (for img, area)
        if (element.hasAttribute('alt')) {
          const alt = normalizeText(element.getAttribute('alt'));
          if (alt) return alt;
        }

        // 7. placeholder (for inputs)
        if (element.hasAttribute('placeholder')) {
          const placeholder = normalizeText(element.getAttribute('placeholder'));
          if (placeholder) return placeholder;
        }

        // 8. SVG <title> element (first child)
        if (element.tagName === 'svg') {
          const titleEl = element.querySelector('title');
          if (titleEl) {
            const titleText = normalizeText(titleEl.textContent);
            if (titleText) return titleText;
          }
        }

        // 9. innerText (visible text only, excludes hidden elements)
        // Fallback to textContent if innerText not available
        try {
          const visibleText = normalizeText(element.innerText || element.textContent);
          if (visibleText) return visibleText;
        } catch {
          // innerText might throw in some contexts
          const textContent = normalizeText(element.textContent);
          if (textContent) return textContent;
        }

        return null;
      }

      function generateSelector(element: any, root?: any): string {
        // ✅ FIX: Skip hidden inputs (type="hidden")
        if (element.tagName === 'INPUT' && element.type === 'hidden') {
          return ''; // Hidden inputs should not be selected
        }

        // ✅ FIX: Get root document from element if not provided
        // element.ownerDocument works in both main DOM and Shadow DOM
        const rootDoc = root || element.ownerDocument || element.getRootNode?.() || element;

        // ✅ OPTIMIZED: Use Playwright API for data-testid (better than CSS)
        if (element.hasAttribute('data-testid')) {
          return `testid="${escapeSelector(element.getAttribute('data-testid'))}"`;
        }
        // data-cy: Keep CSS (Playwright doesn't have getByCy API)
        if (element.hasAttribute('data-cy')) {
          return `[data-cy="${escapeSelector(element.getAttribute('data-cy'))}"]`;
        }

        // ✅ IMPROVED: Try getByRole with accessible name (best practice for accessibility)
        // Detect implicit ARIA roles from HTML elements
        const implicitRole = getImplicitRole(element);
        if (implicitRole) {
          // ✅ FIX: Use getAccessibleName instead of just textContent
          const accessibleName = getAccessibleName(element, rootDoc);
          // Use role with name if accessible name is available and reasonable length
          if (accessibleName && accessibleName.length > 0 && accessibleName.length < 50) {
            return `role=${implicitRole}[name="${escapeSelector(accessibleName)}"]`;
          }
          // Use role without name (less specific, but still good)
          return makeUnique(`role=${implicitRole}`, element);
        }

        // Try ID - convert to role= if element has implicit role (better than CSS)
        // Note: implicitRole already checked above, so if we're here, element has no implicit role
        if (element.id && element.id.length > 0) {
          // If no implicit role, fallback to ID (CSS, but stable)
          return `#${element.id}`;
        }

        // ✅ IMPROVED: Try getByLabel for inputs (accessibility-first)
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
          // ✅ FIX: Use getAccessibleName for comprehensive label lookup
          const accessibleName = getAccessibleName(element, rootDoc);
          if (accessibleName && accessibleName.length > 0 && accessibleName.length < 50) {
            return `label="${escapeSelector(accessibleName)}"`;
          }

          // Fallback: Try name attribute - use as label (Playwright, not CSS)
          if (element.hasAttribute('name')) {
            const name = element.getAttribute('name');
            if (name && name.length > 0) {
              // Use label= instead of input[name="..."] for better stability
              return `label="${escapeSelector(name)}"`;
            }
          }
        }

        // ✅ IMPROVED: Try getByText for buttons/links (Playwright API format)
        if (element.tagName === 'BUTTON' || element.tagName === 'A') {
          // ✅ FIX: Use getAccessibleName for comprehensive text lookup
          const accessibleName = getAccessibleName(element, rootDoc);
          if (accessibleName && accessibleName.length > 0 && accessibleName.length < 50) {
            return `text="${escapeSelector(accessibleName)}"`;
          }
        }

        // ✅ NEW: Handle SVG elements with aria-label or title
        if (element.tagName === 'svg' || element.tagName?.toLowerCase() === 'svg') {
          const accessibleName = getAccessibleName(element, rootDoc);
          if (accessibleName && accessibleName.length > 0 && accessibleName.length < 50) {
            // SVG with role should use role selector
            if (element.hasAttribute('role')) {
              const role = element.getAttribute('role');
              return `role=${role}[name="${escapeSelector(accessibleName)}"]`;
            }
            // Otherwise use text selector
            return `text="${escapeSelector(accessibleName)}"`;
          }
        }

        // ✅ NEW: Handle custom elements (Web Components)
        // Custom elements have hyphen in tag name (e.g., my-button)
        if (element.tagName && element.tagName.includes('-')) {
          const accessibleName = getAccessibleName(element, rootDoc);
          if (accessibleName && accessibleName.length > 0 && accessibleName.length < 50) {
            // If has role, use role selector
            if (element.hasAttribute('role')) {
              const role = element.getAttribute('role');
              return `role=${role}[name="${escapeSelector(accessibleName)}"]`;
            }
            // Otherwise use text selector
            return `text="${escapeSelector(accessibleName)}"`;
          }
        }

        // ✅ REMOVED: Class-based CSS selectors (unstable)
        // ✅ REMOVED: nth-of-type CSS selectors (unstable)
        // ✅ REMOVED: Tag-only selectors (too generic)

        // Final fallback: implicitRole already checked above, so if we're here, element has no role
        // Return empty - element cannot be reliably selected

        // Last resort: return empty (element cannot be reliably selected)
        // This will be handled by the caller
        return '';
      }

      /**
       * ✅ NEW: Get implicit ARIA role from HTML element
       * Maps HTML elements to their implicit ARIA roles
       * https://www.w3.org/TR/html-aria/#docconformance
       */
      function getImplicitRole(element: any): string | null {
        const tag = element.tagName.toLowerCase();

        // Explicit role attribute takes precedence
        if (element.hasAttribute('role')) {
          return element.getAttribute('role');
        }

        // Map HTML elements to implicit roles
        switch (tag) {
          case 'button':
            return 'button';
          case 'a':
            return element.hasAttribute('href') ? 'link' : null;
          case 'input':
            const inputType = (element.getAttribute('type') || 'text').toLowerCase();
            switch (inputType) {
              case 'button':
              case 'submit':
              case 'reset':
              case 'image': // ✅ NEW: input[type="image"] acts as button
                return 'button';
              case 'checkbox':
                return 'checkbox';
              case 'radio':
                return 'radio';
              case 'range':
                return 'slider';
              case 'text':
              case 'email':
              case 'tel':
              case 'url':
              case 'search':
              case 'password': // ✅ NEW: password input is textbox
              case 'number': // ✅ NEW: number input is spinbutton (but textbox is more common)
              case 'date': // ✅ NEW: date inputs are textbox-like
              case 'datetime-local':
              case 'time':
              case 'week':
              case 'month':
              case 'color': // ✅ NEW: color picker is textbox-like
                return 'textbox';
              case 'file': // ✅ NEW: file input has no standard role, but can be selected
                return null; // No implicit role, but still interactive
              case 'hidden': // ✅ NEW: hidden inputs should not be selected
                return null;
              default:
                return null;
            }
          case 'textarea':
            return 'textbox';
          case 'select':
            return element.hasAttribute('multiple') ? 'listbox' : 'combobox';
          case 'img':
            return element.hasAttribute('alt') ? 'img' : null;
          case 'nav':
            return 'navigation';
          case 'main':
            return 'main';
          case 'header':
            return 'banner';
          case 'footer':
            return 'contentinfo';
          case 'aside':
            return 'complementary';
          case 'form':
            return 'form';
          case 'dialog':
            return 'dialog';
          // ✅ NEW: HTML5 form elements
          case 'output':
            return 'status'; // Output displays form calculation results
          case 'meter':
            return 'meter'; // Meter shows a scalar measurement
          case 'progress':
            return 'progressbar'; // Progress shows completion status
          case 'fieldset':
            return 'group'; // Fieldset groups form controls
          case 'datalist':
            return null; // Datalist is not interactive itself, but used by input[list]
          case 'legend':
            return null; // Legend is descriptive text for fieldset
          // ✅ NEW: HTML5 interactive elements
          case 'menu':
            return 'menu';
          case 'menuitem':
            return 'menuitem';
          // ✅ NEW: Media elements
          case 'embed':
          case 'object':
            return null; // Embed/object can be interactive but no standard role
          case 'area':
            return 'link'; // Area in map acts like a link
          case 'map':
            return null; // Map container itself is not interactive
          case 'track':
          case 'source':
            return null; // Track/source are not directly interactive
          case 'h1':
          case 'h2':
          case 'h3':
          case 'h4':
          case 'h5':
          case 'h6':
            return 'heading';
          case 'ul':
          case 'ol':
            return 'list';
          case 'li':
            return 'listitem';
          case 'table':
            return 'table';
          case 'tr':
            return 'row';
          case 'td':
            return 'cell';
          case 'th':
            return 'columnheader';
          // ✅ NEW: Additional semantic elements
          case 'article':
            return 'article';
          case 'section':
            return 'region'; // section with accessible name becomes region
          case 'search':
            return 'search'; // HTML5 search element
          case 'figure':
            return 'figure';
          case 'details':
            return 'group'; // details is a disclosure widget
          case 'summary':
            return 'button'; // summary acts as a button to toggle details
          // ✅ NEW: Media elements with controls
          case 'video':
          case 'audio':
            return null; // No implicit role unless controls attribute present
          // ✅ NEW: Canvas and iframe
          case 'canvas':
            return null; // Canvas has no implicit role
          case 'iframe':
            return null; // Iframe has no implicit role (but can be selected)
          default:
            return null;
        }
      }

      /**
       * Make selector unique by adding parent context if duplicate
       * ✅ FIX: Playwright doesn't support :nth() in CSS selector
       * Instead, we use more specific selector with parent context
       * Uses closure to access selectorCounts (no need to pass as parameter)
       * ✅ IMPROVED: Escapes CSS identifiers, handles ShadowRoot, validates parent
       */
      function makeUnique(selector: string, element?: any): string {
        const count = selectorCounts.get(selector) || 0;
        selectorCounts.set(selector, count + 1);

        // If we've seen this selector before, try to make it more specific
        if (count > 0 && element) {
          // ✅ FIX: Get parent element, but skip ShadowRoot and Document
          let parent = element.parentElement;

          // ✅ FIX: Skip ShadowRoot (parentElement can be ShadowRoot)
          // ShadowRoot doesn't have id, className, or tagName
          if (parent && parent.nodeType === 11) { // Node.SHADOW_ROOT = 11
            // Try to get shadow host instead
            parent = parent.host || null;
          }

          // ✅ FIX: Skip Document and DocumentFragment
          if (parent && (parent.nodeType === 9 || parent.nodeType === 11)) { // Document = 9, DocumentFragment = 11
            parent = null;
          }

          if (parent && parent.tagName) {
            // ✅ FIX: Try parent ID (with proper escaping)
            if (parent.id) {
              const escapedId = escapeCSSIdentifier(parent.id);
              if (escapedId) {
                return `#${escapedId} > ${selector}`;
            }
            }

            // ✅ FIX: Try parent class (first meaningful class, with proper escaping)
            if (parent.className && typeof parent.className === 'string') {
              const classes = parent.className.split(/\s+/).filter((c: string) => {
                const trimmed = c.trim();
                return trimmed && !isDynamicClass(trimmed);
              });

              if (classes.length > 0 && classes.length < 3) {
                const escapedClass = escapeCSSIdentifier(classes[0]);
                if (escapedClass) {
                  return `.${escapedClass} > ${selector}`;
                }
              }
            }

            // ✅ FIX: Try parent tag (skip body, html, and invalid tags)
            const parentTag = parent.tagName?.toLowerCase();
            if (parentTag && parentTag !== 'body' && parentTag !== 'html' && /^[a-z][a-z0-9]*$/i.test(parentTag)) {
              return `${parentTag} > ${selector}`;
            }
          }

          // Fallback: return base selector (Playwright will use .first() or .nth() method)
          // This is better than invalid :nth() in selector string
          return selector;
        }

        return selector;
      }

      /**
       * ✅ NEW: Generate selector for element in Shadow DOM
       * For Shadow DOM elements, we need to use Playwright syntax: parent >> child
       */
      function generateShadowSelector(
        element: any,
        shadowHost: any,
        shadowRoot?: any
      ): string {
        // First, generate selector for the shadow host (parent)
        // Use shadowHost.ownerDocument to get the main document
        const hostSelector = generateSelector(shadowHost, shadowHost.ownerDocument || shadowHost.getRootNode?.());

        // ✅ FIX: If host selector is empty, cannot create reliable Shadow DOM selector
        if (!hostSelector || hostSelector.trim().length === 0) {
          return '';
        }

        // Then, generate selector for the element inside shadow
        const elementSelector = generateSelector(element, shadowRoot || shadowHost.shadowRoot);

        // ✅ FIX: If element selector is empty, cannot create reliable Shadow DOM selector
        if (!elementSelector || elementSelector.trim().length === 0) {
          return '';
        }

        // Use Playwright syntax for Shadow DOM: parent >> child
        return `${hostSelector} >> ${elementSelector}`;
      }

      /**
       * ✅ NEW: Generate selector for element in iframe
       * For iframe elements, we need to use Playwright syntax: iframe >> element
       * Priority: name > id > title > src (partial match) > data-testid > nth-of-type
       *
       * Edge cases covered:
       * - Same-origin iframes ✅
       * - Cross-origin iframes (handled by caller) ✅
       * - srcdoc iframes (no src, use name/id/title) ✅
       * - Sandboxed iframes ✅
       * - Multiple iframes without identifiers (nth-of-type fallback) ✅
       */
      function generateIframeSelector(
        element: any,
        iframeElement: any,
        iframeDocument?: any
      ): string {
        // Generate selector for iframe element
        let iframeSelector = 'iframe';

        // Priority 1: Use name attribute (most reliable for Playwright)
        if (iframeElement.name && iframeElement.name.trim()) {
          iframeSelector = `iframe[name="${escapeSelector(iframeElement.name.trim())}"]`;
        }
        // Priority 2: Use id attribute
        else if (iframeElement.id && iframeElement.id.trim()) {
          iframeSelector = `iframe#${escapeSelector(iframeElement.id.trim())}`;
        }
        // Priority 3: Use title attribute (accessibility, also useful for Playwright)
        else if (iframeElement.title && iframeElement.title.trim()) {
          iframeSelector = `iframe[title="${escapeSelector(iframeElement.title.trim())}"]`;
        }
        // Priority 4: Use data-testid or data-cy (testing attributes)
        else if (iframeElement.getAttribute('data-testid')) {
          const testId = iframeElement.getAttribute('data-testid').trim();
          if (testId) {
            iframeSelector = `iframe[data-testid="${escapeSelector(testId)}"]`;
          }
        } else if (iframeElement.getAttribute('data-cy')) {
          const cyId = iframeElement.getAttribute('data-cy').trim();
          if (cyId) {
            iframeSelector = `iframe[data-cy="${escapeSelector(cyId)}"]`;
          }
        }
        // Priority 5: Use src attribute (partial match)
        else if (iframeElement.src) {
          try {
            // Handle srcdoc (inline content) - skip src matching
            if (iframeElement.src.startsWith('data:') || iframeElement.src.startsWith('about:')) {
              // For data: or about: URLs, try to use parent context or nth-of-type
              // This is a fallback case
              iframeSelector = 'iframe';
            } else {
              // ✅ FIX: Handle relative URLs by using current document's base URL
              try {
                // Extract meaningful part of URL (domain or path)
                // ✅ FIX: Use current document's base URL for relative URLs
                // @ts-expect-error - browser context (document is available)
                const baseURL = document.baseURI || window.location.href;
                const url = new URL(iframeElement.src, baseURL);

                // Try pathname first (more specific)
                let srcPart = url.pathname.split('/').filter(Boolean).pop();
                // If pathname is empty or too generic, use hostname
                if (!srcPart || srcPart.length < 3) {
                  srcPart = url.hostname.split('.').slice(-2).join('.');
                }
                // Use domain if pathname is too long
                if (srcPart && srcPart.length < 50 && srcPart.length > 2) {
                  iframeSelector = `iframe[src*="${escapeSelector(srcPart)}"]`;
                } else {
                  // Fallback to generic iframe
                  iframeSelector = 'iframe';
                }
              } catch {
                // Invalid URL or relative URL without resolvable base, use generic iframe
                iframeSelector = 'iframe';
              }
            }
          } catch {
            // Invalid URL (e.g., relative URL without base), use generic iframe
            iframeSelector = 'iframe';
          }
        }
        // Priority 6: Fallback - use nth-of-type if multiple iframes exist
        // Note: This is less stable but better than nothing
        // The caller should handle this case by using more specific parent context

        // Generate selector for element inside iframe
        const elementSelector = generateSelector(element, iframeDocument || iframeElement.contentDocument);

        // ✅ FIX: If element selector is empty, cannot create reliable iframe selector
        if (!elementSelector || elementSelector.trim().length === 0) {
          return '';
        }

        // Use Playwright syntax for iframe: iframe >> element
        return `${iframeSelector} >> ${elementSelector}`;
      }

      /**
       * ✅ FIX: Create visited Set and selectorCounts Map in closure
       * Set and Map cannot be serialized when passed as parameters to page.evaluate()
       * Using closure ensures they exist in browser context and are shared across recursive calls
       */
      const visited = new Set<any>();
      const visitedDocuments = new Set<any>(); // ✅ NEW: Track visited documents to prevent iframe cycles
      const selectorCounts = new Map<string, number>();

      /**
       * ✅ NEW: Unified element classification and collection
       * Classifies an element and adds it to the appropriate result array
       * This eliminates code duplication between main DOM, Shadow DOM, and iframes
       *
       * @param element - DOM element to classify
       * @param result - Result object to add element to
       * @param context - Context info (shadowHost, iframe, etc.)
       */
      function classifyAndCollectElement(
        element: any,
        result: {
        buttons: any[];
        links: any[];
        inputs: any[];
        checkboxes: any[];
        radios: any[];
        interactiveElements: any[];
          forms?: any[];
          hiddenInteractive?: any[];
        },
        context: {
          shadowHost?: any;
          iframe?: any;
          root?: any; // Document | ShadowRoot
          formsMap?: Map<any, any>; // ✅ Map for matching fields to forms
        } = {}
      ): void {
        const { shadowHost, iframe, root, formsMap } = context;
        const tag = element.tagName.toLowerCase();
        const hiddenCheck = isHiddenButInteractive(element);
        const elementVisible = isVisible(element);

        // Skip if not visible AND not hidden-interactive
        if (!elementVisible && !hiddenCheck.isHidden) return;

        // Helper to generate selector based on context
        const getSelector = (el: any) => {
          let selector: string;
          if (iframe) {
            selector = generateIframeSelector(el, iframe, root);
          } else if (shadowHost) {
            selector = generateShadowSelector(el, shadowHost, root);
          } else {
            selector = generateSelector(el, root);
          }

          // ✅ FIX: Return empty selector if invalid (caller should handle)
          // Empty selector means element cannot be reliably selected
          return selector || '';
        };

        // ✅ 1. Collect buttons
          if ((tag === 'button' ||
               (tag === 'input' && (element.type === 'submit' || element.type === 'button')) ||
               element.getAttribute('role') === 'button') &&
              element.textContent?.trim()) {
            const selector = getSelector(element);
            // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
            if (!selector || selector.trim().length === 0) {
              return; // Skip this element - cannot generate reliable selector
            }
            result.buttons.push({
              text: element.textContent?.trim() || element.value || element.getAttribute('aria-label') || '',
            selector,
              type: element.type || element.getAttribute('role') || 'button',
              inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
            });
          return; // Element classified, skip further checks
          }

        // ✅ 2. Collect links (including area elements in image maps)
          if ((tag === 'a' && element.href &&
              !element.href.startsWith('#') &&
              !element.href.startsWith('javascript:') &&
              element.textContent?.trim()) ||
              (tag === 'area' && element.href && !element.href.startsWith('#') && !element.href.startsWith('javascript:'))) {
            const selector = getSelector(element);
            // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
            if (!selector || selector.trim().length === 0) {
              return; // Skip this element - cannot generate reliable selector
            }
            // ✅ NEW: Check for download attribute (indicates file download link)
            const hasDownload = element.hasAttribute('download');
            const downloadName = hasDownload ? (element.getAttribute('download') || 'file') : undefined;

            result.links.push({
              text: element.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('alt') || element.getAttribute('title') || '',
              href: element.href,
            selector,
              inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
            // ✅ NEW: Include download info if present
            download: hasDownload ? downloadName : undefined,
            });
          return; // Element classified, skip further checks
          }

        // ✅ 3. Collect inputs (including select, textarea)
          if (tag === 'input' || tag === 'select' || tag === 'textarea') {
          const inputType = element.type || tag;

          // ✅ 3a. Checkboxes
          if (inputType === 'checkbox') {
              let label: string | undefined;
              const id = element.id;
            if (id && root) {
                try {
                  // ✅ FIX: Escape CSS identifier to prevent selector injection
                  const escapedId = escapeCSSIdentifier(id);
                  if (escapedId) {
                    const labelEl = root.querySelector(`label[for="${escapedId}"]`);
                  if (labelEl) {
                    label = labelEl.textContent?.trim() || undefined;
                  }
                  }
                } catch {
                  // Selector might be invalid, skip label lookup
                }
              }
            if (!label && element.parentElement?.tagName === 'LABEL') {
              label = element.parentElement.textContent?.trim().replace(element.value || '', '').trim() || undefined;
              }

          const selector = getSelector(element);
          // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
          if (!selector || selector.trim().length === 0) {
            return; // Skip this element - cannot generate reliable selector
          }
          const checkboxData = {
                name: element.name || element.id || undefined,
                label: label || element.getAttribute('aria-label') || undefined,
            selector,
                checked: element.checked,
                inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          };
          result.checkboxes.push(checkboxData);

          // ✅ OPTIMIZED: Match checkbox to its parent form using element.form
          // @ts-ignore - element.form is a standard property
          const parentForm = element.form;
          if (parentForm && formsMap) {
            // ✅ FIX: Create form in formsMap if it doesn't exist yet (input processed before form)
            if (!formsMap.has(parentForm)) {
              const formData = {
                id: parentForm.id || undefined,
                action: parentForm.action || undefined,
                method: parentForm.method || 'get',
                fields: [] as any[],
              };
              formsMap.set(parentForm, formData);
              if (!result.forms) result.forms = [];
              result.forms.push(formData);
            }

            const formData = formsMap.get(parentForm);
            if (formData) {
              formData.fields.push({
                name: checkboxData.name || '',
                type: 'checkbox',
                required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
                selector: checkboxData.selector,
                placeholder: undefined,
                value: element.value || undefined,
              });
            }
          }

          return; // Element classified
          }

          // ✅ 3b. Radio buttons
          if (inputType === 'radio') {
              let label: string | undefined;
              const id = element.id;
            if (id && root) {
                try {
                  // ✅ FIX: Escape CSS identifier to prevent selector injection
                  const escapedId = escapeCSSIdentifier(id);
                  if (escapedId) {
                    const labelEl = root.querySelector(`label[for="${escapedId}"]`);
                  if (labelEl) {
                    label = labelEl.textContent?.trim() || undefined;
                  }
                  }
                } catch {
                  // Selector might be invalid, skip label lookup
                }
              }
            if (!label && element.parentElement?.tagName === 'LABEL') {
              label = element.parentElement.textContent?.trim().replace(element.value || '', '').trim() || undefined;
              }

          const selector = getSelector(element);
          // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
          if (!selector || selector.trim().length === 0) {
            return; // Skip this element - cannot generate reliable selector
          }
          const radioData = {
                name: element.name || undefined,
                label: label || element.getAttribute('aria-label') || undefined,
            selector,
                checked: element.checked,
                value: element.value || undefined,
                inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          };
          result.radios.push(radioData);

          // ✅ OPTIMIZED: Match radio to its parent form using element.form
          // @ts-ignore - element.form is a standard property
          const parentForm = element.form;
          if (parentForm && formsMap) {
            // ✅ FIX: Create form in formsMap if it doesn't exist yet (input processed before form)
            if (!formsMap.has(parentForm)) {
              const formData = {
                id: parentForm.id || undefined,
                action: parentForm.action || undefined,
                method: parentForm.method || 'get',
                fields: [] as any[],
              };
              formsMap.set(parentForm, formData);
              if (!result.forms) result.forms = [];
              result.forms.push(formData);
            }

            const formData = formsMap.get(parentForm);
            if (formData) {
              formData.fields.push({
                name: radioData.name || '',
                type: 'radio',
                required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
                selector: radioData.selector,
                placeholder: undefined,
                value: radioData.value,
              });
            }
          }

          return; // Element classified
          }

          // ✅ 3c. Other inputs (text, email, password, select, textarea, etc.)
          const selector = getSelector(element);
          // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
          if (!selector || selector.trim().length === 0) {
            return; // Skip this element - cannot generate reliable selector
          }

          // ✅ NEW: Check for datalist relationship (input[list] attribute)
          let datalistId: string | undefined;
          if (element.hasAttribute('list') && root) {
            const listId = element.getAttribute('list');
            if (listId) {
              try {
                const escapedListId = escapeCSSIdentifier(listId);
                if (escapedListId) {
                  const datalistEl = root.querySelector(`datalist#${escapedListId}`);
                  if (datalistEl) {
                    datalistId = listId;
                  }
                }
              } catch {
                // Selector might be invalid, skip datalist lookup
              }
            }
          }

          const inputData = {
            type: inputType,
                name: element.name || element.id || undefined,
                placeholder: element.getAttribute('placeholder') || undefined,
            selector,
                required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
                inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
            // ✅ NEW: Include datalist reference if present
            datalist: datalistId,
          };
          result.inputs.push(inputData);

          // ✅ OPTIMIZED: Match input to its parent form using element.form (no querySelectorAll)
          // element.form property automatically points to the form containing this input
          // @ts-ignore - element.form is a standard property
          const parentForm = element.form;
          if (parentForm && formsMap) {
            // ✅ FIX: Create form in formsMap if it doesn't exist yet (input processed before form)
            // This handles the case where input is processed before its parent form element
            if (!formsMap.has(parentForm)) {
              const formData = {
                id: parentForm.id || undefined,
                action: parentForm.action || undefined,
                method: parentForm.method || 'get',
                fields: [] as any[],
              };
              formsMap.set(parentForm, formData);
              if (!result.forms) result.forms = [];
              result.forms.push(formData);
            }

            const formData = formsMap.get(parentForm);
            if (formData) {
              formData.fields.push({
                name: inputData.name || '',
                type: inputData.type,
                required: inputData.required,
                selector: inputData.selector,
                placeholder: inputData.placeholder,
                value: element.value || undefined,
              });
            }
          }

          return; // Element classified
        }

        // ✅ 4. Collect forms (only in main DOM and iframes, not Shadow DOM)
        // ✅ OPTIMIZED: Store form reference in Map for later field matching
        // Fields will be matched using element.form property (no querySelectorAll needed)
        if (tag === 'form' && !shadowHost) {
          const formData = {
            id: element.id || undefined,
            action: element.action || undefined,
            method: element.method || 'get',
            fields: [] as any[],
          };
          if (formsMap) {
            formsMap.set(element, formData);
          }
          if (!result.forms) result.forms = [];
          result.forms.push(formData);
          return; // Element classified
        }

        // ✅ 4a. Collect datalist elements (used by input[list])
        // Note: datalist itself is not interactive, but we track it for input[list] relationships
        if (tag === 'datalist') {
          // Datalist is not directly interactive, but we can track it
          // Input elements with list attribute will reference this datalist
          // We don't need to add it to any result array, but we can log it for debugging
          return; // Element classified (not interactive itself)
        }

        // ✅ 4b. Collect output elements (form calculation results)
        if (tag === 'output') {
          const selector = getSelector(element);
          if (!selector || selector.trim().length === 0) {
            return; // Skip if no selector
          }
          // Output displays form calculation results - treat as interactive element
          const text = element.textContent?.trim() || element.getAttribute('aria-label') || element.getAttribute('for') || '';
          result.interactiveElements.push({
            tag,
            text: text.substring(0, 100),
            selector,
            role: 'status',
            reason: 'role',
            inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          });
          return; // Element classified
        }

        // ✅ 4c. Collect meter elements (scalar measurement)
        if (tag === 'meter') {
          const selector = getSelector(element);
          if (!selector || selector.trim().length === 0) {
            return; // Skip if no selector
          }
          const value = element.getAttribute('value') || '';
          const min = element.getAttribute('min') || '0';
          const max = element.getAttribute('max') || '1';
          const text = `Meter: ${value} (${min}-${max})`;
          result.interactiveElements.push({
            tag,
            text,
            selector,
            role: 'meter',
            reason: 'role',
            inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          });
          return; // Element classified
        }

        // ✅ 4d. Collect progress elements (completion status)
        if (tag === 'progress') {
          const selector = getSelector(element);
          if (!selector || selector.trim().length === 0) {
            return; // Skip if no selector
          }
          const value = element.getAttribute('value') || '';
          const max = element.getAttribute('max') || '100';
          const text = `Progress: ${value}% (max: ${max})`;
          result.interactiveElements.push({
            tag,
            text,
            selector,
            role: 'progressbar',
            reason: 'role',
            inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          });
          return; // Element classified
        }

        // ✅ 4e. Collect fieldset elements (form field grouping)
        // Note: fieldset itself is not directly interactive, but groups form controls
        if (tag === 'fieldset' && !shadowHost) {
          // Fieldset groups form controls - we can track it but don't add to forms
          // The fields inside fieldset will be collected via their form association
          return; // Element classified (not directly interactive)
        }

        // ✅ 4f. Collect dialog elements (modal dialogs)
        if (tag === 'dialog') {
          const selector = getSelector(element);
          if (!selector || selector.trim().length === 0) {
            return; // Skip if no selector
          }
          const text = element.textContent?.trim().substring(0, 100) || element.getAttribute('aria-label') || 'Dialog';
          result.interactiveElements.push({
            tag,
            text,
            selector,
            role: 'dialog',
            reason: 'role',
            inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          });
          return; // Element classified
        }

        // ✅ 4g. Collect menu and menuitem elements
        if (tag === 'menu' || tag === 'menuitem') {
          const selector = getSelector(element);
          if (!selector || selector.trim().length === 0) {
            return; // Skip if no selector
          }
          const text = element.textContent?.trim().substring(0, 100) || element.getAttribute('aria-label') || element.getAttribute('label') || '';
          const role = tag === 'menu' ? 'menu' : 'menuitem';
          result.interactiveElements.push({
            tag,
            text,
            selector,
            role,
            reason: 'role',
            inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          });
          return; // Element classified
        }

        // ✅ 4h. Collect embed and object elements (embedded content)
        if (tag === 'embed' || tag === 'object') {
          const selector = getSelector(element);
          if (!selector || selector.trim().length === 0) {
            return; // Skip if no selector
          }
          const src = element.getAttribute('src') || element.getAttribute('data') || '';
          const type = element.getAttribute('type') || '';
          const text = src ? `Embedded: ${src}` : (type ? `Type: ${type}` : 'Embedded content');
          result.interactiveElements.push({
            tag,
            text,
            selector,
            reason: 'onclick', // Embed/object can be interactive
            inShadowDOM: !!shadowHost,
            inIframe: !!iframe,
          });
          return; // Element classified
        }

        // ✅ 5. Collect interactive elements (non-standard interactive elements)
        // Skip already collected standard elements
        if (['button', 'a', 'input', 'select', 'textarea', 'form',
             'area', 'output', 'meter', 'progress', 'fieldset', 'datalist',
             'dialog', 'menu', 'menuitem', 'embed', 'object'].includes(tag)) {
          return; // Already handled above
        }

        const role = element.getAttribute('role');
        if (role === 'button' || role === 'link') {
          return; // Already in buttons/links
        }

        // Check for interactive attributes
        const tabindex = element.getAttribute('tabindex');
            let reason: string | undefined;

        // Check for event handlers
            // @ts-ignore
        if (element.onclick ||
            element.hasAttribute('onclick') ||
            element.hasAttribute('ondblclick') ||
            element.hasAttribute('onmousedown') ||
            element.hasAttribute('onmouseup')) {
              reason = 'onclick';
        }
        // Check for data-* interactive attributes
        else if (element.hasAttribute('data-click') ||
                 element.hasAttribute('data-onclick') ||
                 element.hasAttribute('data-action') ||
                 element.hasAttribute('data-handler') ||
                 element.hasAttribute('data-trigger') ||
                 element.hasAttribute('data-event') ||
                 element.hasAttribute('data-toggle') ||
                 element.hasAttribute('data-dismiss')) {
          reason = 'onclick';
        }
        // Check for tabindex
        else if (tabindex !== null) {
          const tabindexNum = parseInt(tabindex);
          if (tabindexNum >= 0 || tabindexNum === -1) {
              reason = 'tabindex';
          }
        }
        // Check for interactive ARIA role
        else if (role && [
          'button', 'link', 'checkbox', 'radio', 'switch',
          'menuitem', 'menuitemcheckbox', 'menuitemradio',
          'option', 'tab', 'treeitem',
          'slider', 'spinbutton', 'scrollbar',
          'searchbox', 'combobox', 'listbox',
          'gridcell', 'row', 'columnheader', 'rowheader',
          'menu', 'menubar', 'tablist', 'tree', 'grid', 'treegrid',
          'toolbar', 'radiogroup',
          'dialog', 'alertdialog',
        ].includes(role)) {
              reason = 'role';
        }
        // Check for content-editable or draggable
        else if (element.getAttribute('contenteditable') === 'true') {
              reason = 'onclick';
            }
        else if (element.getAttribute('draggable') === 'true') {
          reason = 'onclick';
        }
        // Check for ARIA state attributes
        else if (element.hasAttribute('aria-expanded') ||
                 element.hasAttribute('aria-pressed') ||
                 element.hasAttribute('aria-checked') ||
                 element.hasAttribute('aria-selected') ||
                 element.hasAttribute('aria-controls') ||
                 element.hasAttribute('aria-haspopup')) {
          reason = 'role';
            }

            if (reason) {
              const selector = getSelector(element);
              // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
              if (!selector || selector.trim().length === 0) {
                return; // Skip this element - cannot generate reliable selector
              }

              const text = element.textContent?.trim().substring(0, 100) ||
                          element.getAttribute('aria-label') ||
                          element.getAttribute('alt') ||
                          element.getAttribute('title') ||
                          undefined;

          if (hiddenCheck.isHidden) {
            // Hidden but interactive - add to hiddenInteractive
            if (!result.hiddenInteractive) result.hiddenInteractive = [];
            result.hiddenInteractive.push({
              tag,
              text,
              selector,
              role: role || undefined,
              tabindex: tabindex ? parseInt(tabindex) : undefined,
              reason: reason === 'cursor-pointer' ? 'onclick' : reason,
              hiddenReason: hiddenCheck.hiddenReason,
              inShadowDOM: !!shadowHost,
              inIframe: !!iframe,
            });
          } else {
            // Visible and interactive
              result.interactiveElements.push({
                tag,
                text,
              selector,
                role: role || undefined,
                tabindex: tabindex ? parseInt(tabindex) : undefined,
                reason: reason as any,
                inShadowDOM: !!shadowHost,
              inIframe: !!iframe,
              });
            }
          }
        }

      /**
       * ✅ OPTIMIZED: Combined selector for all interactive elements (defined once, reused everywhere)
       * Covers all interactive elements without scanning ALL DOM nodes
       *
       * ⚠️ NOTE: This selector does NOT cover all possible Shadow DOM hosts:
       * - Custom elements without interactive attributes (e.g., <my-container>)
       * - Non-interactive elements with Shadow DOM (e.g., <div> with Shadow DOM but no onclick/role)
       *
       * These cases are handled separately in traverseShadowDOM() via:
       * 1. Custom elements search (findCustomElements) - finds elements with hyphen in tag name
       * 2. Recursive children traversal (checkChildrenForShadowDOM) - finds non-interactive Shadow DOM hosts
       *
       * This approach is more efficient than querySelectorAll('*') because:
       * - We only check children (not all descendants via querySelector)
       * - We skip already visited elements
       * - We use reasonable depth limits (5 levels)
       */
      const combinedSelector = [
            // 1. Standard interactive elements
            'button', 'input', 'select', 'textarea', 'a', 'form',
            // 1a. HTML5 form elements
            'datalist', 'output', 'meter', 'progress', 'fieldset', 'legend',
            // 1b. HTML5 interactive elements
            'dialog', 'menu', 'menuitem',
            // 1c. Media elements (can be interactive)
            'embed', 'object', 'area', 'map',
            // 1d. Media control elements
            'track', 'source',
            // 2. Elements with interactive attributes (fast - no computed style needed)
            '[onclick]', '[ondblclick]', '[onmousedown]', '[onmouseup]',
            '[data-click]', '[data-onclick]', '[data-action]', '[data-handler]',
            '[data-trigger]', '[data-event]', '[data-toggle]', '[data-dismiss]',
            '[tabindex]', '[contenteditable="true"]', '[draggable="true"]',
            '[download]', '[autofocus]', '[list]', // ✅ NEW: Additional interactive attributes
            // 3. Interactive ARIA roles
            '[role="button"]', '[role="link"]', '[role="checkbox"]', '[role="radio"]',
            '[role="switch"]', '[role="menuitem"]', '[role="tab"]', '[role="option"]',
            '[role="slider"]', '[role="searchbox"]', '[role="combobox"]', '[role="listbox"]',
            '[role="status"]', '[role="progressbar"]', '[role="meter"]', // ✅ NEW: Progress/meter roles
            // 4. ARIA state attributes (indicate interactivity)
            '[aria-expanded]', '[aria-pressed]', '[aria-checked]', '[aria-selected]',
            '[aria-controls]', '[aria-haspopup]', '[aria-valuenow]', '[aria-valuemin]', '[aria-valuemax]', // ✅ NEW: Value attributes
            // 5. Potentially clickable tags (for cursor:pointer detection - limited set, not all elements)
            'div', 'span', 'article', 'section', 'header', 'footer', 'nav', 'aside', 'main',
            'ul', 'ol', 'li', 'table', 'tr', 'td', 'th',
            'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
            'img', 'svg', 'canvas', 'video', 'audio', 'details', 'summary',
          ].join(',');

      /**
       * ✅ NEW: Collect all elements from a root in a single pass
       * Replaces multiple querySelectorAll calls with one efficient pass
       *
       * @param root - Document or ShadowRoot to collect from
       * @param context - Context info (shadowHost, iframe, etc.)
       * @returns Collected elements organized by type
       */
      function collectAllElementsFromRoot(
        root: any, // Document | ShadowRoot
        context: {
          shadowHost?: any;
          iframe?: any;
        } = {}
      ): {
        buttons: any[];
        links: any[];
        inputs: any[];
        checkboxes: any[];
        radios: any[];
        interactiveElements: any[];
        forms?: any[];
        hiddenInteractive?: any[];
      } {
        const result = {
          buttons: [] as any[],
          links: [] as any[],
          inputs: [] as any[],
          checkboxes: [] as any[],
          radios: [] as any[],
          interactiveElements: [] as any[],
          forms: [] as any[],
          hiddenInteractive: [] as any[],
        };

        // ✅ OPTIMIZED: Map to store forms by their element reference (for field matching)
        // Key: form element, Value: form data object
        const formsMap = new Map<any, any>();

        try {
          const allElements = Array.from(root.querySelectorAll(combinedSelector));

          // Create Set of already collected selectors for O(1) deduplication
          const collectedSelectors = new Set<string>();

          for (const el of allElements) {
            const element: any = el;
            // Skip if already visited (prevents duplicates in nested structures)
            if (visited.has(element)) continue;
            visited.add(element);

            const tag = element.tagName.toLowerCase();

            // ✅ OPTIMIZED: Check for cursor:pointer ONLY for potentially clickable tags
            // (not for standard interactive elements - they're already handled)
            const isPotentiallyClickable = ['div', 'span', 'article', 'section', 'header', 'footer',
              'nav', 'aside', 'main', 'ul', 'ol', 'li', 'table', 'tr', 'td', 'th',
              'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'svg', 'canvas',
              'video', 'audio', 'details', 'summary',
              // ✅ NEW: HTML5 interactive elements
              'dialog', 'menu', 'menuitem', 'output', 'meter', 'progress',
              // ✅ NEW: Media elements
              'embed', 'object', 'area', 'map'].includes(tag);

            // For potentially clickable tags, check cursor:pointer and onclick property
            if (isPotentiallyClickable) {
              const role = element.getAttribute('role');
              // Skip if already handled as button/link
              if (role === 'button' || role === 'link') {
                // Will be handled by classifyAndCollectElement below
              } else {
                // Check for cursor:pointer (requires getComputedStyle - expensive, but limited scope)
                const style = getCachedComputedStyle(element);
                const cursor = style ? style.cursor : undefined;
                const inlineStyle = element.getAttribute('style');
                const hasInlineCursorPointer = inlineStyle && inlineStyle.includes('cursor') && inlineStyle.includes('pointer');

                // Check for onclick property (not attribute - can't be found via selector)
                // @ts-ignore
                const hasOnclick = !!element.onclick;

                let reason: string | undefined;
                if (hasOnclick) {
                  reason = 'onclick';
                } else if (cursor === 'pointer' || hasInlineCursorPointer) {
                  reason = 'cursor-pointer';
                }

                if (reason) {
                  const tempSelector = generateSelector(element, root);

                  // ✅ FIX: Skip elements with empty selectors (cannot be reliably selected)
                  // Empty selector means element has no stable identifier
                  if (!tempSelector || tempSelector.trim().length === 0) {
                    continue; // Skip this element - cannot generate reliable selector
                  }

                  if (collectedSelectors.has(tempSelector)) continue; // Skip duplicates

                  const text = element.textContent?.trim().substring(0, 100) ||
                              element.getAttribute('aria-label') ||
                              element.getAttribute('alt') ||
                              element.getAttribute('title') ||
                              undefined;

                  const hiddenCheck = isHiddenButInteractive(element);

                  if (hiddenCheck.isHidden && hiddenCheck.hiddenReason) {
                    if (!result.hiddenInteractive) result.hiddenInteractive = [];
                    result.hiddenInteractive.push({
                      tag,
                      text,
                      selector: tempSelector,
                      role: role || undefined,
                      tabindex: element.getAttribute('tabindex') ? parseInt(element.getAttribute('tabindex')) : undefined,
                      reason: reason === 'cursor-pointer' ? 'onclick' : reason,
                      hiddenReason: hiddenCheck.hiddenReason as any,
                      inShadowDOM: !!context.shadowHost,
                      inIframe: !!context.iframe,
                    });
                  } else {
                    result.interactiveElements.push({
                      tag,
                      text,
                      selector: tempSelector,
                      role: role || undefined,
                      tabindex: element.getAttribute('tabindex') ? parseInt(element.getAttribute('tabindex')) : undefined,
                      reason: reason as any,
                      inShadowDOM: !!context.shadowHost,
                      inIframe: !!context.iframe,
                    });
                    collectedSelectors.add(tempSelector);
                  }
                  continue; // Skip classifyAndCollectElement for cursor:pointer elements
                }
              }
            }

            // Classify and collect element (handles buttons, links, inputs, forms, etc.)
            classifyAndCollectElement(element, result, {
              ...context,
              root,
              formsMap, // ✅ Pass formsMap for field matching
            });
          }
        } catch (e) {
          // Root might be detached or invalid
          // Return empty result
        }

        return result;
      }

      /**
       * ✅ IMPROVED: Recursively traverse Shadow DOM and collect elements
       * Handles nested Shadow DOM, closed Shadow DOM (skips), slotted content, and performance
       * Uses closure to access visited and selectorCounts (no need to pass them as parameters)
       * ✅ OPTIMIZED: Now uses unified collectAllElementsFromRoot
       * ✅ FIX: Checks ALL elements for Shadow DOM (not just combinedSelector)
       * ✅ FIX: Handles slotted content (<slot> elements)
       */
      function traverseShadowDOM(
        root: any, // Document | ShadowRoot (browser context)
        shadowHost: any | undefined,
        depth: number,
        maxDepth: number
      ): {
        buttons: any[];
        links: any[];
        inputs: any[];
        checkboxes: any[];
        radios: any[];
        interactiveElements: any[];
        hiddenInteractive?: any[]; // ✅ NEW: Hidden but interactive elements
      } {
        const result = {
          buttons: [] as any[],
          links: [] as any[],
          inputs: [] as any[],
          checkboxes: [] as any[],
          radios: [] as any[],
          interactiveElements: [] as any[],
          hiddenInteractive: [] as any[], // ✅ NEW: Hidden but interactive elements
        };

        // Prevent infinite loops and excessive depth
        if (depth > maxDepth) {
          return result;
        }

        // ✅ OPTIMIZED: Use unified collection function (single pass, no duplication)
        const rootResult = collectAllElementsFromRoot(root, { shadowHost });

        // Merge results
        result.buttons.push(...rootResult.buttons);
        result.links.push(...rootResult.links);
        result.inputs.push(...rootResult.inputs);
        result.checkboxes.push(...rootResult.checkboxes);
        result.radios.push(...rootResult.radios);
        result.interactiveElements.push(...rootResult.interactiveElements);
        if (rootResult.hiddenInteractive) {
          result.hiddenInteractive.push(...rootResult.hiddenInteractive);
        }

        // ✅ IMPROVED: Check for Shadow DOM hosts efficiently without querySelectorAll('*')
        // Strategy:
        // 1. Check elements already processed in collectAllElementsFromRoot (via combinedSelector)
        // 2. Check custom elements (elements with hyphen in tag name) - likely to have Shadow DOM
        // 3. Recursively check ALL children (with reasonable depth limit) to catch non-interactive Shadow DOM hosts
        // This ensures we find Shadow DOM hosts even if they're not in combinedSelector
        try {
          // ✅ OPTIMIZED: Get all elements that were processed in collectAllElementsFromRoot
          // These are interactive elements that might have Shadow DOM
          const processedElements = Array.from(root.querySelectorAll(combinedSelector));

          // ✅ IMPROVED: Find ALL custom elements (elements with hyphen in tag name)
          // Custom elements often have Shadow DOM but might not be in combinedSelector
          // We use recursive traversal with reasonable depth to catch all custom elements
          const customElements: any[] = [];
          const customElementsSet = new Set<any>(); // For deduplication

          function findCustomElements(parent: any, maxDepth: number, currentDepth: number = 0): void {
            if (currentDepth >= maxDepth) return;

            try {
              const children = Array.from(parent.children || []) as any[];
              for (const child of children) {
                if (!child) continue;

                const tag = child?.tagName?.toLowerCase();
                // Custom elements have hyphen in name (e.g., my-component, web-component)
                // This is the standard way to identify Web Components
                if (tag && tag.includes('-') && !customElementsSet.has(child)) {
                  customElements.push(child);
                  customElementsSet.add(child);
                }
                // Recursively check children (reasonable depth to catch nested custom elements)
                findCustomElements(child, maxDepth, currentDepth + 1);
              }
            } catch (e) {
              // Parent might be detached
            }
          }

          // ✅ IMPROVED: Find custom elements with deeper traversal (5 levels)
          // This ensures we catch custom elements even in deeply nested structures
          // 5 levels is reasonable - most real-world apps don't nest deeper
          findCustomElements(root, 5);

          // ✅ OPTIMIZED: Combine processed elements with custom elements
          // Use Set to deduplicate
          const elementsToCheck = new Set([...processedElements, ...customElements]);

          for (const element of elementsToCheck) {
            if (!element) continue;

            // ✅ SAFETY: Skip if already visited (prevent duplicates in nested structures)
            if (visited.has(element)) continue;

            // Check if element has Shadow DOM
            // ✅ SAFETY: Enhanced error handling for Shadow DOM access
            let shadowRoot: any = null;
            try {
              // Try to access shadowRoot (works for open Shadow DOM)
              if (element && typeof element.shadowRoot !== 'undefined') {
                shadowRoot = element.shadowRoot;
              }
            } catch (e) {
              // Closed Shadow DOM or error accessing - skip (can't access)
              shadowRoot = null;
            }

            // If element has Shadow DOM, recurse into it
            if (shadowRoot) {
              visited.add(element); // Mark as visited before recursion

              const shadowResult = traverseShadowDOM(
                shadowRoot,
                element, // Pass current element as shadow host
                depth + 1,
                maxDepth
              );

              // Merge results from Shadow DOM
              result.buttons.push(...shadowResult.buttons);
              result.links.push(...shadowResult.links);
              result.inputs.push(...shadowResult.inputs);
              result.checkboxes.push(...shadowResult.checkboxes);
              result.radios.push(...shadowResult.radios);
              result.interactiveElements.push(...shadowResult.interactiveElements);
              if (shadowResult.hiddenInteractive) {
                if (!result.hiddenInteractive) result.hiddenInteractive = [];
                result.hiddenInteractive.push(...shadowResult.hiddenInteractive);
              }
            }

            // ✅ NEW: Check for slotted content (elements projected through <slot>)
            // Slotted elements are in the light DOM but rendered in Shadow DOM
            try {
              // @ts-ignore - assignedSlot is a standard property
              if (element.assignedSlot) {
                // Element is slotted - it's already processed by collectAllElementsFromRoot
                // But we need to ensure it's marked as in Shadow DOM
                // This is handled by the shadowHost context in collectAllElementsFromRoot
              }
            } catch (e) {
              // assignedSlot might not be available in all contexts
            }
          }

          // ✅ IMPROVED: Recursively check ALL children for Shadow DOM hosts (reasonable depth)
          // This catches Shadow DOM hosts that are not interactive elements themselves
          // Examples: <div> with Shadow DOM but no interactive attributes
          // We use reasonable depth (5 levels) to catch most real-world cases
          // This is still much more efficient than querySelectorAll('*') because:
          // 1. We only check children (not all descendants via querySelector)
          // 2. We skip already visited elements
          // 3. We stop at reasonable depth
          function checkChildrenForShadowDOM(parent: any, maxDepth: number, currentDepth: number = 0): void {
            if (currentDepth >= maxDepth) return;

            try {
              const children = Array.from(parent.children || []) as any[];
              for (const child of children) {
                if (!child || visited.has(child)) continue;

                let shadowRoot: any = null;
                try {
                  if (child && typeof (child as any).shadowRoot !== 'undefined') {
                    shadowRoot = (child as any).shadowRoot;
                  }
                } catch (e) {
                  shadowRoot = null;
                }

                if (shadowRoot) {
                  visited.add(child);

                  const shadowResult = traverseShadowDOM(
                    shadowRoot,
                    child,
                    depth + 1,
                    maxDepth
                  );

                  result.buttons.push(...shadowResult.buttons);
                  result.links.push(...shadowResult.links);
                  result.inputs.push(...shadowResult.inputs);
                  result.checkboxes.push(...shadowResult.checkboxes);
                  result.radios.push(...shadowResult.radios);
                  result.interactiveElements.push(...shadowResult.interactiveElements);
                  if (shadowResult.hiddenInteractive) {
                    if (!result.hiddenInteractive) result.hiddenInteractive = [];
                    result.hiddenInteractive.push(...shadowResult.hiddenInteractive);
                  }
                }

                // ✅ IMPROVED: Recursively check children with reasonable depth (5 levels)
                // This ensures we catch Shadow DOM hosts even in nested structures
                // 5 levels is reasonable for real-world applications
                checkChildrenForShadowDOM(child, maxDepth, currentDepth + 1);
              }
            } catch (e) {
              // Parent might be detached
            }
          }

          // ✅ IMPROVED: Check ALL children of root for Shadow DOM (max 5 levels deep)
          // This catches Shadow DOM hosts that are not interactive elements themselves
          // Examples: non-interactive containers with Shadow DOM
          // 5 levels is reasonable - covers most real-world nesting scenarios
          // Still much more efficient than querySelectorAll('*') because:
          // - We use children traversal (not querySelector)
          // - We skip visited elements
          // - We have depth limit
          checkChildrenForShadowDOM(root, 5);
        } catch (e) {
          // Root might be detached or invalid
          // Continue with existing results
        }

        return result;
      }

      /**
       * ✅ IMPROVED: Recursively traverse iframes and collect elements
       * Handles cross-origin iframes (skips), nested iframes, lazy-loaded iframes, and performance
       * Uses closure to access visited, visitedDocuments, and selectorCounts
       * ✅ FIX: Prevents circular iframe references using visitedDocuments Set
       * ✅ FIX: Independent Shadow DOM depth counter inside iframes
       * ✅ FIX: Handles lazy-loaded iframes (loading="lazy")
       */
      function traverseIframes(
        root: any, // Document (browser context)
        depth: number,
        maxDepth: number
      ): {
        buttons: any[];
        links: any[];
        inputs: any[];
        checkboxes: any[];
        radios: any[];
        interactiveElements: any[];
        forms: any[]; // ✅ NEW: Also collect forms from iframes
        hiddenInteractive?: any[]; // ✅ NEW: Hidden but interactive elements
      } {
        const result = {
          buttons: [] as any[],
          links: [] as any[],
          inputs: [] as any[],
          checkboxes: [] as any[],
          radios: [] as any[],
          interactiveElements: [] as any[],
          forms: [] as any[], // ✅ NEW: Forms in iframes
          hiddenInteractive: [] as any[], // ✅ NEW: Hidden but interactive elements
        };

        // Prevent infinite loops and excessive depth
        if (depth > maxDepth) {
          return result;
        }

        // ✅ FIX: Check if document already visited (prevent circular iframe references)
        // Example: iframe A contains iframe B, which contains iframe A
        if (visitedDocuments.has(root)) {
          return result;
        }
        visitedDocuments.add(root);

        // Find all iframes in current root
        let iframes: any[] = [];
        try {
        // @ts-ignore - browser context
          iframes = Array.from(root.querySelectorAll('iframe'));
        } catch (e) {
          // Root might be detached or invalid
          return result;
        }

        for (const iframeEl of iframes) {
          const iframe: any = iframeEl;

          // ✅ SAFETY: Skip if already visited (prevent duplicates)
          if (visited.has(iframe)) continue;
          visited.add(iframe);

          // ✅ IMPROVED: Check for lazy-loaded iframes (loading="lazy")
          const isLazyLoaded = iframe.getAttribute('loading') === 'lazy';

          // ✅ SAFETY: Skip hidden iframes (not useful for analysis)
          // ✅ EDGE CASE: Some iframes might be 0x0 but still functional (check both)
          if (!isVisible(iframe)) {
            // Double-check: iframe might be loading or have delayed content
            // Skip only if truly hidden (display: none, visibility: hidden, or 0x0)
            const style = getCachedComputedStyle(iframe);
            if (style && (style.display === 'none' || style.visibility === 'hidden')) {
              continue;
            }
            // If iframe has 0x0 dimensions, check if it's lazy-loaded
            if (iframe.offsetWidth === 0 && iframe.offsetHeight === 0) {
              // ✅ FIX: If lazy-loaded, it might not be loaded yet - skip for now
              // In production, you might want to wait for it to load
              if (isLazyLoaded) {
                continue; // Skip lazy-loaded iframes with 0x0 dimensions
              }
              // For non-lazy iframes with 0x0, skip to avoid false positives
              continue;
            }
          }

          // ✅ EDGE CASE: Check if iframe is sandboxed (might have restricted access)
          // Sandboxed iframes might have limited functionality, but we can still try
          const sandboxAttr = iframe.getAttribute('sandbox');
          // Note: Sandbox doesn't prevent contentDocument access, but might restrict scripts
          // We'll still try to access it

          // ✅ EDGE CASE: Check if iframe has srcdoc (inline content)
          // srcdoc iframes don't have src, but contentDocument should still work
          const hasSrcdoc = iframe.hasAttribute('srcdoc');

          // Try to access iframe content
          let iframeDocument: any = null;
          try {
            // Access contentDocument (works for same-origin iframes)
            // @ts-ignore - browser context
            iframeDocument = iframe.contentDocument || iframe.contentWindow?.document;

            // ✅ EDGE CASE: Check if document is actually accessible
            // Some browsers might return null even without throwing
            if (!iframeDocument) {
              // Try alternative access method
              try {
                // @ts-ignore - browser context
                iframeDocument = iframe.contentWindow?.document;
              } catch {
                // Still null, skip this iframe
                continue;
              }
            }

            // ✅ FIX: Check if document already visited (circular reference detection)
            if (visitedDocuments.has(iframeDocument)) {
              continue; // Skip circular references
            }

            // ✅ EDGE CASE: Check if document is ready (might be loading)
            // If document.readyState is 'loading', content might not be fully loaded
            // But we'll still try to analyze it (might have some content)
            if (iframeDocument.readyState === 'uninitialized') {
              // Document not initialized yet, skip
              continue;
            }
          } catch (e) {
            // Cross-origin iframe - cannot access (security restriction)
            // ✅ EDGE CASE: Some same-origin iframes might throw if not fully loaded
            // Skip this iframe
            continue;
          }

          // If iframe content is accessible, process it
          if (iframeDocument) {
            // ✅ OPTIMIZED: Single pass for iframe content (no duplication)
            // Step 1: Collect all elements from iframe document (main DOM)
            let iframeMainResult;
            try {
              iframeMainResult = collectAllElementsFromRoot(iframeDocument, { iframe });
            } catch (e) {
              // Document might be detached or invalid
              continue;
            }

            // ✅ FIX: Use independent depth counter for Shadow DOM inside iframe
            // Shadow DOM depth should start from 0 inside each iframe
            // This prevents depth overflow when iframe is deeply nested
            const shadowResult = traverseShadowDOM(iframeDocument, undefined, 0, 5);

            // ✅ FIX: Continue iframe traversal with incremented depth
            // Iframe depth continues to increase to prevent infinite nesting
            const nestedIframeResult = traverseIframes(iframeDocument, depth + 1, maxDepth);

            // ✅ OPTIMIZED: Merge all results in one operation (no duplicate pushes)
            result.buttons.push(
              ...iframeMainResult.buttons,
              ...shadowResult.buttons,
              ...nestedIframeResult.buttons
            );
            result.links.push(
              ...iframeMainResult.links,
              ...shadowResult.links,
              ...nestedIframeResult.links
            );
            result.inputs.push(
              ...iframeMainResult.inputs,
              ...shadowResult.inputs,
              ...nestedIframeResult.inputs
            );
            result.checkboxes.push(
              ...iframeMainResult.checkboxes,
              ...shadowResult.checkboxes,
              ...nestedIframeResult.checkboxes
            );
            result.radios.push(
              ...iframeMainResult.radios,
              ...shadowResult.radios,
              ...nestedIframeResult.radios
            );
            result.interactiveElements.push(
              ...iframeMainResult.interactiveElements,
              ...shadowResult.interactiveElements,
              ...nestedIframeResult.interactiveElements
            );
            result.forms.push(
              ...(iframeMainResult.forms || []),
              ...nestedIframeResult.forms
            );

            // Merge hiddenInteractive
            const allHiddenInteractive = [
              ...(iframeMainResult.hiddenInteractive || []),
              ...(shadowResult.hiddenInteractive || []),
              ...(nestedIframeResult.hiddenInteractive || []),
            ];
            if (allHiddenInteractive.length > 0) {
              if (!result.hiddenInteractive) result.hiddenInteractive = [];
              result.hiddenInteractive.push(...allHiddenInteractive);
            }
          }
        }

        return result;
      }

      // ✅ FIX: visited and selectorCounts are now in closure (created above)
      // ✅ NEW: Traverse Shadow DOM and collect elements
      // Start from document root (depth 0)
      // @ts-expect-error - browser context (document is available in page.evaluate)
      const shadowDOMResult = traverseShadowDOM(document, undefined, 0, 5);

      // ✅ NEW: Traverse iframes and collect elements
      // Start from document root (depth 0)
      // @ts-expect-error - browser context (document is available in page.evaluate)
      const iframeResult = traverseIframes(document, 0, 3);

      // ✅ OPTIMIZED: Collect all elements from main DOM in a single pass
      // Replaces 7+ separate querySelectorAll calls with one efficient pass
      // @ts-expect-error - browser context (document is available in page.evaluate)
      const mainDOMResult = collectAllElementsFromRoot(document, {});

      // Extract results (already filtered and classified)
      const forms = mainDOMResult.forms || [];
      const buttons = mainDOMResult.buttons.filter((btn: any) => btn.text.length > 0); // Only buttons with text/label
      const links = mainDOMResult.links;
      const inputs = mainDOMResult.inputs;
      const checkboxes = mainDOMResult.checkboxes;
      const radios = mainDOMResult.radios;
      const interactiveElements = mainDOMResult.interactiveElements;
      const hiddenInteractive = mainDOMResult.hiddenInteractive || [];

      // ✅ OPTIMIZED: Interactive elements already collected by collectAllElementsFromRoot above
      // No need for separate PHASE 1 and PHASE 2 - all elements classified in single pass

      // ═══════════════════════════════════════════════════════════════════════════
      // OLD CODE REMOVED: PHASE 1 and PHASE 2 (now handled by collectAllElementsFromRoot)
      // ═══════════════════════════════════════════════════════════════════════════
      // The following code was removed because collectAllElementsFromRoot already handles:
      // - Explicit interactive attributes (onclick, data-*, role, tabindex, etc.)
      // - Cursor pointer detection (via getCachedComputedStyle)
      // - Hidden but interactive elements
      // All in a single pass through the DOM
      // ═══════════════════════════════════════════════════════════════════════════


      // ✅ OPTIMIZED: Old PHASE 1 and PHASE 2 code removed
      // All interactive elements are now collected by collectAllElementsFromRoot above
      // No need for separate phases - single pass handles everything via classifyAndCollectElement

      // Return separate results - merging will be done in Node.js
      return {
        mainDOM: {
        forms,
          buttons,
          links,
          inputs,
          checkboxes,
          radios,
          interactiveElements,
          hiddenInteractive,
        },
        shadowDOMResult,
        iframeResult,
      };
    });

    // Merge results in Node.js (not in browser)
    const mergedResult = mergeDOMResults(
      result.mainDOM,
      result.shadowDOMResult,
      result.iframeResult
    );

    // Calculate and log metrics
    calculateMetrics(mergedResult);

    return mergedResult;
  } catch (error) {
    // ✅ FIX: Enhanced error logging with context
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logger.error('DOM analysis failed', {
      error: errorMessage,
      stack: errorStack,
      phase: 'page.evaluate',
      suggestion: 'Page might have dynamic content or CSP restrictions',
    });

    // Return empty structure instead of throwing
    return {
      forms: [],
      buttons: [],
      links: [],
      inputs: [],
      checkboxes: undefined,
      radios: undefined,
      interactiveElements: undefined,
      hiddenInteractive: undefined, // ✅ NEW: Hidden interactive elements
    };
  }
}

/**
 * Extract interactive elements (shorthand)
 */
export async function extractInteractiveElements(page: Page) {
  const analysis = await analyzeDOMStructure(page);

  return {
    formFields: analysis.forms.flatMap(f => f.fields),
    buttons: analysis.buttons,
    links: analysis.links.filter(l => !l.href.startsWith('#')), // Exclude anchor links
  };
}
