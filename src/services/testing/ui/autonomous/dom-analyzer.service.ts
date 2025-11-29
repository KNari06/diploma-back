import { logger } from '@/utils/logger';
import { Page } from 'playwright';

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
  }>;
  links: Array<{
    text: string;
    href: string;
    selector: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  inputs: Array<{
    type: string;
    name?: string;
    placeholder?: string;
    selector: string;
    required: boolean;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  checkboxes?: Array<{
    name?: string;
    label?: string;
    selector: string;
    checked: boolean;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  radios?: Array<{
    name?: string;
    label?: string;
    selector: string;
    checked: boolean;
    value?: string;
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
  interactiveElements?: Array<{
    tag: string;
    text?: string;
    selector: string;
    role?: string;
    tabindex?: number;
    reason: 'onclick' | 'cursor-pointer' | 'tabindex' | 'role';
    inShadowDOM?: boolean; // ✅ NEW: Mark if element is in Shadow DOM
  }>;
}

/**
 * Analyze DOM structure and extract interactive elements
 */
export async function analyzeDOMStructure(page: Page): Promise<DOMAnalysisResult> {
  try {
    logger.info('Analyzing DOM structure');

    const result = await page.evaluate(() => {
      /**
       * Check if element is visible (not hidden by CSS)
       * ✅ SAFETY: Added error handling for edge cases
       */
      function isVisible(element: any): boolean {
        try {
          // @ts-expect-error - browser context
          const style = window.getComputedStyle(element);
          return (
            style &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            element &&
            element.offsetWidth > 0 &&
            element.offsetHeight > 0
          );
        } catch (e) {
          // Element might be detached or not in DOM
          return false;
        }
      }

      /**
       * Escape special characters for CSS selector
       */
      function escapeSelector(text: string): string {
        return text.replace(/["\\]/g, '\\$&');
      }

      /**
       * Check if class looks like dynamic/generated (CSS-in-JS)
       */
      function isDynamicClass(className: string): boolean {
        // Filter out CSS-in-JS hashes and generic classes
        return (
          /^(css-|sc-|jsx-|_)/.test(className) || // CSS-in-JS prefixes
          /^(btn|button|input|form|active|focus|hover|disabled|selected|error)$/.test(className) || // Generic
          className.length > 20 || // Too long = likely hash
          /^[a-f0-9]{6,}$/i.test(className) // Looks like hex hash
        );
      }

      /**
       * ✅ CRITICAL FIX: Generate Playwright API selector (not CSS contextual locators)
       * Priority: getByRole > getByLabel > getByText > data-testid > CSS
       * Format: role=button[name="Login"], text="Login", label="Email", #id, .class
       */
      function generateSelector(element: any, selectorCounts: Map<string, number>): string {
        // Try ID first (most reliable, use CSS)
        if (element.id && element.id.length > 0) {
          return `#${element.id}`;
        }

        // Try data-testid or data-cy (test-friendly, use CSS)
        if (element.hasAttribute('data-testid')) {
          return `[data-testid="${escapeSelector(element.getAttribute('data-testid'))}"]`;
        }
        if (element.hasAttribute('data-cy')) {
          return `[data-cy="${escapeSelector(element.getAttribute('data-cy'))}"]`;
        }

        // ✅ NEW: Try getByRole (best practice for accessibility)
        // Detect implicit ARIA roles from HTML elements
        const implicitRole = getImplicitRole(element);
        if (implicitRole) {
          const text = element.textContent?.trim();
          // Use role with name if text is available and reasonable length
          if (text && text.length > 0 && text.length < 50) {
            return `role=${implicitRole}[name="${escapeSelector(text)}"]`;
          }
          // Use role without name (less specific, but still good)
          return makeUnique(`role=${implicitRole}`, selectorCounts, element);
        }

        // ✅ NEW: Try getByLabel for inputs (accessibility-first)
        if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT') {
          // Try aria-label first
          if (element.hasAttribute('aria-label')) {
            const ariaLabel = element.getAttribute('aria-label');
            if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 50) {
              return `label="${escapeSelector(ariaLabel)}"`;
            }
          }

          // Try placeholder as label
          if (element.hasAttribute('placeholder')) {
            const placeholder = element.getAttribute('placeholder');
            if (placeholder && placeholder.length > 0 && placeholder.length < 50) {
              return `label="${escapeSelector(placeholder)}"`;
            }
          }

          // Try name attribute (fallback to CSS)
          if (element.hasAttribute('name')) {
            const name = element.getAttribute('name');
            if (name && name.length > 0) {
              const selector = `${element.tagName.toLowerCase()}[name="${escapeSelector(name)}"]`;
              return makeUnique(selector, selectorCounts, element);
            }
          }
        }

        // ✅ NEW: Try getByText for buttons/links (Playwright API format)
        if ((element.tagName === 'BUTTON' || element.tagName === 'A') && element.textContent) {
          const text = element.textContent.trim();
          if (text.length > 0 && text.length < 50) {
            return `text="${escapeSelector(text)}"`;
          }
        }

        // Try meaningful classes (filter out dynamic ones)
        if (element.className && typeof element.className === 'string') {
          const classes = element.className
            .split(' ')
            .filter((c: string) => c && !isDynamicClass(c));

          if (classes.length > 0 && classes.length < 3) {
            const selector = `.${classes.join('.')}`;
            return makeUnique(selector, selectorCounts, element);
          }
        }

        // Fallback to nth-of-type with parent context
        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((e: any) => e.tagName === element.tagName);
          const index = siblings.indexOf(element);
          return `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        }

        return element.tagName.toLowerCase();
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
                return 'textbox';
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
          default:
            return null;
        }
      }

      /**
       * Make selector unique by adding parent context if duplicate
       * ✅ FIX: Playwright doesn't support :nth() in CSS selector
       * Instead, we use more specific selector with parent context
       */
      function makeUnique(selector: string, selectorCounts: Map<string, number>, element?: any): string {
        const count = selectorCounts.get(selector) || 0;
        selectorCounts.set(selector, count + 1);

        // If we've seen this selector before, try to make it more specific
        if (count > 0 && element) {
          // Try to add parent context for uniqueness
          const parent = element.parentElement;
          if (parent) {
            // Try parent ID
            if (parent.id) {
              return `#${parent.id} > ${selector}`;
            }
            // Try parent class (first meaningful class)
            if (parent.className && typeof parent.className === 'string') {
              const classes = parent.className.split(' ').filter((c: string) => c && !isDynamicClass(c));
              if (classes.length > 0 && classes.length < 3) {
                return `.${classes[0]} > ${selector}`;
              }
            }
            // Try parent tag
            const parentTag = parent.tagName.toLowerCase();
            if (parentTag !== 'body' && parentTag !== 'html') {
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
        selectorCounts: Map<string, number>
      ): string {
        // First, generate selector for the shadow host (parent)
        const hostSelector = generateSelector(shadowHost, selectorCounts);

        // Then, generate selector for the element inside shadow
        const elementSelector = generateSelector(element, selectorCounts);

        // Use Playwright syntax for Shadow DOM: parent >> child
        return `${hostSelector} >> ${elementSelector}`;
      }

      /**
       * ✅ NEW: Recursively traverse Shadow DOM and collect elements
       * Handles nested Shadow DOM, closed Shadow DOM (skips), and performance
       */
      function traverseShadowDOM(
        root: any, // Document | ShadowRoot (browser context)
        shadowHost: any | undefined,
        depth: number,
        maxDepth: number,
        visited: Set<any>, // ✅ SAFETY: Set is available in all modern browsers
        selectorCounts: Map<string, number> // ✅ SAFETY: Map is available in all modern browsers
      ): {
        buttons: any[];
        links: any[];
        inputs: any[];
        checkboxes: any[];
        radios: any[];
        interactiveElements: any[];
      } {
        const result = {
          buttons: [] as any[],
          links: [] as any[],
          inputs: [] as any[],
          checkboxes: [] as any[],
          radios: [] as any[],
          interactiveElements: [] as any[],
        };

        // Prevent infinite loops and excessive depth
        if (depth > maxDepth) {
          return result;
        }

        // Get all elements in current root
        // ✅ SAFETY: Added error handling for querySelectorAll
        let allElements: any[] = [];
        try {
          // @ts-ignore - browser context
          allElements = Array.from(root.querySelectorAll('*'));
        } catch (e) {
          // Root might be detached or invalid
          return result;
        }

        for (const el of allElements) {
          const element: any = el;

          // ✅ SAFETY: Skip if already visited (prevent duplicates in nested structures)
          if (visited.has(element)) continue;
          visited.add(element);

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
            const shadowResult = traverseShadowDOM(
              shadowRoot,
              element, // Pass current element as shadow host
              depth + 1,
              maxDepth,
              visited,
              selectorCounts // ✅ FIX: Pass selectorCounts
            );

            // Merge results from Shadow DOM
            result.buttons.push(...shadowResult.buttons);
            result.links.push(...shadowResult.links);
            result.inputs.push(...shadowResult.inputs);
            result.checkboxes.push(...shadowResult.checkboxes);
            result.radios.push(...shadowResult.radios);
            result.interactiveElements.push(...shadowResult.interactiveElements);
          }

          // Process current element (if visible)
          if (!isVisible(element)) continue;

          const tag = element.tagName.toLowerCase();

          // Collect buttons from Shadow DOM
          if ((tag === 'button' ||
               (tag === 'input' && (element.type === 'submit' || element.type === 'button')) ||
               element.getAttribute('role') === 'button') &&
              element.textContent?.trim()) {
            result.buttons.push({
              text: element.textContent?.trim() || element.value || element.getAttribute('aria-label') || '',
              selector: shadowHost
                ? generateShadowSelector(element, shadowHost, selectorCounts)
                : generateSelector(element, selectorCounts),
              type: element.type || element.getAttribute('role') || 'button',
              inShadowDOM: !!shadowHost,
            });
          }

          // Collect links from Shadow DOM
          if (tag === 'a' && element.href &&
              !element.href.startsWith('#') &&
              !element.href.startsWith('javascript:') &&
              element.textContent?.trim()) {
            result.links.push({
              text: element.textContent?.trim() || element.getAttribute('aria-label') || '',
              href: element.href,
              selector: shadowHost
                ? generateShadowSelector(element, shadowHost, selectorCounts)
                : generateSelector(element, selectorCounts),
              inShadowDOM: !!shadowHost,
            });
          }

          // Collect inputs from Shadow DOM
          if (tag === 'input' || tag === 'select' || tag === 'textarea') {
            if (element.type === 'checkbox') {
              let label: string | undefined;
              const id = element.id;
              if (id) {
                // Try to find label in Shadow DOM
                try {
                  // @ts-ignore
                  const labelEl = root.querySelector(`label[for="${id}"]`);
                  if (labelEl) {
                    label = labelEl.textContent?.trim() || undefined;
                  }
                } catch {}
              }

              result.checkboxes.push({
                name: element.name || element.id || undefined,
                label: label || element.getAttribute('aria-label') || undefined,
                selector: shadowHost
                  ? generateShadowSelector(element, shadowHost, selectorCounts)
                  : generateSelector(element, selectorCounts),
                checked: element.checked,
                inShadowDOM: !!shadowHost,
              });
            } else if (element.type === 'radio') {
              let label: string | undefined;
              const id = element.id;
              if (id) {
                // Try to find label in current root (Shadow DOM or document)
                try {
                  const labelEl = root.querySelector(`label[for="${id}"]`);
                  if (labelEl) {
                    label = labelEl.textContent?.trim() || undefined;
                  }
                } catch {}
              }

              result.radios.push({
                name: element.name || undefined,
                label: label || element.getAttribute('aria-label') || undefined,
                selector: shadowHost
                  ? generateShadowSelector(element, shadowHost, selectorCounts)
                  : generateSelector(element, selectorCounts),
                checked: element.checked,
                value: element.value || undefined,
                inShadowDOM: !!shadowHost,
              });
            } else {
              // Regular input
              result.inputs.push({
                type: element.type || tag,
                name: element.name || element.id || undefined,
                placeholder: element.getAttribute('placeholder') || undefined,
                selector: shadowHost
                  ? generateShadowSelector(element, shadowHost, selectorCounts)
                  : generateSelector(element, selectorCounts),
                required: element.hasAttribute('required') || element.getAttribute('aria-required') === 'true',
                inShadowDOM: !!shadowHost,
              });
            }
          }

          // Collect other interactive elements from Shadow DOM
          if (!['button', 'a', 'input', 'select', 'textarea', 'form'].includes(tag)) {
            const role = element.getAttribute('role');
            if (role === 'button' || role === 'link') continue; // Already handled

            const tabindex = element.getAttribute('tabindex');
            // ✅ SAFETY: Added error handling for getComputedStyle
            let cursor = 'auto';
            try {
              // @ts-ignore
              const style = window.getComputedStyle(element);
              cursor = style ? style.cursor || 'auto' : 'auto';
            } catch (e) {
              // Element might be detached
              cursor = 'auto';
            }

            let reason: string | undefined;

            // @ts-ignore
            if (element.onclick || element.hasAttribute('onclick') || element.hasAttribute('data-onclick')) {
              reason = 'onclick';
            } else if (cursor === 'pointer') {
              reason = 'cursor-pointer';
            } else if (tabindex !== null && parseInt(tabindex) >= 0) {
              reason = 'tabindex';
            } else if (role && ['button', 'link', 'menuitem', 'tab', 'option'].includes(role)) {
              reason = 'role';
            } else if ((tag === 'img' || tag === 'svg' || element.tagName === 'SVG') &&
                       (element.onclick || element.hasAttribute('onclick'))) {
              reason = 'onclick';
            }

            if (reason) {
              const text = element.textContent?.trim().substring(0, 100) ||
                          element.getAttribute('aria-label') ||
                          element.getAttribute('alt') ||
                          element.getAttribute('title') ||
                          undefined;

              result.interactiveElements.push({
                tag,
                text,
                selector: shadowHost
                  ? generateShadowSelector(element, shadowHost, selectorCounts)
                  : generateSelector(element, selectorCounts),
                role: role || undefined,
                tabindex: tabindex ? parseInt(tabindex) : undefined,
                reason: reason as any,
                inShadowDOM: !!shadowHost,
              });
            }
          }
        }

        return result;
      }

      // ✅ FIX: Create selector count map to track duplicates
      const selectorCounts = new Map<string, number>();

      // ✅ NEW: Traverse Shadow DOM and collect elements
      // Start from document root (depth 0)
      // @ts-expect-error - browser context
      const shadowDOMResult = traverseShadowDOM(document, undefined, 0, 5, new Set(), selectorCounts);

      // ✅ FIX: Analyze forms (only visible ones) - including Shadow DOM
      // @ts-expect-error - browser context
      const forms = Array.from(document.querySelectorAll('form'))
        .filter((form: any) => isVisible(form))
        .map((form: any) => {
          const fields = Array.from(form.querySelectorAll('input, select, textarea'))
            .filter((field: any) => isVisible(field))
            .map((field: any) => {
              const input = field;
              return {
                name: input.name || input.id || '',
                type: input.type || input.tagName.toLowerCase(),
                required: input.hasAttribute('required') || input.getAttribute('aria-required') === 'true',
                selector: generateSelector(field, selectorCounts),
                placeholder: input.getAttribute('placeholder') || undefined,
                value: input.value || undefined,
              };
            });

          return {
            id: form.id || undefined,
            action: form.action || undefined,
            method: form.method || 'get',
            fields,
          };
        });

      // ✅ FIX: Analyze buttons (including role="button", only visible)
      // @ts-expect-error - browser context
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]'))
        .filter((btn: any) => isVisible(btn))
        .map((btn: any) => {
          const button = btn;
          return {
            text: button.textContent?.trim() || button.value || button.getAttribute('aria-label') || '',
            selector: generateSelector(btn, selectorCounts),
            type: button.type || button.getAttribute('role') || 'button',
          };
        })
        .filter((btn: any) => btn.text.length > 0); // Only buttons with text/label

      // ✅ FIX: Analyze links (only visible, exclude anchors and javascript:)
      // @ts-expect-error - browser context
      const links = Array.from(document.querySelectorAll('a[href]'))
        .filter((link: any) => {
          const anchor = link;
          return (
            isVisible(anchor) &&
            !anchor.href.startsWith('#') &&
            !anchor.href.startsWith('javascript:') &&
            anchor.textContent?.trim().length > 0
          );
        })
        .map((link: any) => {
          const anchor = link;
          return {
            text: anchor.textContent?.trim() || anchor.getAttribute('aria-label') || '',
            href: anchor.href,
            selector: generateSelector(link, selectorCounts),
          };
        });

      // ✅ FIX: Analyze all inputs (including those outside forms, only visible)
      // @ts-expect-error - browser context
      const inputs = Array.from(document.querySelectorAll('input, select, textarea'))
        .filter((input: any) => isVisible(input))
        .map((input: any) => {
          const field = input;
          return {
            type: field.type || field.tagName.toLowerCase(),
            name: field.name || field.id || undefined,
            placeholder: field.getAttribute('placeholder') || undefined,
            selector: generateSelector(input, selectorCounts),
            required: field.hasAttribute('required') || field.getAttribute('aria-required') === 'true',
          };
        });

      // ✅ NEW: Extract checkboxes separately
      // @ts-expect-error - browser context (document is available in page.evaluate)
      const checkboxes = Array.from(document.querySelectorAll('input[type="checkbox"]'))
        .filter((checkbox: any) => isVisible(checkbox))
        .map((checkbox: any) => {
          // Find associated label
          let label: string | undefined;
          const id = checkbox.id;
          if (id) {
            // @ts-expect-error - browser context (document is available in page.evaluate)
            const labelEl = document.querySelector(`label[for="${id}"]`);
            if (labelEl) {
              label = labelEl.textContent?.trim() || undefined;
            }
          }
          if (!label && checkbox.parentElement?.tagName === 'LABEL') {
            label = checkbox.parentElement.textContent?.trim().replace(checkbox.value || '', '').trim() || undefined;
          }

          return {
            name: checkbox.name || checkbox.id || undefined,
            label: label || checkbox.getAttribute('aria-label') || undefined,
            selector: generateSelector(checkbox, selectorCounts),
            checked: checkbox.checked,
          };
        });

      // ✅ NEW: Extract radio buttons separately
      // @ts-expect-error - browser context (document is available in page.evaluate)
      const radios = Array.from(document.querySelectorAll('input[type="radio"]'))
        .filter((radio: any) => isVisible(radio))
        .map((radio: any) => {
          // Find associated label
          let label: string | undefined;
          const id = radio.id;
          if (id) {
            // @ts-expect-error - browser context (document is available in page.evaluate)
            const labelEl = document.querySelector(`label[for="${id}"]`);
            if (labelEl) {
              label = labelEl.textContent?.trim() || undefined;
            }
          }
          if (!label && radio.parentElement?.tagName === 'LABEL') {
            label = radio.parentElement.textContent?.trim().replace(radio.value || '', '').trim() || undefined;
          }

          return {
            name: radio.name || undefined,
            label: label || radio.getAttribute('aria-label') || undefined,
            selector: generateSelector(radio, selectorCounts),
            checked: radio.checked,
            value: radio.value || undefined,
          };
        });

      // ✅ NEW: Extract other interactive elements (div/span/img with onClick, cursor:pointer, tabindex)
      const interactiveElements: any[] = [];

      // Find elements with onClick handlers
      // @ts-ignore - browser context
      const allElements = Array.from(document.querySelectorAll('*'));
      for (const el of allElements) {
        const element: any = el;
        if (!isVisible(element)) continue;

        const tag = element.tagName.toLowerCase();
        const role = element.getAttribute('role');
        const tabindex = element.getAttribute('tabindex');
        // @ts-ignore - browser context
        const style = window.getComputedStyle(element);
        const cursor = style.cursor;

        // Skip already collected elements
        if (['button', 'a', 'input', 'select', 'textarea', 'form'].includes(tag)) continue;
        if (role === 'button' || role === 'link') continue; // Already in buttons/links

        let reason: string | undefined;

        // Check for onClick (inline or event listener)
        // @ts-ignore
        if (element.onclick || element.hasAttribute('onclick') || element.hasAttribute('data-onclick')) {
          reason = 'onclick';
        }
        // Check for cursor pointer (clickable element)
        else if (cursor === 'pointer') {
          reason = 'cursor-pointer';
        }
        // Check for tabindex (focusable element)
        else if (tabindex !== null && parseInt(tabindex) >= 0) {
          reason = 'tabindex';
        }
        // Check for interactive role
        else if (role && ['button', 'link', 'menuitem', 'tab', 'option'].includes(role)) {
          reason = 'role';
        }
        // Check for img/SVG with onClick
        else if ((tag === 'img' || tag === 'svg' || element.tagName === 'SVG') && (element.onclick || element.hasAttribute('onclick'))) {
          reason = 'onclick';
        }

        if (reason) {
          const text = element.textContent?.trim().substring(0, 100) ||
                      element.getAttribute('aria-label') ||
                      element.getAttribute('alt') ||
                      element.getAttribute('title') ||
                      undefined;

          interactiveElements.push({
            tag,
            text,
            selector: generateSelector(element, selectorCounts),
            role: role || undefined,
            tabindex: tabindex ? parseInt(tabindex) : undefined,
            reason,
          });
        }
      }

      // ✅ NEW: Merge Shadow DOM results with regular DOM results
      // Priority: Regular DOM first, then Shadow DOM (for deduplication)
      const allButtons = [
        ...buttons,
        ...shadowDOMResult.buttons.filter(shadowBtn =>
          !buttons.some(btn => btn.selector === shadowBtn.selector)
        ),
      ];

      const allLinks = [
        ...links,
        ...shadowDOMResult.links.filter(shadowLink =>
          !links.some(link => link.selector === shadowLink.selector)
        ),
      ];

      const allInputs = [
        ...inputs,
        ...shadowDOMResult.inputs.filter(shadowInput =>
          !inputs.some(input => input.selector === shadowInput.selector)
        ),
      ];

      const allCheckboxes = [
        ...checkboxes,
        ...shadowDOMResult.checkboxes.filter(shadowCb =>
          !checkboxes.some(cb => cb.selector === shadowCb.selector)
        ),
      ];

      const allRadios = [
        ...radios,
        ...shadowDOMResult.radios.filter(shadowRadio =>
          !radios.some(radio => radio.selector === shadowRadio.selector)
        ),
      ];

      const allInteractiveElements = [
        ...interactiveElements,
        ...shadowDOMResult.interactiveElements.filter(shadowEl =>
          !interactiveElements.some(el => el.selector === shadowEl.selector)
        ),
      ];

      return {
        forms,
        buttons: allButtons.slice(0, 20), // Limit to first 20
        links: allLinks.slice(0, 30), // Limit to first 30
        inputs: allInputs.slice(0, 30), // Limit to first 30
        checkboxes: allCheckboxes.length > 0 ? allCheckboxes.slice(0, 50) : undefined,
        radios: allRadios.length > 0 ? allRadios.slice(0, 50) : undefined,
        interactiveElements: allInteractiveElements.length > 0 ? allInteractiveElements.slice(0, 30) : undefined,
      };
    });

    // ✅ FIX: Enhanced metrics with visibility info and Shadow DOM stats
    const shadowDOMButtons = result.buttons.filter(b => b.inShadowDOM).length;
    const shadowDOMLinks = result.links.filter(l => l.inShadowDOM).length;
    const shadowDOMInputs = result.inputs.filter(i => i.inShadowDOM).length;
    const shadowDOMCheckboxes = result.checkboxes?.filter(c => c.inShadowDOM).length || 0;
    const shadowDOMRadios = result.radios?.filter(r => r.inShadowDOM).length || 0;
    const shadowDOMInteractive = result.interactiveElements?.filter(e => e.inShadowDOM).length || 0;

    // ✅ FIX: Enhanced metrics with visibility info and Shadow DOM stats
    logger.info('DOM analysis completed', {
      formsCount: result.forms.length,
      buttonsCount: result.buttons.length,
      linksCount: result.links.length,
      inputsCount: result.inputs.length,
      checkboxesCount: result.checkboxes?.length || 0,
      radiosCount: result.radios?.length || 0,
      interactiveElementsCount: result.interactiveElements?.length || 0,
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
      visibilityFiltered: true,
      duplicatesHandled: true,
      shadowDOMSupported: true,
    });

    return result;
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
