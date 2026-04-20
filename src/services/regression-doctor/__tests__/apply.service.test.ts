/**
 * Unit tests for the pure parts of the Regression Doctor apply service.
 *
 * We deliberately test the *pure* helpers only — `applyPatch` and
 * `locateTargetStep`. The DB-touching `applyDoctorFinding` entry point
 * is exercised by integration tests (Supabase-backed) because the
 * meaningful behaviour it adds over the pure core is concurrency +
 * RLS semantics, both of which require a real (or well-mocked) DB.
 *
 * Goals:
 *   • Prove the four patch actions produce correct step arrays.
 *   • Prove the target-step resolver falls back in the documented order
 *     (text match → tag+text match → targetStepIndex → null).
 *   • Prove StepOutOfBoundsError fires on invalid indexes.
 *   • Lock down insertStep UUID generation — the caller relies on the
 *     new step having a non-empty `id` so downstream compiled plans
 *     don't key on `undefined`.
 */

import {
  applyPatch,
  locateTargetStep,
  StepOutOfBoundsError,
} from '../apply.service';
import type { IntentStep } from '@/services/testing/ui/preview/preview.types';
import type { DriftProposedPatch } from '../drift-agent';

// ─── Helpers ────────────────────────────────────────────────────────────
const makeStep = (overrides: Partial<IntentStep> = {}): IntentStep => ({
  id: `step-${Math.random().toString(36).slice(2, 8)}`,
  type: 'click' as IntentStep['type'],
  description: 'Click login',
  ...overrides,
});

const makeSteps = (): IntentStep[] => [
  makeStep({ id: 's1', type: 'fill' as IntentStep['type'], description: 'Fill email' }),
  makeStep({ id: 's2', type: 'fill' as IntentStep['type'], description: 'Fill password' }),
  makeStep({ id: 's3', type: 'click' as IntentStep['type'], description: 'Click login' }),
];

// Minimal finding shape accepted by locateTargetStep.
// Note: we check `'target_element_key' in overrides` (not `??`) so that
// callers can explicitly pass `null` to test the null-key branch without
// being silently coerced back to the default.
const makeFinding = (overrides: {
  target_element_key?: string | null;
  url_pattern?: string;
} = {}) => ({
  target_element_key:
    'target_element_key' in overrides
      ? (overrides.target_element_key as string | null)
      : 'button:Click login',
  url_pattern: overrides.url_pattern ?? '/login',
});

// ─── locateTargetStep ───────────────────────────────────────────────────
describe('locateTargetStep', () => {
  const basePatch: DriftProposedPatch = {
    action: 'replace_selector',
    targetStepIndex: 2,
    newSelector: '#login-btn',
    reason: 'Button selector moved',
  };

  it('returns null for empty steps array', () => {
    expect(locateTargetStep([], makeFinding(), basePatch)).toBeNull();
  });

  it('matches by targetElementKey text (primary path)', () => {
    const steps = makeSteps();
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Click login' }),
      basePatch,
    );
    expect(idx).toBe(2);
  });

  it('matches case-insensitively on text', () => {
    const steps = makeSteps();
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:CLICK LOGIN' }),
      basePatch,
    );
    expect(idx).toBe(2);
  });

  it('respects bindingHints.tag when present and mismatching', () => {
    // Step has bindingHints.tag='a' but we look for 'button' → no text-match
    // should be accepted because the tag filter rejects it. Falls back to
    // targetStepIndex which points to step 2 (valid).
    const steps = makeSteps();
    steps[2].bindingHints = { tag: 'a' } as IntentStep['bindingHints'];
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Click login' }),
      basePatch,
    );
    // With text-match rejected by tag, fallback = targetStepIndex = 2.
    expect(idx).toBe(2);
  });

  it('accepts bindingHints.tag match when present', () => {
    const steps = makeSteps();
    steps[2].bindingHints = { tag: 'button' } as IntentStep['bindingHints'];
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Click login' }),
      basePatch,
    );
    expect(idx).toBe(2);
  });

  it('falls back to targetStepIndex when text does not match', () => {
    const steps = makeSteps();
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Solve captcha' }),
      { ...basePatch, targetStepIndex: 1 },
    );
    expect(idx).toBe(1);
  });

  it('returns null when both text and fallback fail', () => {
    const steps = makeSteps();
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Solve captcha' }),
      { ...basePatch, targetStepIndex: 99 },
    );
    expect(idx).toBeNull();
  });

  it('allows insert_before to target index === length (append)', () => {
    const steps = makeSteps();
    const patch: DriftProposedPatch = {
      action: 'insert_before',
      targetStepIndex: steps.length, // 3 on a 3-element array
      insertStep: { type: 'click', description: 'Extra step' },
      reason: 'append',
    };
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Does not exist' }),
      patch,
    );
    expect(idx).toBe(steps.length);
  });

  it('does NOT allow other actions to target index === length', () => {
    const steps = makeSteps();
    const patch: DriftProposedPatch = {
      action: 'replace_selector',
      targetStepIndex: steps.length,
      newSelector: '#foo',
      reason: 'bad',
    };
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: 'button:Does not exist' }),
      patch,
    );
    expect(idx).toBeNull();
  });

  it('tolerates null target_element_key and uses fallback only', () => {
    const steps = makeSteps();
    const idx = locateTargetStep(
      steps,
      makeFinding({ target_element_key: null }),
      { ...basePatch, targetStepIndex: 0 },
    );
    expect(idx).toBe(0);
  });
});

// ─── applyPatch ─────────────────────────────────────────────────────────
describe('applyPatch', () => {
  describe('insert_before', () => {
    it('splices a new step at the given index and generates an id', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'insert_before',
        targetStepIndex: 2,
        insertStep: { type: 'click', description: 'Solve captcha' },
        reason: 'captcha added',
      };

      const { steps: out, description } = applyPatch(steps, 2, patch);

      expect(out).toHaveLength(steps.length + 1);
      expect(out[2].type).toBe('click');
      expect(out[2].description).toBe('Solve captcha');
      expect(typeof out[2].id).toBe('string');
      expect(out[2].id.length).toBeGreaterThan(0);
      // Original step that was at index 2 is now at 3.
      expect(out[3].id).toBe('s3');
      expect(description).toMatch(/Inserted step at index 2/);
    });

    it('preserves existing step ids around the insert point', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'insert_before',
        targetStepIndex: 1,
        insertStep: { type: 'click', description: 'Accept cookies' },
        reason: 'cookies banner',
      };
      const { steps: out } = applyPatch(steps, 1, patch);
      expect(out[0].id).toBe('s1');
      expect(out[2].id).toBe('s2');
      expect(out[3].id).toBe('s3');
    });

    it('includes value on the inserted step when supplied', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'insert_before',
        targetStepIndex: 0,
        insertStep: { type: 'fill', description: 'OTP', value: '123456' },
        reason: 'OTP step added',
      };
      const { steps: out } = applyPatch(steps, 0, patch);
      expect(out[0].value).toBe('123456');
    });

    it('throws when insertStep is missing', () => {
      const steps = makeSteps();
      const patch = {
        action: 'insert_before',
        targetStepIndex: 0,
        reason: 'bad',
      } as unknown as DriftProposedPatch;
      expect(() => applyPatch(steps, 0, patch)).toThrow(/insertStep/);
    });
  });

  describe('replace_selector', () => {
    it('writes newSelector into bindingHints and keeps other fields', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'replace_selector',
        targetStepIndex: 2,
        newSelector: '#primary-login',
        reason: 'Selector renamed',
      };
      const { steps: out, description } = applyPatch(steps, 2, patch);
      expect(out).toHaveLength(steps.length); // length unchanged
      expect(out[2].id).toBe('s3'); // id preserved
      expect(out[2].description).toBe('Click login'); // description preserved
      const hints = out[2].bindingHints as { selector?: string } | undefined;
      expect(hints?.selector).toBe('#primary-login');
      expect(description).toMatch(/Replaced selector on step 2/);
    });

    it('merges with existing bindingHints without clobbering other keys', () => {
      const steps = makeSteps();
      steps[2].bindingHints = { tag: 'button', role: 'button' } as IntentStep['bindingHints'];
      const patch: DriftProposedPatch = {
        action: 'replace_selector',
        targetStepIndex: 2,
        newSelector: '#login',
        reason: 'ok',
      };
      const { steps: out } = applyPatch(steps, 2, patch);
      const hints = out[2].bindingHints as {
        tag?: string;
        role?: string;
        selector?: string;
      };
      expect(hints.tag).toBe('button');
      expect(hints.role).toBe('button');
      expect(hints.selector).toBe('#login');
    });

    it('throws StepOutOfBoundsError on negative index', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'replace_selector',
        targetStepIndex: -1,
        newSelector: '#x',
        reason: 'bad',
      };
      expect(() => applyPatch(steps, -1, patch)).toThrow(StepOutOfBoundsError);
    });

    it('throws StepOutOfBoundsError on index === length', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'replace_selector',
        targetStepIndex: steps.length,
        newSelector: '#x',
        reason: 'bad',
      };
      expect(() => applyPatch(steps, steps.length, patch)).toThrow(
        StepOutOfBoundsError,
      );
    });

    it('throws when newSelector is missing', () => {
      const steps = makeSteps();
      const patch = {
        action: 'replace_selector',
        targetStepIndex: 2,
        reason: 'bad',
      } as unknown as DriftProposedPatch;
      expect(() => applyPatch(steps, 2, patch)).toThrow(/newSelector/);
    });
  });

  describe('delete_step', () => {
    it('removes the step at the given index', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'delete_step',
        targetStepIndex: 1,
        reason: 'legacy step gone',
      };
      const { steps: out, description } = applyPatch(steps, 1, patch);
      expect(out).toHaveLength(steps.length - 1);
      expect(out[0].id).toBe('s1');
      expect(out[1].id).toBe('s3');
      expect(description).toMatch(/Deleted step 1/);
    });

    it('throws StepOutOfBoundsError on index === length', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'delete_step',
        targetStepIndex: steps.length,
        reason: 'bad',
      };
      expect(() => applyPatch(steps, steps.length, patch)).toThrow(
        StepOutOfBoundsError,
      );
    });
  });

  describe('update_value', () => {
    it('replaces the value on the step, preserving id and description', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'update_value',
        targetStepIndex: 0,
        insertStep: { type: 'fill', description: '', value: 'new@example.com' },
        reason: 'placeholder change',
      };
      const { steps: out, description } = applyPatch(steps, 0, patch);
      expect(out[0].id).toBe('s1');
      expect(out[0].description).toBe('Fill email');
      expect(out[0].value).toBe('new@example.com');
      expect(description).toMatch(/Updated value on step 0/);
    });

    it('falls back to empty string when no value is supplied', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'update_value',
        targetStepIndex: 0,
        reason: 'clear field',
      };
      const { steps: out } = applyPatch(steps, 0, patch);
      expect(out[0].value).toBe('');
    });

    it('throws StepOutOfBoundsError on bad index', () => {
      const steps = makeSteps();
      const patch: DriftProposedPatch = {
        action: 'update_value',
        targetStepIndex: 99,
        reason: 'bad',
      };
      expect(() => applyPatch(steps, 99, patch)).toThrow(StepOutOfBoundsError);
    });
  });

  describe('immutability', () => {
    it('never mutates the input steps array', () => {
      const steps = makeSteps();
      const snapshot = JSON.stringify(steps);
      const patch: DriftProposedPatch = {
        action: 'delete_step',
        targetStepIndex: 1,
        reason: 'ok',
      };
      applyPatch(steps, 1, patch);
      expect(JSON.stringify(steps)).toBe(snapshot);
    });
  });
});
