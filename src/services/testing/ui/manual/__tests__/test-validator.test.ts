/**
 * Tests for validateTestRequest — the guard on the manual test-run request.
 * Each branch maps to a user-facing 400, so the specific message + the browser
 * whitelist matter (a wrong message or a missing valid browser is a real UX /
 * regression bug).
 */

import { validateTestRequest } from '../test-validator';
import { ValidationError } from '@/types';
import type { TestRunRequest } from '@/types';

function req(over: Partial<TestRunRequest> = {}): TestRunRequest {
  return {
    url: 'https://app.example.com',
    browsers: ['chrome'],
    projectId: 'p1',
    ...over,
  } as TestRunRequest;
}

describe('validateTestRequest', () => {
  it('accepts a well-formed request', () => {
    expect(() => validateTestRequest(req())).not.toThrow();
  });

  it('throws "URL is required" when url is missing', () => {
    expect(() => validateTestRequest(req({ url: '' }))).toThrow(ValidationError);
    expect(() => validateTestRequest(req({ url: undefined as unknown as string }))).toThrow(/URL is required/);
  });

  it('throws when no browsers are provided', () => {
    expect(() => validateTestRequest(req({ browsers: [] }))).toThrow(/At least one browser is required/);
    expect(() => validateTestRequest(req({ browsers: undefined as unknown as TestRunRequest['browsers'] }))).toThrow(
      /At least one browser is required/,
    );
  });

  it('throws when projectId is missing', () => {
    expect(() => validateTestRequest(req({ projectId: '' }))).toThrow(/Project ID is required/);
  });

  it('throws "Invalid URL format" for a malformed url', () => {
    expect(() => validateTestRequest(req({ url: 'not a url' }))).toThrow(/Invalid URL format/);
  });

  it('accepts every whitelisted browser', () => {
    const all = ['chrome', 'firefox', 'safari', 'edge', 'mobile-chrome', 'mobile-safari'];
    expect(() => validateTestRequest(req({ browsers: all as TestRunRequest['browsers'] }))).not.toThrow();
  });

  it('rejects an unknown browser, naming it in the message', () => {
    expect(() =>
      validateTestRequest(req({ browsers: ['internet-explorer'] as unknown as TestRunRequest['browsers'] })),
    ).toThrow(/Invalid browser: internet-explorer/);
  });

  it('rejects when one browser in a list is invalid', () => {
    expect(() =>
      validateTestRequest(req({ browsers: ['chrome', 'netscape'] as unknown as TestRunRequest['browsers'] })),
    ).toThrow(/Invalid browser: netscape/);
  });
});
