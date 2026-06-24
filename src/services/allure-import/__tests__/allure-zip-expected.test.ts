/**
 * ZIP-path parity for expected results (Root A).
 *
 * The ZIP format has no explicit "expected result" field — the closest signal
 * is a step's statusDetails.message (failure / expected-vs-actual). flattenRawSteps
 * now captures that into expected[], and convertStepsWithAI emits one assert per
 * entry right after its step (matching the CSV path).
 *
 * We exercise the deterministic FALLBACK path (LLM throws) so the
 * statusDetails → expected → assert chain is proven without LLM nondeterminism.
 */

const mockGetChatCompletion = jest.fn();

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: unknown[]) => mockGetChatCompletion(...args),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('@/services/testing/modules/module.service', () => ({ ModuleService: {} }));
jest.mock('@/services/testing/flows/flow.service', () => ({ FlowService: {} }));
jest.mock('@/services/testing/platforms/platform.service', () => ({ PlatformService: {} }));

import { mapAllureResult, HierarchyCache } from '../allure-mapper';
import type { AllureTestResult, AllureContainer } from '../allure-import.types';

function makeResult(overrides: Partial<AllureTestResult>): AllureTestResult {
  return {
    uuid: 'u1',
    name: 'Test',
    status: 'failed',
    labels: [],
    links: [],
    parameters: [],
    steps: [],
    attachments: [],
    ...overrides,
  } as AllureTestResult;
}

const opts = { projectId: 'p1', userId: 'u1', autoCreateModules: false, autoCreateFlows: false, platform: 'web' as const };
const emptyContainers = new Map<string, AllureContainer>();

beforeEach(() => mockGetChatCompletion.mockReset());

describe('ZIP path — statusDetails becomes a linked assert', () => {
  it('emits an assert (after its step) from a failed step statusDetails.message [fallback]', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('LLM down'));

    const result = makeResult({
      steps: [
        { name: 'Click submit', status: 'passed' },
        {
          name: 'Verify result',
          status: 'failed',
          statusDetails: { message: 'Expected: dashboard shown, but got 403' },
        },
      ],
    });

    const mapped = await mapAllureResult(result, emptyContainers, new HierarchyCache(), 'tree-1', opts);
    const steps = mapped.createParams.steps;

    // click(submit), click(verify, degraded type), assert(from statusDetails)
    expect(steps.map((s) => s.type)).toEqual(['click', 'click', 'assert']);
    expect(steps[2].description).toBe('Expected: dashboard shown, but got 403');
    expect(mapped.stepsDegraded).toBe(true);
  });

  it('ignores a stacktrace-only statusDetails message (no garbage assert) [fallback]', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('LLM down'));

    const result = makeResult({
      steps: [
        {
          name: 'Do thing',
          status: 'broken',
          statusDetails: { message: 'NullPointerException\n    at com.x.Foo.bar(Foo.java:42)\n    at com.x.Baz(Baz.java:9)' },
        },
      ],
    });

    const mapped = await mapAllureResult(result, emptyContainers, new HierarchyCache(), 'tree-1', opts);
    const steps = mapped.createParams.steps;

    // Only the action — the stacktrace blob is NOT turned into an assert.
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('click');
  });

  it('passed step with no statusDetails yields just the action [fallback]', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('LLM down'));

    const result = makeResult({ steps: [{ name: 'Open page', status: 'passed' }] });
    const mapped = await mapAllureResult(result, emptyContainers, new HierarchyCache(), 'tree-1', opts);

    expect(mapped.createParams.steps).toHaveLength(1);
    expect(mapped.createParams.steps[0].type).toBe('click');
  });

  it('feeds expected results into the LLM prompt on the happy path', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({ steps: [{ type: 'click', description: 'Verify result' }] }),
    });

    const result = makeResult({
      steps: [{ name: 'Verify result', status: 'failed', statusDetails: { message: 'Expected X but got Y' } }],
    });

    await mapAllureResult(result, emptyContainers, new HierarchyCache(), 'tree-1', opts);

    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userPrompt = messages.find((m) => m.role === 'user')!.content;
    expect(userPrompt).toContain('Expected X but got Y');
    expect(userPrompt).toMatch(/expected results/i);
  });
});
