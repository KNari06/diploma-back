import {
  createInitialState,
  addStepResult,
  updateConsumedTime,
  addAiTokens,
  addKnownId,
  addDiscoveredMethod,
  updateInferredSchema,
  addErrorSignature,
  updateNovelty,
  incrementEndpointsConsidered,
  markCompleted,
  markStopped,
  markFailed,
  getDurationMs,
  getFindingsCounts,
  getTopFindings,
  hasSuccessfulHappyPath,
  hasCriticalFindings,
  computeErrorSignature,
} from '../api-agent-state';
import type { ApiAgentRunState, ApiAgentStepResult } from '../api-agent.types';

const newState = (): ApiAgentRunState => createInitialState('test-1', 'standard' as any);

const step = (over: Partial<ApiAgentStepResult> = {}): ApiAgentStepResult =>
  ({ aiTokensUsed: 0, findings: [], ...over }) as unknown as ApiAgentStepResult;

const finding = (severity: string) =>
  ({ id: `f-${severity}`, type: 'x', severity, title: 't', description: 'd' }) as any;

describe('createInitialState', () => {
  it('initializes a running state with zeroed counters', () => {
    const s = createInitialState('test-1', 'standard' as any, 'run-9');
    expect(s).toMatchObject({
      runId: 'run-9',
      testId: 'test-1',
      status: 'running',
      currentStep: 0,
      steps: [],
      findings: [],
      knownIds: [],
      novelty: 1.0,
    });
    expect(s.consumed).toEqual({ steps: 0, seconds: 0, aiTokens: 0, endpointsConsidered: 0, requests: 0 });
    expect(s.errorSignatures.size).toBe(0);
  });

  it('generates a runId when none is provided', () => {
    expect(typeof createInitialState('t', 'standard' as any).runId).toBe('string');
  });
});

describe('state mutators', () => {
  it('addStepResult appends the step and rolls up counters and findings', () => {
    const s = newState();
    addStepResult(s, step({ aiTokensUsed: 10, requestsExecuted: 2, findings: [finding('high')] }));
    expect(s.steps).toHaveLength(1);
    expect(s.currentStep).toBe(1);
    expect(s.consumed.steps).toBe(1);
    expect(s.consumed.aiTokens).toBe(10);
    expect(s.consumed.requests).toBe(2);
    expect(s.findings).toHaveLength(1);
  });

  it('addStepResult defaults requestsExecuted to 1', () => {
    const s = newState();
    addStepResult(s, step({ aiTokensUsed: 0 }));
    expect(s.consumed.requests).toBe(1);
  });

  it('updateConsumedTime floors ms to seconds', () => {
    const s = newState();
    updateConsumedTime(s, 5500);
    expect(s.consumed.seconds).toBe(5);
  });

  it('addAiTokens accumulates', () => {
    const s = newState();
    addAiTokens(s, 5);
    addAiTokens(s, 7);
    expect(s.consumed.aiTokens).toBe(12);
  });

  it('addKnownId dedups', () => {
    const s = newState();
    addKnownId(s, 'a');
    addKnownId(s, 'a');
    addKnownId(s, 'b');
    expect(s.knownIds).toEqual(['a', 'b']);
  });

  it('addDiscoveredMethod uppercases and dedups', () => {
    const s = newState();
    addDiscoveredMethod(s, 'get');
    addDiscoveredMethod(s, 'GET');
    addDiscoveredMethod(s, 'post');
    expect(s.discoveredMethods).toEqual(['GET', 'POST']);
  });

  it('updateInferredSchema sets then merges', () => {
    const s = newState();
    updateInferredSchema(s, { a: 1 });
    updateInferredSchema(s, { b: 2 });
    expect(s.inferredSchema).toEqual({ a: 1, b: 2 });
  });

  it('addErrorSignature returns true for new and false for duplicate', () => {
    const s = newState();
    expect(addErrorSignature(s, 'sig')).toBe(true);
    expect(addErrorSignature(s, 'sig')).toBe(false);
  });

  it('updateNovelty clamps to [0, 1]', () => {
    const s = newState();
    updateNovelty(s, 2);
    expect(s.novelty).toBe(1);
    updateNovelty(s, -1);
    expect(s.novelty).toBe(0);
    updateNovelty(s, 0.4);
    expect(s.novelty).toBe(0.4);
  });

  it('incrementEndpointsConsidered increments', () => {
    const s = newState();
    incrementEndpointsConsidered(s);
    incrementEndpointsConsidered(s);
    expect(s.consumed.endpointsConsidered).toBe(2);
  });
});

describe('terminal markers', () => {
  it('markCompleted sets completed status and stop reason', () => {
    const s = newState();
    markCompleted(s, 'budget' as any);
    expect(s.status).toBe('completed');
    expect(s.stopReason).toBe('budget');
    expect(s.completedAt).toBeDefined();
  });

  it('markStopped sets stopped status', () => {
    const s = newState();
    markStopped(s, 'budget' as any);
    expect(s.status).toBe('stopped');
  });

  it('markFailed sets failed status and records a critical finding', () => {
    const s = newState();
    markFailed(s, 'kaboom');
    expect(s.status).toBe('failed');
    expect(s.stopReason).toBe('error');
    expect(s.findings.some((f) => f.severity === 'critical' && f.description === 'kaboom')).toBe(true);
  });
});

describe('state queries', () => {
  it('getDurationMs returns elapsed since start', () => {
    const s = newState();
    expect(getDurationMs(s)).toBeGreaterThanOrEqual(0);
  });

  it('getFindingsCounts tallies by severity', () => {
    const s = newState();
    s.findings.push(finding('critical'), finding('critical'), finding('low'));
    expect(getFindingsCounts(s)).toMatchObject({ critical: 2, low: 1, high: 0 });
  });

  it('getTopFindings sorts by severity and caps at n', () => {
    const s = newState();
    s.findings.push(finding('low'), finding('critical'), finding('medium'), finding('high'));
    const top = getTopFindings(s, 2);
    expect(top.map((f) => f.severity)).toEqual(['critical', 'high']);
  });

  it('hasSuccessfulHappyPath reflects a successful happy-path step', () => {
    const s = newState();
    expect(hasSuccessfulHappyPath(s)).toBe(false);
    addStepResult(s, step({ stepType: 'happy_path', success: true } as any));
    expect(hasSuccessfulHappyPath(s)).toBe(true);
  });

  it('hasCriticalFindings detects critical findings', () => {
    const s = newState();
    expect(hasCriticalFindings(s)).toBe(false);
    s.findings.push(finding('critical'));
    expect(hasCriticalFindings(s)).toBe(true);
  });
});

describe('computeErrorSignature', () => {
  it('combines status with a stringified body preview', () => {
    expect(computeErrorSignature(404, { error: 'x' })).toBe('404:{"error":"x"}');
    expect(computeErrorSignature(500, 'boom')).toBe('500:boom');
  });

  it('handles an undefined body', () => {
    expect(computeErrorSignature(400, undefined)).toBe('400:');
  });
});
