import { ApiAgentStepExecutorService } from '@/services/testing/api/agent/api-agent-step-executor.service';
import type { ApiAgentPlannedStep } from '@/services/testing/api/agent/api-agent.types';
import { executeApiTest } from '@/services/testing/api/apiTest.service';

jest.mock('@/services/testing/api/apiTest.service', () => ({
  executeApiTest: jest.fn(),
}));

function makeMethodContractStep(method: string): ApiAgentPlannedStep {
  return {
    stepType: 'method_contract',
    description: `Test ${method} method on endpoint (expect 405/4xx)`,
    request: { method, url: 'https://api.example.com/users', headers: {} },
    expectedOutcome: 'Expect 405 Method Not Allowed or 4xx error',
    riskLevel: 'low',
  };
}

describe('ApiAgentStepExecutorService (network errors)', () => {
  it('emits network_error on method_contract when executeApiTest returns status=0 network-unreachable', async () => {
    const mocked = executeApiTest as unknown as jest.Mock;
    mocked.mockResolvedValue({
      success: false,
      status: 0,
      statusText: '',
      responseHeaders: {},
      responseBody: null,
      durationMs: 5,
      error: 'Network error - unable to reach server',
    });

    const step = makeMethodContractStep('DELETE');
    const res = await ApiAgentStepExecutorService.executeStep(step, 0);

    expect(res.findings.some((f) => f.type === 'network_error')).toBe(true);
    expect(res.findings.some((f) => f.type === 'contract_violation')).toBe(false);
  });

  it('does not emit contract_violation on method_contract when status=0 (even if no network_error is inferred)', async () => {
    const mocked = executeApiTest as unknown as jest.Mock;
    mocked.mockResolvedValue({
      success: false,
      status: 0,
      statusText: '',
      responseHeaders: {},
      responseBody: null,
      durationMs: 10000,
      error: 'Request timeout',
    });

    const step = makeMethodContractStep('PUT');
    const res = await ApiAgentStepExecutorService.executeStep(step, 0);

    expect(res.findings.some((f) => f.type === 'contract_violation')).toBe(false);
  });
});

