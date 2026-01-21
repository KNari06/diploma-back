import type { LiteSnapshot } from '../lite-types';

/**
 * Cross-origin check (treats protocol/subdomain differences as different origins).
 * Supports relative target URLs by resolving against current URL.
 */
export function isDifferentOrigin(currentUrl: string, targetUrl: string): boolean {
  try {
    const current = new URL(currentUrl);
    const target = new URL(targetUrl, current);
    return current.origin !== target.origin;
  } catch {
    return false;
  }
}

/**
 * Detect if text suggests download/export action.
 */
export function isDownloadText(text: string): boolean {
  const downloadKeywords = ['download', 'export', 'pdf', 'csv', 'xlsx', 'xls', 'report', 'print'];
  const lowerText = (text || '').toLowerCase();
  return downloadKeywords.some(keyword => lowerText.includes(keyword));
}

/**
 * Detect if snapshot has a visible, enabled file input.
 */
export function hasFileInput(snapshot: LiteSnapshot): boolean {
  return snapshot.elements.some(el => el.type === 'file' && el.visible && !el.disabled);
}

/**
 * Detect if the target ref is a file input or upload-related control.
 */
export function isFileUploadTarget(targetRef: string, snapshot: LiteSnapshot): boolean {
  const target = snapshot.elements.find(el => el.ref === targetRef);
  if (!target) return false;

  if (target.type === 'file') return true;

  const uploadKeywords = ['upload', 'choose file', 'browse', 'attach', 'add file'];
  const targetText = (target.name || '').toLowerCase();
  return uploadKeywords.some(keyword => targetText.includes(keyword));
}

/**
 * Detect payment/checkout context from target text and/or snapshot content.
 */
export function isPaymentContext(snapshot: LiteSnapshot, targetText?: string): boolean {
  if (targetText) {
    const paymentKeywords = ['pay', 'checkout', 'order', 'place order', 'confirm payment', 'purchase', 'buy now'];
    const lowerTargetText = targetText.toLowerCase();
    if (paymentKeywords.some(keyword => lowerTargetText.includes(keyword))) {
      return true;
    }
  }

  const paymentFieldKeywords = ['card number', 'cvv', 'cvc', 'billing', 'stripe', 'payment', 'expiry', 'cardholder'];
  const visibleText = snapshot.elements
    .filter(el => el.visible)
    .map(el => (el.name || '').toLowerCase())
    .join(' ');

  return paymentFieldKeywords.some(keyword => visibleText.includes(keyword));
}
