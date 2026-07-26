import {
  collectSecretValues,
  containsBoundSecretPlaceholder,
  isBoundSecretPlaceholder,
  redactCredentialValues,
  redactSecrets,
  redactSnapshotValues,
  redactWithValues,
} from '../redact-secrets';

describe('collectSecretValues', () => {
  it('returns [] when map is null/undefined/empty', () => {
    expect(collectSecretValues(null)).toEqual([]);
    expect(collectSecretValues(undefined)).toEqual([]);
    expect(collectSecretValues(new Map())).toEqual([]);
  });

  it('only collects keys with secrets. prefix', () => {
    const m = new Map<string, unknown>([
      ['secrets.STRIPE', 'sk_test_aaaaaaaaaaaa'],
      ['env.BASE_URL', 'https://example.com'],
      ['email.otp', '123456'],
    ]);
    expect(collectSecretValues(m)).toEqual(['sk_test_aaaaaaaaaaaa']);
  });

  it('drops values shorter than MIN_REDACT_LENGTH (4 chars)', () => {
    const m = new Map<string, unknown>([
      ['secrets.SHORT', 'ab'],   // 2 chars — skipped
      ['secrets.MED', 'abcd'],   // 4 chars — kept (boundary)
      ['secrets.LONG', 'abcdefgh'],
    ]);
    const out = collectSecretValues(m);
    expect(out).toContain('abcd');
    expect(out).toContain('abcdefgh');
    expect(out).not.toContain('ab');
  });

  it('coerces non-string secret values to string', () => {
    const m = new Map<string, unknown>([
      ['secrets.PORT', 12345],
      ['secrets.FLAG', true],
    ]);
    const out = collectSecretValues(m);
    expect(out).toContain('12345');
    expect(out).toContain('true');
  });

  it('sorts longest first to prevent substring shadowing', () => {
    const m = new Map<string, unknown>([
      ['secrets.A', 'abcd'],
      ['secrets.B', 'abcdefgh'],
    ]);
    expect(collectSecretValues(m)).toEqual(['abcdefgh', 'abcd']);
  });
});

describe('redactSecrets', () => {
  it('returns input unchanged when no secrets', () => {
    expect(redactSecrets('hello {{secrets.X}}', new Map())).toBe('hello {{secrets.X}}');
    expect(redactSecrets('plain', null)).toBe('plain');
  });

  it('replaces a secret value occurrence with ***', () => {
    const m = new Map<string, unknown>([['secrets.STRIPE', 'sk_test_xyz123']]);
    expect(redactSecrets('Authorization: Bearer sk_test_xyz123', m)).toBe(
      'Authorization: Bearer ***',
    );
  });

  it('replaces every occurrence (not just first)', () => {
    const m = new Map<string, unknown>([['secrets.K', 'tokenABCD']]);
    expect(redactSecrets('a=tokenABCD b=tokenABCD c=other', m)).toBe(
      'a=*** b=*** c=other',
    );
  });

  it('masks the longer secret entirely when one contains another', () => {
    const m = new Map<string, unknown>([
      ['secrets.SHORT', 'abcd'],
      ['secrets.LONG', 'abcdEFGH'],   // contains the short one
    ]);
    // Long-first sorting means LONG is replaced before SHORT can chew
    // out the prefix. Without the sort we'd get '***EFGH'.
    expect(redactSecrets('value=abcdEFGH', m)).toBe('value=***');
  });

  it('handles regex-special characters in secrets safely', () => {
    const m = new Map<string, unknown>([
      ['secrets.JWT', 'eyJhbGc.payload+signature/with$pecial'],
    ]);
    expect(
      redactSecrets('token=eyJhbGc.payload+signature/with$pecial end', m),
    ).toBe('token=*** end');
  });

  it('returns non-strings unchanged', () => {
    const m = new Map<string, unknown>([['secrets.X', 'abcdefgh']]);
    expect(redactSecrets(undefined as unknown as string, m)).toBeUndefined();
    expect(redactSecrets(null as unknown as string, m)).toBeNull();
    expect(redactSecrets(42 as unknown as string, m)).toBe(42);
  });

  it('skips non-secret namespaces', () => {
    const m = new Map<string, unknown>([
      ['env.BASE_URL', 'https://stg.app.com'],
      ['email.otp', '482917'],
    ]);
    const text = 'env=https://stg.app.com otp=482917';
    expect(redactSecrets(text, m)).toBe(text);
  });
});

describe('redactWithValues', () => {
  it('uses the precomputed list directly', () => {
    expect(redactWithValues('a=secretvalue', ['secretvalue'])).toBe('a=***');
  });

  it('skips short entries even when explicitly passed', () => {
    expect(redactWithValues('a=ab b=abcd', ['ab', 'abcd'])).toBe('a=ab b=***');
  });

  it('returns input unchanged when list is empty', () => {
    expect(redactWithValues('hello', [])).toBe('hello');
  });
});

describe('redactSnapshotValues', () => {
  it('returns undefined when snapshot is null/undefined', () => {
    expect(redactSnapshotValues(null, ['secretvalue'])).toBeUndefined();
    expect(redactSnapshotValues(undefined, ['secretvalue'])).toBeUndefined();
  });

  it('returns undefined when there are no secret values (cheap no-op path)', () => {
    expect(redactSnapshotValues({ orderId: 'abc123' }, [])).toBeUndefined();
  });

  it('returns undefined when nothing in the snapshot matches a secret', () => {
    expect(redactSnapshotValues({ orderId: 'abc123' }, ['sk_test_xyz'])).toBeUndefined();
  });

  it('masks a matching value and reports its key as redacted', () => {
    const result = redactSnapshotValues(
      { apiToken: 'sk_test_secretvalue', orderId: 'abc123' },
      ['sk_test_secretvalue'],
    );
    expect(result).toEqual({
      snapshot: { apiToken: '***', orderId: 'abc123' },
      redactedKeys: ['apiToken'],
    });
  });

  it('masks every key whose value contains a secret, leaves others untouched', () => {
    const result = redactSnapshotValues(
      {
        greeting: 'hello sk_test_secretvalue world',
        token: 'sk_test_secretvalue',
        plain: 'nothing sensitive here',
      },
      ['sk_test_secretvalue'],
    );
    expect(result?.snapshot).toEqual({
      greeting: 'hello *** world',
      token: '***',
      plain: 'nothing sensitive here',
    });
    expect(result?.redactedKeys.sort()).toEqual(['greeting', 'token']);
  });

  it('does not mutate the input snapshot object', () => {
    const input = { apiToken: 'sk_test_secretvalue' };
    const result = redactSnapshotValues(input, ['sk_test_secretvalue']);
    expect(input.apiToken).toBe('sk_test_secretvalue');
    expect(result?.snapshot).not.toBe(input);
  });
});

describe('redactCredentialValues', () => {
  it('returns input unchanged on the no-creds path', () => {
    expect(redactCredentialValues('plain text', null)).toBe('plain text');
    expect(redactCredentialValues('plain text', undefined)).toBe('plain text');
    expect(redactCredentialValues('plain text', {})).toBe('plain text');
  });

  it('masks each configured credential value echoed into a string', () => {
    const out = redactCredentialValues('user user@acme.io failed with hunter2pw', {
      email: 'user@acme.io',
      password: 'hunter2pw',
    });
    expect(out).not.toContain('user@acme.io');
    expect(out).not.toContain('hunter2pw');
  });

  it('masks the longer value fully when a shorter value is its substring', () => {
    // username "johndoe" is a prefix of email "johndoe@acme.io" — longest-first
    // ordering must mask the email whole, leaving no "@acme.io" tail exposed.
    const out = redactCredentialValues('contact johndoe@acme.io now', {
      username: 'johndoe',
      email: 'johndoe@acme.io',
    });
    expect(out).not.toContain('@acme.io');
    expect(out).toBe('contact *** now');
  });
});

describe('containsBoundSecretPlaceholder', () => {
  it('accepts an EMBEDDED placeholder, where the anchored check does not', () => {
    // This is the whole reason it exists: templating a credential out of an
    // assertion produces a placeholder inside surrounding text, and the
    // sanitizer must treat that string as already safe.
    expect(containsBoundSecretPlaceholder('Welcome back, {{secrets.login_email}}!')).toBe(true);
    expect(isBoundSecretPlaceholder('Welcome back, {{secrets.login_email}}!')).toBe(false);
  });

  it('accepts a bare placeholder too', () => {
    expect(containsBoundSecretPlaceholder('{{secrets.login_password}}')).toBe(true);
  });

  it('rejects other namespaces and malformed shapes', () => {
    expect(containsBoundSecretPlaceholder('{{param_secret}}')).toBe(false);
    expect(containsBoundSecretPlaceholder('{{env.API_BASE}}')).toBe(false);
    expect(containsBoundSecretPlaceholder('{{secrets.}}')).toBe(false);
    expect(containsBoundSecretPlaceholder('plain text')).toBe(false);
    expect(containsBoundSecretPlaceholder(undefined)).toBe(false);
    expect(containsBoundSecretPlaceholder(42)).toBe(false);
  });

  it('treats a CORRUPTED nesting as containing a placeholder — documented, and why it is safe', () => {
    // `{{secrets.login_{{secrets.login_password}}}}` was produced by a real bug
    // (a credential value occurring inside its own key name). The inner match
    // makes this true, so `sanitizeSteps` waves the string through instead of
    // masking it. That is the RIGHT trade-off here: the string contains no
    // credential literal (it is placeholders all the way down), so nothing
    // leaks; it merely fails to resolve. Masking it would swap a resolution
    // failure for a different one while hiding the real defect. The corruption
    // itself is prevented upstream in credential-step-templater.
    expect(containsBoundSecretPlaceholder('{{secrets.login_{{secrets.login_password}}}}')).toBe(true);
  });
});
