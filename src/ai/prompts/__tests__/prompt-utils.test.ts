import { z } from 'zod';
import { parseRobustJSON, truncateString, estimateTokens, maskPII } from '../prompt-utils';

describe('parseRobustJSON', () => {
  it('parses a clean JSON string directly', () => {
    expect(parseRobustJSON('{"a":1,"b":"x"}')).toEqual({ a: 1, b: 'x' });
  });

  it('extracts JSON from a markdown code block', () => {
    expect(parseRobustJSON('Here you go:\n```json\n{"a":1}\n```\nthanks')).toEqual({ a: 1 });
    expect(parseRobustJSON('```\n{"a":2}\n```')).toEqual({ a: 2 });
  });

  it('extracts the first {...} embedded in prose', () => {
    expect(parseRobustJSON('The result is {"ok":true} as requested')).toEqual({ ok: true });
  });

  it('validates against a Zod schema when provided', () => {
    const schema = z.object({ n: z.number() });
    expect(parseRobustJSON('{"n":5}', schema)).toEqual({ n: 5 });
  });

  it('throws when the content has no parseable JSON', () => {
    expect(() => parseRobustJSON('no json here at all')).toThrow(/Failed to parse JSON/);
  });

  it('throws when the parsed JSON fails schema validation', () => {
    const schema = z.object({ n: z.number() });
    expect(() => parseRobustJSON('{"n":"not-a-number"}', schema)).toThrow();
  });
});

describe('truncateString', () => {
  it('returns the string unchanged when within the limit', () => {
    expect(truncateString('hello', 10)).toBe('hello');
    expect(truncateString('hello', 5)).toBe('hello');
  });

  it('truncates and marks longer strings', () => {
    expect(truncateString('hello world', 5)).toBe('hello\n... (truncated)');
  });

  it('passes through empty/falsy input', () => {
    expect(truncateString('', 5)).toBe('');
  });
});

describe('estimateTokens', () => {
  it('returns 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('approximates 1 token per 4 chars (rounded up)', () => {
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
    expect(estimateTokens('a'.repeat(40))).toBe(10);
  });
});

describe('maskPII', () => {
  it('returns empty string for empty input', () => {
    expect(maskPII('')).toBe('');
  });

  it('masks email addresses', () => {
    const out = maskPII('Reach me at alice@example.com please');
    expect(out).toContain('[EMAIL]');
    expect(out).not.toContain('alice@example.com');
  });

  it('masks long token-like strings', () => {
    const token = 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8'; // 36 chars
    const out = maskPII(`token=${token}`);
    expect(out).not.toContain(token);
    expect(out).toContain('[TOKEN]');
  });

  it('masks JWTs', () => {
    const out = maskPII('auth eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4');
    expect(out).toContain('[JWT]');
  });

  it('masks shorter sk_/api_ keys via the api-key pattern', () => {
    const out = maskPII('key sk_livedummyabcdefghij12'); // sk_ + 20 chars, < 32 → not the token rule
    expect(out).not.toContain('sk_livedummyabcdefghij12');
  });

  it('strips secrets from a mixed string', () => {
    const out = maskPII('user bob@corp.io paid with 4111 1111 1111 1111');
    expect(out).not.toContain('bob@corp.io');
    expect(out).not.toContain('4111 1111 1111 1111');
  });
});
