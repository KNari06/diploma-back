/**
 * Tests for clarification gate helper functions
 * L7: Payment, Upload, External/Download approval gates
 */

import { hasFileInput, isDifferentOrigin, isDownloadText, isFileUploadTarget, isPaymentContext } from '../analysis/clarification-gates';
import type { LiteElement, LiteSnapshot } from '../lite-types';

// Helper to create minimal LiteElement
function createElement(overrides: Partial<LiteElement>): LiteElement {
  return {
    ref: overrides.ref || 'el_0',
    role: overrides.role || 'generic',
    name: overrides.name || '',
    tag: overrides.tag || 'div',
    type: overrides.type,
    visible: overrides.visible !== undefined ? overrides.visible : true,
    disabled: overrides.disabled || false,
    ...overrides,
  } as LiteElement;
}

// Helper to create minimal snapshot
function createSnapshot(elements: LiteElement[], url = 'https://example.com'): LiteSnapshot {
  return {
    url,
    title: 'Test Page',
    elements,
    timestamp: Date.now(),
  };
}

describe('Clarification Gate Helpers', () => {
  describe('isDifferentOrigin', () => {
    it('should return true for different origins', () => {
      const result = isDifferentOrigin(
        'https://example.com/page1',
        'https://other.com/page2'
      );
      expect(result).toBe(true);
    });

    it('should return false for same origin with different paths', () => {
      const result = isDifferentOrigin(
        'https://example.com/page1',
        'https://example.com/page2'
      );
      expect(result).toBe(false);
    });

    it('should return true for different protocols', () => {
      const result = isDifferentOrigin(
        'http://example.com',
        'https://example.com'
      );
      expect(result).toBe(true);
    });

    it('should return false for invalid URLs', () => {
      const result = isDifferentOrigin(
        'not-a-url',
        'https://example.com'
      );
      expect(result).toBe(false);
    });

    it('should handle different subdomains as different origins', () => {
      const result = isDifferentOrigin(
        'https://www.example.com',
        'https://api.example.com'
      );
      expect(result).toBe(true);
    });
  });

  describe('isDownloadText', () => {
    it('should detect download keywords', () => {
      expect(isDownloadText('Download PDF')).toBe(true);
      expect(isDownloadText('Export CSV')).toBe(true);
      expect(isDownloadText('Download Report')).toBe(true);
    });

    it('should detect case-insensitive', () => {
      expect(isDownloadText('DOWNLOAD')).toBe(true);
      expect(isDownloadText('export')).toBe(true);
      expect(isDownloadText('Print Report')).toBe(true);
    });

    it('should detect partial matches', () => {
      expect(isDownloadText('Click here to download')).toBe(true);
      expect(isDownloadText('Export to Excel')).toBe(true);
    });

    it('should return false for non-download text', () => {
      expect(isDownloadText('Submit')).toBe(false);
      expect(isDownloadText('Click here')).toBe(false);
      expect(isDownloadText('Save')).toBe(false);
    });

    it('should detect all download formats', () => {
      expect(isDownloadText('PDF Report')).toBe(true);
      expect(isDownloadText('Excel XLSX')).toBe(true);
      expect(isDownloadText('CSV data')).toBe(true);
    });
  });

  describe('hasFileInput', () => {
    it('should detect visible enabled file input', () => {
      const snapshot = createSnapshot([
        createElement({ type: 'file', visible: true, disabled: false }),
      ]);
      expect(hasFileInput(snapshot)).toBe(true);
    });

    it('should return false for disabled file input', () => {
      const snapshot = createSnapshot([
        createElement({ type: 'file', visible: true, disabled: true }),
      ]);
      expect(hasFileInput(snapshot)).toBe(false);
    });

    it('should return false for invisible file input', () => {
      const snapshot = createSnapshot([
        createElement({ type: 'file', visible: false, disabled: false }),
      ]);
      expect(hasFileInput(snapshot)).toBe(false);
    });

    it('should return false when no file input present', () => {
      const snapshot = createSnapshot([
        createElement({ type: 'text' }),
        createElement({ type: 'button' }),
      ]);
      expect(hasFileInput(snapshot)).toBe(false);
    });
  });

  describe('isFileUploadTarget', () => {
    it('should detect direct file input', () => {
      const snapshot = createSnapshot([
        createElement({ ref: 'file_input', type: 'file' }),
      ]);
      expect(isFileUploadTarget('file_input', snapshot)).toBe(true);
    });

    it('should detect upload button by text', () => {
      const snapshot = createSnapshot([
        createElement({ ref: 'upload_btn', name: 'Upload File', tag: 'button' }),
      ]);
      expect(isFileUploadTarget('upload_btn', snapshot)).toBe(true);
    });

    it('should detect various upload keywords', () => {
      const snapshot = createSnapshot([
        createElement({ ref: 'btn1', name: 'Choose File' }),
        createElement({ ref: 'btn2', name: 'Browse Files' }),
        createElement({ ref: 'btn3', name: 'Attach Document' }),
        createElement({ ref: 'btn4', name: 'Add File' }),
      ]);

      expect(isFileUploadTarget('btn1', snapshot)).toBe(true);
      expect(isFileUploadTarget('btn2', snapshot)).toBe(true);
      expect(isFileUploadTarget('btn3', snapshot)).toBe(true);
      expect(isFileUploadTarget('btn4', snapshot)).toBe(true);
    });

    it('should return false for non-upload elements', () => {
      const snapshot = createSnapshot([
        createElement({ ref: 'submit_btn', name: 'Submit', tag: 'button' }),
      ]);
      expect(isFileUploadTarget('submit_btn', snapshot)).toBe(false);
    });

    it('should return false for non-existent ref', () => {
      const snapshot = createSnapshot([
        createElement({ ref: 'btn1', name: 'Click' }),
      ]);
      expect(isFileUploadTarget('non_existent', snapshot)).toBe(false);
    });
  });

  describe('isPaymentContext', () => {
    it('should detect payment keywords in target text', () => {
      const snapshot = createSnapshot([]);

      expect(isPaymentContext(snapshot, 'Pay Now')).toBe(true);
      expect(isPaymentContext(snapshot, 'Checkout')).toBe(true);
      expect(isPaymentContext(snapshot, 'Place Order')).toBe(true);
      expect(isPaymentContext(snapshot, 'Confirm Payment')).toBe(true);
      expect(isPaymentContext(snapshot, 'Purchase')).toBe(true);
      expect(isPaymentContext(snapshot, 'Buy Now')).toBe(true);
    });

    it('should detect payment fields in snapshot', () => {
      const snapshot = createSnapshot([
        createElement({ name: 'Card Number', visible: true }),
        createElement({ name: 'CVV', visible: true }),
      ]);

      expect(isPaymentContext(snapshot)).toBe(true);
    });

    it('should detect various payment field keywords', () => {
      const paymentFields = [
        'Card Number',
        'CVV',
        'CVC',
        'Billing Address',
        'Stripe Payment',
        'Payment Method',
        'Expiry Date',
        'Cardholder Name',
      ];

      paymentFields.forEach(fieldName => {
        const snapshot = createSnapshot([
          createElement({ name: fieldName, visible: true }),
        ]);
        expect(isPaymentContext(snapshot)).toBe(true);
      });
    });

    it('should be case-insensitive', () => {
      const snapshot = createSnapshot([
        createElement({ name: 'CARD NUMBER', visible: true }),
      ]);

      expect(isPaymentContext(snapshot)).toBe(true);
      expect(isPaymentContext(snapshot, 'PAY NOW')).toBe(true);
    });

    it('should return false when no payment indicators', () => {
      const snapshot = createSnapshot([
        createElement({ name: 'Username', visible: true }),
        createElement({ name: 'Email', visible: true }),
      ]);

      expect(isPaymentContext(snapshot, 'Submit')).toBe(false);
    });

    it('should ignore invisible elements', () => {
      const snapshot = createSnapshot([
        createElement({ name: 'Card Number', visible: false }),
      ]);

      expect(isPaymentContext(snapshot)).toBe(false);
    });

    it('should detect payment context with target text only', () => {
      const snapshot = createSnapshot([
        createElement({ name: 'Regular Button', visible: true }),
      ]);

      expect(isPaymentContext(snapshot, 'Checkout')).toBe(true);
    });
  });
});
