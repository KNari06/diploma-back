/**
 * Unit tests for recipe redaction + interpolation.
 *
 * Coverage:
 *   - redactRecipeForResource: happy path, idempotency, type-only redaction,
 *     legacy steps without recordedInputType, invalid input, ID sanitization.
 *   - interpolateRecipeSecrets: happy path, missing secret throws,
 *     non-string values pass through, multiple placeholders in one value,
 *     idempotent absence (no `{{` shortcut).
 *
 * No external deps — pure functions, runs without Playwright / DB.
 */

import {
  REDACT_INPUT_TYPES,
  SECRET_KEY_PREFIX,
  SECRET_PLACEHOLDER_FULL_RE,
  SECRET_PLACEHOLDER_GLOBAL_RE,
  redactRecipeForResource,
  interpolateRecipeSecrets,
} from '../runtime/recipe-redaction';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

// ─────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────

function step(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'step-default-id',
    type: 'click',
    description: 'click something',
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Constants — guard against accidental mutation
// ─────────────────────────────────────────────────────────────────────────

describe('recipe-redaction constants', () => {
  it('has expected REDACT_INPUT_TYPES', () => {
    expect([...REDACT_INPUT_TYPES]).toEqual(['password']);
  });

  it('SECRET_KEY_PREFIX is _secret_', () => {
    expect(SECRET_KEY_PREFIX).toBe('_secret_');
  });

  it('full RE matches a placeholder string and rejects garbage', () => {
    expect(SECRET_PLACEHOLDER_FULL_RE.test('{{_secret_abc_123}}')).toBe(true);
    expect(SECRET_PLACEHOLDER_FULL_RE.test('  {{_secret_abc}}  ')).toBe(false);
    expect(SECRET_PLACEHOLDER_FULL_RE.test('{{secret_abc}}')).toBe(false);
    expect(SECRET_PLACEHOLDER_FULL_RE.test('not a placeholder')).toBe(false);
  });

  it('global RE finds embedded placeholders', () => {
    SECRET_PLACEHOLDER_GLOBAL_RE.lastIndex = 0;
    const matches = 'a {{_secret_x}} b {{_secret_y}}'.match(
      SECRET_PLACEHOLDER_GLOBAL_RE,
    );
    expect(matches).toEqual(['{{_secret_x}}', '{{_secret_y}}']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// redactRecipeForResource
// ─────────────────────────────────────────────────────────────────────────

describe('redactRecipeForResource', () => {
  it('returns empty result for non-array input', () => {
    expect(redactRecipeForResource(null)).toEqual({ recipe: [], sensitive: {} });
    expect(redactRecipeForResource(undefined)).toEqual({ recipe: [], sensitive: {} });
    expect(redactRecipeForResource('not an array')).toEqual({
      recipe: [],
      sensitive: {},
    });
  });

  it('passes non-secret steps through unchanged (reference-preserved fields)', () => {
    const steps = [
      step({ id: 's1', type: 'click', description: 'click login button' }),
      step({
        id: 's2',
        type: 'type',
        value: 'user@example.com',
        recordedInputType: 'email',
      }),
    ];
    const out = redactRecipeForResource(steps);
    expect(out.sensitive).toEqual({});
    expect(out.recipe).toHaveLength(2);
    expect(out.recipe[0]).toEqual(steps[0]);
    expect(out.recipe[1]).toEqual(steps[1]);
  });

  it('moves password value into sensitive and replaces with placeholder', () => {
    const steps = [
      step({
        id: 's1',
        type: 'type',
        value: 'super-secret-pwd',
        recordedInputType: 'password',
      }),
    ];
    const out = redactRecipeForResource(steps);

    expect(out.sensitive).toEqual({ _secret_s1: 'super-secret-pwd' });
    expect(out.recipe).toHaveLength(1);
    expect((out.recipe[0] as Record<string, unknown>).value).toBe(
      '{{_secret_s1}}',
    );
    expect(SECRET_PLACEHOLDER_FULL_RE.test((out.recipe[0] as any).value)).toBe(
      true,
    );
    // Original step object MUST NOT be mutated.
    expect((steps[0] as any).value).toBe('super-secret-pwd');
  });

  it('redacts password regardless of casing in recordedInputType', () => {
    const out = redactRecipeForResource([
      step({
        id: 's1',
        type: 'type',
        value: 'pwd',
        recordedInputType: 'PASSWORD',
      }),
    ]);
    expect(out.sensitive).toEqual({ _secret_s1: 'pwd' });
    expect((out.recipe[0] as any).value).toBe('{{_secret_s1}}');
  });

  it('is idempotent — re-running on already-redacted recipe does not double-wrap', () => {
    const original = [
      step({
        id: 's1',
        type: 'type',
        value: '{{_secret_s1}}',
        recordedInputType: 'password',
      }),
    ];
    const out = redactRecipeForResource(original);

    expect(out.sensitive).toEqual({}); // no new secret extracted
    expect((out.recipe[0] as any).value).toBe('{{_secret_s1}}'); // unchanged
  });

  it('skips steps that are not type=type even with password marker', () => {
    const out = redactRecipeForResource([
      step({
        id: 's1',
        type: 'click',
        value: 'pwd-leaked',
        recordedInputType: 'password',
      }),
    ]);
    expect(out.sensitive).toEqual({});
    expect((out.recipe[0] as any).value).toBe('pwd-leaked');
  });

  it('skips legacy steps without recordedInputType', () => {
    const out = redactRecipeForResource([
      step({ id: 's1', type: 'type', value: 'maybe-pwd' }),
    ]);
    expect(out.sensitive).toEqual({});
    expect((out.recipe[0] as any).value).toBe('maybe-pwd');
  });

  it('skips empty / whitespace-only / non-string values', () => {
    const out = redactRecipeForResource([
      step({ id: 's1', type: 'type', value: '', recordedInputType: 'password' }),
      step({ id: 's2', type: 'type', recordedInputType: 'password' }),
      step({
        id: 's3',
        type: 'type',
        value: 12345,
        recordedInputType: 'password',
      }),
    ]);
    expect(out.sensitive).toEqual({});
    expect(out.recipe).toHaveLength(3);
  });

  it('sanitizes step ids that contain regex-unsafe characters', () => {
    const out = redactRecipeForResource([
      step({
        id: 's:weird-id.with/colons',
        type: 'type',
        value: 'pwd',
        recordedInputType: 'password',
      }),
    ]);
    const keys = Object.keys(out.sensitive);
    expect(keys).toHaveLength(1);
    // No raw regex-special chars survive.
    expect(keys[0]).toMatch(/^_secret_[A-Za-z0-9_]+$/);
    // The placeholder in the step references the same key.
    expect((out.recipe[0] as any).value).toBe(`{{${keys[0]}}}`);
  });

  it('falls back to positional s<n> id when step.id is missing', () => {
    const out = redactRecipeForResource([
      step({ id: undefined, type: 'type', value: 'pwd1', recordedInputType: 'password' }),
      step({ id: undefined, type: 'type', value: 'pwd2', recordedInputType: 'password' }),
    ]);
    expect(out.sensitive).toEqual({
      _secret_s0: 'pwd1',
      _secret_s1: 'pwd2',
    });
  });

  it('skips invalid array entries (null / undefined / primitive)', () => {
    const out = redactRecipeForResource([
      null,
      undefined,
      'a string',
      42,
      step({
        id: 's1',
        type: 'type',
        value: 'pwd',
        recordedInputType: 'password',
      }),
    ]);
    expect(out.recipe).toHaveLength(1);
    expect(out.sensitive).toEqual({ _secret_s1: 'pwd' });
  });

  it('preserves original step ordering', () => {
    const out = redactRecipeForResource([
      step({ id: 's1', type: 'navigate' }),
      step({ id: 's2', type: 'type', value: 'pwd', recordedInputType: 'password' }),
      step({ id: 's3', type: 'click' }),
    ]);
    expect(out.recipe.map((s) => (s as any).id)).toEqual(['s1', 's2', 's3']);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// interpolateRecipeSecrets
// ─────────────────────────────────────────────────────────────────────────

describe('interpolateRecipeSecrets', () => {
  it('returns empty array unchanged', () => {
    expect(interpolateRecipeSecrets([], { foo: 'bar' })).toEqual([]);
  });

  it('passes through steps with no placeholders (reference-equal short circuit)', () => {
    const steps: IntentStep[] = [
      { id: 's1', type: 'click', description: 'c' },
      { id: 's2', type: 'type', description: 't', value: 'plaintext' },
    ];
    const out = interpolateRecipeSecrets(steps, { _secret_s2: 'unused' });
    expect(out[0]).toBe(steps[0]); // ref-equal
    expect(out[1]).toBe(steps[1]); // ref-equal — no `{{` in value
  });

  it('replaces a single placeholder with the matching secret', () => {
    const steps: IntentStep[] = [
      { id: 's1', type: 'type', description: 'pwd', value: '{{_secret_s1}}' },
    ];
    const out = interpolateRecipeSecrets(steps, { _secret_s1: 'realPassword' });
    expect(out[0].value).toBe('realPassword');
    // Original step is not mutated.
    expect(steps[0].value).toBe('{{_secret_s1}}');
  });

  it('throws when a placeholder has no matching secret', () => {
    const steps: IntentStep[] = [
      { id: 's1', type: 'type', description: 'pwd', value: '{{_secret_unknown}}' },
    ];
    expect(() => interpolateRecipeSecrets(steps, { _secret_other: 'x' })).toThrow(
      /missing secret "_secret_unknown"/,
    );
  });

  it('throws when secrets map is undefined and a placeholder is present', () => {
    const steps: IntentStep[] = [
      { id: 's1', type: 'type', description: 'pwd', value: '{{_secret_s1}}' },
    ];
    expect(() => interpolateRecipeSecrets(steps, undefined)).toThrow(
      /missing secret "_secret_s1"/,
    );
  });

  it('replaces multiple placeholders inside one value', () => {
    const steps: IntentStep[] = [
      {
        id: 's1',
        type: 'type',
        description: 'concat',
        value: '{{_secret_user}}:{{_secret_pwd}}',
      },
    ];
    const out = interpolateRecipeSecrets(steps, {
      _secret_user: 'admin',
      _secret_pwd: 'p@ss',
    });
    expect(out[0].value).toBe('admin:p@ss');
  });

  it('ignores non-string value fields', () => {
    const steps: IntentStep[] = [
      { id: 's1', type: 'click', description: 'c' } as IntentStep,
      { id: 's2', type: 'type', description: 't' } as IntentStep, // no value
    ];
    const out = interpolateRecipeSecrets(steps, undefined);
    expect(out).toEqual(steps);
  });

  it('global regex is reset between calls (no lastIndex bleed)', () => {
    const steps: IntentStep[] = [
      { id: 's1', type: 'type', description: 'a', value: '{{_secret_x}}' },
    ];
    const secrets = { _secret_x: 'pwd' };
    // Run twice — second pass would fail-open if lastIndex leaked.
    const first = interpolateRecipeSecrets(steps, secrets);
    const second = interpolateRecipeSecrets(steps, secrets);
    expect(first[0].value).toBe('pwd');
    expect(second[0].value).toBe('pwd');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Round-trip — redact then interpolate yields the original value
// ─────────────────────────────────────────────────────────────────────────

describe('redact → interpolate round trip', () => {
  it('reproduces the original plaintext on replay', () => {
    const original = [
      step({ id: 's1', type: 'navigate', value: 'https://login' }),
      step({
        id: 's2',
        type: 'type',
        description: 'email',
        value: 'admin@example.com',
        recordedInputType: 'email',
      }),
      step({
        id: 's3',
        type: 'type',
        description: 'pwd',
        value: 'super!secret',
        recordedInputType: 'password',
      }),
      step({ id: 's4', type: 'click', description: 'submit' }),
    ];

    const { recipe, sensitive } = redactRecipeForResource(original);
    // After redaction the password value is gone from the recipe shape.
    expect((recipe[2] as any).value).toBe('{{_secret_s3}}');
    expect(sensitive).toEqual({ _secret_s3: 'super!secret' });

    const replay = interpolateRecipeSecrets(recipe as unknown as IntentStep[], sensitive);
    expect((replay[0] as any).value).toBe('https://login');
    expect((replay[1] as any).value).toBe('admin@example.com');
    expect((replay[2] as any).value).toBe('super!secret'); // ← restored
    expect((replay[3] as any).value).toBeUndefined();
  });
});
