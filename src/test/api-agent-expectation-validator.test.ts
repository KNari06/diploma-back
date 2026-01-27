import { ApiAgentExpectationValidatorService } from '@/services/testing/api/agent/api-agent-expectation-validator.service';
import type { ApiAgentPlannedStep, ApiAgentStepResult } from '@/services/testing/api/agent/api-agent.types';

function makeHappyPathStep(): ApiAgentPlannedStep {
  return {
    stepType: 'happy_path',
    description: 'Happy path',
    request: {
      method: 'GET',
      url: 'https://example.com/api',
      headers: {},
    },
    expectedOutcome: 'Expect 200',
    riskLevel: 'safe',
  };
}

function makeStepResult(params: {
  status: number;
  stepType?: ApiAgentPlannedStep['stepType'];
  headers?: Record<string, string>;
  body: any;
  error?: string;
  findings?: ApiAgentStepResult['findings'];
}): ApiAgentStepResult {
  const stepType = params.stepType || 'happy_path';
  return {
    stepId: 'step_0_test',
    stepType,
    description: 'Happy path',
    request: {
      method: 'GET',
      url: 'https://example.com/api',
      headers: {},
    },
    response: {
      status: params.status,
      statusText: params.status === 200 ? 'OK' : 'ERROR',
      headers: params.headers || {},
      body: params.body,
      durationMs: 5,
    },
    success: params.status >= 200 && params.status < 300,
    error: params.error,
    findings: params.findings || [],
    aiTokensUsed: 0,
    timestamp: new Date().toISOString(),
  };
}

describe('ApiAgentExpectationValidatorService', () => {
  it('flags HTML response on happy_path as expectation_violation by default', () => {
    const plannedStep = makeHappyPathStep();
    const stepResult = makeStepResult({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<!doctype html><html><head></head><body>ok</body></html>',
    });

    const { findings } = ApiAgentExpectationValidatorService.validateStep({
      plannedStep,
      stepResult,
      expectationModel: undefined,
      expectedBehaviorRaw: 'Just verify the endpoint works',
    });

    expect(findings.some((f) => f.type === 'expectation_violation')).toBe(true);
  });

  it('does not flag HTML response when expectation explicitly allows HTML', () => {
    const plannedStep = makeHappyPathStep();
    const stepResult = makeStepResult({
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: '<html><body>ok</body></html>',
    });

    const { findings } = ApiAgentExpectationValidatorService.validateStep({
      plannedStep,
      stepResult,
      expectationModel: undefined,
      expectedBehaviorRaw: 'Expect HTML page content',
    });

    expect(findings.some((f) => f.type === 'expectation_violation')).toBe(false);
  });

  it('classifies status=0 network-unreachable on method_contract as network_error (not invalid_method_handling)', () => {
    const plannedStep: ApiAgentPlannedStep = {
      stepType: 'method_contract',
      description: 'Method contract',
      request: { method: 'DELETE', url: 'https://example.com/api', headers: {} },
      expectedOutcome: 'Expect 405 or 4xx',
      riskLevel: 'low',
    };
    const stepResult = makeStepResult({
      status: 0,
      stepType: 'method_contract',
      headers: {},
      body: null,
      error: 'Network error - unable to reach server',
      findings: [],
    });

    const { findings } = ApiAgentExpectationValidatorService.validateStep({
      plannedStep,
      stepResult,
      expectationModel: undefined,
      expectedBehaviorRaw: 'Test endpoint behavior',
    });

    expect(findings.some((f) => f.type === 'network_error')).toBe(true);
    expect(findings.some((f) => f.type === 'invalid_method_handling')).toBe(false);
  });

  it('does not duplicate network_error if stepResult already contains it', () => {
    const plannedStep: ApiAgentPlannedStep = {
      stepType: 'method_contract',
      description: 'Method contract',
      request: { method: 'DELETE', url: 'https://example.com/api', headers: {} },
      expectedOutcome: 'Expect 405 or 4xx',
      riskLevel: 'low',
    };
    const stepResult = makeStepResult({
      status: 0,
      stepType: 'method_contract',
      headers: {},
      body: null,
      error: 'Network error - unable to reach server',
      findings: [
        {
          id: 'finding_network_existing',
          type: 'network_error',
          severity: 'high',
          title: 'Network error',
          description: 'Network error - unable to reach server',
        },
      ],
    });

    const { findings } = ApiAgentExpectationValidatorService.validateStep({
      plannedStep,
      stepResult,
      expectationModel: undefined,
      expectedBehaviorRaw: 'Test endpoint behavior',
    });

    expect(findings.some((f) => f.type === 'network_error')).toBe(false);
  });
});

