import {
  DEFAULT_RETRY_CONFIG,
  resolveRetryConfig,
  isRetryableError,
  calculateRetryDelay,
  sleep,
} from '../retry';

describe('resolveRetryConfig', () => {
  it('returns the defaults when no config is given', () => {
    expect(resolveRetryConfig()).toEqual(DEFAULT_RETRY_CONFIG);
  });

  it('clamps out-of-range values into the safe bounds', () => {
    expect(resolveRetryConfig({ maxRetries: 99, initialDelayMs: 999999, backoffMultiplier: 50 })).toEqual({
      maxRetries: 5,
      initialDelayMs: 10_000,
      backoffMultiplier: 5,
    });
    expect(resolveRetryConfig({ maxRetries: -3, initialDelayMs: 1, backoffMultiplier: 0 })).toEqual({
      maxRetries: 0,
      initialDelayMs: 50,
      backoffMultiplier: 1,
    });
  });

  it('falls back to defaults for NaN / non-finite values', () => {
    expect(resolveRetryConfig({ maxRetries: NaN, initialDelayMs: Infinity })).toMatchObject({
      maxRetries: DEFAULT_RETRY_CONFIG.maxRetries,
      initialDelayMs: DEFAULT_RETRY_CONFIG.initialDelayMs,
    });
  });

  it('rounds fractional retry counts and delays', () => {
    const cfg = resolveRetryConfig({ maxRetries: 3.7, initialDelayMs: 500.6 });
    expect(cfg.maxRetries).toBe(4);
    expect(cfg.initialDelayMs).toBe(501);
  });
});

describe('isRetryableError', () => {
  const errWith = (props: Record<string, unknown>): Error => Object.assign(new Error(String(props.message ?? 'err')), props);

  it('retries on structured retryable status codes', () => {
    expect(isRetryableError(errWith({ status: 429 }))).toBe(true);
    expect(isRetryableError(errWith({ statusCode: '503' }))).toBe(true);
  });

  it('does not retry on structured client-error status codes', () => {
    expect(isRetryableError(errWith({ status: 404 }))).toBe(false);
    expect(isRetryableError(errWith({ status: 422 }))).toBe(false);
  });

  it('retries on structured network error codes', () => {
    expect(isRetryableError(errWith({ code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableError(errWith({ code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('extracts an HTTP status from the message', () => {
    expect(isRetryableError(new Error('Request failed with 502'))).toBe(true);
    expect(isRetryableError(new Error('got 400 bad request'))).toBe(false);
  });

  it('matches retryable message patterns', () => {
    expect(isRetryableError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new Error('fetch failed'))).toBe(true);
  });

  it('matches non-retryable message patterns', () => {
    expect(isRetryableError(new Error('validation error'))).toBe(false);
    expect(isRetryableError(new Error('requires confirmation'))).toBe(false);
    expect(isRetryableError(new Error('unknown tool: foo'))).toBe(false);
  });

  it('lets a non-retryable status win over a retryable message pattern', () => {
    expect(isRetryableError(errWith({ status: 400, message: 'timeout' }))).toBe(false);
  });

  it('defaults to not retryable for unrecognized errors', () => {
    expect(isRetryableError(new Error('something unexpected happened'))).toBe(false);
  });
});

describe('calculateRetryDelay', () => {
  const cfg = DEFAULT_RETRY_CONFIG;

  it('applies exponential backoff within the ±20% jitter band', () => {
    for (let i = 0; i < 50; i++) {
      expect(calculateRetryDelay(0, cfg)).toBeGreaterThanOrEqual(400);
      expect(calculateRetryDelay(0, cfg)).toBeLessThanOrEqual(600);
      expect(calculateRetryDelay(1, cfg)).toBeGreaterThanOrEqual(800);
      expect(calculateRetryDelay(1, cfg)).toBeLessThanOrEqual(1200);
    }
  });

  it('caps the delay at the maximum', () => {
    expect(calculateRetryDelay(20, cfg)).toBeLessThanOrEqual(30_000);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await expect(sleep(5)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(sleep(1000, ac.signal)).rejects.toThrow('aborted');
  });

  it('rejects when aborted during the wait', async () => {
    const ac = new AbortController();
    const p = sleep(10_000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow('aborted');
  });

  it('resolves normally when a signal is provided but never aborted', async () => {
    const ac = new AbortController();
    await expect(sleep(5, ac.signal)).resolves.toBeUndefined();
  });
});
