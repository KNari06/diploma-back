/**
 * Unit tests for the agent's output validation.
 *
 * These are the guard rails between "the model said something" and "we offered
 * the user a button that edits their test". Everything rejected here degrades
 * to a diagnosis-only finding, which is the safe direction.
 */

import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import { validatePatch, __testing } from '../step-fix-agent';
import { buildUserPrompt } from '../step-fix-prompt';
import { MIN_ASSERTION_PATCH_CONFIDENCE, MIN_PATCH_CONFIDENCE } from '../types';

const { parseVerdict, isTransient } = __testing;

describe('validatePatch — update_element', () => {
  const patch = {
    action: 'update_element',
    reason: 'renamed in 2.3',
    description: 'the Support entry',
    bindingHints: { label: 'Поддержка', role: null },
  };

  it('accepts a well-formed patch', () => {
    expect(validatePatch(patch, 0.8)).toMatchObject({
      action: 'update_element',
      description: 'the Support entry',
    });
  });

  it('keeps an explicit null hint — that is how the agent says "resolve by description"', () => {
    expect(validatePatch(patch, 0.8)?.bindingHints).toEqual({ label: 'Поддержка', role: null });
  });

  it('rejects a patch with no new description — it would blank the only locator', () => {
    expect(validatePatch({ action: 'update_element', reason: 'x' }, 0.9)).toBeNull();
  });

  it('rejects a patch with no reason', () => {
    expect(validatePatch({ ...patch, reason: '  ' }, 0.9)).toBeNull();
  });
});

describe('validatePatch — insert_wait', () => {
  const patch = { action: 'insert_wait', reason: 'renders late', waitMs: 3000 };

  it('accepts a sane duration', () => {
    expect(validatePatch(patch, 0.7)).toMatchObject({ action: 'insert_wait', waitMs: 3000 });
  });

  it('rejects a wait too short to change anything', () => {
    expect(validatePatch({ ...patch, waitMs: 200 }, 0.9)).toBeNull();
  });

  it('rejects a wait that would just make the test slow', () => {
    expect(validatePatch({ ...patch, waitMs: 120000 }, 0.9)).toBeNull();
  });
});

describe('validatePatch — update_assertion', () => {
  const patch = {
    action: 'update_assertion',
    reason: 'the empty state was reworded, the app behaves correctly',
    assertionText: 'The "nothing found" illustration is shown',
  };

  it('accepts a confident assertion rewrite', () => {
    expect(validatePatch(patch, 0.9)).toMatchObject({ action: 'update_assertion' });
  });

  it('holds assertion rewrites to a higher bar than other patches', () => {
    // This is the one action that can hide a real bug, so a confidence that
    // would pass for an element rename is not enough here.
    const between = (MIN_PATCH_CONFIDENCE + MIN_ASSERTION_PATCH_CONFIDENCE) / 2;
    expect(validatePatch({ ...patch, action: 'update_element', description: 'x' }, between))
      .not.toBeNull();
    expect(validatePatch(patch, between)).toBeNull();
  });
});

describe('validatePatch — general', () => {
  it('drops any patch below the confidence floor', () => {
    expect(
      validatePatch({ action: 'update_element', reason: 'x', description: 'y' }, 0.4),
    ).toBeNull();
  });

  it('drops an action outside the supported set', () => {
    // The model may still know the old vocabulary (delete_step, replace_selector).
    expect(validatePatch({ action: 'delete_step', reason: 'x' }, 0.95)).toBeNull();
  });

  it('drops junk', () => {
    expect(validatePatch(null, 0.95)).toBeNull();
    expect(validatePatch('a patch', 0.95)).toBeNull();
  });
});

describe('parseVerdict', () => {
  it('reads a well-formed verdict', () => {
    const out = parseVerdict(
      JSON.stringify({
        verdict: 'test_fix',
        diagnosis: 'The FAQ entry was renamed.',
        confidence: 0.82,
        patch: { action: 'update_element', reason: 'renamed', description: 'new target' },
      }),
    );
    expect(out).toMatchObject({ verdict: 'test_fix', confidence: 0.82 });
    expect(out.patch).not.toBeNull();
  });

  it('never carries a patch on an app_bug verdict', () => {
    // Even if the model contradicts itself and supplies one.
    const out = parseVerdict(
      JSON.stringify({
        verdict: 'app_bug',
        diagnosis: 'The payment list never loaded.',
        confidence: 0.9,
        patch: { action: 'update_element', reason: 'x', description: 'y' },
      }),
    );
    expect(out.patch).toBeNull();
  });

  it('falls back to unclear for an unrecognised verdict', () => {
    const out = parseVerdict(JSON.stringify({ verdict: 'maybe', diagnosis: 'hm', confidence: 1 }));
    expect(out.verdict).toBe('unclear');
  });

  it('recovers JSON wrapped in markdown', () => {
    const out = parseVerdict(
      '```json\n{"verdict":"unclear","diagnosis":"not sure","confidence":0.3}\n```',
    );
    expect(out.diagnosis).toBe('not sure');
  });

  it('clamps a confidence outside 0..1', () => {
    const out = parseVerdict(JSON.stringify({ verdict: 'unclear', diagnosis: 'x', confidence: 7 }));
    expect(out.confidence).toBe(1);
  });

  it('throws on a response containing no JSON at all', () => {
    expect(() => parseVerdict('I could not analyze this step.')).toThrow();
  });
});

describe('the step value never leaves in the clear', () => {
  const step = (over: Partial<IntentStep>): IntentStep =>
    ({ id: 's', type: 'type', description: 'the password field', ...over }) as IntentStep;

  const valueLine = (s: IntentStep) =>
    buildUserPrompt({
      evidence: {
        testId: 't',
        testCaseId: 'tc',
        testCaseName: 'login',
        platform: 'web',
        projectId: 'p',
        step: s,
        stepId: 's',
        stepIndex: 0,
        precedingSteps: [],
        followingStep: null,
      },
      kbChunks: [],
    })
      .split('\n')
      .find((line) => line.trim().startsWith('value:')) ?? '';

  it('omits a literal value even when nothing flagged it sensitive', () => {
    // isSensitive is set by one authoring path only, so a recorded login step
    // carries a real password with no flag at all.
    const line = valueLine(step({ value: 'hunter2-real-password' }));
    expect(line).not.toContain('hunter2');
    expect(line).toContain('omitted');
  });

  it('keeps a placeholder, which names the variable rather than its value', () => {
    expect(valueLine(step({ value: '{{secrets.password}}' }))).toContain('{{secrets.password}}');
  });

  it('says so explicitly when the step was flagged sensitive', () => {
    expect(valueLine(step({ value: 'x', isSensitive: true }))).toContain('sensitive');
  });
});

describe('transient provider failures', () => {
  const transient = (props: Record<string, unknown>) => Object.assign(new Error('boom'), props);

  it('classifies rate limits, 5xx and connection errors as transient', () => {
    expect(isTransient(transient({ status: 429 }))).toBe(true);
    expect(isTransient(transient({ status: 503 }))).toBe(true);
    expect(isTransient(transient({ name: 'APIConnectionTimeoutError' }))).toBe(true);
    expect(isTransient(new Error('socket hang up'))).toBe(true);
  });

  it('does not classify a malformed completion as transient', () => {
    // That is the model failing to answer, which IS a verdict of "unclear".
    expect(isTransient(new Error('No JSON in LLM response'))).toBe(false);
    expect(isTransient(transient({ status: 400 }))).toBe(false);
  });
});
