/**
 * Unit tests for the pure patch application.
 *
 * The behaviours worth locking down here are the ones that decide whether an
 * applied fix has any effect at replay: clearing the compiled plan, and not
 * leaving a stale `bindingHints.label` that outranks the new description.
 */

import {
  applyStepPatch,
  locateStepById,
  StepNotFoundError,
  UnsupportedPatchError,
} from '../patch-applier';
import type { StepPatch } from '../types';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';

const clickStep = (): IntentStep =>
  ({
    id: 'step-1',
    type: 'click',
    description: 'FAQ entry in Profile / Гид section',
    bindingHints: { role: 'flutter.Text', label: 'FAQ' },
    compiled: { version: 1, strategies: [{ kind: 'label_exact', label: 'FAQ' }] },
    evidence: { resolvedVia: 'llm', confidence: 0.9 },
    recordedFingerprint: { role: 'Text', label: 'FAQ' },
  }) as unknown as IntentStep;

const assertStep = (): IntentStep =>
  ({
    id: 'step-2',
    type: 'ai_check',
    description: 'The empty-state message is shown',
    assertionText: 'The empty-state message is shown',
    options: { aiCheckSource: 'screenshot' },
  }) as unknown as IntentStep;

const steps = (): IntentStep[] => [clickStep(), assertStep()];

describe('locateStepById', () => {
  it('finds the step whose id matches exactly', () => {
    expect(locateStepById(steps(), 'step-2')).toBe(1);
  });

  it('returns -1 rather than guessing when the id is absent', () => {
    expect(locateStepById(steps(), 'step-does-not-exist')).toBe(-1);
  });
});

describe('applyStepPatch — update_element', () => {
  const patch: StepPatch = {
    action: 'update_element',
    reason: 'renamed in the 2.3 release',
    description: '"Часто задаваемые вопросы" entry in the Support section',
    bindingHints: { label: 'Часто задаваемые вопросы' },
  };

  it('rewrites the description', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0].description).toBe('"Часто задаваемые вопросы" entry in the Support section');
  });

  it('drops the compiled plan so the runner cannot shortcut to the stale target', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0]).not.toHaveProperty('compiled');
  });

  it('drops the resolution provenance that described the old element', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0]).not.toHaveProperty('evidence');
    expect(out[0]).not.toHaveProperty('recordedFingerprint');
  });

  it('replaces the binding label, which outranks the description at replay', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0].bindingHints).toMatchObject({ label: 'Часто задаваемые вопросы' });
  });

  it('clears a hint the patch does not restate, instead of leaving it to win', () => {
    // `role` is not in the patch. Left behind, a stale role narrows resolution
    // to the wrong widget type and the new description never gets a chance.
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0].bindingHints).not.toHaveProperty('role');
  });

  it('drops the whole recorded fingerprint, not just the fields it overwrites', () => {
    // Web steps carry a dozen hint fields recorded from the old element —
    // `nearText`, `containerTitles`, `cssClass`. Any survivor re-asserts the
    // stale copy the resolver reads before the description, and the patch is
    // silently inert. Seen live: the agent moved the description to
    // "Seedance 2.0" while nearText still said "Enhanced Seedance 2.0".
    const webStep = steps();
    (webStep[0] as unknown as { bindingHints: Record<string, unknown> }).bindingHints = {
      tag: 'a',
      href: '/nano-banana-pro',
      text: 'Nano Banana Pro',
      nearText: 'Enhanced Seedance 2.0 Fast 30-day Unlimited',
      containerTitles: ['Enhanced Seedance 2.0 Fast Unlimited'],
    };

    const { steps: out } = applyStepPatch(webStep, 'step-1', patch);

    expect(out[0].bindingHints).toEqual({ label: 'Часто задаваемые вопросы' });
  });

  it('clears a hint the agent explicitly nulls', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', {
      ...patch,
      bindingHints: { label: null, placeholder: null, role: null },
    });
    expect(out[0].bindingHints).toBeUndefined();
  });

  it('leaves other steps untouched', () => {
    const before = steps();
    const { steps: out } = applyStepPatch(before, 'step-1', patch);
    expect(out[1]).toEqual(before[1]);
  });

  it('rejects a patch with no new description', () => {
    expect(() =>
      applyStepPatch(steps(), 'step-1', { action: 'update_element', reason: 'x' }),
    ).toThrow(UnsupportedPatchError);
  });
});

describe('applyStepPatch — insert_wait', () => {
  const patch: StepPatch = { action: 'insert_wait', reason: 'list renders late', waitMs: 3000 };

  it('inserts the pause before the failing step', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-2', patch);
    expect(out).toHaveLength(3);
    expect(out[1].type).toBe('timeout');
    expect(out[2].id).toBe('step-2');
  });

  it("emits 'timeout', not 'wait' — the runner maps 'wait' to a re-snapshot, not a pause", () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0].type).toBe('timeout');
    expect(out[0].value).toBe('3000');
  });

  it('gives the inserted step its own id so nothing keys on undefined', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-1', patch);
    expect(out[0].id).toEqual(expect.any(String));
    expect(out[0].id).not.toBe('step-1');
  });

  it('rejects a patch with no duration', () => {
    expect(() =>
      applyStepPatch(steps(), 'step-1', { action: 'insert_wait', reason: 'x' }),
    ).toThrow(UnsupportedPatchError);
  });
});

describe('applyStepPatch — update_assertion', () => {
  const patch: StepPatch = {
    action: 'update_assertion',
    reason: 'the empty state was reworded in 2.3',
    assertionText: 'The "nothing found" illustration is shown',
  };

  it('rewrites the assertion text', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-2', patch);
    expect(out[1].assertionText).toBe('The "nothing found" illustration is shown');
  });

  it('mirrors the new text into the description the step list shows', () => {
    const { steps: out } = applyStepPatch(steps(), 'step-2', patch);
    expect(out[1].description).toBe('The "nothing found" illustration is shown');
  });

  it('refuses to write an assertion onto a step that has no assertion', () => {
    // Nothing reads `assertionText` on a click step, so applying would report
    // success for a change with no effect.
    expect(() => applyStepPatch(steps(), 'step-1', patch)).toThrow(UnsupportedPatchError);
  });
});

describe('applyStepPatch — step resolution', () => {
  it('throws when the step id is not in this test case', () => {
    expect(() =>
      applyStepPatch(steps(), 'step-from-another-test', {
        action: 'update_element',
        reason: 'x',
        description: 'y',
      }),
    ).toThrow(StepNotFoundError);
  });

  it('does not mutate the array it was given', () => {
    const before = steps();
    const snapshot = JSON.stringify(before);
    applyStepPatch(before, 'step-1', {
      action: 'update_element',
      reason: 'x',
      description: 'new target',
    });
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});
