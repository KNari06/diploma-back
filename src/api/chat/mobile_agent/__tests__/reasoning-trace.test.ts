// Mutable env mock so we can flip the persist flag per test; redactCredentials
// is mocked to a sentinel so we test the wrapper's contract, not the redactor.
const mockEnv: Record<string, unknown> = {};
jest.mock('@/config/environment/env', () => ({ env: mockEnv }));
jest.mock('@/utils/security/redact-credentials', () => ({ redactCredentials: jest.fn((x: string) => `RED:${x}`) }));

import { sanitizeReasoning, safeTruncate, isReasoningPersistEnabled } from '../reasoning-trace';
import { redactCredentials } from '@/utils/security/redact-credentials';

const redactMock = redactCredentials as jest.Mock;

describe('sanitizeReasoning', () => {
  it('delegates non-empty strings to redactCredentials', () => {
    expect(sanitizeReasoning('password=qwerty123')).toBe('RED:password=qwerty123');
    expect(redactMock).toHaveBeenCalledWith('password=qwerty123');
  });

  it('returns "" for empty / non-string input without calling the redactor', () => {
    expect(sanitizeReasoning('')).toBe('');
    expect(sanitizeReasoning(null as unknown as string)).toBe('');
    expect(sanitizeReasoning(123 as unknown as string)).toBe('');
    expect(redactMock).not.toHaveBeenCalled();
  });
});

describe('safeTruncate', () => {
  it('returns "" for falsy input', () => {
    expect(safeTruncate('', 10)).toBe('');
  });

  it('returns the input unchanged when within the limit', () => {
    expect(safeTruncate('short', 10)).toBe('short');
    expect(safeTruncate('exactly-10', 10)).toBe('exactly-10'); // length === max
  });

  it('breaks at the last space within the trailing window', () => {
    // 'hello world foo' (15) capped at 12 → break at the space after "world".
    expect(safeTruncate('hello world foo', 12)).toBe('hello world…');
  });

  it('trims trailing whitespace before the ellipsis', () => {
    expect(safeTruncate('abc   def ghi', 6)).toBe('abc…');
  });

  it('hard-cuts when there is no space to break on', () => {
    const input = 'a'.repeat(40);
    expect(safeTruncate(input, 30)).toBe('a'.repeat(30) + '…');
  });
});

describe('isReasoningPersistEnabled', () => {
  it('defaults to enabled when the flag is unset', () => {
    delete mockEnv.MOBILE_AGENT_PERSIST_REASONING;
    expect(isReasoningPersistEnabled()).toBe(true);
  });

  it('stays enabled when the flag is explicitly true', () => {
    mockEnv.MOBILE_AGENT_PERSIST_REASONING = true;
    expect(isReasoningPersistEnabled()).toBe(true);
  });

  it('is disabled only when the flag is exactly false', () => {
    mockEnv.MOBILE_AGENT_PERSIST_REASONING = false;
    expect(isReasoningPersistEnabled()).toBe(false);
  });
});
