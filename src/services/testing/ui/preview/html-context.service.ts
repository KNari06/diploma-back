/**
 * HTML Context Service
 * Builds semantic HTML for AI check assertions with token budgeting
 * 
 * Features:
 * - Strips scripts/styles/non-content elements
 * - Preserves semantic controls and text
 * - Dynamic token budgeting with priority-based pruning
 * - Special handling for validation text and negative assertions
 */

import { logger } from '@/utils/core/logger';
import { countTokens } from '@/utils/text-processing/chunking';
import type { Page } from 'playwright';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Options for semantic HTML building
 */
export interface SemanticHtmlOptions {
  /** Max tokens for output (default: 8000) */
  tokenBudget?: number;
  /** Assertion text - used for negative-assertion detection */
  assertionText?: string;
  /** When true, expand budget for error/alert contexts (for negative assertions) */
  expandForNegative?: boolean;
  /** Max nodes to process (safety limit, default: 1500) */
  maxNodes?: number;
}

/**
 * Result from semantic HTML building
 */
export interface SemanticHtmlResult {
  /** Semantic HTML string */
  html: string;
  /** Estimated tokens */
  tokens: number;
  /** Original HTML length */
  originalLength: number;
  /** Semantic HTML length */
  semanticLength: number;
  /** Number of nodes pruned */
  prunedCount: number;
  /** Whether negative assertion was detected */
  isNegative: boolean;
  /** Number of helper text nodes included */
  helperTextCount: number;
  /** Pruning path used (spa_root/main/article/forms) */
  pruningPath?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const DEFAULT_TOKEN_BUDGET = 8000;
const DEFAULT_MAX_NODES = 1500;
const NEGATIVE_ASSERTION_BUDGET_MULTIPLIER = 1.5; // 50% increase for negative assertions

// Semantic class patterns that indicate state (keep these)
const SEMANTIC_CLASS_PATTERNS = [
  // Validation / form feedback
  'error', 'success', 'warning', 'info', 'alert',
  'invalid', 'valid', 'validation', 'helper', 'hint',
  // UI states
  'disabled', 'active', 'selected', 'checked', 'hidden',
  'loading', 'pending', 'complete',
  // Notifications / messages / toasts / banners
  'message', 'msg', 'notice', 'notification', 'toast',
  'snackbar', 'callout', 'banner', 'feedback', 'status',
  'flash', 'popup', 'modal', 'dialog',
  // Results / outcomes
  'result', 'outcome', 'response', 'empty', 'placeholder',
  // Common component prefixes (MUI, Ant, Chakra, etc.)
  'MuiAlert', 'ant-message', 'ant-notification', 'chakra-alert',
];

// Negative assertion keywords (English + Russian)
const NEGATIVE_KEYWORDS = [
  // English
  'not', 'no', 'without', 'hidden', 'invisible', 'disabled', 'empty', 'missing', 'absent',
  // Russian
  'нет', 'не', 'без', 'скрыт', 'отсутствует', 'пуст', 'невидим',
];

// ═══════════════════════════════════════════════════════════════════════════
// HELPER FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect if assertion is negative (checking for absence/non-existence)
 */
function isNegativeAssertion(assertionText: string): boolean {
  if (!assertionText) return false;
  const lower = assertionText.toLowerCase();
  return NEGATIVE_KEYWORDS.some(keyword => lower.includes(keyword));
}

// ═══════════════════════════════════════════════════════════════════════════
// BROWSER-SIDE SEMANTIC HTML BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build semantic HTML from page via page.evaluate()
 * This is the preferred method as it has access to live DOM
 */
export async function buildSemanticHtmlFromPage(
  page: Page,
  options: SemanticHtmlOptions = {}
): Promise<SemanticHtmlResult> {
  const startTime = Date.now();
  
  // Detect negative assertion
  const isNegative = options.assertionText ? isNegativeAssertion(options.assertionText) : false;
  
  // Calculate token budget
  let tokenBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
  if (isNegative && options.expandForNegative !== false) {
    tokenBudget = Math.floor(tokenBudget * NEGATIVE_ASSERTION_BUDGET_MULTIPLIER);
  }
  
  const maxNodes = options.maxNodes || DEFAULT_MAX_NODES;
  
  logger.debug('[HTML_CONTEXT] Building semantic HTML from page', {
    tokenBudget,
    isNegative,
    maxNodes,
  });

  try {
    // Get original HTML length for comparison
    const originalHtml = await page.content();
    const originalLength = originalHtml.length;

    // Build semantic HTML in browser context
    const result = await page.evaluate(({ tokenBudget, maxNodes, semanticClassPatterns }) => {
      // Helper: check computed visibility (skip hidden elements to save token budget)
      function isVisible(el: any): boolean {
        try {
          // @ts-ignore
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return false;
          if (style.opacity === '0') return false;
          // Check zero-size elements (common CSS hiding technique)
          if (parseInt(style.width) === 0 && parseInt(style.height) === 0 &&
              style.overflow === 'hidden') return false;
        } catch { /* fallback: assume visible */ }
        return true;
      }

      // Helper: Check if element should be kept
      function shouldKeepElement(el: any): boolean {
        const tag = el.tagName.toLowerCase();

        // Always drop non-content tags
        const dropTags = ['script', 'style', 'noscript', 'template', 'link', 'meta', 'head'];
        if (dropTags.includes(tag)) return false;

        // Drop hidden elements early (saves token budget for visible content)
        if (!isVisible(el)) return false;

        // Always keep if has data-agent-ref
        if (el.hasAttribute('data-agent-ref')) return true;

        // Always keep if has alert/error role
        const role = el.getAttribute('role');
        if (role && ['alert', 'alertdialog', 'status', 'log', 'marquee', 'timer'].includes(role)) {
          return true;
        }

        // Keep elements with aria-live (dynamic status regions — toasts, errors, etc.)
        if (el.hasAttribute('aria-live') || el.hasAttribute('aria-atomic')) return true;

        // Keep interactive controls
        const controlTags = ['input', 'textarea', 'select', 'button', 'a'];
        if (controlTags.includes(tag)) return true;

        // Keep semantic structure
        const structureTags = ['main', 'header', 'nav', 'footer', 'section', 'article', 'form'];
        if (structureTags.includes(tag)) return true;

        // Keep text blocks
        const textTags = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'ul', 'ol', 'label', 'span'];
        if (textTags.includes(tag)) return true;

        // Keep tables
        const tableTags = ['table', 'thead', 'tbody', 'tr', 'th', 'td'];
        if (tableTags.includes(tag)) return true;

        // Keep images with alt
        if (tag === 'img' && el.hasAttribute('alt')) return true;

        // Keep SVG/Canvas only if has aria-label or data-agent-ref
        if ((tag === 'svg' || tag === 'canvas') &&
            (el.hasAttribute('aria-label') || el.hasAttribute('data-agent-ref'))) {
          return true;
        }

        // Check semantic classes on ANY element (not just div/span)
        const anyClassList = typeof el.className === 'string' ? el.className : '';
        if (anyClassList.length > 0 &&
            semanticClassPatterns.some((c: string) => anyClassList.toLowerCase().includes(c.toLowerCase()))) {
          return true;
        }

        // Keep divs/spans with meaningful attributes or visible text
        if (tag === 'div' || tag === 'span') {
          if (role || el.hasAttribute('data-testid')) return true;
          // Keep if has short meaningful visible text (likely a message/label)
          const text = (el.textContent || '').trim();
          if (text.length > 0 && text.length < 200) return true;
        }

        return false;
      }
      
      // Helper: Extract semantic attributes
      function extractAttributes(el: any): Record<string, string> {
        const attrs: Record<string, string> = {};
        
        // Always keep
        const keepAttrs = [
          'data-agent-ref', 'data-testid',
          'role', 'aria-label', 'aria-expanded', 'aria-checked', 'aria-selected',
          'aria-invalid', 'aria-describedby', 'aria-hidden',
          'placeholder', 'name', 'type', 'disabled', 'readonly', 'checked', 'required',
          'hidden',
        ];
        
        for (const attr of keepAttrs) {
          const value = el.getAttribute(attr);
          if (value !== null) {
            attrs[attr] = value;
          }
        }
        
        // Special handling for links and images
        if (el.tagName.toLowerCase() === 'a') {
          const href = el.getAttribute('href');
          if (href) attrs['href'] = href.substring(0, 100); // Truncate long URLs
        }
        
        if (el.tagName.toLowerCase() === 'img') {
          const src = el.getAttribute('src');
          const alt = el.getAttribute('alt');
          if (src) attrs['src'] = src.substring(0, 100);
          if (alt) attrs['alt'] = alt;
        }
        
        // Keep style only if affects visibility
        const style = el.getAttribute('style');
        if (style && /display\s*:|visibility\s*:|opacity\s*:\s*0/.test(style)) {
          attrs['style'] = style;
        }
        
        // Extract semantic classes
        const classList = el.className;
        if (typeof classList === 'string' && classList.length > 0) {
          const classes = classList.split(/\s+/);
          const semantic = classes.filter(cls => 
            semanticClassPatterns.some((pattern: string) => cls.toLowerCase().includes(pattern))
          );
          if (semantic.length > 0) {
            attrs['class'] = semantic.join(' ');
          }
        }
        
        return attrs;
      }
      
      // Patterns for error/helper/notification text detection
      const helperClassPatterns = [
        'error', 'helper', 'hint', 'validation', 'warning', 'success', 'info',
        'msg', 'message', 'feedback', 'alert', 'notice', 'toast', 'notification',
        'invalid', 'danger', 'fail', 'banner', 'callout', 'status',
      ];

      function isHelperLikeElement(el: any): boolean {
        const classList = el.className || '';
        if (typeof classList === 'string' && classList.length > 0 &&
            helperClassPatterns.some(c => classList.toLowerCase().includes(c))) {
          return true;
        }
        const role = el.getAttribute('role');
        if (role && ['alert', 'status', 'log'].includes(role)) return true;
        if (el.hasAttribute('aria-live')) return true;
        return false;
      }

      // Helper: Find helper/error text near control
      function findNearestHelperText(controlEl: any, maxDistance: number = 5): any[] {
        const helpers: any[] = [];
        const seen = new Set<any>();

        function addIfHelper(el: any) {
          if (!el || seen.has(el)) return;
          seen.add(el);
          const text = (el.textContent || '').trim();
          if (text.length > 0 && text.length < 500 && isHelperLikeElement(el)) {
            helpers.push(el);
          }
        }

        // Check siblings (before and after)
        let sibling = controlEl.previousElementSibling;
        let distance = 0;
        while (sibling && distance < maxDistance) {
          addIfHelper(sibling);
          sibling = sibling.previousElementSibling;
          distance++;
        }

        sibling = controlEl.nextElementSibling;
        distance = 0;
        while (sibling && distance < maxDistance) {
          addIfHelper(sibling);
          sibling = sibling.nextElementSibling;
          distance++;
        }

        // Check parent and parent's siblings (error messages often wrap the form field)
        let parent = controlEl.parentElement;
        for (let lvl = 0; parent && lvl < 3; lvl++) {
          addIfHelper(parent);
          // Also check parent's siblings
          let pSib = parent.previousElementSibling;
          for (let d = 0; pSib && d < 2; d++) { addIfHelper(pSib); pSib = pSib.previousElementSibling; }
          pSib = parent.nextElementSibling;
          for (let d = 0; pSib && d < 2; d++) { addIfHelper(pSib); pSib = pSib.nextElementSibling; }
          parent = parent.parentElement;
        }

        // Check aria-describedby
        const describedBy = controlEl.getAttribute('aria-describedby');
        if (describedBy) {
          // @ts-ignore - document is available in browser context
          const describedEl = document.getElementById(describedBy);
          if (describedEl && !seen.has(describedEl)) helpers.push(describedEl);
        }

        // Check aria-errormessage
        const errorMsgId = controlEl.getAttribute('aria-errormessage');
        if (errorMsgId) {
          // @ts-ignore
          const errorEl = document.getElementById(errorMsgId);
          if (errorEl && !seen.has(errorEl)) helpers.push(errorEl);
        }

        return helpers;
      }
      
      // Priority levels for pruning
      enum Priority {
        NEVER_PRUNE = 0,     // data-agent-ref, alerts, controls with validation
        HIGH = 1,            // Form controls + labels, headings, buttons
        MEDIUM = 2,          // Text paragraphs, list items, table cells
        LOW = 3,             // Decorative wrappers, empty containers
      }
      
      interface NodeInfo {
        element: any;
        priority: Priority;
        html: string;
        estimatedTokens: number;
      }
      
      // Collect nodes with priority
      const nodes: NodeInfo[] = [];
      const helperTextElements = new Set<any>();
      let nodeCount = 0;
      
      function collectNodes(el: any, depth: number = 0) {
        if (nodeCount >= maxNodes || depth > 20) return;
        
        if (!shouldKeepElement(el)) {
          // Still recurse into children
          for (const child of Array.from(el.children)) {
            collectNodes(child, depth + 1);
          }
          return;
        }
        
        nodeCount++;
        
        const tag = el.tagName.toLowerCase();
        const role = el.getAttribute('role');
        const hasRef = el.hasAttribute('data-agent-ref');
        
        // Determine priority
        let priority = Priority.MEDIUM;

        // Helper: check if element or its classes indicate an error/notification/status
        const classList = (typeof el.className === 'string' ? el.className : '').toLowerCase();
        const errorClassPatterns = ['error', 'alert', 'warning', 'invalid', 'danger', 'fail',
          'toast', 'snackbar', 'notification', 'banner', 'flash', 'callout', 'status',
          'feedback', 'msg', 'message'];
        const hasErrorClass = classList.length > 0 && errorClassPatterns.some(p => classList.includes(p));
        const hasAriaLive = el.hasAttribute('aria-live') || el.hasAttribute('aria-atomic');

        // Text-content heuristic: detect error-like messages even when classes are CSS-in-JS hashes.
        // Only for leaf-ish elements (childElementCount <= 2) to avoid tagging large containers.
        const ownText = (el.textContent || '').trim();
        const isLeafLike = el.childElementCount <= 2;
        const errorTextPatterns = /\b(error|incorrect|invalid|fail|denied|expired|wrong|unable|can'?t|couldn'?t|couldn't|not found|not allowed|forbidden|unauthorized|unavailable|timed?\s*out|rejected|blocked|suspended|locked|disabled|required|missing|ошибк|неверн|некорректн|запрещ|заблокир|недоступн|истек|не найден|не удалось|отказ)\b/i;
        const hasErrorText = isLeafLike && ownText.length > 0 && ownText.length < 300 && errorTextPatterns.test(ownText);

        // Detect error-like background color (red/orange) via computed style
        let hasErrorColor = false;
        try {
          // @ts-ignore
          const computedStyle = window.getComputedStyle(el);
          const bg = computedStyle.backgroundColor || '';
          const color = computedStyle.color || '';
          // Match red-ish hues: rgb(R, G, B) where R is dominant
          const rgbMatch = (bg + ' ' + color).match(/rgb[a]?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
          if (rgbMatch) {
            const r = parseInt(rgbMatch[1]);
            const g = parseInt(rgbMatch[2]);
            const b = parseInt(rgbMatch[3]);
            // Red-dominant: R > 180 and R > G*1.5 and R > B*1.5 (covers red, dark-red, orange-red)
            if (r > 180 && r > g * 1.5 && r > b * 1.5 && isLeafLike && ownText.length > 0) {
              hasErrorColor = true;
            }
          }
        } catch { /* ignore */ }

        if (hasRef ||
            (role && ['alert', 'alertdialog', 'status', 'log'].includes(role)) ||
            el.hasAttribute('aria-invalid') ||
            hasAriaLive) {
          priority = Priority.NEVER_PRUNE;
        } else if (hasErrorClass || hasErrorText || hasErrorColor) {
          // Error/notification elements should never be pruned — they are the primary
          // content AI assertions need to evaluate (error messages, toasts, banners).
          // Detected by: semantic class name, error-like text content, or red background/text color.
          priority = Priority.NEVER_PRUNE;
        } else if (['input', 'textarea', 'select', 'button'].includes(tag) ||
                   ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tag) ||
                   tag === 'label') {
          priority = Priority.HIGH;

          // Find helper text for controls
          if (['input', 'textarea', 'select'].includes(tag)) {
            const helpers = findNearestHelperText(el);
            helpers.forEach(h => helperTextElements.add(h));
          }
        } else if (['p', 'li', 'th', 'td', 'a'].includes(tag)) {
          priority = Priority.MEDIUM;
        } else if (tag === 'div' || tag === 'span') {
          priority = ownText.length > 0 ? Priority.MEDIUM : Priority.LOW;
        }
        
        // Build HTML for this node
        const attrs = extractAttributes(el);
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ');
        
        const text = (el.textContent || '').trim();
        // NEVER_PRUNE elements (errors, alerts) get more text to preserve full message
        const textLimit = priority === Priority.NEVER_PRUNE ? 300 : 100;
        const shortText = text.length > textLimit ? text.substring(0, textLimit) + '...' : text;
        
        let html = attrStr ? `<${tag} ${attrStr}>` : `<${tag}>`;
        if (shortText) html += shortText;
        html += `</${tag}>`;
        
        // Rough token estimate (1 token ≈ 4 chars)
        const estimatedTokens = Math.ceil(html.length / 4);
        
        nodes.push({
          element: el,
          priority,
          html,
          estimatedTokens,
        });
        
        // Recurse into children
        for (const child of Array.from(el.children)) {
          collectNodes(child, depth + 1);
        }
      }
      
      // Start collection from body
      // @ts-ignore - document is available in browser context
      const body = document.body;
      if (body) {
        collectNodes(body);
      }

      // ─── Page-level visible error/toast/notification scanner ───
      // Some error messages (toasts, snackbars, fixed banners) may not have been
      // captured by the tree walk (e.g., portaled to body root, or using generic tags).
      // Do a targeted query for common error/notification selectors.
      const errorSelectors = [
        '[role="alert"]', '[role="status"]', '[role="log"]',
        '[aria-live="polite"]', '[aria-live="assertive"]',
        '[class*="error"]', '[class*="alert"]', '[class*="warning"]',
        '[class*="toast"]', '[class*="snackbar"]', '[class*="notification"]',
        '[class*="banner"]', '[class*="flash"]', '[class*="callout"]',
        '[class*="message"]', '[class*="feedback"]',
        '[class*="invalid"]', '[class*="danger"]',
      ].join(',');

      try {
        // @ts-ignore
        const errorEls = document.querySelectorAll(errorSelectors);
        const existingIds = new Set(nodes.map(n => n.element));

        for (const _el of Array.from(errorEls)) {
          const el = _el as any;
          if (existingIds.has(el)) continue; // Already captured
          const text = (el.textContent || '').trim();
          if (text.length === 0 || text.length > 500) continue;
          // Check visibility (skip hidden elements)
          // @ts-ignore
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;

          const elTag = el.tagName.toLowerCase();
          const elAttrs = extractAttributes(el);
          const attrStr = Object.entries(elAttrs).map(([k, v]: [string, string]) => `${k}="${v}"`).join(' ');
          const shortText = text.length > 200 ? text.substring(0, 200) + '...' : text;
          let html = attrStr ? `<${elTag} ${attrStr}>` : `<${elTag}>`;
          html += shortText;
          html += `</${elTag}>`;

          nodes.push({
            element: el,
            priority: Priority.NEVER_PRUNE,
            html,
            estimatedTokens: Math.ceil(html.length / 4),
          });
          existingIds.add(el);
        }
      } catch (_e) { /* ignore querySelectorAll failures */ }

      // Sort by priority (lower number = higher priority = keep first)
      nodes.sort((a, b) => a.priority - b.priority);
      
      // Build output respecting token budget
      const output: string[] = [];
      let currentTokens = 0;
      let prunedCount = 0;
      
      for (const node of nodes) {
        if (currentTokens + node.estimatedTokens > tokenBudget && node.priority !== Priority.NEVER_PRUNE) {
          prunedCount++;
          continue;
        }
        
        output.push(node.html);
        currentTokens += node.estimatedTokens;
      }
      
      // Add helper text elements (even if over budget slightly)
      for (const helperEl of Array.from(helperTextElements)) {
        const text = (helperEl.textContent || '').trim();
        if (text.length > 0 && text.length < 500) {
          output.push(`<span class="helper-text">${text}</span>`);
        }
      }
      
      const semanticHtml = output.join('\n');
      
      return {
        semanticHtml,
        prunedCount,
        helperTextCount: helperTextElements.size,
        nodeCount,
      };
    }, {
      tokenBudget,
      maxNodes,
      semanticClassPatterns: SEMANTIC_CLASS_PATTERNS,
    });

    const semanticLength = result.semanticHtml.length;
    const tokens = countTokens(result.semanticHtml);
    
    logger.info('[HTML_CONTEXT] Semantic HTML built from page', {
      originalLength,
      semanticLength,
      reduction: `${Math.round((1 - semanticLength / originalLength) * 100)}%`,
      estimatedTokens: tokens,
      tokenBudget,
      prunedCount: result.prunedCount,
      isNegative,
      helperTextCount: result.helperTextCount,
      durationMs: Date.now() - startTime,
    });

    return {
      html: result.semanticHtml,
      tokens,
      originalLength,
      semanticLength,
      prunedCount: result.prunedCount,
      isNegative,
      helperTextCount: result.helperTextCount,
    };
  } catch (error) {
    logger.error('[HTML_CONTEXT] Failed to build semantic HTML from page', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * Build semantic HTML from HTML string (fallback)
 * Used when page is not available
 */
export function buildSemanticHtmlFromString(
  html: string,
  options: SemanticHtmlOptions = {}
): SemanticHtmlResult {
  const startTime = Date.now();
  
  // Detect negative assertion
  const isNegative = options.assertionText ? isNegativeAssertion(options.assertionText) : false;
  
  // Calculate token budget
  let tokenBudget = options.tokenBudget || DEFAULT_TOKEN_BUDGET;
  if (isNegative && options.expandForNegative !== false) {
    tokenBudget = Math.floor(tokenBudget * NEGATIVE_ASSERTION_BUDGET_MULTIPLIER);
  }
  
  logger.debug('[HTML_CONTEXT] Building semantic HTML from string', {
    originalLength: html.length,
    tokenBudget,
    isNegative,
  });

  try {
    const originalLength = html.length;
    
    // Strip scripts and styles using regex (simple but effective)
    let semanticHtml = html;
    
    // Remove script tags and content
    semanticHtml = semanticHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
    
    // Remove style tags and content
    semanticHtml = semanticHtml.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '');
    
    // Remove head tag and content
    semanticHtml = semanticHtml.replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, '');
    
    // Remove comments
    semanticHtml = semanticHtml.replace(/<!--[\s\S]*?-->/g, '');
    
    // Remove noscript, template, link, meta
    semanticHtml = semanticHtml.replace(/<(noscript|template|link|meta)\b[^>]*>/gi, '');
    
    // Collapse whitespace
    semanticHtml = semanticHtml.replace(/\s+/g, ' ').trim();
    
    const semanticLength = semanticHtml.length;
    
    // Truncate if still over token budget
    const tokens = countTokens(semanticHtml);
    let prunedCount = 0;
    
    if (tokens > tokenBudget) {
      // Simple truncation by character length (rough estimate: 1 token ≈ 4 chars)
      const targetLength = tokenBudget * 4;
      semanticHtml = semanticHtml.substring(0, targetLength);
      prunedCount = 1; // Mark that we pruned
    }
    
    const finalTokens = countTokens(semanticHtml);
    
    logger.info('[HTML_CONTEXT] Semantic HTML built from string', {
      originalLength,
      semanticLength,
      reduction: `${Math.round((1 - semanticLength / originalLength) * 100)}%`,
      estimatedTokens: finalTokens,
      tokenBudget,
      prunedCount,
      isNegative,
      durationMs: Date.now() - startTime,
    });

    return {
      html: semanticHtml,
      tokens: finalTokens,
      originalLength,
      semanticLength,
      prunedCount,
      isNegative,
      helperTextCount: 0, // Not available in string mode
    };
  } catch (error) {
    logger.error('[HTML_CONTEXT] Failed to build semantic HTML from string', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
