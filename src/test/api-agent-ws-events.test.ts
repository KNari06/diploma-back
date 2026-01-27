import { ApiAgentOrchestratorService } from '@/services/testing/api/agent/api-agent-orchestrator.service';
import { webSocketService } from '@/websocket/core/websocket.service';

jest.mock('@/services/ai/core/openai.service', () => {
  let call = 0;
  const make = (obj: any) => ({
    content: JSON.stringify(obj),
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, model: 'mock' },
  });
  return {
    getChatCompletionWithMessages: jest.fn(async () => {
      call++;
      // LIGHT expected sequence: happy_path + 4 method_contract, then stop
      if (call === 1) {
        return make({
          nextStep: {
            stepType: 'happy_path',
            description: 'Execute GET https://api.example.com/users with provided data',
            request: { method: 'GET', url: 'https://api.example.com/users', headers: {}, body: null },
            expectedOutcome: 'Expect 200 response',
            riskLevel: 'safe',
          },
          reasoning: 'Start with happy path',
          shouldStop: false,
          stopReason: null,
          noveltyEstimate: 1.0,
        });
      }
      const methods = ['POST', 'PUT', 'DELETE', 'PATCH'];
      if (call >= 2 && call <= 5) {
        const m = methods[call - 2];
        return make({
          nextStep: {
            stepType: 'method_contract',
            description: `Test ${m} method on endpoint (expect 405/4xx)`,
            request: { method: m, url: 'https://api.example.com/users', headers: {} },
            expectedOutcome: 'Expect 405 Method Not Allowed or 4xx error',
            riskLevel: 'low',
          },
          reasoning: `Test method contract for ${m}`,
          shouldStop: false,
          stopReason: null,
          noveltyEstimate: 0.9,
        });
      }
      return make({
        nextStep: null,
        reasoning: 'Done',
        shouldStop: true,
        stopReason: 'completed',
        noveltyEstimate: 0.0,
      });
    }),
  };
});

jest.mock('@/services/testing/api/agent/api-agent-trace.service', () => {
  class ApiAgentTraceService {
    // eslint-disable-next-line @typescript-eslint/no-useless-constructor
    constructor() {}
    writeRunStart() {}
    writeRunEnd() {}
    writeError() {}
    writeStepPlanning() {}
    writeStepStart() {}
    writeStepResult() {}
    writeStateUpdate() {}
    async closeAndUpload() {
      return null;
    }
  }

  return { ApiAgentTraceService };
});

jest.mock('@/services/testing/api/agent/api-agent-step-executor.service', () => {
  const makeResult = (step: any, stepIndex: number) => {
    const timestamp = new Date().toISOString();
    const isMethodContract = step.stepType === 'method_contract';

    return {
      stepId: `step_${stepIndex}_mock`,
      stepType: step.stepType,
      description: step.description,
      request: step.request,
      response: {
        status: isMethodContract ? 405 : 200,
        statusText: isMethodContract ? 'Method Not Allowed' : 'OK',
        headers: {},
        body: isMethodContract ? { error: 'method_not_allowed' } : { ok: true },
        durationMs: 10,
      },
      success: true,
      findings: [],
      aiTokensUsed: 0,
      timestamp,
    };
  };

  return {
    ApiAgentStepExecutorService: {
      executeStep: jest.fn(async (step: any, stepIndex: number) => makeResult(step, stepIndex)),
      executeStepWithRetry: jest.fn(async (step: any, stepIndex: number) => ({
        results: [makeResult(step, stepIndex)],
        finalResult: makeResult(step, stepIndex),
        retryCount: 0,
      })),
    },
  };
});

jest.mock('@/websocket/core/websocket.service', () => {
  const webSocketService = {
    emitApiAgentStep: jest.fn(),
    emitChatProcessingStep: jest.fn(),
  };
  return { webSocketService };
});

describe('ApiAgentOrchestratorService WebSocket step events', () => {
  it('emits planning/executing/completed events for each LIGHT step', async () => {
    await ApiAgentOrchestratorService.run({
      level: 'light',
      url: 'https://api.example.com/users',
      method: 'GET',
      userId: 'user_test',
      chatSessionId: 'chat_session_test',
      headers: { Authorization: 'Bearer secret' },
    });

    const emitApiAgentStep = webSocketService.emitApiAgentStep as unknown as jest.Mock;
    const calls = emitApiAgentStep.mock.calls;

    // LIGHT = happy_path + 4 method_contract steps => 5 executed steps
    expect(calls.length).toBe(15);

    // First step planning/executing/completed
    expect(calls[0][0]).toBe('chat_session_test');
    expect(calls[0][1]).toMatchObject({
      stage: 'planning',
      stepIndex: 0,
      stepType: 'happy_path',
      description: expect.any(String),
    });
    expect(calls[1][1]).toMatchObject({
      stage: 'executing',
      stepIndex: 0,
      stepType: 'happy_path',
      description: expect.any(String),
    });
    expect(calls[2][1]).toMatchObject({
      stage: 'completed',
      stepIndex: 0,
      stepType: 'happy_path',
      description: expect.any(String),
      success: true,
      response: { status: 200 },
    });

    // First method contract step
    expect(calls[3][1]).toMatchObject({
      stage: 'planning',
      stepIndex: 1,
      stepType: 'method_contract',
      description: expect.any(String),
    });
    expect(calls[4][1]).toMatchObject({
      stage: 'executing',
      stepIndex: 1,
      stepType: 'method_contract',
      description: expect.any(String),
    });
    expect(calls[5][1]).toMatchObject({
      stage: 'completed',
      stepIndex: 1,
      stepType: 'method_contract',
      description: expect.any(String),
      response: { status: 405 },
    });

  });
});
