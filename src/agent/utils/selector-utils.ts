/**
 * Selector Utilities
 * Centralized selector normalization and locator creation
 * Used by CommandExecutor, IntelligentTestOrchestrator, and other components
 */

import { Page, Locator } from 'playwright';
import { logger } from '@/utils/logger';

// ═══════════════════════════════════════════════════════════════════════════
// ARIA ROLES VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX: Valid ARIA roles for validation
 * Source: https://www.w3.org/TR/wai-aria-1.2/#role_definitions
 */
const VALID_ARIA_ROLES = new Set([
  // Document structure roles
  'article', 'application', 'banner', 'complementary', 'contentinfo', 'document',
  'feed', 'figure', 'footer', 'form', 'heading', 'img', 'list', 'listitem',
  'main', 'navigation', 'region', 'search', 'table', 'row', 'cell',
  // Widget roles
  'alert', 'alertdialog', 'button', 'checkbox', 'dialog', 'gridcell',
  'link', 'log', 'marquee', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
  'option', 'progressbar', 'radio', 'scrollbar', 'searchbox', 'separator',
  'slider', 'spinbutton', 'status', 'switch', 'tab', 'tabpanel', 'textbox',
  'timer', 'tooltip', 'treeitem',
  // Composite widget roles
  'combobox', 'grid', 'listbox', 'menu', 'menubar', 'radiogroup',
  'tablist', 'tree', 'treegrid',
  // Landmark roles
  'banner', 'complementary', 'contentinfo', 'form', 'main', 'navigation',
  'region', 'search',
  // Live region roles
  'alert', 'log', 'marquee', 'status', 'timer',
  // Window roles
  'alertdialog', 'dialog',
  // Abstract roles (not used directly but included for completeness)
  'command', 'composite', 'input', 'landmark', 'range', 'roletype',
  'section', 'sectionhead', 'select', 'structure', 'widget', 'window',
  // Additional common roles
  'group', 'none', 'presentation', 'rowheader', 'columnheader',
  'definition', 'term', 'note', 'toolbar', 'math',
]);

/**
 * Validate ARIA role and log warning if invalid
 */
function validateAriaRole(role: string): boolean {
  const normalizedRole = role.toLowerCase().trim();
  if (!VALID_ARIA_ROLES.has(normalizedRole)) {
    logger.warn('[SELECTOR_UTILS] Invalid ARIA role - may result in empty locator', {
      role,
      validRoles: Array.from(VALID_ARIA_ROLES).slice(0, 10).join(', ') + '...',
    });
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 2: Centralized normalizeSelector to avoid code duplication
 * Normalize selector to Playwright locator format
 * Handles: getByText(), getByRole(), getByLabel(), text=, role=, label=, contextual, CSS, XPath
 * Converts all formats to consistent format that getLocator() can parse
 */
export function normalizeSelector(selector: string): string {
  if (!selector) return selector;

  const s = selector.trim();

  // 1. Convert getByText('text') → text="text"
  const getByTextMatch = s.match(/^getByText\(['"](.+?)['"]\)$/);
  if (getByTextMatch) {
    const text = getByTextMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return `text="${text}"`;
  }

  // 2. Convert getByLabel('label') → label="label"
  const getByLabelMatch = s.match(/^getByLabel\(['"](.+?)['"]\)$/);
  if (getByLabelMatch) {
    const label = getByLabelMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return `label="${label}"`;
  }

  // 3. Convert getByRole('role'[, {name: 'text'}]) → role=role[name="text"]
  const getByRoleMatch = s.match(/^getByRole\(['"](.+?)['"]\s*(?:,\s*\{name:\s*['"](.+?)['"]\})?\)$/);
  if (getByRoleMatch) {
    const role = getByRoleMatch[1];
    const name = getByRoleMatch[2];
    if (name) {
      const escapedName = name.replace(/\\'/g, "'").replace(/\\"/g, '"');
      return `role=${role}[name="${escapedName}"]`;
    }
    return `role=${role}`;
  }

  // 4. Normalize text= format: text='...' → text="..."
  const textSingleQuoteMatch = s.match(/^text\s*=\s*'(.+?)'$/);
  if (textSingleQuoteMatch) {
    return `text="${textSingleQuoteMatch[1]}"`;
  }

  // 5. Normalize role= format: role=button[name='...'] → role=button[name="..."]
  const roleSingleQuoteMatch = s.match(/^role\s*=\s*([^\[\s]+)\[name\s*=\s*'(.+?)'\]$/);
  if (roleSingleQuoteMatch) {
    return `role=${roleSingleQuoteMatch[1]}[name="${roleSingleQuoteMatch[2]}"]`;
  }

  // 6. Normalize label= format: label='...' → label="..."
  const labelSingleQuoteMatch = s.match(/^label\s*=\s*'(.+?)'$/);
  if (labelSingleQuoteMatch) {
    return `label="${labelSingleQuoteMatch[1]}"`;
  }

  // 7. Convert contextual locators to CSS (if simple enough)
  // button:has-text("Login") → text="Login" (simpler and more reliable)
  const hasTextMatch = s.match(/^(button|a|div|span):has-text\(['"](.+?)['"]\)$/);
  if (hasTextMatch) {
    return `text="${hasTextMatch[2]}"`;
  }

  // Already in correct format or CSS/XPath selector
  return s;
}

// ═══════════════════════════════════════════════════════════════════════════
// LOCATOR CREATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 2: Centralized getLocator to avoid code duplication
 * Get Playwright locator based on selector type
 * Supports: text=, role=, label=, regex, contextual, CSS, XPath
 * Uses proper Playwright API methods (getByText, getByRole, getByLabel) instead of locator()
 * @returns Locator - all Playwright methods return Locator type
 */
export function getLocator(page: Page, selector: string): Locator {
  if (!selector) {
    throw new Error('Selector is required');
  }

  const s = selector.trim();

  // 1. Handle text= format (with or without quotes, with or without regex)
  // Formats: text="Login", text=Login, text=/Login/i
  const textMatch = s.match(/^text\s*=\s*(.+)$/i);
  if (textMatch) {
    let payload = textMatch[1].trim();

    // Check if it's a regex: /pattern/flags
    const regexMatch = payload.match(/^\/(.+?)\/([gimsuy]*)$/);
    if (regexMatch) {
      try {
        // ✅ FIX: Validate regex flags before creating RegExp
        const pattern = regexMatch[1];
        const flags = regexMatch[2];

        // Validate flags (only g, i, m, s, u, y are valid)
        if (flags && !/^[gimsuy]*$/.test(flags)) {
          logger.warn('[SELECTOR_UTILS] Invalid regex flags, treating as plain text', {
            selector: s,
            flags,
          });
          // Fallback: treat as plain text
          payload = payload.replace(/^["']|["']$/g, '');
          return page.getByText(payload);
        }

        const regex = new RegExp(pattern, flags);
        return page.getByText(regex);
      } catch (regexError) {
        logger.warn('[SELECTOR_UTILS] Invalid regex pattern, treating as plain text', {
          selector: s,
          error: regexError instanceof Error ? regexError.message : String(regexError),
        });
        // Fallback: treat as plain text (remove regex delimiters)
        payload = regexMatch[1]; // Use pattern without delimiters
        return page.getByText(payload);
      }
    }

    // Remove quotes if present
    payload = payload.replace(/^["']|["']$/g, '');

    // Check if should be exact match (originally had quotes)
    const isExact = textMatch[1].includes('"') || textMatch[1].includes("'");

    return page.getByText(payload, { exact: isExact });
  }

  // 2. Handle label= format (with or without quotes)
  // Formats: label="Email", label=Email
  const labelMatch = s.match(/^label\s*=\s*(.+)$/i);
  if (labelMatch) {
    let label = labelMatch[1].trim().replace(/^["']|["']$/g, '');
    return page.getByLabel(label);
  }

  // 3. Handle role= format (with or without name, with or without regex)
  // Formats: role=button, role=button[name="Login"], role=button[name=/Login/i]
  const roleMatch = s.match(/^role\s*=\s*([^\[\s]+)(?:\s*\[name\s*=\s*(.+?)\])?$/i);
  if (roleMatch) {
    const role = roleMatch[1].trim() as any;
    let name = roleMatch[2]?.trim();

    // ✅ FIX 4: Validate ARIA role
    validateAriaRole(role);

    if (name) {
      // Check if name is a regex: /pattern/flags
      const nameRegexMatch = name.match(/^\/(.+?)\/([gimsuy]*)$/);
      if (nameRegexMatch) {
        try {
          // ✅ FIX: Validate regex flags before creating RegExp
          const pattern = nameRegexMatch[1];
          const flags = nameRegexMatch[2];

          // Validate flags
          if (flags && !/^[gimsuy]*$/.test(flags)) {
            logger.warn('[SELECTOR_UTILS] Invalid regex flags in role name, treating as plain text', {
              selector: s,
              flags,
            });
            // Fallback: treat as plain text
            name = pattern;
            return page.getByRole(role, { name });
          }

          const regex = new RegExp(pattern, flags);
          return page.getByRole(role, { name: regex });
        } catch (regexError) {
          logger.warn('[SELECTOR_UTILS] Invalid regex pattern in role name, treating as plain text', {
            selector: s,
            error: regexError instanceof Error ? regexError.message : String(regexError),
          });
          // Fallback: use pattern without delimiters
          name = nameRegexMatch[1];
          return page.getByRole(role, { name });
        }
      }

      // Remove quotes if present
      name = name.replace(/^["']|["']$/g, '');
      return page.getByRole(role, { name });
    }

    return page.getByRole(role);
  }

  // 4. Handle contextual locators (has-text, >>, :has, :scope)
  // These are Playwright-specific CSS extensions
  if (s.includes('>>') || s.includes(':has-text(') || s.includes(':has(') || s.includes(':scope')) {
    return page.locator(s);
  }

  // 5. Handle XPath: starts with / or // or xpath=
  if (s.match(/^(xpath\s*=\s*)?\/{1,2}/i)) {
    const xpath = s.startsWith('xpath=') ? s.slice(6).trim() : s;
    return page.locator(`xpath=${xpath}`);
  }

  // 6. Handle CSS selector (default)
  // Includes: #id, .class, [attr="value"], tag, etc.
  return page.locator(s);
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR VALIDATION & DRY-RUN
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 1 & 3: Validate selector with dry-run before execution
 * Checks: exists, visible, actionable (for click actions)
 * Returns the validated locator to avoid race conditions
 */
export async function validateAndGetLocator(
  page: Page,
  selector: string,
  options: {
    actionType?: 'click' | 'fill' | 'type' | 'select' | 'check' | 'uncheck' | 'hover' | 'other';
    timeout?: number;
  } = {}
): Promise<{
  success: boolean;
  locator?: Locator;
  error?: string;
  count?: number;
  isVisible?: boolean;
  isActionable?: boolean;
}> {
  const { actionType = 'other', timeout = 2000 } = options;

  try {
    // Normalize selector
    const normalizedSelector = normalizeSelector(selector);

    // Get locator
    const locator = getLocator(page, normalizedSelector).first(); // ✅ FIX 1: Use .first() to avoid race conditions

    // Check count
    const count = await locator.count();
    if (count === 0) {
      return {
        success: false,
        error: `Selector not found: ${normalizedSelector}`,
        count: 0,
      };
    }

    // Check visibility (for all interactive actions)
    let isVisible = false;
    try {
      await locator.waitFor({ state: 'visible', timeout });
      isVisible = true;
    } catch (visibilityError) {
      return {
        success: false,
        locator,
        error: `Element not visible: ${normalizedSelector}`,
        count,
        isVisible: false,
      };
    }

    // Check actionability (for click actions)
    let isActionable = true;
    if (actionType === 'click') {
      try {
        isActionable = await locator.evaluate((el) => {
          // @ts-ignore - browser context
          const rect = el.getBoundingClientRect();
          const centerX = rect.left + rect.width / 2;
          const centerY = rect.top + rect.height / 2;
          // @ts-ignore - browser context
          const topElement = document.elementFromPoint(centerX, centerY);
          return topElement === el || el.contains(topElement);
        }).catch(() => false);

        if (!isActionable) {
          logger.warn('[SELECTOR_UTILS] Element not actionable (covered by another element)', {
            selector: normalizedSelector,
          });
          // Don't fail - might still work, just warn
        }
      } catch (actionabilityError) {
        // Continue anyway - might become actionable during action
        logger.debug('[SELECTOR_UTILS] Actionability check failed', {
          selector: normalizedSelector,
          error: actionabilityError instanceof Error ? actionabilityError.message : String(actionabilityError),
        });
      }
    }

    return {
      success: true,
      locator, // ✅ FIX 1: Return the same locator to avoid race conditions
      count,
      isVisible,
      isActionable,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR CLASSIFICATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ FIX 4: Robust selector error detection using Playwright error types
 * Detects selector-related errors reliably (not just string matching)
 */
export function isSelectorRelatedError(error: any): boolean {
  if (!error) return false;

  // Check Playwright error name
  const errorName = error.name || '';
  if (errorName === 'TimeoutError') {
    // TimeoutError can be selector-related if message mentions locator/selector
    const message = (error.message || '').toLowerCase();
    return message.includes('locator') ||
           message.includes('selector') ||
           message.includes('waiting for') ||
           message.includes('element');
  }

  // Check error message patterns (as fallback)
  const message = (error.message || '').toLowerCase();
  const selectorErrorPatterns = [
    /selector.*not.*found/i,
    /element.*not.*found/i,
    /no.*element.*matches/i,
    /waiting for selector/i,
    /locator.*resolved to/i,
    /strict mode violation/i, // Multiple elements found
    /element is not visible/i,
    /element is not attached/i,
  ];

  return selectorErrorPatterns.some(pattern => pattern.test(message));
}
