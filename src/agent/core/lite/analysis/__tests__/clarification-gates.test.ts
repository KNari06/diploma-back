import {
  isDifferentOrigin,
  isDownloadText,
  hasFileInput,
  isFileUploadTarget,
  isPaymentContext,
} from '../clarification-gates';

const el = (over: any = {}) => ({ ref: 'e1', type: 'button', name: '', visible: true, disabled: false, ...over });
const snap = (elements: any[]): any => ({ url: 'https://app.com', elements });

describe('isDifferentOrigin', () => {
  it('is false for same-origin URLs', () => {
    expect(isDifferentOrigin('https://a.com/x', 'https://a.com/y')).toBe(false);
  });
  it('is true for a different host or protocol', () => {
    expect(isDifferentOrigin('https://a.com', 'https://b.com')).toBe(true);
    expect(isDifferentOrigin('https://a.com', 'http://a.com')).toBe(true);
  });
  it('resolves a relative target against the current URL (same origin)', () => {
    expect(isDifferentOrigin('https://a.com/page', '/other')).toBe(false);
  });
  it('returns false on an unparseable current URL', () => {
    expect(isDifferentOrigin('not a url', '/x')).toBe(false);
  });
});

describe('isDownloadText', () => {
  it('matches download/export keywords case-insensitively', () => {
    expect(isDownloadText('Download report')).toBe(true);
    expect(isDownloadText('Export to CSV')).toBe(true);
    expect(isDownloadText('Save as PDF')).toBe(true);
  });
  it('is false for unrelated or empty text', () => {
    expect(isDownloadText('Submit form')).toBe(false);
    expect(isDownloadText('')).toBe(false);
  });
});

describe('hasFileInput', () => {
  it('detects a visible, enabled file input', () => {
    expect(hasFileInput(snap([el({ type: 'file' })]))).toBe(true);
  });
  it('ignores hidden or disabled file inputs and non-file elements', () => {
    expect(hasFileInput(snap([el({ type: 'file', visible: false })]))).toBe(false);
    expect(hasFileInput(snap([el({ type: 'file', disabled: true })]))).toBe(false);
    expect(hasFileInput(snap([el({ type: 'button' })]))).toBe(false);
  });
});

describe('isFileUploadTarget', () => {
  it('is true when the target is a file input', () => {
    expect(isFileUploadTarget('e1', snap([el({ ref: 'e1', type: 'file' })]))).toBe(true);
  });
  it('is true when the target name reads like an upload control', () => {
    expect(isFileUploadTarget('e1', snap([el({ ref: 'e1', name: 'Upload photo' })]))).toBe(true);
    expect(isFileUploadTarget('e1', snap([el({ ref: 'e1', name: 'Browse files' })]))).toBe(true);
  });
  it('is false for unrelated targets or a missing ref', () => {
    expect(isFileUploadTarget('e1', snap([el({ ref: 'e1', name: 'Save' })]))).toBe(false);
    expect(isFileUploadTarget('missing', snap([el({ ref: 'e1' })]))).toBe(false);
  });
});

describe('isPaymentContext', () => {
  it('detects payment intent from the target text', () => {
    expect(isPaymentContext(snap([]), 'Place order')).toBe(true);
    expect(isPaymentContext(snap([]), 'Buy now')).toBe(true);
  });
  it('detects payment context from visible field names', () => {
    expect(isPaymentContext(snap([el({ name: 'Card number' })]), 'Continue')).toBe(true);
    expect(isPaymentContext(snap([el({ name: 'CVV' })]))).toBe(true);
  });
  it('ignores payment fields that are not visible', () => {
    expect(isPaymentContext(snap([el({ name: 'Card number', visible: false })]))).toBe(false);
  });
  it('is false with no payment signal', () => {
    expect(isPaymentContext(snap([el({ name: 'Email' })]), 'Subscribe')).toBe(false);
  });
});
