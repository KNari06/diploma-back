import { Page } from 'playwright';
import { logger } from '@/utils/logger';

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
      // @ts-ignore - browser context has DOM types
      /**
       * Generate unique CSS selector for an element
       */
      function generateSelector(element: any): string {
        // Try ID first
        if (element.id) {
          return `#${element.id}`;
        }

        // Try name attribute
        if (element.hasAttribute('name')) {
          const name = element.getAttribute('name');
          return `${element.tagName.toLowerCase()}[name="${name}"]`;
        }

        // Try data-testid or data-cy
        if (element.hasAttribute('data-testid')) {
          return `[data-testid="${element.getAttribute('data-testid')}"]`;
        }
        if (element.hasAttribute('data-cy')) {
          return `[data-cy="${element.getAttribute('data-cy')}"]`;
        }

        // Try class if it looks meaningful
        if (element.className && typeof element.className === 'string') {
          const classes = element.className.split(' ').filter((c: any) =>
            c && !c.match(/^(btn|button|input|form|active|focus|hover|disabled)$/)
          );
          if (classes.length > 0 && classes.length < 3) {
            return `.${classes.join('.')}`;
          }
        }

        // Try placeholder for inputs
        if (element.tagName === 'INPUT' && element.hasAttribute('placeholder')) {
          return `input[placeholder="${element.getAttribute('placeholder')}"]`;
        }

        // Try text content for buttons
        if (element.tagName === 'BUTTON' && element.textContent) {
          const text = element.textContent.trim();
          if (text.length > 0 && text.length < 30) {
            return `button:has-text("${text}")`;
          }
        }

        // Fallback to nth-of-type
        const parent = element.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((e: any) => e.tagName === element.tagName);
          const index = siblings.indexOf(element);
          return `${element.tagName.toLowerCase()}:nth-of-type(${index + 1})`;
        }

        return element.tagName.toLowerCase();
      }

      // Analyze forms
      // @ts-expect-error - browser context
      const forms = Array.from(document.querySelectorAll('form')).map((form: any) => {
        const fields = Array.from(form.querySelectorAll('input, select, textarea')).map((field: any) => {
          const input = field;
          return {
            name: input.name || input.id || '',
            type: input.type || input.tagName.toLowerCase(),
            required: input.hasAttribute('required') || input.getAttribute('aria-required') === 'true',
            selector: generateSelector(field),
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

      // @ts-expect-error - browser context
      // Analyze buttons
      const buttons = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]')).map((btn: any) => {
        const button = btn;
        return {
          text: button.textContent?.trim() || button.value || '',
          selector: generateSelector(btn),
          type: button.type || 'button',
        };
      });

      // @ts-expect-error - browser context
      // Analyze links
      const links = Array.from(document.querySelectorAll('a[href]')).map((link: any) => {
        const anchor = link;
        return {
          text: anchor.textContent?.trim() || '',
          href: anchor.href,
          selector: generateSelector(link),
        };
      }).filter((l: any) => l.text.length > 0); // Only links with text

      // @ts-expect-error - browser context
      // Analyze all inputs (including those outside forms)
      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).map((input: any) => {
        const field = input;
        return {
          type: field.type || field.tagName.toLowerCase(),
          name: field.name || field.id || undefined,
          placeholder: field.getAttribute('placeholder') || undefined,
          selector: generateSelector(input),
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

    logger.info('DOM analysis completed', {
      formsCount: result.forms.length,
      buttonsCount: result.buttons.length,
      linksCount: result.links.length,
      inputsCount: result.inputs.length,
    });

    return result;
  } catch (error) {
    logger.error('DOM analysis failed', { error });

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
