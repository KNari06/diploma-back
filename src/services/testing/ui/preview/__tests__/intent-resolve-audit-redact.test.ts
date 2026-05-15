/**
 * Phase 2.5 leak-coverage: intent-resolve-audit must never write a
 * `secrets.*` value into logs/intent_resolve.log when the caller
 * supplies `secretValues`.
 *
 * The audit writer uses `fs.appendFile` (callback form). We mock the
 * `fs` module to capture the line that would have been written and
 * assert on its contents. This is unit-style (no real I/O), but
 * exercises the full path through `buildIntentSnapshot` /
 * `maybeRedactString` / `redactWithValues`.
 */

const appendCalls: string[] = [];

jest.mock('fs', () => {
  const real = jest.requireActual('fs');
  return {
    ...real,
    existsSync: () => true,
    mkdirSync: () => undefined,
    appendFile: (
      _path: string,
      data: string,
      cb: (err: Error | null) => void,
    ) => {
      appendCalls.push(data);
      cb(null);
    },
  };
});

import {
  logIntentResolveApply,
  logIntentResolveLint,
} from '../intent-resolve-audit';
import type { IntentStep, LintResult } from '../preview.types';

beforeEach(() => {
  appendCalls.length = 0;
});

function buildStep(overrides: Partial<IntentStep> = {}): IntentStep {
  return {
    id: 'step1',
    type: 'type',
    description: 'fill the password field',
    value: 'plain-text',
    ...overrides,
  } as IntentStep;
}

describe('intent-resolve-audit redaction', () => {
  it('redacts `value` / `description` / `assertionText` in apply log', () => {
    logIntentResolveApply({
      stepDraft: buildStep({
        value: 'sk_test_LEAK_VALUE_LONG',
        description: 'type sk_test_LEAK_VALUE_LONG into Card field',
        assertionText: 'expected sk_test_LEAK_VALUE_LONG',
      }),
      candidate: null,
      outcome: 'pass',
      secretValues: ['sk_test_LEAK_VALUE_LONG'],
    });

    expect(appendCalls.length).toBe(1);
    const line = appendCalls[0];
    expect(line).not.toContain('sk_test_LEAK_VALUE_LONG');
    expect(line).toContain('***');
  });

  it('redacts `rejectReason` on apply log', () => {
    logIntentResolveApply({
      stepDraft: buildStep(),
      candidate: null,
      outcome: 'reject',
      rejectReason: 'fill failed for value sk_LEAK_LONG_REASON',
      secretValues: ['sk_LEAK_LONG_REASON'],
    });
    expect(appendCalls[0]).not.toContain('sk_LEAK_LONG_REASON');
  });

  it('is a no-op when secretValues is undefined / empty', () => {
    logIntentResolveApply({
      stepDraft: buildStep({ value: 'plain-but-could-be-anything' }),
      candidate: null,
      outcome: 'pass',
      // secretValues omitted
    });
    expect(appendCalls[0]).toContain('plain-but-could-be-anything');
  });

  it('redacts `result.message` and snapshot fields in lint log', () => {
    const result: LintResult = {
      status: 'error',
      message: 'lint failed for value sk_LINT_LEAK_VALUE',
      confidence: 0,
      candidates: [],
      highlight: [],
    };
    logIntentResolveLint({
      stepDraft: buildStep({ description: 'see sk_LINT_LEAK_VALUE somewhere' }),
      result,
      secretValues: ['sk_LINT_LEAK_VALUE'],
    });
    const line = appendCalls[0];
    expect(line).not.toContain('sk_LINT_LEAK_VALUE');
    expect(line).toContain('***');
  });

  it('handles missing optional fields without throwing', () => {
    expect(() =>
      logIntentResolveApply({
        stepDraft: { id: 's', type: 'click' } as IntentStep,
        candidate: null,
        outcome: 'pass',
        secretValues: ['some_long_secret'],
      }),
    ).not.toThrow();
  });
});
