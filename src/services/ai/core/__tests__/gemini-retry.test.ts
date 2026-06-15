/**
 * Unit tests for the Gemini transient-retry internals (one quick retry on
 * 503/429/5xx, abort-aware). Exercises the helpers directly — no live SDK.
 */

import { _retryInternals } from '../gemini.service';

const { isTransientGeminiError, callGeminiWithRetry } = _retryInternals;

describe('isTransientGeminiError', () => {
  it('classifies the real Gemini 503 "high demand" message as transient', () => {
    const e = new Error(
      '[GoogleGenerativeAI Error]: Error fetching from .../gemini-2.5-flash:generateContent: [503 Service Unavailable] The model is currently experiencing high demand. Please try again later.',
    );
    expect(isTransientGeminiError(e)).toBe(true);
  });

  it('classifies 429 / 500 / 502 / overloaded / rate limit as transient', () => {
    expect(isTransientGeminiError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientGeminiError(new Error('500 Internal Server Error'))).toBe(true);
    expect(isTransientGeminiError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientGeminiError(new Error('the model is overloaded'))).toBe(true);
    expect(isTransientGeminiError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('reads numeric .status and .code fields', () => {
    expect(isTransientGeminiError({ status: 503 })).toBe(true);
    expect(isTransientGeminiError({ code: 'ECONNRESET' })).toBe(true);
    expect(isTransientGeminiError({ code: 'ETIMEDOUT' })).toBe(true);
    expect(isTransientGeminiError({ status: 400 })).toBe(false);
  });

  it('treats permanent errors (400 / auth / parse) as NON-transient', () => {
    expect(isTransientGeminiError(new Error('400 Bad Request'))).toBe(false);
    expect(isTransientGeminiError(new Error('401 Unauthorized: bad key'))).toBe(false);
    expect(isTransientGeminiError(new Error('Unexpected token in JSON'))).toBe(false);
  });
});

describe('callGeminiWithRetry', () => {
  it('returns immediately on success (no retry)', async () => {
    const attempt = jest.fn().mockResolvedValue('ok');
    await expect(callGeminiWithRetry(attempt, undefined)).resolves.toBe('ok');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries ONCE on a transient error then succeeds', async () => {
    const attempt = jest
      .fn()
      .mockRejectedValueOnce(new Error('503 Service Unavailable'))
      .mockResolvedValueOnce('recovered');
    await expect(callGeminiWithRetry(attempt, undefined)).resolves.toBe('recovered');
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry a permanent error', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('400 Bad Request'));
    await expect(callGeminiWithRetry(attempt, undefined)).rejects.toThrow('400');
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('throws the last transient error after the single retry is exhausted', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('503 high demand'));
    await expect(callGeminiWithRetry(attempt, undefined)).rejects.toThrow('503');
    expect(attempt).toHaveBeenCalledTimes(2); // initial + one retry
  });

  it('does NOT retry when the caller signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const attempt = jest.fn().mockRejectedValue(new Error('503 Service Unavailable'));
    await expect(callGeminiWithRetry(attempt, controller.signal)).rejects.toThrow('503');
    expect(attempt).toHaveBeenCalledTimes(1); // aborted → surface immediately
  });
});
