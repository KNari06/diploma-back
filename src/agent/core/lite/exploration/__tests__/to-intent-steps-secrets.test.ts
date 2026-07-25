/**
 * Unit tests for `toIntentSteps` handling of credential (`isSensitive`) fills.
 *
 * Load-bearing for rung-4 (credential-store substrate): a credential fill frozen
 * against a bound `secret` carries a `{{secrets.<key>}}` value. If `toIntentSteps`
 * overwrote it with the legacy `{{password}}` mask, replay would have nothing to
 * resolve from `runVariables` and the login would 401 — which is exactly the
 * failure rung 2 measured. The legacy mask must still apply to any OTHER
 * sensitive value, so an unbound credential can never be persisted verbatim.
 */

import { toIntentSteps, type DiscoveredStep } from '../types';

function fillStep(overrides: Partial<DiscoveredStep> = {}): DiscoveredStep {
  return {
    stepNumber: 1,
    description: 'Fill the password field',
    action: 'fill',
    pageUrl: 'https://x.test/login',
    isSensitive: true,
    ...overrides,
  };
}

describe('toIntentSteps — credential values', () => {
  it('carries a bound {{secrets.*}} placeholder through untouched', () => {
    const [step] = toIntentSteps([fillStep({ value: '{{secrets.login_password}}' })]);
    expect(step.value).toBe('{{secrets.login_password}}');
  });

  it('carries a dotted / hyphenated secret key', () => {
    const [step] = toIntentSteps([fillStep({ value: '{{secrets.stage-1.login_email}}' })]);
    expect(step.value).toBe('{{secrets.stage-1.login_email}}');
  });

  it('masks a sensitive value that is NOT a secrets placeholder', () => {
    // Defensive: nothing should reach here with a literal, but if it does the
    // literal must never be persisted.
    const [step] = toIntentSteps([fillStep({ value: 'hunter2' })]);
    expect(step.value).toBe('{{password}}');
    expect(step.value).not.toContain('hunter2');
  });

  it('does not treat a non-secrets placeholder as bound', () => {
    const [step] = toIntentSteps([fillStep({ value: '{{env.LOGIN_PASSWORD}}' })]);
    expect(step.value).toBe('{{password}}');
  });

  it('leaves a non-sensitive fill value alone', () => {
    const [step] = toIntentSteps([fillStep({ isSensitive: false, value: 'jane@x.test' })]);
    expect(step.value).toBe('jane@x.test');
  });
});
