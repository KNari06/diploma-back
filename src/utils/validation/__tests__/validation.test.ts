/**
 * Unit tests for validation.ts
 * Tests UUID validation, URL sanitization, and other validators
 */

import {
  isValidUUID,
  sanitizeUrl,
  sanitizeHtml,
  sanitizeLogs,
  validateViewport,
  validateTimeout,
  validateRetries,
  validateBrowserCompatibility,
  validateScreenshot,
  validateDom,
  validateRequest,
  uuidSchema,
} from '../validation';
import { ValidationError } from '@/types';

describe('validation utilities', () => {
  // ═══════════════════════════════════════════════════════════════════════════
  // isValidUUID
  // ═══════════════════════════════════════════════════════════════════════════
  describe('isValidUUID', () => {
    it('should return true for valid UUID v4', () => {
      expect(isValidUUID('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
      expect(isValidUUID('6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe(true);
    });

    it('should return true for uppercase UUID', () => {
      expect(isValidUUID('550E8400-E29B-41D4-A716-446655440000')).toBe(true);
    });

    it('should return false for invalid UUID formats', () => {
      expect(isValidUUID('not-a-uuid')).toBe(false);
      expect(isValidUUID('550e8400-e29b-41d4-a716')).toBe(false); // Too short
      expect(isValidUUID('550e8400e29b41d4a716446655440000')).toBe(false); // No dashes
      expect(isValidUUID('550e8400-e29b-41d4-a716-44665544000g')).toBe(false); // Invalid char
    });

    it('should return false for null/undefined/empty', () => {
      expect(isValidUUID(null)).toBe(false);
      expect(isValidUUID(undefined)).toBe(false);
      expect(isValidUUID('')).toBe(false);
    });

    it('should return false for non-strings', () => {
      // @ts-expect-error - Testing invalid input
      expect(isValidUUID(123)).toBe(false);
      // @ts-expect-error - Testing invalid input
      expect(isValidUUID({})).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // sanitizeUrl
  // ═══════════════════════════════════════════════════════════════════════════
  describe('sanitizeUrl', () => {
    it('should accept valid HTTPS URLs', () => {
      const result = sanitizeUrl('https://example.com/path');
      expect(result).toBe('https://example.com/path');
    });

    it('should accept valid HTTP URLs', () => {
      const result = sanitizeUrl('http://example.com');
      expect(result).toBe('http://example.com/');
    });

    it('should trim whitespace', () => {
      const result = sanitizeUrl('  https://example.com  ');
      expect(result).toBe('https://example.com/');
    });

    it('should throw for empty/null input', () => {
      expect(() => sanitizeUrl('')).toThrow(ValidationError);
      // @ts-expect-error - Testing invalid input
      expect(() => sanitizeUrl(null)).toThrow(ValidationError);
      // @ts-expect-error - Testing invalid input
      expect(() => sanitizeUrl(undefined)).toThrow(ValidationError);
    });

    it('should throw for non-http/https protocols', () => {
      expect(() => sanitizeUrl('ftp://example.com')).toThrow(ValidationError);
      expect(() => sanitizeUrl('file:///path')).toThrow(ValidationError);
      expect(() => sanitizeUrl('javascript:alert(1)')).toThrow(ValidationError);
    });

    it('should throw for localhost URLs', () => {
      expect(() => sanitizeUrl('http://localhost:3000')).toThrow(ValidationError);
      expect(() => sanitizeUrl('http://127.0.0.1')).toThrow(ValidationError);
      expect(() => sanitizeUrl('http://0.0.0.0')).toThrow(ValidationError);
    });

    it('should throw for SSRF-prone hosts (private + cloud metadata)', () => {
      expect(() => sanitizeUrl('http://169.254.169.254/latest/meta-data')).toThrow(ValidationError);
      expect(() => sanitizeUrl('http://10.0.0.5')).toThrow(ValidationError);
      expect(() => sanitizeUrl('http://192.168.1.1')).toThrow(ValidationError);
      expect(() => sanitizeUrl('http://172.16.0.1')).toThrow(ValidationError);
      expect(() => sanitizeUrl('http://[::1]')).toThrow(ValidationError);
    });

    it('should throw for invalid URL format', () => {
      expect(() => sanitizeUrl('not-a-url')).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // sanitizeHtml
  // ═══════════════════════════════════════════════════════════════════════════
  describe('sanitizeHtml', () => {
    it('should return empty string for null/undefined', () => {
      // @ts-expect-error - Testing invalid input
      expect(sanitizeHtml(null)).toBe('');
      // @ts-expect-error - Testing invalid input
      expect(sanitizeHtml(undefined)).toBe('');
    });

    it('should remove script tags', () => {
      const result = sanitizeHtml('<div><script>alert("xss")</script>Hello</div>');
      expect(result).not.toContain('<script');
      expect(result).toContain('Hello');
    });

    it('should remove iframe tags', () => {
      const result = sanitizeHtml('<div><iframe src="evil.com"></iframe>Content</div>');
      expect(result).not.toContain('<iframe');
      expect(result).toContain('Content');
    });

    it('should remove inline event handlers', () => {
      const result = sanitizeHtml('<button onclick="evil()">Click</button>');
      expect(result).not.toContain('onclick');
      expect(result).toContain('Click');
    });

    it('should remove javascript: protocol', () => {
      const result = sanitizeHtml('<a href="javascript:alert(1)">Link</a>');
      expect(result).not.toContain('javascript:');
      expect(result).toContain('Link');
    });

    it('should keep safe HTML', () => {
      const html = '<div class="test"><p>Safe content</p></div>';
      const result = sanitizeHtml(html);
      expect(result).toContain('<div');
      expect(result).toContain('Safe content');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // sanitizeLogs
  // ═══════════════════════════════════════════════════════════════════════════
  describe('sanitizeLogs', () => {
    it('should return empty array for null/undefined', () => {
      // @ts-expect-error - Testing invalid input
      expect(sanitizeLogs(null)).toEqual([]);
      // @ts-expect-error - Testing invalid input
      expect(sanitizeLogs(undefined)).toEqual([]);
    });

    it('should return empty array for non-array', () => {
      // @ts-expect-error - Testing invalid input
      expect(sanitizeLogs('string')).toEqual([]);
      // @ts-expect-error - Testing invalid input
      expect(sanitizeLogs({})).toEqual([]);
    });

    it('should filter out null/undefined entries', () => {
      const result = sanitizeLogs(['log1', null, 'log2', undefined, 'log3'] as any);
      expect(result).toEqual(['log1', 'log2', 'log3']);
    });

    it('should convert non-strings to strings', () => {
      const result = sanitizeLogs([123, true, { key: 'value' }] as any);
      expect(result).toEqual(['123', 'true', '[object Object]']);
    });

    it('should remove control characters', () => {
      const result = sanitizeLogs(['log\x00with\x1Fcontrol\x7Fchars']);
      expect(result[0]).toBe('logwithcontrolchars');
    });

    it('should truncate long logs', () => {
      const longLog = 'a'.repeat(20000);
      const result = sanitizeLogs([longLog]);
      expect(result[0].length).toBe(10000);
    });

    it('should filter out empty strings after processing', () => {
      // Only truly empty strings after control char removal are filtered
      // Whitespace-only strings become empty after being converted but before the filter
      const result = sanitizeLogs(['', '\x00\x01']);
      // Empty string stays empty, control chars are removed leaving empty string
      expect(result).toEqual([]);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateViewport
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateViewport', () => {
    it('should accept valid viewport', () => {
      expect(() => validateViewport({ width: 1920, height: 1080 })).not.toThrow();
    });

    it('should accept undefined (optional)', () => {
      expect(() => validateViewport(undefined)).not.toThrow();
      expect(() => validateViewport(null)).not.toThrow();
    });

    it('should throw for non-object viewport', () => {
      expect(() => validateViewport('1920x1080')).toThrow(ValidationError);
      expect(() => validateViewport([])).toThrow(ValidationError);
    });

    it('should throw for invalid width', () => {
      expect(() => validateViewport({ width: 50, height: 1080 })).toThrow(ValidationError);
      expect(() => validateViewport({ width: 5000, height: 1080 })).toThrow(ValidationError);
      expect(() => validateViewport({ width: NaN, height: 1080 })).toThrow(ValidationError);
      expect(() => validateViewport({ width: 100.5, height: 1080 })).toThrow(ValidationError);
    });

    it('should throw for invalid height', () => {
      expect(() => validateViewport({ width: 1920, height: 50 })).toThrow(ValidationError);
      expect(() => validateViewport({ width: 1920, height: 5000 })).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateTimeout
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateTimeout', () => {
    it('should accept valid timeout', () => {
      expect(() => validateTimeout(5000)).not.toThrow();
      expect(() => validateTimeout(1000)).not.toThrow();
      expect(() => validateTimeout(300000)).not.toThrow();
    });

    it('should throw for timeout too low', () => {
      expect(() => validateTimeout(500)).toThrow(ValidationError);
      expect(() => validateTimeout(0)).toThrow(ValidationError);
      expect(() => validateTimeout(-1000)).toThrow(ValidationError);
    });

    it('should throw for timeout too high', () => {
      expect(() => validateTimeout(400000)).toThrow(ValidationError);
    });

    it('should throw for non-integer timeout', () => {
      expect(() => validateTimeout(5000.5)).toThrow(ValidationError);
      expect(() => validateTimeout(NaN)).toThrow(ValidationError);
      expect(() => validateTimeout(Infinity)).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateRetries
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateRetries', () => {
    it('should accept valid retries', () => {
      expect(() => validateRetries(0)).not.toThrow();
      expect(() => validateRetries(3)).not.toThrow();
      expect(() => validateRetries(10)).not.toThrow();
    });

    it('should throw for negative retries', () => {
      expect(() => validateRetries(-1)).toThrow(ValidationError);
    });

    it('should throw for retries > 10', () => {
      expect(() => validateRetries(11)).toThrow(ValidationError);
    });

    it('should throw for non-integer retries', () => {
      expect(() => validateRetries(2.5)).toThrow(ValidationError);
      expect(() => validateRetries(NaN)).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateBrowserCompatibility
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateBrowserCompatibility', () => {
    it('should accept valid browsers array', () => {
      expect(() => validateBrowserCompatibility(['chrome', 'firefox'])).not.toThrow();
    });

    it('should throw for empty array', () => {
      expect(() => validateBrowserCompatibility([])).toThrow(ValidationError);
    });

    it('should throw for null/undefined', () => {
      // @ts-expect-error - Testing invalid input
      expect(() => validateBrowserCompatibility(null)).toThrow(ValidationError);
      // @ts-expect-error - Testing invalid input
      expect(() => validateBrowserCompatibility(undefined)).toThrow(ValidationError);
    });

    it('should throw for non-string browser entries', () => {
      // @ts-expect-error - Testing invalid input
      expect(() => validateBrowserCompatibility([123, 'chrome'])).toThrow(ValidationError);
      expect(() => validateBrowserCompatibility(['', 'chrome'])).toThrow(ValidationError);
    });

    it('should throw for mixing mobile and desktop with mobile option', () => {
      expect(() =>
        validateBrowserCompatibility(['chrome', 'mobile-chrome'], { mobile: true })
      ).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateScreenshot
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateScreenshot', () => {
    it('should accept undefined/null (optional)', () => {
      expect(() => validateScreenshot(undefined as any)).not.toThrow();
      expect(() => validateScreenshot(null as any)).not.toThrow();
    });

    it('should accept empty string', () => {
      expect(() => validateScreenshot('')).not.toThrow();
      expect(() => validateScreenshot('   ')).not.toThrow();
    });

    it('should accept valid base64 image', () => {
      const validBase64 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
      expect(() => validateScreenshot(validBase64)).not.toThrow();
    });

    it('should throw for non-string', () => {
      expect(() => validateScreenshot(123 as any)).toThrow(ValidationError);
    });

    it('should throw for missing data URI prefix', () => {
      expect(() => validateScreenshot('iVBORw0KGgoAAAANSUhEUg==')).toThrow(ValidationError);
    });

    it('should throw for invalid base64 characters', () => {
      expect(() => validateScreenshot('data:image/png;base64,invalid!@#$')).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateDom
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateDom', () => {
    it('should accept undefined/null (optional)', () => {
      expect(() => validateDom(undefined as any)).not.toThrow();
      expect(() => validateDom(null as any)).not.toThrow();
    });

    it('should accept valid HTML', () => {
      expect(() => validateDom('<html><body><div>Content</div></body></html>')).not.toThrow();
    });

    it('should throw for non-string', () => {
      expect(() => validateDom(123 as any)).toThrow(ValidationError);
    });

    it('should throw for DOM exceeding 1MB', () => {
      const largeDom = 'a'.repeat(1024 * 1024 + 1);
      expect(() => validateDom(largeDom)).toThrow(ValidationError);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // validateRequest with Zod schema
  // ═══════════════════════════════════════════════════════════════════════════
  describe('validateRequest', () => {
    it('should return parsed data for valid input', () => {
      const result = validateRequest(uuidSchema, '550e8400-e29b-41d4-a716-446655440000');
      expect(result).toBe('550e8400-e29b-41d4-a716-446655440000');
    });

    it('should throw ValidationError for invalid input', () => {
      expect(() => validateRequest(uuidSchema, 'not-a-uuid')).toThrow(ValidationError);
    });
  });
});
