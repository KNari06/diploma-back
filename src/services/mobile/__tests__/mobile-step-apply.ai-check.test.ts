import { MobileStepApplyService } from '../mobile-step-apply.service';

jest.mock('../session-runner-routing', () => ({
  getMobileRunnerClientForSession: jest.fn(),
}));

const { getMobileRunnerClientForSession } = require('../session-runner-routing') as {
  getMobileRunnerClientForSession: jest.Mock;
};

describe('MobileStepApplyService.apply — ai_check detail', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('forwards resolved assertion, confidence, and explanation on a passing ai_check', async () => {
    const runSteps = jest.fn().mockResolvedValue({
      steps: [{
        stepId: 'apply_1',
        success: true,
        durationMs: 500,
        aiCheckResolvedAssertion: 'the page shows the address 123 Main St',
        aiCheckConfidence: 0.95,
        aiCheckExplanation: 'The address matches exactly.',
      }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({ runSteps });

    const output = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: {
        id: 'step-1',
        type: 'ai_check',
        description: 'branch address is correct',
        assertionText: 'the page shows {{extracted.branch_address}}',
        options: { aiCheckSource: 'tree' },
      },
      userId: 'user-1',
    });

    expect(output.stepResult?.success).toBe(true);
    expect(output.stepResult?.aiCheckResolvedAssertion).toBe('the page shows the address 123 Main St');
    expect(output.stepResult?.aiCheckConfidence).toBe(0.95);
    expect(output.stepResult?.aiCheckExplanation).toBe('The address matches exactly.');
  });

  it('forwards resolved assertion, confidence, and explanation on a failing ai_check', async () => {
    const runSteps = jest.fn().mockResolvedValue({
      steps: [{
        stepId: 'apply_1',
        success: false,
        error: 'the address does not match',
        durationMs: 500,
        aiCheckResolvedAssertion: 'the page shows the address 123 Main St',
        aiCheckConfidence: 0.4,
        aiCheckExplanation: 'the address does not match',
      }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({ runSteps });

    const output = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: {
        id: 'step-1',
        type: 'ai_check',
        description: 'branch address is correct',
        assertionText: 'the page shows {{extracted.branch_address}}',
        options: { aiCheckSource: 'tree' },
      },
      userId: 'user-1',
    });

    expect(output.stepResult?.success).toBe(false);
    expect(output.stepResult?.aiCheckResolvedAssertion).toBe('the page shows the address 123 Main St');
    expect(output.stepResult?.aiCheckConfidence).toBe(0.4);
    expect(output.stepResult?.aiCheckExplanation).toBe('the address does not match');
  });

  it('omits ai_check fields for a non-ai_check step', async () => {
    const runSteps = jest.fn().mockResolvedValue({
      steps: [{ stepId: 'apply_1', success: true, durationMs: 100 }],
    });
    getMobileRunnerClientForSession.mockResolvedValue({ runSteps });

    const output = await MobileStepApplyService.apply({
      sessionId: 'sess-1',
      stepDraft: { id: 'step-1', type: 'tap', description: 'tap submit' },
      userId: 'user-1',
    });

    expect(output.stepResult?.aiCheckResolvedAssertion).toBeUndefined();
    expect(output.stepResult?.aiCheckConfidence).toBeUndefined();
    expect(output.stepResult?.aiCheckExplanation).toBeUndefined();
  });
});
