/**
 * Unit tests for pii-redactor.ts.
 *
 * Two angles:
 *   1. Patterns hit when they should (positive cases).
 *   2. Patterns DON'T hit benign content (no-op cases) — the over-redact
 *      cost is acceptable, but we still confirm we're not eating
 *      everything in sight.
 */

import { redactPii, isValidLuhn } from '../pii-redactor';

describe('isValidLuhn', () => {
  it('accepts canonical test card numbers', () => {
    expect(isValidLuhn('4111111111111111')).toBe(true);  // Visa test
    expect(isValidLuhn('5500000000000004')).toBe(true);  // MasterCard test
    expect(isValidLuhn('340000000000009')).toBe(true);   // Amex 15-digit test
  });

  it('rejects random 16-digit numbers', () => {
    expect(isValidLuhn('1234567890123456')).toBe(false);
    expect(isValidLuhn('0000000000000000')).toBe(true);  // technically passes
    expect(isValidLuhn('9999999999999999')).toBe(false);
  });

  it('strips dashes and spaces before checking', () => {
    expect(isValidLuhn('4111-1111-1111-1111')).toBe(true);
    expect(isValidLuhn('4111 1111 1111 1111')).toBe(true);
  });

  it('rejects too-short / too-long sequences', () => {
    expect(isValidLuhn('411111')).toBe(false);
    expect(isValidLuhn('4'.repeat(25))).toBe(false);
  });

  it('rejects non-digit characters', () => {
    expect(isValidLuhn('4111abcd11111111')).toBe(false);
  });
});

describe('redactPii — empty / no-op', () => {
  it('passes empty string through', () => {
    expect(redactPii('')).toBe('');
  });

  it('leaves plain English text untouched', () => {
    const input = 'The user tapped the login button on the home screen.';
    expect(redactPii(input)).toBe(input);
  });

  it('does NOT redact common UI labels', () => {
    expect(redactPii('Settings')).toBe('Settings');
    expect(redactPii('Continue')).toBe('Continue');
    expect(redactPii('Sign in with Google')).toBe('Sign in with Google');
  });
});

describe('redactPii — emails', () => {
  it('redacts a standard email', () => {
    expect(redactPii('Sent to user@example.com today')).toBe(
      'Sent to <redacted:email> today',
    );
  });

  it('redacts emails with plus addressing', () => {
    expect(redactPii('alerts+2026@gmail.com')).toBe('<redacted:email>');
  });

  it('redacts multiple emails in one string', () => {
    expect(redactPii('From a@b.com to c@d.org')).toBe(
      'From <redacted:email> to <redacted:email>',
    );
  });

  it('does NOT redact strings that look like emails but are not (no TLD)', () => {
    expect(redactPii('@username on twitter')).toBe('@username on twitter');
  });
});

describe('redactPii — JWTs', () => {
  it('redacts a JWT-shaped token', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    expect(redactPii(`Authorization: Bearer ${jwt}`)).toBe(
      'Authorization: Bearer <redacted:jwt>',
    );
  });

  it('does NOT redact "x.y.z" version-shape strings', () => {
    expect(redactPii('v1.2.3 released')).toBe('v1.2.3 released');
  });
});

describe('redactPii — card numbers (Luhn-validated)', () => {
  it('redacts a valid Visa test number', () => {
    expect(redactPii('Card: 4111111111111111')).toBe('Card: <redacted:card>');
  });

  it('redacts a card with spaces', () => {
    expect(redactPii('4111 1111 1111 1111')).toBe('<redacted:card>');
  });

  it('non-Luhn 16-digit order IDs fall through to the PHONE redaction (over-redact > under-redact)', () => {
    // Documented behaviour: a 16-digit number that fails Luhn is NOT a card,
    // but it IS ≥10 digits — the phone pattern then claims it. We prefer
    // over-redacting an order ID to leaking a real phone number that happens
    // to be 16 digits long. False-positive cost is "the LLM sees
    // <redacted:phone> instead of the order ID"; the negative cost would be
    // leaking PII. The trade-off is intentional.
    expect(redactPii('Order #1234567890123456')).toBe('Order #<redacted:phone>');
  });

  it('non-Luhn 16-digit tracking number also falls through to phone (same trade-off)', () => {
    expect(redactPii('Tracking 9876543210987654')).toBe('Tracking <redacted:phone>');
  });
});

describe('redactPii — phone numbers', () => {
  it('redacts international format', () => {
    expect(redactPii('Call +1 555 123 4567 now')).toBe('Call <redacted:phone> now');
  });

  it('redacts Russian format with parens', () => {
    expect(redactPii('+7 (123) 456-78-90')).toBe('<redacted:phone>');
  });

  it('redacts dashed US format', () => {
    expect(redactPii('555-123-4567')).toBe('<redacted:phone>');
  });

  it('does NOT redact short numbers (< 10 digits)', () => {
    // Note: short numbers (4-8 digits) get caught by OTP pattern.
    // Anything below 4 digits is left alone.
    expect(redactPii('Year 1989')).toBe('Year <redacted:otp>');
    expect(redactPii('Price: $99')).toBe('Price: $99');
  });
});

describe('redactPii — OTP codes', () => {
  it('redacts a 6-digit code', () => {
    expect(redactPii('Your code is 123456')).toBe('Your code is <redacted:otp>');
  });

  it('redacts a 4-digit PIN', () => {
    expect(redactPii('PIN: 1234')).toBe('PIN: <redacted:otp>');
  });

  it('over-redacts years and prices (accepted trade-off)', () => {
    // Documented behaviour — false positives on bare digits are the
    // price of catching real OTPs that don't carry a "code:" prefix.
    expect(redactPii('Born in 1989')).toBe('Born in <redacted:otp>');
  });

  it('does NOT touch 1-3 digit numbers', () => {
    expect(redactPii('Page 7 of 12')).toBe('Page 7 of 12');
    expect(redactPii('99% complete')).toBe('99% complete');
  });
});

describe('redactPii — order matters (no double-redaction)', () => {
  it('redacts card before OTP catches the trailing digits', () => {
    // 16-digit valid card. If OTP ran first it would over-eat segments.
    expect(redactPii('Card 4111111111111111 used.')).toBe(
      'Card <redacted:card> used.',
    );
  });

  it('redacts JWT before any other pattern can fragment it', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.aaaaaaaaaaaaaaaaa';
    expect(redactPii(`Authorization Bearer ${jwt}`)).toBe(
      `Authorization Bearer <redacted:jwt>`,
    );
  });
});

describe('redactPii — multiline a11y-tree-like input', () => {
  it('redacts across lines independently', () => {
    const input = [
      'EditText "email": user@example.com',
      'EditText "phone": +1 555 123 4567',
      'EditText "card":  4111111111111111',
      'TextView "Welcome back!"',
    ].join('\n');
    const out = redactPii(input);
    expect(out).toContain('<redacted:email>');
    expect(out).toContain('<redacted:phone>');
    expect(out).toContain('<redacted:card>');
    expect(out).toContain('Welcome back!'); // unchanged
  });
});
