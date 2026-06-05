import { redactForPersist, redactUrlTokens } from '../redact-llm-text';

describe('redactUrlTokens', () => {
  it('masks sensitive query params, keeps the key', () => {
    expect(redactUrlTokens('https://x.com/cb?token=abc123def')).toBe(
      'https://x.com/cb?token=<redacted:urltoken>',
    );
    expect(redactUrlTokens('GET /api?api_key=sk-live-xyz&page=2')).toBe(
      'GET /api?api_key=<redacted:urltoken>&page=2',
    );
    expect(redactUrlTokens('callback#access_token=ya29.A0&state=1')).toContain(
      'access_token=<redacted:urltoken>',
    );
  });

  it('leaves benign params untouched', () => {
    expect(redactUrlTokens('https://x.com?page=2&sort=asc')).toBe('https://x.com?page=2&sort=asc');
  });

  it('does not eat the following param', () => {
    const out = redactUrlTokens('?token=abc&page=2');
    expect(out).toBe('?token=<redacted:urltoken>&page=2');
  });
});

describe('redactForPersist', () => {
  it('masks credential assignments', () => {
    expect(redactForPersist('the user set password=qwerty123')).toContain('password: [REDACTED]');
  });

  it('masks PII shapes (email, jwt)', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dQw4w9WgXcQabcdef';
    const out = redactForPersist(`contact john@acme.com bearer ${jwt}`);
    expect(out).toContain('<redacted:email>');
    expect(out).toContain('<redacted:jwt>');
    expect(out).not.toContain('john@acme.com');
    expect(out).not.toContain(jwt);
  });

  it('masks URL token values (cred rule fires first, value always hidden)', () => {
    const out = redactForPersist('navigate to https://app.test/cb?token=secrettoken123&id=5');
    // cred-first: `token=…` is matched by the credential rule → token: [REDACTED].
    // What matters: the value is gone and a non-sensitive param survives.
    expect(out).not.toContain('secrettoken123');
    expect(out).toContain('id=5');
  });

  it('handles a prompt with multiple sensitive classes at once', () => {
    const prompt =
      'Login as admin@corp.io with password=Sup3rSecret then call /v1?api_key=AKIA12345';
    const out = redactForPersist(prompt);
    expect(out).not.toContain('admin@corp.io');
    expect(out).not.toContain('Sup3rSecret');
    expect(out).not.toContain('AKIA12345');
  });

  it('leaves clean prose untouched', () => {
    const prose = 'Click the submit button and verify the success banner appears.';
    expect(redactForPersist(prose)).toBe(prose);
  });

  it('is nullish-safe', () => {
    expect(redactForPersist('')).toBe('');
    // @ts-expect-error runtime guard
    expect(redactForPersist(undefined)).toBe('');
    // @ts-expect-error runtime guard
    expect(redactForPersist(null)).toBe('');
  });

  it('is idempotent (re-running does not double-mask or re-expose)', () => {
    const once = redactForPersist('password=qwerty123 email a@b.co ?token=zzz999');
    const twice = redactForPersist(once);
    expect(twice).toBe(once);
  });
});
