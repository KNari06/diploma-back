/**
 * Tests for degraded-step detection in AI step conversion.
 *
 * When the AI call throws (rate limit, network, timeout), the mapper falls back
 * to mapping every step to type 'click'. The step text survives but the action
 * TYPES are unreliable, so the import must flag the test as degraded
 * (stats.testsWithDegradedSteps) rather than presenting it as a clean import.
 *
 * We mock the OpenAI client to control success vs failure per call.
 */

const mockGetChatCompletion = jest.fn();

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...args: unknown[]) => mockGetChatCompletion(...args),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The mapper imports these services at module load; stub so import doesn't fail.
jest.mock('@/services/testing/modules/module.service', () => ({ ModuleService: {} }));
jest.mock('@/services/testing/flows/flow.service', () => ({ FlowService: {} }));
jest.mock('@/services/testing/platforms/platform.service', () => ({ PlatformService: {} }));

import { convertImportedStepsWithAI } from '../allure-mapper';

beforeEach(() => {
  mockGetChatCompletion.mockReset();
});

describe('convertImportedStepsWithAI — degraded detection', () => {
  const steps = [
    { type: 'step', description: 'Open the login page' },
    { type: 'step', description: 'Enter username' },
  ];

  it('returns degraded=false when AI conversion succeeds', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        steps: [
          { type: 'navigate', description: 'Open login page', value: '/login' },
          { type: 'type', description: 'Enter username', value: 'alice' },
        ],
      }),
    });

    const result = await convertImportedStepsWithAI('Login', steps);

    expect(result.degraded).toBe(false);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0].type).toBe('navigate');
    expect(result.steps[1].type).toBe('type');
  });

  it('returns degraded=true and falls back to all-click when AI throws', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('429 rate limit'));

    const result = await convertImportedStepsWithAI('Login', steps);

    expect(result.degraded).toBe(true);
    expect(result.steps).toHaveLength(2);
    expect(result.steps.every((s) => s.type === 'click')).toBe(true);
    // Step text is preserved even in the fallback
    expect(result.steps[0].description).toBe('Open the login page');
  });

  it('returns degraded=false (not true) when AI returns unparseable JSON', async () => {
    // A bad-JSON response yields an empty batch — no fabricated steps, so it is
    // NOT degraded (degraded means wrong types were invented, not zero steps).
    mockGetChatCompletion.mockResolvedValue({ content: 'not json at all {' });

    const result = await convertImportedStepsWithAI('Login', steps);

    expect(result.degraded).toBe(false);
    expect(result.steps).toHaveLength(0);
  });

  it('returns degraded=false for an empty step list (no AI call)', async () => {
    const result = await convertImportedStepsWithAI('Empty', []);

    expect(result.degraded).toBe(false);
    expect(result.steps).toEqual([]);
    expect(mockGetChatCompletion).not.toHaveBeenCalled();
  });
});
