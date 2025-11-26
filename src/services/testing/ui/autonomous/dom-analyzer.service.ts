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
  }>;
  links: Array<{
    text: string;
    href: string;
    selector: string;
  }>;
  inputs: Array<{
    type: string;
    name?: string;
    placeholder?: string;
    selector: string;
    required: boolean;
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
       */
      function isVisible(element: any): boolean {
        // @ts-expect-error - browser context
        const style = window.getComputedStyle(element);
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          element.offsetWidth > 0 &&
          element.offsetHeight > 0
        );
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
       * Generate unique CSS selector for an element
       */
      function generateSelector(element: any, selectorCounts: Map<string, number>): string {
        // Try ID first (most reliable)
        if (element.id && element.id.length > 0) {
          return `#${element.id}`;
        }

        // Try ARIA label (accessibility-first approach)
        if (element.hasAttribute('aria-label')) {
          const ariaLabel = element.getAttribute('aria-label');
          if (ariaLabel && ariaLabel.length > 0 && ariaLabel.length < 50) {
            const selector = `[aria-label="${escapeSelector(ariaLabel)}"]`;
            return makeUnique(selector, selectorCounts, element);
          }
        }

        // Try name attribute (common for forms)
        if (element.hasAttribute('name')) {
          const name = element.getAttribute('name');
          if (name && name.length > 0) {
            const selector = `${element.tagName.toLowerCase()}[name="${escapeSelector(name)}"]`;
            return makeUnique(selector, selectorCounts, element);
          }
        }

        // Try data-testid or data-cy (test-friendly)
        if (element.hasAttribute('data-testid')) {
          return `[data-testid="${escapeSelector(element.getAttribute('data-testid'))}"]`;
        }
        if (element.hasAttribute('data-cy')) {
          return `[data-cy="${escapeSelector(element.getAttribute('data-cy'))}"]`;
        }

        // Try role attribute (accessibility + semantic)
        if (element.hasAttribute('role')) {
          const role = element.getAttribute('role');
          const roleName = element.hasAttribute('aria-label')
            ? `[role="${role}"][aria-label="${escapeSelector(element.getAttribute('aria-label'))}"]`
            : `[role="${role}"]`;
          return makeUnique(roleName, selectorCounts, element);
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

        // Try placeholder for inputs
        if (element.tagName === 'INPUT' && element.hasAttribute('placeholder')) {
          const placeholder = element.getAttribute('placeholder');
          if (placeholder && placeholder.length > 0) {
            const selector = `input[placeholder="${escapeSelector(placeholder)}"]`;
            return makeUnique(selector, selectorCounts, element);
          }
        }

        // Try text content for buttons (Playwright-friendly)
        if ((element.tagName === 'BUTTON' || element.tagName === 'A') && element.textContent) {
          const text = element.textContent.trim();
          if (text.length > 0 && text.length < 50) {
            const tag = element.tagName.toLowerCase();
            const selector = `${tag}:has-text("${escapeSelector(text)}")`;
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

      // ✅ FIX: Create selector count map to track duplicates
      const selectorCounts = new Map<string, number>();

      // ✅ FIX: Analyze forms (only visible ones)
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

      return {
        forms,
        buttons: buttons.slice(0, 20), // Limit to first 20
        links: links.slice(0, 30), // Limit to first 30
        inputs: inputs.slice(0, 30), // Limit to first 30
      };
    });

    // ✅ FIX: Enhanced metrics with visibility info
    logger.info('DOM analysis completed', {
      formsCount: result.forms.length,
      buttonsCount: result.buttons.length,
      linksCount: result.links.length,
      inputsCount: result.inputs.length,
      totalFields: result.forms.reduce((sum, f) => sum + f.fields.length, 0),
      visibilityFiltered: true,
      duplicatesHandled: true,
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
