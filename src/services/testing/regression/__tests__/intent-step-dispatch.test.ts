import { normaliseIntentStep, stitchPhases } from '../intent-step-dispatch.service';
import { logger } from '@/utils/core/logger';

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockLogger = logger as jest.Mocked<typeof logger>;

beforeEach(() => {
  jest.clearAllMocks();
});

// ── normaliseIntentStep ──────────────────────────────────────────────────────

describe('normaliseIntentStep', () => {
  it('uses raw.id when present', () => {
    expect(normaliseIntentStep({ id: 'abc', type: 'click' }, 0).id).toBe('abc');
  });

  it('falls back to "step_<index+1>" when id is missing', () => {
    expect(normaliseIntentStep({}, 2).id).toBe('step_3');
  });

  it('uses "<phase>_<index+1>" as id fallback when a phase is provided', () => {
    expect(normaliseIntentStep({}, 0, 'setup').id).toBe('setup_1');
    expect(normaliseIntentStep({}, 1, 'teardown').id).toBe('teardown_2');
  });

  it('defaults type to "click" when missing', () => {
    expect(normaliseIntentStep({}, 0).type).toBe('click');
  });

  it('preserves raw.type when present', () => {
    expect(normaliseIntentStep({ type: 'navigate' }, 0).type).toBe('navigate');
  });

  it('defaults description to "Step <n>" (1-based) when no phase', () => {
    expect(normaliseIntentStep({}, 0).description).toBe('Step 1');
    expect(normaliseIntentStep({}, 4).description).toBe('Step 5');
  });

  it('defaults description to "<phase> step <n>" when a phase is given', () => {
    expect(normaliseIntentStep({}, 0, 'setup').description).toBe('setup step 1');
    expect(normaliseIntentStep({}, 2, 'main').description).toBe('main step 3');
  });

  it('preserves raw.description', () => {
    expect(normaliseIntentStep({ description: 'Click login' }, 0).description).toBe('Click login');
  });

  it('spreads value only when present in raw', () => {
    expect(normaliseIntentStep({ value: 'hello' }, 0)).toHaveProperty('value', 'hello');
    expect(normaliseIntentStep({}, 0)).not.toHaveProperty('value');
  });

  it('spreads assertionText only when truthy', () => {
    expect(normaliseIntentStep({ assertionText: 'visible' }, 0)).toHaveProperty('assertionText', 'visible');
    expect(normaliseIntentStep({ assertionText: '' }, 0)).not.toHaveProperty('assertionText');
    expect(normaliseIntentStep({}, 0)).not.toHaveProperty('assertionText');
  });

  it('spreads bindingHints, compiled, options, isAutoInjected, expectedOutcome when truthy', () => {
    const raw = {
      bindingHints: { env: 'prod' },
      compiled: { selector: '#btn' },
      options: { continueOnError: true },
      isAutoInjected: true,
      expectedOutcome: 'logged in',
    };
    const step = normaliseIntentStep(raw, 0);
    expect(step.bindingHints).toEqual({ env: 'prod' });
    expect(step.compiled).toEqual({ selector: '#btn' });
    expect(step.options).toEqual({ continueOnError: true });
    expect(step.isAutoInjected).toBe(true);
    expect(step.expectedOutcome).toBe('logged in');
  });

  it('spreads tabIndex when 0 (falsy but present)', () => {
    expect(normaliseIntentStep({ tabIndex: 0 }, 0)).toHaveProperty('tabIndex', 0);
    expect(normaliseIntentStep({}, 0)).not.toHaveProperty('tabIndex');
  });

  it('phase argument overwrites any phase in raw', () => {
    const step = normaliseIntentStep({ phase: 'teardown' }, 0, 'setup');
    expect(step.phase).toBe('setup');
  });

  it('leaves phase off when not provided', () => {
    expect(normaliseIntentStep({}, 0)).not.toHaveProperty('phase');
  });

  it('handles null raw gracefully (all fields fall back to defaults)', () => {
    const step = normaliseIntentStep(null, 0);
    expect(step.id).toBe('step_1');
    expect(step.type).toBe('click');
  });
});

// ── stitchPhases ─────────────────────────────────────────────────────────────

describe('stitchPhases', () => {
  const mainSteps = [
    { id: 'm1', type: 'click' as const, description: 'Click login' },
    { id: 'm2', type: 'navigate' as const, description: 'Go to dashboard' },
  ];

  describe('passthrough (no extras)', () => {
    it('returns mainSteps untouched when testCase has no setup or teardown', () => {
      const result = stitchPhases(mainSteps, {});
      expect(result.steps).toBe(mainSteps);
      expect(result.didStitch).toBe(false);
    });

    it('returns didStitch=false and correct counts', () => {
      const result = stitchPhases(mainSteps, {});
      expect(result.counts).toEqual({ setup: 0, main: 2, teardown: 0 });
    });

    it('does not add phase markers to mainSteps in passthrough', () => {
      const result = stitchPhases(mainSteps, {});
      expect(result.steps.every((s) => !('phase' in s))).toBe(true);
    });

    it('does not call logger.info when nothing to stitch', () => {
      stitchPhases(mainSteps, {});
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });

  describe('camelCase input (TS service shape)', () => {
    const tc = {
      id: 'tc-1',
      setupSteps: [{ type: 'navigate', description: 'open app' }],
      teardownSteps: [{ type: 'click', description: 'logout' }],
    };

    it('prepends setup steps tagged phase=setup', () => {
      const result = stitchPhases(mainSteps, tc);
      expect(result.steps[0].phase).toBe('setup');
      expect(result.steps[0].description).toBe('open app');
    });

    it('appends teardown steps tagged phase=teardown', () => {
      const result = stitchPhases(mainSteps, tc);
      expect(result.steps[result.steps.length - 1].phase).toBe('teardown');
    });

    it('tags main steps as phase=main', () => {
      const result = stitchPhases(mainSteps, tc);
      const mainInResult = result.steps.filter((s) => s.phase === 'main');
      expect(mainInResult).toHaveLength(2);
    });

    it('total step count is setup + main + teardown', () => {
      const result = stitchPhases(mainSteps, tc);
      expect(result.steps).toHaveLength(1 + 2 + 1);
    });

    it('counts are accurate', () => {
      const result = stitchPhases(mainSteps, tc);
      expect(result.counts).toEqual({ setup: 1, main: 2, teardown: 1 });
    });

    it('didStitch is true', () => {
      expect(stitchPhases(mainSteps, tc).didStitch).toBe(true);
    });

    it('calls logger.info once when stitching', () => {
      stitchPhases(mainSteps, tc);
      expect(mockLogger.info).toHaveBeenCalledTimes(1);
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('PHASE_STITCH'),
        expect.objectContaining({ testCaseId: 'tc-1', setup: 1, main: 2, teardown: 1 }),
      );
    });
  });

  describe('snake_case input (raw DB row)', () => {
    const tc = {
      setup_steps: [{ type: 'navigate', description: 'login' }],
      teardown_steps: [],
    };

    it('accepts snake_case setup_steps', () => {
      const result = stitchPhases(mainSteps, tc);
      expect(result.didStitch).toBe(true);
      expect(result.counts.setup).toBe(1);
    });

    it('teardown is empty → no teardown steps appended', () => {
      const result = stitchPhases(mainSteps, tc);
      expect(result.steps.filter((s) => s.phase === 'teardown')).toHaveLength(0);
    });
  });

  describe('setup only / teardown only', () => {
    it('setup only → didStitch=true', () => {
      const result = stitchPhases(mainSteps, { setupSteps: [{ type: 'navigate' }] });
      expect(result.didStitch).toBe(true);
      expect(result.counts.teardown).toBe(0);
    });

    it('teardown only → didStitch=true', () => {
      const result = stitchPhases(mainSteps, { teardownSteps: [{ type: 'click' }] });
      expect(result.didStitch).toBe(true);
      expect(result.counts.setup).toBe(0);
    });
  });

  describe('empty mainSteps', () => {
    it('handles empty mainSteps with setup and teardown', () => {
      const result = stitchPhases([], {
        setupSteps: [{ type: 'navigate' }],
        teardownSteps: [{ type: 'click' }],
      });
      expect(result.steps).toHaveLength(2);
      expect(result.counts.main).toBe(0);
    });
  });
});
