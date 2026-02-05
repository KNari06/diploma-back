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
  'error', 'success', 'warning', 'info', 'alert',
  'disabled', 'active', 'selected', 'checked', 'hidden',
  'loading', 'pending', 'complete', 'invalid', 'valid',
  'validation', 'helper', 'hint', 'message',
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
      // Helper: Check if element should be kept
      function shouldKeepElement(el: any): boolean {
        const tag = el.tagName.toLowerCase();
        
        // Always drop
        const dropTags = ['script', 'style', 'noscript', 'template', 'link', 'meta', 'head'];
        if (dropTags.includes(tag)) return false;
        
        // Always keep if has data-agent-ref
        if (el.hasAttribute('data-agent-ref')) return true;
        
        // Always keep if has alert/error role
        const role = el.getAttribute('role');
        if (role && ['alert', 'alertdialog', 'status', 'log', 'marquee', 'timer'].includes(role)) {
          return true;
        }
        
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
        
        // Keep divs/spans if they have meaningful attributes or error/validation classes
        if (tag === 'div' || tag === 'span') {
          if (role || el.hasAttribute('data-testid')) return true;
          const classList = el.className || '';
          if (typeof classList === 'string' && 
              ['error', 'warning', 'success', 'validation', 'helper', 'hint', 'alert'].some(c => 
                classList.toLowerCase().includes(c)
              )) {
            return true;
          }
          // Keep if has short meaningful text
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
      
      // Helper: Find helper/error text near control
      function findNearestHelperText(controlEl: any, maxDistance: number = 3): any[] {
        const helpers: any[] = [];
        
        // Check siblings
        let sibling = controlEl.previousElementSibling;
        let distance = 0;
        while (sibling && distance < maxDistance) {
          const text = (sibling.textContent || '').trim();
          const classList = sibling.className || '';
          if (typeof classList === 'string' && 
              ['error', 'helper', 'hint', 'validation', 'warning', 'success'].some(c => 
                classList.toLowerCase().includes(c)
              ) && text.length > 0) {
            helpers.push(sibling);
          }
          sibling = sibling.previousElementSibling;
          distance++;
        }
        
        sibling = controlEl.nextElementSibling;
        distance = 0;
        while (sibling && distance < maxDistance) {
          const text = (sibling.textContent || '').trim();
          const classList = sibling.className || '';
          if (typeof classList === 'string' && 
              ['error', 'helper', 'hint', 'validation', 'warning', 'success'].some(c => 
                classList.toLowerCase().includes(c)
              ) && text.length > 0) {
            helpers.push(sibling);
          }
          sibling = sibling.nextElementSibling;
          distance++;
        }
        
        // Check aria-describedby
        const describedBy = controlEl.getAttribute('aria-describedby');
        if (describedBy) {
          // @ts-ignore - document is available in browser context
          const describedEl = document.getElementById(describedBy);
          if (describedEl) helpers.push(describedEl);
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
        
        if (hasRef || 
            (role && ['alert', 'alertdialog', 'status'].includes(role)) ||
            el.hasAttribute('aria-invalid')) {
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
          const text = (el.textContent || '').trim();
          priority = text.length > 0 ? Priority.MEDIUM : Priority.LOW;
        }
        
        // Build HTML for this node
        const attrs = extractAttributes(el);
        const attrStr = Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ');
        
        const text = (el.textContent || '').trim();
        const shortText = text.length > 100 ? text.substring(0, 100) + '...' : text;
        
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
