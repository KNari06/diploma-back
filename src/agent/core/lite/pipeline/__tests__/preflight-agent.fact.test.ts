import { PreflightCheckAgent } from '../preflight-agent';
import { TestBlackboard } from '../blackboard';
import type { LiteSnapshot, LiteElement } from '../../lite-types';
import type { ExecutionRound, TestPlan, PlaywrightCommand, CommandResult } from '../types';

/**
 * FACT-layer behaviour of PreflightCheckAgent — the deterministic checks that
 * run BEFORE the LLM and short-circuit inspect() with a verdict. Two guarantees
 * worth pinning (both straight from real exploration-log failure patterns):
 *   1. a plan targeting a ref not on the page → 'revise' (hallucinated ref)
 *   2. a plan re-targeting a ref that already failed → 'revise' (dead end)
 *
 * The LLM semantic layer is stubbed to a fixed 'go' so the NEGATIVE cases
 * (FACT must NOT fire) assert on a real verdict instead of setup state, and
 * no test hits the network. We do NOT unit-test the LLM's own judgment.
 */

const mockLlm = jest.fn();
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...a: any[]) => mockLlm(...a),
}));

function el(ref: string, name = ref): LiteElement {
  return { ref, role: 'button', name, tag: 'button', visible: true };
}

function snapshotWithRefs(refs: string[]): LiteSnapshot {
  return { url: 'https://app.test/', title: 'Test', elements: refs.map((r) => el(r)), timestamp: 0 };
}

function round(roundNumber: number, cmds: Array<{ ref?: string; success: boolean; error?: string }>): ExecutionRound {
  return {
    roundNumber,
    commands: cmds.map((c) => ({
      command: { name: 'click_element', args: c.ref ? { ref: c.ref } : {} } as PlaywrightCommand,
      result: { success: c.success, output: '', error: c.error } as CommandResult,
      durationMs: 1,
    })),
    pageSnapshotBefore: '',
    durationMs: 1,
  };
}

function planTargeting(refs: string[]): TestPlan {
  return {
    summary: 'plan',
    steps: refs.map((r, i) => ({ stepNumber: i + 1, description: `act ${r}`, status: 'pending', targetRef: r })),
  };
}

function bb(): TestBlackboard {
  return new TestBlackboard('goal', 'https://app.test/', 'ep-0', false);
}

beforeEach(() => {
  mockLlm.mockReset();
  // Default: LLM would say "go" — so a NEGATIVE fact result surfaces as 'go'.
  mockLlm.mockResolvedValue({ content: JSON.stringify({ verdict: 'go', reason: 'looks fine' }) });
});

describe('PreflightCheckAgent FACT — hallucinated refs', () => {
  it("revises when a plan targets a ref that isn't on the page (LLM not consulted)", async () => {
    const b = bb();
    b.setCurrentSnapshot('formatted', 'https://app.test/', snapshotWithRefs(['e1', 'e2']));
    b.setPlan(planTargeting(['e1', 'e99']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('revise');
    expect(r.reason).toMatch(/e99/);
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('lets a fully-grounded plan through to the LLM layer', async () => {
    const b = bb();
    b.setCurrentSnapshot('formatted', 'https://app.test/', snapshotWithRefs(['e1', 'e2']));
    b.setPlan(planTargeting(['e1', 'e2']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('go');
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });
});

describe('PreflightCheckAgent FACT — repeated failures', () => {
  it('revises when the plan re-targets a ref that failed with a deterministic error (one occurrence)', async () => {
    const b = bb();
    b.setCurrentSnapshot('f', 'https://app.test/', snapshotWithRefs(['e80', 'e5']));
    b.addRound(round(1, [{ ref: 'e80', success: false, error: 'external_link_avoided: External origin https://wa.me blocked' }]));
    b.setPlan(planTargeting(['e80']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('revise');
    expect(r.reason).toMatch(/e80/);
    expect(mockLlm).not.toHaveBeenCalled();
  });

  it('revises when a ref failed repeatedly (>= threshold) even with a generic error', async () => {
    const b = bb();
    b.setCurrentSnapshot('f', 'https://app.test/', snapshotWithRefs(['e12']));
    b.addRound(round(1, [{ ref: 'e12', success: false, error: 'Timeout 4000ms exceeded' }]));
    b.addRound(round(2, [{ ref: 'e12', success: false, error: 'Timeout 4000ms exceeded' }]));
    b.setPlan(planTargeting(['e12']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('revise');
    expect(r.reason).toMatch(/e12/);
  });

  it('does NOT flag a ref that failed once with a generic (possibly transient) error → go', async () => {
    const b = bb();
    b.setCurrentSnapshot('f', 'https://app.test/', snapshotWithRefs(['e7']));
    b.addRound(round(1, [{ ref: 'e7', success: false, error: 'Timeout 4000ms exceeded' }]));
    b.setPlan(planTargeting(['e7']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('go'); // below threshold, not deterministic → LLM path
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });

  it('clears a ref that failed then later SUCCEEDED (page changed, ref live again) → go', async () => {
    const b = bb();
    b.setCurrentSnapshot('f', 'https://app.test/', snapshotWithRefs(['e3']));
    b.addRound(round(1, [{ ref: 'e3', success: false, error: 'element is not visible' }]));
    b.addRound(round(2, [{ ref: 'e3', success: true }]));
    b.setPlan(planTargeting(['e3']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('go'); // a later success clears the dead-ref flag
    expect(mockLlm).toHaveBeenCalledTimes(1);
  });
});

describe('PreflightCheckAgent — fail-open', () => {
  it('returns go when the LLM layer throws (never blocks a flow it could not evaluate)', async () => {
    mockLlm.mockRejectedValue(new Error('network down'));
    const b = bb();
    b.setCurrentSnapshot('f', 'https://app.test/', snapshotWithRefs(['e1']));
    b.setPlan(planTargeting(['e1']));

    const r = await PreflightCheckAgent.inspect(b);
    expect(r.verdict).toBe('go');
  });
});
