/**
 * Tests for expected-result handling in convertImportedStepsWithAI (Fix B).
 *
 * - The LLM is given each step's expected[] as a labelled sub-list, with an
 *   instruction to emit one assert per item right after the step.
 * - On the fallback (LLM failure) path, the converter deterministically emits
 *   the action step followed by one assert per expected result — so the
 *   step↔assertion link survives even when AI is unavailable.
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

import { convertImportedStepsWithAI } from '../allure-mapper';

beforeEach(() => mockGetChatCompletion.mockReset());

// Models case #13: a step with two expected results.
const stepsWithExpected = [
  { type: 'step', description: 'Return to Profile page after success screen', expected: [
    'IN_PROGRESS status is not shown for KZ users',
    'Only CREATED, VERIFIED, REJECTED statuses are used',
  ] },
];

describe('convertImportedStepsWithAI — expected results reach the LLM', () => {
  it('includes each expected result in the prompt sent to the model', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({ steps: [{ type: 'click', description: 'Return to Profile' }] }),
    });

    await convertImportedStepsWithAI('KZ test', stepsWithExpected);

    expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const userPrompt = messages.find((m) => m.role === 'user')!.content;

    expect(userPrompt).toContain('IN_PROGRESS status is not shown for KZ users');
    expect(userPrompt).toContain('Only CREATED, VERIFIED, REJECTED statuses are used');
    expect(userPrompt).toMatch(/expected results/i);
  });

  it('keeps whatever asserts the model returns (link is the model\'s job at runtime)', async () => {
    mockGetChatCompletion.mockResolvedValue({
      content: JSON.stringify({
        steps: [
          { type: 'click', description: 'Return to Profile' },
          { type: 'assert', description: 'IN_PROGRESS not shown for KZ users' },
          { type: 'assert', description: 'Only CREATED/VERIFIED/REJECTED used' },
        ],
      }),
    });

    const { steps, degraded } = await convertImportedStepsWithAI('KZ test', stepsWithExpected);

    expect(degraded).toBe(false);
    expect(steps.map((s) => s.type)).toEqual(['click', 'assert', 'assert']);
  });
});

describe('convertImportedStepsWithAI — fallback preserves expected as asserts', () => {
  it('emits action + one assert per expected, in order, when the LLM throws', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('429 rate limit'));

    const { steps, degraded } = await convertImportedStepsWithAI('KZ test', stepsWithExpected);

    expect(degraded).toBe(true);
    // action step first, then its two asserts, in order
    expect(steps.map((s) => ({ type: s.type, d: s.description }))).toEqual([
      { type: 'click', d: 'Return to Profile page after success screen' },
      { type: 'assert', d: 'IN_PROGRESS status is not shown for KZ users' },
      { type: 'assert', d: 'Only CREATED, VERIFIED, REJECTED statuses are used' },
    ]);
  });

  it('does not drop the 3rd expected result on the fallback path (the old 120-char bug)', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('boom'));

    const { steps } = await convertImportedStepsWithAI('KZ test', [
      { type: 'step', description: 'Track status changes', expected: [
        '"Under review" status never appears',
        'Operator review logic is not used in KZ flow',
        'UI is not mixed with other countries logic',
      ] },
    ]);

    const asserts = steps.filter((s) => s.type === 'assert').map((s) => s.description);
    expect(asserts).toHaveLength(3);
    expect(asserts[2]).toBe('UI is not mixed with other countries logic');
  });

  it('a step with no expected results yields just the action (fallback)', async () => {
    mockGetChatCompletion.mockRejectedValue(new Error('boom'));

    const { steps } = await convertImportedStepsWithAI('t', [
      { type: 'step', description: 'Click button' },
    ]);

    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe('click');
  });
});
