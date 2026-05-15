import { buildStepRedactor, redactStepShape } from '../redact-step';

describe('buildStepRedactor', () => {
  it('returns identity when runVariables has no secrets', () => {
    const r = buildStepRedactor(new Map([['env.X', 'value_long_enough']]));
    const obj = { value: 'value_long_enough', other: 'kept' };
    expect(r(obj)).toBe(obj); // same reference, no copy
  });

  it('returns identity when runVariables is null/undefined', () => {
    expect(buildStepRedactor(null)({ value: 'x' })).toEqual({ value: 'x' });
    expect(buildStepRedactor(undefined)({ value: 'x' })).toEqual({ value: 'x' });
  });

  it('redacts only the documented step fields (value/url/assertionText/description)', () => {
    const r = buildStepRedactor(
      new Map<string, unknown>([['secrets.STRIPE', 'sk_test_LONG_VALUE']]),
    );
    const out = r({
      value: 'Bearer sk_test_LONG_VALUE',
      assertionText: 'expected sk_test_LONG_VALUE',
      description: 'type sk_test_LONG_VALUE into field',
      url: 'https://api.x.com/sk_test_LONG_VALUE',
      // Non-redact fields should pass through verbatim:
      selector: '#sk_test_LONG_VALUE',
      id: 'sk_test_LONG_VALUE',
      ref: 'sk_test_LONG_VALUE',
    });
    expect(out.value).toBe('Bearer ***');
    expect(out.assertionText).toBe('expected ***');
    expect(out.description).toBe('type *** into field');
    expect(out.url).toBe('https://api.x.com/***');
    // selectors / refs / ids are NOT redacted by the step-shape helper.
    expect(out.selector).toBe('#sk_test_LONG_VALUE');
    expect(out.id).toBe('sk_test_LONG_VALUE');
    expect(out.ref).toBe('sk_test_LONG_VALUE');
  });

  it('returns the original object reference when no field changed', () => {
    const r = buildStepRedactor(
      new Map<string, unknown>([['secrets.X', 'no_match_here_long']]),
    );
    const obj = { value: 'plain text', description: 'nothing' };
    expect(r(obj)).toBe(obj);
  });

  it('shallow-copies on first changed field, leaves later fields intact', () => {
    const r = buildStepRedactor(
      new Map<string, unknown>([['secrets.X', 'sk_long_secret']]),
    );
    const obj = { value: 'leak: sk_long_secret', description: 'plain' };
    const out = r(obj);
    expect(out).not.toBe(obj);
    expect(out.value).toBe('leak: ***');
    expect(out.description).toBe('plain'); // unchanged but in copy
  });

  it('handles non-string field values without throwing', () => {
    const r = buildStepRedactor(
      new Map<string, unknown>([['secrets.X', 'sk_long_secret']]),
    );
    const obj = { value: 42 as unknown, description: undefined as unknown };
    expect(() => r(obj as Record<string, unknown>)).not.toThrow();
  });
});

describe('redactStepShape (one-shot)', () => {
  it('matches buildStepRedactor for a single object', () => {
    const map = new Map<string, unknown>([['secrets.K', 'sk_long_token_here']]);
    const obj = { value: 'a sk_long_token_here b', selector: '#x' };
    expect(redactStepShape(obj, map)).toEqual({
      value: 'a *** b',
      selector: '#x',
    });
  });
});
