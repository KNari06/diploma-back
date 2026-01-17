/**
 * FunnelAnalyzer Unit Tests
 *
 * Validates that funnel phase detection and element categorization
 * work correctly for both EN and RU patterns.
 */

import { FunnelAnalyzer, FunnelPhase } from '../funnel-analyzer';
import type { LiteElement } from '../../lite-types';

describe('FunnelAnalyzer', () => {
  describe('analyze() - URL-based detection', () => {
    it('should detect CONVERSION phase from URL (EN)', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/checkout', []);
      expect(phase).toBe(FunnelPhase.CONVERSION);
    });

    it('should detect CONVERSION phase from URL (RU)', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/оплата', []);
      expect(phase).toBe(FunnelPhase.CONVERSION);
    });

    it('should detect PRE_ACTION phase from URL (EN)', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/cart', []);
      expect(phase).toBe(FunnelPhase.PRE_ACTION);
    });

    it('should detect PRE_ACTION phase from URL (RU)', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/корзина', []);
      expect(phase).toBe(FunnelPhase.PRE_ACTION);
    });

    it('should detect SELECTION phase from URL (EN)', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/product/123', []);
      expect(phase).toBe(FunnelPhase.SELECTION);
    });

    it('should detect SELECTION phase from URL (RU)', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/товар/123', []);
      expect(phase).toBe(FunnelPhase.SELECTION);
    });

    it('should default to DISCOVERY phase for generic URL', () => {
      const phase = FunnelAnalyzer.analyze('https://example.com/', []);
      expect(phase).toBe(FunnelPhase.DISCOVERY);
    });
  });

  describe('analyze() - Element-based detection', () => {
    it('should detect CONVERSION phase from submit button', () => {
      const elements: LiteElement[] = [
        {
          ref: 'btn1',
          tag: 'button',
          role: 'button',
          name: 'Submit Payment',
          visible: true,
          bounds: { x: 0, y: 0, width: 100, height: 40 },
        },
      ];
      const phase = FunnelAnalyzer.analyze('https://example.com/page', elements);
      expect(phase).toBe(FunnelPhase.CONVERSION);
    });

    it('should detect PRE_ACTION phase from checkout button', () => {
      const elements: LiteElement[] = [
        {
          ref: 'btn1',
          tag: 'button',
          role: 'button',
          name: 'Proceed to Checkout',
          visible: true,
          bounds: { x: 0, y: 0, width: 100, height: 40 },
        },
        {
          ref: 'span1',
          tag: 'span',
          role: '',
          name: 'Cart (3 items)',
          visible: true,
          bounds: { x: 0, y: 0, width: 100, height: 20 },
        },
      ];
      const phase = FunnelAnalyzer.analyze('https://example.com/page', elements);
      expect(phase).toBe(FunnelPhase.PRE_ACTION);
    });

    it('should detect SELECTION phase from add-to-cart button', () => {
      const elements: LiteElement[] = [
        {
          ref: 'btn1',
          tag: 'button',
          role: 'button',
          name: 'Add to Cart',
          visible: true,
          bounds: { x: 0, y: 0, width: 100, height: 40 },
        },
      ];
      const phase = FunnelAnalyzer.analyze('https://example.com/page', elements);
      expect(phase).toBe(FunnelPhase.SELECTION);
    });
  });

  describe('categorizeElement()', () => {
    it('should categorize submit button (EN)', () => {
      const element: LiteElement = {
        ref: 'btn1',
        tag: 'button',
        role: 'button',
        name: 'Submit',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('submit-button');
    });

    it('should categorize submit button (RU)', () => {
      const element: LiteElement = {
        ref: 'btn1',
        tag: 'button',
        role: 'button',
        name: 'Отправить',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('submit-button');
    });

    it('should categorize checkout button (EN)', () => {
      const element: LiteElement = {
        ref: 'btn1',
        tag: 'button',
        role: 'button',
        name: 'Proceed to Checkout',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('checkout-button');
    });

    it('should categorize add-to-cart button (EN)', () => {
      const element: LiteElement = {
        ref: 'btn1',
        tag: 'button',
        role: 'button',
        name: 'Add to Cart',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('add-to-cart');
    });

    it('should categorize add-to-cart button (RU)', () => {
      const element: LiteElement = {
        ref: 'btn1',
        tag: 'button',
        role: 'button',
        name: 'В корзину',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 40 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('add-to-cart');
    });

    it('should categorize input field', () => {
      const element: LiteElement = {
        ref: 'input1',
        tag: 'input',
        role: '',
        type: 'text',
        name: 'Email',
        visible: true,
        bounds: { x: 0, y: 0, width: 200, height: 30 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('input-field');
    });

    it('should categorize form', () => {
      const element: LiteElement = {
        ref: 'form1',
        tag: 'form',
        role: '',
        name: 'Login Form',
        visible: true,
        bounds: { x: 0, y: 0, width: 300, height: 200 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('form');
    });

    it('should categorize footer link', () => {
      const element: LiteElement = {
        ref: 'link1',
        tag: 'a',
        role: 'link',
        name: 'Privacy Policy',
        context: 'footer',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 20 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('footer-link');
    });

    it('should categorize nav link', () => {
      const element: LiteElement = {
        ref: 'link1',
        tag: 'a',
        role: 'link',
        name: 'Products',
        context: 'nav',
        visible: true,
        bounds: { x: 0, y: 0, width: 100, height: 20 },
      };
      const category = FunnelAnalyzer.categorizeElement(element);
      expect(category).toBe('nav-link');
    });
  });

  describe('hasPhaseChanged()', () => {
    it('should return false for first iteration (no previous phase)', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(null, FunnelPhase.DISCOVERY);
      expect(changed).toBe(false);
    });

    it('should return false for same phase', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(FunnelPhase.DISCOVERY, FunnelPhase.DISCOVERY);
      expect(changed).toBe(false);
    });

    it('should return true for forward transition (DISCOVERY → SELECTION)', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(FunnelPhase.DISCOVERY, FunnelPhase.SELECTION);
      expect(changed).toBe(true);
    });

    it('should return true for forward transition (SELECTION → PRE_ACTION)', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(FunnelPhase.SELECTION, FunnelPhase.PRE_ACTION);
      expect(changed).toBe(true);
    });

    it('should return true for forward transition (PRE_ACTION → CONVERSION)', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(FunnelPhase.PRE_ACTION, FunnelPhase.CONVERSION);
      expect(changed).toBe(true);
    });

    it('should return true for backward transition (CONVERSION → PRE_ACTION)', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(FunnelPhase.CONVERSION, FunnelPhase.PRE_ACTION);
      expect(changed).toBe(true);
    });

    it('should return false for non-significant transition (DISCOVERY → CONVERSION)', () => {
      const changed = FunnelAnalyzer.hasPhaseChanged(FunnelPhase.DISCOVERY, FunnelPhase.CONVERSION);
      expect(changed).toBe(false);
    });
  });

  describe('getMultipliers()', () => {
    it('should return high multiplier for submit-button in CONVERSION phase', () => {
      const multipliers = FunnelAnalyzer.getMultipliers(FunnelPhase.CONVERSION);
      expect(multipliers['submit-button']).toBe(5.0);
    });

    it('should return low multiplier for nav-link in CONVERSION phase', () => {
      const multipliers = FunnelAnalyzer.getMultipliers(FunnelPhase.CONVERSION);
      expect(multipliers['nav-link']).toBe(0.0);
    });

    it('should return high multiplier for add-to-cart in SELECTION phase', () => {
      const multipliers = FunnelAnalyzer.getMultipliers(FunnelPhase.SELECTION);
      expect(multipliers['add-to-cart']).toBe(3.0);
    });

    it('should return high multiplier for nav-link in DISCOVERY phase', () => {
      const multipliers = FunnelAnalyzer.getMultipliers(FunnelPhase.DISCOVERY);
      expect(multipliers['nav-link']).toBe(2.0);
    });
  });
});
