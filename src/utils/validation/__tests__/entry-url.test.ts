import { normalizeEntryUrl } from '../entry-url';
import { ValidationError } from '@/types';

describe('normalizeEntryUrl', () => {
  const originalEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe('scheme prepending — the gap that made REST reject what users type', () => {
    it('accepts a bare domain and defaults it to https', () => {
      expect(normalizeEntryUrl('app.acme.com')).toBe('https://app.acme.com/');
    });

    it('accepts a bare domain with a path', () => {
      expect(normalizeEntryUrl('acme.com/dashboard')).toBe('https://acme.com/dashboard');
    });

    it('leaves an explicit scheme untouched', () => {
      expect(normalizeEntryUrl('http://example.com')).toBe('http://example.com/');
      expect(normalizeEntryUrl('https://example.com/path')).toBe('https://example.com/path');
    });

    it('trims surrounding whitespace', () => {
      expect(normalizeEntryUrl('  acme.com  ')).toBe('https://acme.com/');
    });
  });

  describe('rejects what it should', () => {
    it('throws on empty or non-string input', () => {
      expect(() => normalizeEntryUrl('')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('   ')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl(null)).toThrow(ValidationError);
      expect(() => normalizeEntryUrl(undefined)).toThrow(ValidationError);
      expect(() => normalizeEntryUrl(42)).toThrow(ValidationError);
    });

    it('throws on a non-http(s) scheme rather than prefixing it', () => {
      expect(() => normalizeEntryUrl('ftp://example.com')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('file:///etc/passwd')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('javascript:alert(1)')).toThrow(ValidationError);
    });

    it('does not turn a malformed scheme into a hostname', () => {
      // 'htp://x' contains '://' so it must NOT become 'https://htp://x' —
      // it has to surface as a protocol error.
      expect(() => normalizeEntryUrl('htp://x')).toThrow(ValidationError);
    });
  });

  describe('SSRF blocklist (the hole the chat path had)', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('blocks loopback and unspecified hosts', () => {
      expect(() => normalizeEntryUrl('http://localhost:3000')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('http://127.0.0.1')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('http://0.0.0.0')).toThrow(ValidationError);
    });

    it('blocks private ranges and the cloud metadata endpoint', () => {
      expect(() => normalizeEntryUrl('http://10.0.0.5')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('http://192.168.1.1')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('http://172.16.0.1')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('http://169.254.169.254/latest/meta-data')).toThrow(ValidationError);
    });

    it('blocks a bare private IP typed without a scheme', () => {
      // The scheme-prepending must not create a bypass.
      expect(() => normalizeEntryUrl('169.254.169.254')).toThrow(ValidationError);
      expect(() => normalizeEntryUrl('10.0.0.5')).toThrow(ValidationError);
    });

    it('allows a normal public host', () => {
      expect(normalizeEntryUrl('acme.com')).toBe('https://acme.com/');
    });
  });

  describe('scheme selection is decided on the parsed HOST, not a string prefix', () => {
    it('does not downgrade localhost.attacker.com to cleartext http', () => {
      process.env.NODE_ENV = 'development';
      // A raw-string `startsWith('localhost')` check matched this and served an
      // attacker-chosen host over http://.
      expect(normalizeEntryUrl('localhost.attacker.com')).toBe('https://localhost.attacker.com/');
    });

    it('does not downgrade a host merely starting with a loopback IP', () => {
      process.env.NODE_ENV = 'development';
      expect(normalizeEntryUrl('127.0.0.1.evil.com')).toBe('https://127.0.0.1.evil.com/');
    });

    it('still uses http for a real loopback subdomain', () => {
      process.env.NODE_ENV = 'development';
      expect(normalizeEntryUrl('app.localhost:3000')).toBe('http://app.localhost:3000/');
    });
  });

  describe('local development carve-out', () => {
    it('allows localhost in development so devs can explore local apps', () => {
      process.env.NODE_ENV = 'development';
      expect(normalizeEntryUrl('localhost:3000')).toBe('http://localhost:3000/');
    });

    it('uses http (not https) for localhost, matching the chat helper', () => {
      process.env.NODE_ENV = 'development';
      expect(normalizeEntryUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    });
  });
});
