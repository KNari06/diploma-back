import {
  isFreeEmailDomain,
  isDisposableEmailDomain,
  validateBusinessEmail,
  BUSINESS_EMAIL_ERROR_CODES,
} from '../businessEmail';

// Anchor domains verified against businessEmail.data.ts:
//   free:       gmail.com, yahoo.com
//   disposable: mailinator.com, 10minutemail.com
//   business:   qait.dev (absent from both lists)

describe('isFreeEmailDomain', () => {
  it('recognizes a known free-provider domain', () => {
    expect(isFreeEmailDomain('alice@gmail.com')).toBe(true);
    expect(isFreeEmailDomain('bob@yahoo.com')).toBe(true);
  });

  it('returns false for a business domain', () => {
    expect(isFreeEmailDomain('alice@qait.dev')).toBe(false);
  });

  it('is case-insensitive on the domain', () => {
    expect(isFreeEmailDomain('Alice@GMAIL.COM')).toBe(true);
  });

  it('uses the domain after the last @', () => {
    expect(isFreeEmailDomain('weird@name@gmail.com')).toBe(true);
  });

  it('returns false for malformed or empty input', () => {
    expect(isFreeEmailDomain('')).toBe(false);
    expect(isFreeEmailDomain('no-at-sign')).toBe(false);
    expect(isFreeEmailDomain('trailing@')).toBe(false);
    expect(isFreeEmailDomain(null as any)).toBe(false);
  });
});

describe('isDisposableEmailDomain', () => {
  it('recognizes a known disposable domain', () => {
    expect(isDisposableEmailDomain('x@mailinator.com')).toBe(true);
    expect(isDisposableEmailDomain('x@10minutemail.com')).toBe(true);
  });

  it('returns false for a business domain', () => {
    expect(isDisposableEmailDomain('x@qait.dev')).toBe(false);
  });
});

describe('validateBusinessEmail', () => {
  it('accepts a genuine business email', () => {
    expect(validateBusinessEmail('founder@qait.dev')).toEqual({ ok: true });
  });

  it('rejects a free-provider email with reason "free"', () => {
    expect(validateBusinessEmail('someone@gmail.com')).toEqual({ ok: false, reason: 'free' });
  });

  it('rejects a disposable email with reason "disposable"', () => {
    expect(validateBusinessEmail('throwaway@mailinator.com')).toEqual({
      ok: false,
      reason: 'disposable',
    });
  });

  it('exposes stable error codes for each reason', () => {
    expect(BUSINESS_EMAIL_ERROR_CODES.free).toBe('BUSINESS_EMAIL_REQUIRED');
    expect(BUSINESS_EMAIL_ERROR_CODES.disposable).toBe('DISPOSABLE_EMAIL_NOT_ALLOWED');
  });
});
