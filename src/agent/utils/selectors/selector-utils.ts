/**
 * Selector Utilities
 * Centralized selector normalization and locator creation
 * Used by CommandExecutor, IntelligentTestOrchestrator, and other components
 */

import { AISelectorEngine } from '@/services/ai-selector/ai-selector-engine.service';
import { logger } from '@/utils/core/logger';
import { Locator, Page } from 'playwright';

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
// SELECTOR VALIDATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if selector is valid Playwright format
 * Returns validation result with details
 */
export function validateSelectorFormat(selector: string): {
  isValid: boolean;
  format: 'playwright' | 'css' | 'xpath' | 'mixed' | 'unknown';
  issue?: string;
} {
  if (!selector) {
    return { isValid: false, format: 'unknown', issue: 'Empty selector' };
  }

  const s = selector.trim();

  // Check for mixed CSS + Playwright (INVALID)
  if (s.match(/^[.#\[].*\s*>\s*(role|text|label)\s*=/)) {
    return {
      isValid: false,
      format: 'mixed',
      issue: 'Mixed CSS + Playwright format (e.g., ".class > role=button"). Use pure Playwright or pure CSS.',
    };
  }

  // Check for space-separated mixed (INVALID)
  if (s.match(/^[.#\[].*\s+(role|text|label)\s*=/)) {
    return {
      isValid: false,
      format: 'mixed',
      issue: 'Mixed CSS + Playwright format. Use pure Playwright or pure CSS.',
    };
  }

  // Valid Playwright formats
  if (s.match(/^(role|text|label)\s*=/i)) {
    return { isValid: true, format: 'playwright' };
  }

  // Valid XPath
  if (s.match(/^(xpath\s*=)?\/{1,2}/i)) {
    return { isValid: true, format: 'xpath' };
  }

  // Valid CSS (starts with #, ., [, or tag name)
  if (s.match(/^[#.\[]/) || s.match(/^[a-z][a-z0-9]*(\[|$)/i)) {
    return { isValid: true, format: 'css' };
  }

  // Chained selector (>>) - valid for Shadow DOM
  if (s.includes('>>')) {
    return { isValid: true, format: 'playwright' };
  }

  return { isValid: true, format: 'unknown' };
}

// ═══════════════════════════════════════════════════════════════════════════
// SELECTOR NORMALIZATION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize selector to Playwright locator format
 * Handles: getByText(), getByRole(), getByLabel(), text=, role=, label=, contextual, CSS, XPath
 *
 * ⚠️ IMPORTANT: This function now EXTRACTS Playwright part from mixed selectors
 * instead of creating chained selectors (which caused issues)
 */
export function normalizeSelector(selector: string): string {
  if (!selector) return selector;

  const s = selector.trim();

  // ✅ EARLY RETURN: If selector is already normalized (contains >>), return as-is
  // This prevents double-processing and corruption like ".relative > >> role=textbox"
  if (s.includes('>>')) {
    // ✅ FIX: Clean up corrupted selectors like ".relative > >> role=textbox"
    // This can happen if selector was double-processed by old code
    if (s.includes(' > >>')) {
      const cleaned = s.replace(/ > >>/g, ' >>');
      logger.warn('[SELECTOR_UTILS] Cleaning corrupted selector (> >>)', {
        original: s,
        cleaned,
      });
      return cleaned;
    }
    // Already normalized - return without further processing
    return s;
  }

  // 1. Convert getByText('text') → text="text"
  const getByTextMatch = s.match(/^getByText\(['"](.+?)['"]\)$/);
  if (getByTextMatch) {
    const text = getByTextMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return `text="${text}"`;
  }

  // 2. Convert getByTestId('id') → testid="id"
  const getByTestIdMatch = s.match(/^getByTestId\(['"](.+?)['"]\)$/);
  if (getByTestIdMatch) {
    const testId = getByTestIdMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return `testid="${testId}"`;
  }

  // 3. Convert getByLabel('label') → label="label"
  const getByLabelMatch = s.match(/^getByLabel\(['"](.+?)['"]\)$/);
  if (getByLabelMatch) {
    const label = getByLabelMatch[1].replace(/\\'/g, "'").replace(/\\"/g, '"');
    return `label="${label}"`;
  }

  // 4. Convert getByRole('role'[, {name: 'text'}]) → role=role[name="text"]
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

  // 5. Normalize testid= format: testid='...' → testid="..."
  const testidSingleQuoteMatch = s.match(/^testid\s*=\s*'(.+?)'$/);
  if (testidSingleQuoteMatch) {
    return `testid="${testidSingleQuoteMatch[1]}"`;
  }

  // 6. Normalize role= format: role=button[name='...'] → role=button[name="..."]
  const roleSingleQuoteMatch = s.match(/^role\s*=\s*([^\[\s]+)\[name\s*=\s*'(.+?)'\]$/);
  if (roleSingleQuoteMatch) {
    return `role=${roleSingleQuoteMatch[1]}[name="${roleSingleQuoteMatch[2]}"]`;
  }

  // 7. Normalize label= format: label='...' → label="..."
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

  // ✅ FIX: Handle invalid mixed selectors like ".relative > role=textbox"
  // AI sometimes generates CSS + Playwright syntax mixed
  // SOLUTION: Extract ONLY the Playwright part (more reliable than chaining)
  // Pattern: .selector > role=something OR .selector > text=something
  if (!s.includes('>>')) {
    const mixedSelectorMatch = s.match(/^.+?\s*>\s*(role|text|label)\s*=\s*(.+)$/);
    if (mixedSelectorMatch) {
      const playwrightType = mixedSelectorMatch[1];
      const playwrightValue = mixedSelectorMatch[2].trim();
      const extracted = `${playwrightType}=${playwrightValue}`;

      logger.warn('[SELECTOR_UTILS] Extracted Playwright selector from mixed format', {
        original: s,
        extracted,
        reason: 'Mixed CSS + Playwright selectors are not supported',
      });

      // Return ONLY the Playwright part (ignore CSS prefix)
      return extracted;
    }
  }

  // ✅ FIX: Handle pattern: ".selector role=something" (space separated, no >)
  if (!s.includes('>>')) {
    const mixedWithSpaceMatch = s.match(/^.+?\s+(role|text|label)\s*=\s*(.+)$/);
    if (mixedWithSpaceMatch) {
      const potentialCss = s.split(/\s+(role|text|label)\s*=/)[0].trim();
      const playwrightType = mixedWithSpaceMatch[1];
      const playwrightValue = mixedWithSpaceMatch[2].trim();

      // Only fix if first part looks like CSS selector
      if (/^[.#\[]|^[a-z]/i.test(potentialCss)) {
        const extracted = `${playwrightType}=${playwrightValue}`;

        logger.warn('[SELECTOR_UTILS] Extracted Playwright selector from mixed format', {
          original: s,
          extracted,
          reason: 'Mixed CSS + Playwright selectors are not supported',
        });

        // Return ONLY the Playwright part
        return extracted;
      }
    }
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

  // 2. Handle testid= format (Playwright API for data-testid)
  // Formats: testid="login-button", testid=login-button
  const testidMatch = s.match(/^testid\s*=\s*(.+)$/i);
  if (testidMatch) {
    let testId = testidMatch[1].trim().replace(/^["']|["']$/g, '');
    return page.getByTestId(testId);
  }

  // 3. Handle label= format (with or without quotes)
  // Formats: label="Email", label=Email
  const labelMatch = s.match(/^label\s*=\s*(.+)$/i);
  if (labelMatch) {
    let label = labelMatch[1].trim().replace(/^["']|["']$/g, '');
    return page.getByLabel(label);
  }

  // 4. Handle role= format (with or without name, with or without regex)
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
    // ✅ FIX: Handle chained selectors with role=/text=/label= after >>
    // Example: ".relative >> role=textbox" → use proper Playwright chaining
    if (s.includes('>>')) {
      const parts = s.split('>>').map(p => p.trim());

      // Start with first part (usually CSS selector)
      let locator = page.locator(parts[0]);

      // Chain remaining parts using proper Playwright methods
      for (let i = 1; i < parts.length; i++) {
        const part = parts[i];

        // Handle role=value
        const roleMatch = part.match(/^role\s*=\s*(.+?)(?:\[name\s*=\s*["']?(.+?)["']?\])?$/);
        if (roleMatch) {
          const role = roleMatch[1].trim() as any;
          const name = roleMatch[2]?.trim();
          validateAriaRole(role);

          if (name) {
            // Remove quotes if present
            const cleanName = name.replace(/^["']|["']$/g, '');
            locator = locator.getByRole(role, { name: cleanName });
          } else {
            locator = locator.getByRole(role);
          }
          continue;
        }

        // Handle text="value"
        const textMatch = part.match(/^text\s*=\s*["']?(.+?)["']?$/);
        if (textMatch) {
          const text = textMatch[1];
          // Check if it's a regex
          const regexMatch = text.match(/^\/(.+?)\/([gimsuy]*)$/);
          if (regexMatch) {
            try {
              const regex = new RegExp(regexMatch[1], regexMatch[2]);
              locator = locator.getByText(regex);
            } catch {
              locator = locator.getByText(text);
            }
          } else {
            locator = locator.getByText(text);
          }
          continue;
        }

        // Handle label="value"
        const labelMatch = part.match(/^label\s*=\s*["']?(.+?)["']?$/);
        if (labelMatch) {
          const label = labelMatch[1];
          locator = locator.getByLabel(label);
          continue;
        }

        // Handle testid="value"
        const testidMatch = part.match(/^testid\s*=\s*["']?(.+?)["']?$/);
        if (testidMatch) {
          const testId = testidMatch[1];
          locator = locator.getByTestId(testId);
          continue;
        }

        // Fallback: treat as CSS selector
        locator = locator.locator(part);
      }

      logger.debug('[SELECTOR_UTILS] Processed chained selector', {
        original: s,
        parts: parts.length,
        method: 'chained_locator',
      });
      return locator;
    }

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
  isDisabled?: boolean; // ✅ NEW
  disabledReason?: string; // ✅ NEW
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

    // ✅ IMPROVED: Universal disabled check (context-aware)
    // Checks both element and parent disabled state (fieldset, etc.)
    let isDisabled = false;
    let disabledReason: string | undefined;
    if (actionType === 'click' || actionType === 'fill' || actionType === 'type') {
      try {
        const disabledInfo = await locator.evaluate((el: any, actionType: string) => {
          const htmlEl = el;
          const result: { disabled: boolean; reason: string | null } = { disabled: false, reason: null };

          // ✅ UNIVERSAL: Check element's own disabled state
          if ('disabled' in htmlEl && (htmlEl as any).disabled === true) {
            result.disabled = true;
            result.reason = 'disabled attribute';
            return result;
          }

          // 2. ARIA disabled attribute (universal for all elements)
          const ariaDisabled = htmlEl.getAttribute('aria-disabled');
          if (ariaDisabled === 'true') {
            result.disabled = true;
            result.reason = 'aria-disabled="true"';
            return result;
          }

          // 3. ✅ CONTEXT-AWARE: readonly only blocks fill/type, not click
          // readonly inputs can be clicked (to view value) but not filled
          if (actionType === 'fill' || actionType === 'type') {
            if ('readOnly' in htmlEl && (htmlEl as any).readOnly === true) {
              result.disabled = true;
              result.reason = 'readonly attribute (blocks fill/type)';
              return result;
            }
          }

          // ✅ UNIVERSAL: Check parent disabled state (fieldset, form)
          // If element is inside a disabled fieldset, it's also disabled
          let parent = htmlEl.parentElement;
          // @ts-ignore - browser context (document is available in page.evaluate)
          while (parent && parent !== document.body) {
            if (parent.tagName === 'FIELDSET' && (parent as any).disabled === true) {
              result.disabled = true;
              result.reason = 'parent fieldset is disabled';
              return result;
            }
            parent = parent.parentElement;
          }

          // ✅ UNIVERSAL: Check CSS pointer-events (blocks all interactions)
          // @ts-ignore - browser context
          const computedStyle = (window as any).getComputedStyle(htmlEl);
          if (computedStyle && computedStyle.pointerEvents === 'none') {
            result.disabled = true;
            result.reason = 'pointer-events: none (CSS)';
            return result;
          }

          // ✅ REMOVED: cursor: not-allowed check (too unreliable)
          // - Not all disabled elements have this cursor
          // - Some enabled elements might have it for other reasons
          // - It's a visual indicator, not a functional state

          return result;
        }, actionType).catch(() => ({ disabled: false, reason: null }));

        isDisabled = disabledInfo.disabled;
        disabledReason = disabledInfo.reason || undefined;

        if (isDisabled) {
          logger.warn('[SELECTOR_UTILS] Element is DISABLED', {
            selector: normalizedSelector,
            actionType,
            reason: disabledReason,
          });
          // Return failure for disabled elements
          return {
            success: false,
            locator,
            error: `Element is disabled (${disabledReason}): ${normalizedSelector}`,
            count,
            isVisible,
            isDisabled: true,
            disabledReason,
          };
        }
      } catch (disabledCheckError) {
        logger.debug('[SELECTOR_UTILS] Disabled check failed', {
          selector: normalizedSelector,
          error: disabledCheckError instanceof Error ? disabledCheckError.message : String(disabledCheckError),
        });
      }
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
      isDisabled: false, // ✅ NEW: Element is enabled
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// DISABLED ELEMENT DETECTION (for AI decision making)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * ✅ NEW: Check if element is disabled and get context for AI
 * Returns detailed information for AI to make intelligent decisions
 */
export async function getElementDisabledContext(
  page: Page,
  selector: string
): Promise<{
  isDisabled: boolean;
  reason?: string;
  alternatives?: string[]; // Suggested alternative selectors
  context?: {
    formValidation?: boolean; // Is this part of a form that needs validation?
    authRequired?: boolean; // Does this require authentication?
    dependsOn?: string[]; // What other elements must be filled first?
  };
}> {
  try {
    const normalizedSelector = normalizeSelector(selector);
    const locator = getLocator(page, normalizedSelector).first();

    // Check if element exists
    const count = await locator.count();
    if (count === 0) {
      return {
        isDisabled: false,
        reason: 'Element not found',
      };
    }

    // Get comprehensive disabled info
    const info = await locator.evaluate((el: any) => {
      const htmlEl = el;
      const result: any = {
        isDisabled: false,
        reason: null,
        alternatives: [],
        context: {},
      };

      // Check disabled state
      if ('disabled' in htmlEl && (htmlEl as any).disabled === true) {
        result.isDisabled = true;
        result.reason = 'disabled attribute';
      } else if (htmlEl.getAttribute('aria-disabled') === 'true') {
        result.isDisabled = true;
        result.reason = 'aria-disabled="true"';
      } else if ('readOnly' in htmlEl && (htmlEl as any).readOnly === true) {
        result.isDisabled = true;
        result.reason = 'readonly attribute';
        } else {
          // @ts-ignore - browser context
          const computedStyle = (window as any).getComputedStyle(htmlEl);
          if (computedStyle.pointerEvents === 'none') {
          result.isDisabled = true;
          result.reason = 'pointer-events: none';
        } else if (computedStyle.cursor === 'not-allowed') {
          result.isDisabled = true;
          result.reason = 'cursor: not-allowed';
        }
      }

      // If disabled, gather context for AI
      if (result.isDisabled) {
        // Check if part of a form
        const form = htmlEl.closest('form');
        if (form) {
          result.context.formValidation = true;

          // Find required inputs in the form
          const requiredInputs = Array.from(form.querySelectorAll('input[required], select[required], textarea[required]'));
          const emptyRequired = requiredInputs.filter((input: any) => {
            if (input.type === 'checkbox' || input.type === 'radio') {
              return !input.checked;
            }
            return !input.value || input.value.trim() === '';
          });

          if (emptyRequired.length > 0) {
            result.context.dependsOn = emptyRequired.map((input: any) => {
              return input.name || input.id || input.placeholder || input.type;
            });
          }
        }

        // Check for auth indicators
        const authKeywords = ['login', 'sign in', 'authenticate', 'auth', 'unauthorized'];
        // @ts-ignore - browser context
        const bodyText = document.body.textContent?.toLowerCase() || '';
        result.context.authRequired = authKeywords.some((keyword: string) => bodyText.includes(keyword));

        // Find similar enabled elements (alternatives)
        const tagName = htmlEl.tagName.toLowerCase();
        const text = htmlEl.textContent?.trim() || '';

        // Look for similar buttons/links that are NOT disabled
        // @ts-ignore - browser context
        const similarElements = Array.from(document.querySelectorAll(`${tagName}:not([disabled]):not([aria-disabled="true"])`));
        result.alternatives = similarElements
          .filter((el: any) => {
            const elText = el.textContent?.trim() || '';
            // Find elements with similar text
            return elText && text && (
              elText.includes(text) ||
              text.includes(elText) ||
              elText.toLowerCase() === text.toLowerCase()
            );
          })
          .slice(0, 3) // Max 3 alternatives
          .map((el: any) => {
            // Generate selector for alternative
            if (el.id) return `#${el.id}`;
            if (el.className) return `.${el.className.split(' ')[0]}`;
            return tagName;
          });
      }

      return result;
    }).catch(() => ({
      isDisabled: false,
      reason: 'Evaluation failed',
    }));

    return info;
  } catch (error) {
    logger.error('[SELECTOR_UTILS] Failed to get disabled context', {
      selector,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      isDisabled: false,
      reason: 'Check failed',
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

// ═══════════════════════════════════════════════════════════════════════════
// SMART LOCATOR - ACTION-AWARE ELEMENT SELECTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Action types and their preferred element types
 * This defines what kind of elements are expected for each action
 */
const ACTION_ELEMENT_PREFERENCES: Record<string, {
  preferredTags: string[];
  preferredRoles: string[];
  requiresInteractive: boolean;
}> = {
  // Click actions - need interactive elements
  click: {
    preferredTags: ['button', 'a', 'input', 'select', 'label'],
    preferredRoles: ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option'],
    requiresInteractive: true,
  },
  dblclick: {
    preferredTags: ['button', 'a', 'input', 'div', 'span'],
    preferredRoles: ['button', 'link', 'menuitem'],
    requiresInteractive: true,
  },

  // Input actions - need input elements
  fill: {
    preferredTags: ['input', 'textarea'],
    preferredRoles: ['textbox', 'searchbox', 'spinbutton'],
    requiresInteractive: true,
  },
  type: {
    preferredTags: ['input', 'textarea'],
    preferredRoles: ['textbox', 'searchbox'],
    requiresInteractive: true,
  },

  // Selection actions
  select: {
    preferredTags: ['select'],
    preferredRoles: ['combobox', 'listbox'],
    requiresInteractive: true,
  },
  check: {
    preferredTags: ['input'],
    preferredRoles: ['checkbox', 'switch'],
    requiresInteractive: true,
  },
  uncheck: {
    preferredTags: ['input'],
    preferredRoles: ['checkbox', 'switch'],
    requiresInteractive: true,
  },

  // Hover/Focus - any visible element
  hover: {
    preferredTags: ['button', 'a', 'div', 'span', 'img'],
    preferredRoles: ['button', 'link', 'img', 'menuitem'],
    requiresInteractive: false,
  },
  focus: {
    preferredTags: ['input', 'textarea', 'button', 'a', 'select'],
    preferredRoles: ['textbox', 'button', 'link', 'combobox'],
    requiresInteractive: true,
  },

  // Scroll - any element
  scroll: {
    preferredTags: [],
    preferredRoles: [],
    requiresInteractive: false,
  },
  scrollIntoView: {
    preferredTags: [],
    preferredRoles: [],
    requiresInteractive: false,
  },

  // Assertions - any element with text
  assertVisible: {
    preferredTags: [],
    preferredRoles: [],
    requiresInteractive: false,
  },
  assertText: {
    preferredTags: [],
    preferredRoles: [],
    requiresInteractive: false,
  },
  assertValue: {
    preferredTags: ['input', 'textarea', 'select'],
    preferredRoles: ['textbox', 'combobox'],
    requiresInteractive: false,
  },

  // Default for unknown actions
  default: {
    preferredTags: [],
    preferredRoles: [],
    requiresInteractive: false,
  },
};

/**
 * Element analysis result from browser context
 */
interface ElementAnalysis {
  index: number;
  tag: string;
  role: string | null;
  isInteractive: boolean;
  isVisible: boolean;
  isInViewport: boolean;
  hasClickHandler: boolean;
  cursorPointer: boolean;
  text: string;
  score: number; // Calculated preference score
}

/**
 * ✅ NEW: Smart locator that selects the right element based on action context
 *
 * This solves the problem where text="Математика" finds <span> instead of <button>
 * by analyzing all matching elements and selecting the most appropriate one
 * based on the action type.
 *
 * Uses hybrid approach:
 * 1. Static rules first (fast, cheap) - tag, role, interactivity
 * 2. AI fallback if ambiguous (when multiple elements have similar scores)
 *
 * @param page - Playwright page
 * @param selector - Original selector (e.g., text="Математика")
 * @param actionType - The action to perform (click, fill, select, etc.)
 * @param intent - Optional: action description for AI context (e.g., "Click on the 'Математика' button to select this subject")
 * @param useAI - Optional: force AI usage even if not ambiguous (default: auto-detect)
 * @returns The most appropriate locator for the action
 */
export async function getSmartLocator(
  page: Page,
  selector: string,
  actionType: string,
  intent?: string,
  useAI: boolean | 'auto' = 'auto'
): Promise<{
  locator: Locator;
  wasSmartSelected: boolean;
  selectedIndex: number;
  totalMatches: number;
  usedAI: boolean;
  analysis?: ElementAnalysis[];
}> {
  const normalizedSelector = normalizeSelector(selector);
  const preferences = ACTION_ELEMENT_PREFERENCES[actionType] || ACTION_ELEMENT_PREFERENCES.default;

  // Get base locator
  const baseLocator = getLocator(page, normalizedSelector);

  // Check how many elements match
  const count = await baseLocator.count().catch(() => 0);

  // If 0 or 1 element, no smart selection needed
  if (count <= 1) {
    return {
      locator: baseLocator.first(),
      wasSmartSelected: false,
      selectedIndex: 0,
      totalMatches: count,
      usedAI: false,
    };
  }

  logger.debug('[SELECTOR_UTILS] Multiple elements found, using smart selection', {
    selector: normalizedSelector.substring(0, 50),
    count,
    actionType,
  });

  // Analyze all matching elements
  const analysisResults: ElementAnalysis[] = [];

  for (let i = 0; i < Math.min(count, 10); i++) { // Limit to 10 elements for performance
    const element = baseLocator.nth(i);

    try {
      const analysis = await element.evaluate((el, prefs) => {
        // @ts-ignore - browser context
        const tag = el.tagName.toLowerCase();
        // @ts-ignore - browser context
        const explicitRole = el.getAttribute('role');

        // ✅ FIX: Get implicit ARIA role based on HTML element
        // HTML elements have implicit roles even without role="" attribute
        const implicitRoleMap: Record<string, string> = {
          'button': 'button',
          'a': 'link',
          'input': 'textbox', // simplified, depends on type
          'textarea': 'textbox',
          'select': 'combobox',
          'option': 'option',
          'img': 'img',
          'nav': 'navigation',
          'main': 'main',
          'header': 'banner',
          'footer': 'contentinfo',
          'aside': 'complementary',
          'form': 'form',
          'article': 'article',
          'section': 'region',
          'ul': 'list',
          'ol': 'list',
          'li': 'listitem',
          'table': 'table',
          'tr': 'row',
          'td': 'cell',
          'th': 'columnheader',
          'h1': 'heading',
          'h2': 'heading',
          'h3': 'heading',
          'h4': 'heading',
          'h5': 'heading',
          'h6': 'heading',
        };

        // Special case for input types
        // @ts-ignore - browser context
        const inputType = el.type?.toLowerCase();
        let implicitRole = implicitRoleMap[tag] || null;
        if (tag === 'input') {
          const inputRoleMap: Record<string, string> = {
            'text': 'textbox',
            'email': 'textbox',
            'password': 'textbox',
            'search': 'searchbox',
            'tel': 'textbox',
            'url': 'textbox',
            'number': 'spinbutton',
            'range': 'slider',
            'checkbox': 'checkbox',
            'radio': 'radio',
            'button': 'button',
            'submit': 'button',
            'reset': 'button',
          };
          implicitRole = inputRoleMap[inputType] || 'textbox';
        }

        // Use explicit role if set, otherwise implicit
        const role = explicitRole || implicitRole;
        // @ts-ignore - browser context
        const style = window.getComputedStyle(el);
        // @ts-ignore - browser context
        const rect = el.getBoundingClientRect();
        // @ts-ignore - browser context
        const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
        // @ts-ignore - browser context
        const viewportWidth = window.innerWidth || document.documentElement.clientWidth;

        // Check interactivity
        const isInteractive = (
          ['button', 'a', 'input', 'select', 'textarea', 'label'].includes(tag) ||
          ['button', 'link', 'menuitem', 'tab', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'textbox'].includes(role || '') ||
          // @ts-ignore - browser context
          el.onclick !== null ||
          // @ts-ignore - browser context
          el.hasAttribute('onclick') ||
          style.cursor === 'pointer' ||
          // @ts-ignore - browser context
          el.tabIndex >= 0
        );

        // Check visibility
        const isVisible = (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0
        );

        // Check viewport
        const isInViewport = (
          rect.top >= 0 &&
          rect.left >= 0 &&
          rect.bottom <= viewportHeight &&
          rect.right <= viewportWidth
        );

        // Calculate score
        let score = 0;

        // Preferred tag match (+50)
        if (prefs.preferredTags.includes(tag)) {
          score += 50;
        }

        // Preferred role match (+40)
        if (role && prefs.preferredRoles.includes(role)) {
          score += 40;
        }

        // Interactive bonus (+30 if required, +10 otherwise)
        if (isInteractive) {
          score += prefs.requiresInteractive ? 30 : 10;
        } else if (prefs.requiresInteractive) {
          score -= 50; // Penalty for non-interactive when required
        }

        // Visibility bonus (+20)
        if (isVisible) {
          score += 20;
        }

        // Viewport bonus (+10)
        if (isInViewport) {
          score += 10;
        }

        // Cursor pointer bonus (+5)
        if (style.cursor === 'pointer') {
          score += 5;
        }

        return {
          tag,
          role,
          isInteractive,
          isVisible,
          isInViewport,
          // @ts-ignore - browser context
          hasClickHandler: el.onclick !== null || el.hasAttribute('onclick'),
          cursorPointer: style.cursor === 'pointer',
          // @ts-ignore - browser context
          text: (el.textContent || '').trim().substring(0, 50),
          score,
        };
      }, preferences);

      analysisResults.push({
        index: i,
        ...analysis,
      });
    } catch (error) {
      // Element might be detached, skip it
      logger.debug('[SELECTOR_UTILS] Failed to analyze element', {
        index: i,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Sort by score (highest first)
  analysisResults.sort((a, b) => b.score - a.score);

  // Log analysis results
  logger.info('[SELECTOR_UTILS] Smart element selection', {
    selector: normalizedSelector.substring(0, 50),
    actionType,
    totalMatches: count,
    analyzed: analysisResults.length,
    topCandidate: analysisResults[0] ? {
      index: analysisResults[0].index,
      tag: analysisResults[0].tag,
      role: analysisResults[0].role,
      isInteractive: analysisResults[0].isInteractive,
      score: analysisResults[0].score,
    } : null,
  });

  // Select the best element
  const bestMatch = analysisResults[0];
  if (!bestMatch) {
    // Fallback to first element
    return {
      locator: baseLocator.first(),
      wasSmartSelected: false,
      selectedIndex: 0,
      totalMatches: count,
      usedAI: false,
    };
  }

  // ✅ NEW: Check if we need AI for disambiguation
  const needsAI = useAI === true || (
    useAI === 'auto' &&
    analysisResults.length >= 2 &&
    intent && // Only use AI if we have intent
    (
      // Case 1: Top 2 elements have very close scores (difference < 10)
      (analysisResults[0].score - analysisResults[1].score < 10) ||
      // Case 2: Multiple elements with high scores (> 50) - all are good candidates
      (analysisResults.filter(a => a.score > 50).length >= 2) ||
      // Case 3: Top element score is low (< 30) - static rules didn't help much
      (analysisResults[0].score < 30)
    )
  );

  let finalIndex = bestMatch.index;
  let usedAI = false;

  if (needsAI && intent) {
    logger.info('[SELECTOR_UTILS] Ambiguous selection, using AI for disambiguation', {
      selector: normalizedSelector.substring(0, 50),
      topScore: analysisResults[0].score,
      secondScore: analysisResults[1]?.score,
      intent: intent.substring(0, 100),
    });

    try {
      // Get top candidates (score > 50 or top 3)
      const topCandidates = analysisResults
        .filter(a => a.score > 50 || analysisResults.indexOf(a) < 3)
        .slice(0, 5); // Limit to 5 for AI

      if (topCandidates.length >= 2) {
        // Extract DOM nodes for top candidates
        const nodes = await Promise.all(
          topCandidates.map(async (candidate) => {
            const element = baseLocator.nth(candidate.index);
            try {
              const nodeData = await element.evaluate((el) => {
                // @ts-ignore - browser context
                const rect = el.getBoundingClientRect();
                // @ts-ignore - browser context
                const tag = el.tagName.toLowerCase();
                // @ts-ignore - browser context
                const explicitRole = el.getAttribute('role');

                // ✅ FIX: Calculate implicit ARIA role (same logic as static analysis)
                const implicitRoleMap: Record<string, string> = {
                  'button': 'button',
                  'a': 'link',
                  'input': 'textbox',
                  'textarea': 'textbox',
                  'select': 'combobox',
                  'option': 'option',
                  'img': 'img',
                  'nav': 'navigation',
                  'main': 'main',
                  'header': 'banner',
                  'footer': 'contentinfo',
                  'aside': 'complementary',
                  'form': 'form',
                  'article': 'article',
                  'section': 'region',
                  'ul': 'list',
                  'ol': 'list',
                  'li': 'listitem',
                  'table': 'table',
                  'tr': 'row',
                  'td': 'cell',
                  'th': 'columnheader',
                  'h1': 'heading',
                  'h2': 'heading',
                  'h3': 'heading',
                  'h4': 'heading',
                  'h5': 'heading',
                  'h6': 'heading',
                };

                // Special case for input types
                // @ts-ignore - browser context
                const inputType = el.type?.toLowerCase();
                let implicitRole = implicitRoleMap[tag] || null;
                if (tag === 'input') {
                  const inputRoleMap: Record<string, string> = {
                    'text': 'textbox',
                    'email': 'textbox',
                    'password': 'textbox',
                    'search': 'searchbox',
                    'tel': 'textbox',
                    'url': 'textbox',
                    'number': 'spinbutton',
                    'range': 'slider',
                    'checkbox': 'checkbox',
                    'radio': 'radio',
                    'button': 'button',
                    'submit': 'button',
                    'reset': 'button',
                  };
                  implicitRole = inputRoleMap[inputType] || 'textbox';
                }

                // Use explicit role if set, otherwise implicit
                const role = explicitRole || implicitRole;

                return {
                  tag,
                  // @ts-ignore
                  text: (el.textContent || '').trim().substring(0, 200),
                  // @ts-ignore
                  html: el.outerHTML.substring(0, 500),
                  // @ts-ignore
                  attributes: Array.from(el.attributes).reduce((acc: Record<string, string>, attr: any) => {
                    acc[attr.name] = attr.value;
                    return acc;
                  }, {} as Record<string, string>),
                  role, // ✅ FIX: Include role (explicit or implicit)
                  boundingBox: {
                    x: rect.x,
                    y: rect.y,
                    width: rect.width,
                    height: rect.height,
                  },
                };
              });
              return {
                ...nodeData,
                index: candidate.index,
                score: candidate.score,
              };
            } catch {
              return null;
            }
          })
        );

        const validNodes = nodes.filter((n): n is NonNullable<typeof n> => n !== null);

        if (validNodes.length >= 2) {
          // Get page DOM and viewport
          const [dom, viewport] = await Promise.all([
            page.content().catch(() => ''),
            page.viewportSize() || { width: 1920, height: 1080 },
          ]);

          // Use AI to select the best candidate
          const aiResult = await AISelectorEngine.resolve({
            intent: `${intent} (selector: ${normalizedSelector})`,
            dom: dom.substring(0, 50000), // Limit DOM size
            nodes: validNodes.map(n => ({
              nodeId: `candidate-${n.index}`,
              tag: n.tag as string,
              text: n.text as string,
              attributes: n.attributes as Record<string, string>,
              role: (n.role as string) || undefined, // ✅ FIX: Include role for AI scoring
              boundingBox: n.boundingBox,
              isVisible: true,
            })),
            metadata: {
              url: page.url(),
              viewport,
            },
            mode: 'fast', // Fast mode for performance
          });

          if (aiResult.success && aiResult.selectedNode) {
            // Find which candidate matches AI's choice
            const aiSelectedNodeId = aiResult.selectedNode.nodeId;
            const matchedCandidate = validNodes.find(n => `candidate-${n.index}` === aiSelectedNodeId);

            if (matchedCandidate) {
              finalIndex = matchedCandidate.index;
              usedAI = true;

              logger.info('[SELECTOR_UTILS] AI selected element', {
                selector: normalizedSelector.substring(0, 50),
                aiSelectedIndex: finalIndex,
                aiConfidence: aiResult.selectedNode.confidence,
                aiSelector: aiResult.selectedNode.primarySelector,
              });
            } else {
              logger.warn('[SELECTOR_UTILS] AI selected element not in candidates, using static result', {
                aiNodeId: aiSelectedNodeId,
              });
            }
          } else {
            logger.warn('[SELECTOR_UTILS] AI resolution failed, using static result', {
              error: aiResult.explanation,
            });
          }
        }
      }
    } catch (error) {
      logger.warn('[SELECTOR_UTILS] AI disambiguation failed, using static result', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    locator: baseLocator.nth(finalIndex),
    wasSmartSelected: true,
    selectedIndex: finalIndex,
    totalMatches: count,
    usedAI,
    analysis: analysisResults,
  };
}
