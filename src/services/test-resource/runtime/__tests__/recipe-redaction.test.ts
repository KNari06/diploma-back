import {
  redactRecipeForResource,
  interpolateRecipeSecrets,
  SECRET_PLACEHOLDER_FULL_RE,
} from '../recipe-redaction';

const pwStep = (over: any = {}) => ({ id: 'pw1', type: 'type', recordedInputType: 'password', value: 'hunter2', ...over });

describe('redactRecipeForResource', () => {
  it('returns empty result for a non-array recipe', () => {
    expect(redactRecipeForResource(null)).toEqual({ recipe: [], sensitive: {} });
    expect(redactRecipeForResource('nope')).toEqual({ recipe: [], sensitive: {} });
  });

  it('moves a password value into the sensitive map and leaves a placeholder', () => {
    const { recipe, sensitive } = redactRecipeForResource([pwStep({ id: 'login' })]);
    expect(sensitive).toEqual({ _secret_login: 'hunter2' });
    expect(recipe[0].value).toBe('{{_secret_login}}');
    expect(SECRET_PLACEHOLDER_FULL_RE.test(recipe[0].value as string)).toBe(true);
  });

  it('derives a regex-safe slug from the step id (and caps length)', () => {
    const { sensitive } = redactRecipeForResource([pwStep({ id: 'a.b/c d!' })]);
    expect(Object.keys(sensitive)[0]).toBe('_secret_a_b_c_d_');
  });

  it('falls back to a positional key when the id is missing', () => {
    const { sensitive } = redactRecipeForResource([pwStep({ id: undefined })]);
    expect(Object.keys(sensitive)[0]).toBe('_secret_s0');
  });

  it('is case-insensitive on the recorded input type', () => {
    const { sensitive } = redactRecipeForResource([pwStep({ id: 'x', recordedInputType: 'PASSWORD' })]);
    expect(sensitive._secret_x).toBe('hunter2');
  });

  it('passes non-secret steps through untouched', () => {
    const steps = [
      { id: 't', type: 'type', recordedInputType: 'text', value: 'bob' }, // not a password type
      { id: 'c', type: 'click' }, // not a type step
      { id: 'e', type: 'type', recordedInputType: 'password', value: '' }, // empty value
      { id: 'n', type: 'type', value: 'x' }, // no recordedInputType
    ];
    const { recipe, sensitive } = redactRecipeForResource(steps);
    expect(sensitive).toEqual({});
    expect(recipe).toHaveLength(4);
    expect(recipe[0]).toBe(steps[0]); // reference-preserved
  });

  it('is idempotent — an already-redacted placeholder value is not re-wrapped', () => {
    const { recipe, sensitive } = redactRecipeForResource([pwStep({ id: 'login', value: '{{_secret_login}}' })]);
    expect(sensitive).toEqual({});
    expect(recipe[0].value).toBe('{{_secret_login}}');
  });

  it('skips nullish / non-object entries', () => {
    const { recipe } = redactRecipeForResource([null, 5, pwStep({ id: 'k' })]);
    expect(recipe).toHaveLength(1);
  });
});

describe('interpolateRecipeSecrets', () => {
  it('replaces a placeholder value with the secret plaintext', () => {
    const out = interpolateRecipeSecrets([{ value: '{{_secret_login}}' } as any], { _secret_login: 'hunter2' });
    expect(out[0].value).toBe('hunter2');
  });

  it('leaves steps without a placeholder reference-equal', () => {
    const step = { value: 'plain text' } as any;
    const out = interpolateRecipeSecrets([step], {});
    expect(out[0]).toBe(step);
  });

  it('leaves non-string values untouched', () => {
    const step = { value: 123 } as any;
    expect(interpolateRecipeSecrets([step], {})[0]).toBe(step);
  });

  it('throws (rather than leaking the placeholder) when a secret is missing', () => {
    expect(() => interpolateRecipeSecrets([{ value: '{{_secret_x}}' } as any], {})).toThrow(/missing secret/);
    expect(() => interpolateRecipeSecrets([{ value: '{{_secret_x}}' } as any], undefined)).toThrow(/missing secret/);
  });

  it('resolves multiple placeholders within one value', () => {
    const out = interpolateRecipeSecrets(
      [{ value: '{{_secret_a}}:{{_secret_b}}' } as any],
      { _secret_a: 'u', _secret_b: 'p' },
    );
    expect(out[0].value).toBe('u:p');
  });

  it('round-trips with redactRecipeForResource', () => {
    const { recipe, sensitive } = redactRecipeForResource([pwStep({ id: 'login', value: 's3cr3t' })]);
    const restored = interpolateRecipeSecrets(recipe as any, sensitive);
    expect(restored[0].value).toBe('s3cr3t');
  });
});
