/**
 * FunnelAnalyzer (Manus Style)
 *
 * Determines current phase in user journey funnel and applies
 * contextual weight multipliers to prioritize relevant elements.
 *
 * Phases:
 * - DISCOVERY: Browsing, navigation, search
 * - SELECTION: Product view, option selection
 * - PRE_ACTION: Cart, form filling, review
 * - CONVERSION: Checkout, payment, final submit
 */

import { FUNNEL_ELEMENT_PATTERNS, FUNNEL_URL_PATTERNS } from '@/config/testing/semantic-keywords';
import { logger } from '@/utils/core/logger';
import type { LiteElement } from '../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export enum FunnelPhase {
  DISCOVERY = 'discovery',
  SELECTION = 'selection',
  PRE_ACTION = 'pre_action',
  CONVERSION = 'conversion',
}

/** Element category for multiplier application */
export type ElementCategory =
  | 'submit-button'
  | 'primary-action'
  | 'input-field'
  | 'nav-link'
  | 'footer-link'
  | 'category-link'
  | 'product-link'
  | 'add-to-cart'
  | 'checkout-button'
  | 'form'
  | 'search'
  | 'pagination-button'
  | 'load-more-button'
  | 'sort-control'
  | 'filter-control'
  | 'default';

// ═══════════════════════════════════════════════════════════════════════════
// FUNNEL ANALYZER
// ═══════════════════════════════════════════════════════════════════════════

export class FunnelAnalyzer {
  /**
   * Analyze current page to determine funnel phase
   *
   * @param url Current page URL
   * @param elements Page elements
   * @returns Detected funnel phase
   */
  static analyze(url: string, elements: LiteElement[]): FunnelPhase {
    const urlLower = url.toLowerCase();

    // Priority 1: CONVERSION (highest priority)
    if (this.matchesAnyPattern(urlLower, FUNNEL_URL_PATTERNS.conversion)) {
      logger.debug('[FUNNEL] Detected CONVERSION phase from URL', { url: url.slice(0, 50) });
      return FunnelPhase.CONVERSION;
    }

    // Check for conversion elements (payment forms, final submit)
    if (this.hasConversionElements(elements)) {
      logger.debug('[FUNNEL] Detected CONVERSION phase from elements');
      return FunnelPhase.CONVERSION;
    }

    // Priority 2: PRE_ACTION
    if (this.matchesAnyPattern(urlLower, FUNNEL_URL_PATTERNS.pre_action)) {
      logger.debug('[FUNNEL] Detected PRE_ACTION phase from URL', { url: url.slice(0, 50) });
      return FunnelPhase.PRE_ACTION;
    }

    // Check for cart/review elements
    if (this.hasPreActionElements(elements)) {
      logger.debug('[FUNNEL] Detected PRE_ACTION phase from elements');
      return FunnelPhase.PRE_ACTION;
    }

    // Priority 3: SELECTION
    if (this.matchesAnyPattern(urlLower, FUNNEL_URL_PATTERNS.selection)) {
      logger.debug('[FUNNEL] Detected SELECTION phase from URL');
      return FunnelPhase.SELECTION;
    }

    // Check for product selection elements
    if (this.hasSelectionElements(elements)) {
      logger.debug('[FUNNEL] Detected SELECTION phase from elements');
      return FunnelPhase.SELECTION;
    }

    // Default: DISCOVERY
    logger.debug('[FUNNEL] Default DISCOVERY phase');
    return FunnelPhase.DISCOVERY;
  }

  /**
   * Get weight multipliers for current phase
   * Higher multiplier = more important for this phase
   *
   * @param phase Current funnel phase
   * @returns Multipliers by element category
   */
  static getMultipliers(phase: FunnelPhase): Record<ElementCategory, number> {
    switch (phase) {
      case FunnelPhase.CONVERSION:
        return {
          'submit-button': 5.0,
          'primary-action': 4.0,
          'input-field': 2.0,
          'form': 2.0,
          'checkout-button': 3.0,
          'add-to-cart': 0.5,
          'nav-link': 0.0,        // Block navigation away from payment
          'footer-link': 0.0,
          'category-link': 0.1,
          'product-link': 0.1,
          'search': 0.1,
          'pagination-button': 0.1,
          'load-more-button': 0.1,
          'sort-control': 0.0,
          'filter-control': 0.1,
          'default': 0.5,
        };

      case FunnelPhase.PRE_ACTION:
        return {
          'submit-button': 2.0,
          'primary-action': 2.0,
          'checkout-button': 4.0, // Priority: proceed to checkout
          'input-field': 1.5,
          'form': 1.5,
          'add-to-cart': 1.0,
          'nav-link': 0.3,
          'footer-link': 0.1,
          'category-link': 0.3,
          'product-link': 0.5,
          'search': 0.3,
          'pagination-button': 0.5,
          'load-more-button': 0.5,
          'sort-control': 0.3,
          'filter-control': 0.5,
          'default': 1.0,
        };

      case FunnelPhase.SELECTION:
        return {
          'submit-button': 1.0,
          'primary-action': 1.5,
          'add-to-cart': 3.0,     // Priority: add selected item
          'checkout-button': 2.0,
          'input-field': 1.5,     // Options, quantity
          'form': 1.0,
          'nav-link': 0.8,
          'footer-link': 0.2,
          'category-link': 1.0,
          'product-link': 1.5,
          'search': 1.0,
          'pagination-button': 1.5,
          'load-more-button': 2.0,
          'sort-control': 1.5,
          'filter-control': 1.5,
          'default': 1.0,
        };

      case FunnelPhase.DISCOVERY:
      default:
        return {
          'submit-button': 1.0,
          'primary-action': 1.5,
          'nav-link': 2.0,        // Priority: navigation
          'category-link': 2.5,
          'product-link': 2.0,
          'search': 2.0,
          'add-to-cart': 0.5,
          'checkout-button': 0.3,
          'input-field': 1.0,
          'form': 1.0,
          'footer-link': 0.3,
          'pagination-button': 2.0,
          'load-more-button': 2.5,
          'sort-control': 1.0,
          'filter-control': 1.5,
          'default': 1.0,
        };
    }
  }

  /**
   * Check if funnel phase changed significantly
   *
   * @param previousPhase Previous phase (null if first iteration)
   * @param currentPhase Current detected phase
   * @returns True if phase changed significantly
   */
  static hasPhaseChanged(
    previousPhase: FunnelPhase | null,
    currentPhase: FunnelPhase
  ): boolean {
    if (previousPhase === null) return false; // First iteration
    if (previousPhase === currentPhase) return false;

    // Define significant transitions
    const significantTransitions: Array<[FunnelPhase, FunnelPhase]> = [
      [FunnelPhase.DISCOVERY, FunnelPhase.SELECTION],
      [FunnelPhase.SELECTION, FunnelPhase.PRE_ACTION],
      [FunnelPhase.PRE_ACTION, FunnelPhase.CONVERSION],
      // Backward transitions are also significant (user went back)
      [FunnelPhase.CONVERSION, FunnelPhase.PRE_ACTION],
      [FunnelPhase.PRE_ACTION, FunnelPhase.SELECTION],
    ];

    const isSignificant = significantTransitions.some(
      ([from, to]) => previousPhase === from && currentPhase === to
    );

    if (isSignificant) {
      logger.info('[FUNNEL] Significant phase change detected', {
        from: previousPhase,
        to: currentPhase,
      });
    }

    return isSignificant;
  }

  /**
   * Categorize element for multiplier application
   *
   * @param element Element to categorize
   * @returns Element category
   */
  static categorizeElement(element: LiteElement): ElementCategory {
    const nameLower = (element.name || '').toLowerCase();
    const tag = element.tag;
    const type = element.type;

    // Form detection
    if (tag === 'form') return 'form';

    // Input fields
    if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      return 'input-field';
    }

    // Pagination / load-more / sort / filter detection (before generic button/link)
    if (tag === 'button' || tag === 'a' || element.role === 'button') {
      if (/\b(next|prev|previous|»|«|›|‹)\b/i.test(nameLower) || element.context?.toLowerCase().includes('pagination'))
        return 'pagination-button';
      if (this.matchesAnyPattern(nameLower, FUNNEL_ELEMENT_PATTERNS.load_more))
        return 'load-more-button';
    }
    if ((tag === 'button' || element.role === 'button') && element.context?.toLowerCase().includes('header') && /\b(sort|↑|↓)\b/i.test(nameLower))
      return 'sort-control';
    if ((tag === 'input' || tag === 'select') && (/\b(filter|search)\b/i.test(nameLower) || element.context?.toLowerCase().includes('filter')))
      return 'filter-control';

    // Button categorization
    if (tag === 'button' || element.role === 'button') {
      if (this.matchesAnyPattern(nameLower, FUNNEL_ELEMENT_PATTERNS.submit)) {
        return 'submit-button';
      }
      if (this.matchesAnyPattern(nameLower, FUNNEL_ELEMENT_PATTERNS.checkout)) {
        return 'checkout-button';
      }
      if (this.matchesAnyPattern(nameLower, FUNNEL_ELEMENT_PATTERNS.add_to_cart)) {
        return 'add-to-cart';
      }
      return 'primary-action';
    }

    // Link categorization
    if (tag === 'a' || element.role === 'link') {
      // Check context for footer
      if (element.context?.toLowerCase().includes('footer')) {
        return 'footer-link';
      }
      // Category/navigation links
      if (element.context?.toLowerCase().includes('nav') ||
        element.context?.toLowerCase().includes('menu')) {
        return 'nav-link';
      }
      // Product links
      if (nameLower.includes('product') || nameLower.includes('item') ||
        nameLower.includes('товар') || nameLower.includes('продукт')) {
        return 'product-link';
      }
      return 'category-link';
    }

    // Search
    if (type === 'search' || nameLower.includes('search') || nameLower.includes('поиск')) {
      return 'search';
    }

    return 'default';
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  private static matchesAnyPattern(text: string, patterns: readonly string[]): boolean {
    return patterns.some(p => text.includes(p.toLowerCase()));
  }

  private static hasConversionElements(elements: LiteElement[]): boolean {
    // Look for payment form, credit card fields, final submit
    const hasPaymentInput = elements.some(el =>
      el.type === 'password' ||
      el.htmlName?.toLowerCase().includes('card') ||
      el.htmlName?.toLowerCase().includes('cvv') ||
      el.htmlName?.toLowerCase().includes('expir') ||
      el.autocomplete?.includes('cc-')
    );

    const hasSubmitButton = elements.some(el =>
      (el.tag === 'button' || el.role === 'button') &&
      this.matchesAnyPattern((el.name || '').toLowerCase(), FUNNEL_ELEMENT_PATTERNS.submit)
    );

    return hasPaymentInput || hasSubmitButton;
  }

  private static hasPreActionElements(elements: LiteElement[]): boolean {
    // Look for cart items, checkout button
    const hasCheckoutButton = elements.some(el =>
      (el.tag === 'button' || el.role === 'button') &&
      this.matchesAnyPattern((el.name || '').toLowerCase(), FUNNEL_ELEMENT_PATTERNS.checkout)
    );

    const hasCartIndicator = elements.some(el =>
      (el.name || '').toLowerCase().includes('cart') ||
      (el.name || '').toLowerCase().includes('корзин')
    );

    return hasCheckoutButton && hasCartIndicator;
  }

  private static hasSelectionElements(elements: LiteElement[]): boolean {
    // Look for "Add to Cart" button
    return elements.some(el =>
      (el.tag === 'button' || el.role === 'button') &&
      this.matchesAnyPattern((el.name || '').toLowerCase(), FUNNEL_ELEMENT_PATTERNS.add_to_cart)
    );
  }
}
