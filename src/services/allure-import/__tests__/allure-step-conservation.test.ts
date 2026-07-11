/**
 * Tests for the P0 step-conservation fix.
 *
 * The reported bug: multi-step imported tests collapsed to 1-2 steps because
 * the AI converter was allowed to "skip non-meaningful" steps and a truncated
 * (unparseable) response silently deleted a whole batch with no degraded flag.
 *
 * The fix makes conversion conservation-biased:
 *  - a batch that comes back with fewer steps than the floor is retried once,
 *    then falls back to a deterministic 1:1 mapping (degraded = true);
 *  - small batches (≤5 steps) tolerate ZERO loss;
 *  - the prompt is platform-aware (mobile imports no longer framed as "web");
 *  - finalizeTypedSteps replaces the PDF path's second LLM pass (no loss, no AI).
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

import { convertImportedStepsWithAI, finalizeTypedSteps } from '../allure-mapper';

beforeEach(() => mockGetChatCompletion.mockReset());

function jsonSteps(descriptions: string[]): { content: string } {
  return {
    content: JSON.stringify({
      steps: descriptions.map((d) => ({ type: 'click', description: d })),
    }),
  };
}

describe('step conservation — small batches tolerate zero loss', () => {
  const fiveSteps = [
    { type: 'step', description: 'Open the app' },
    { type: 'step', description: 'Tap Profile' },
    { type: 'step', description: 'Tap Top-Up' },
    { type: 'step', description: 'Select card' },
    { type: 'step', description: 'Confirm payment' },
  ];

  it('retries once when the model drops steps, then keeps the corrected response', async () => {
    // First call drops 3 of 5 steps → below floor (floor for 5 = 5). Retry
    // returns all 5. The corrected response is kept, not degraded.
    mockGetChatCompletion
      .mockResolvedValueOnce(jsonSteps(['Open the app', 'Tap Profile']))
      .mockResolvedValueOnce(
        jsonSteps(['Open the app', 'Tap Profile', 'Tap Top-Up', 'Select card', 'Confirm payment']),
      );

    const { steps, degraded } = await convertImportedStepsWithAI('Top-Up', fiveSteps);

    expect(degraded).toBe(false);
    expect(steps).toHaveLength(5);
    expect(mockGetChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('falls back to 1:1 (degraded) when the model keeps dropping steps after retry', async () => {
    // Both calls drop steps → deterministic 1:1 fallback preserves all 5,
    // flags degraded so the user is warned in the results panel.
    mockGetChatCompletion.mockResolvedValue(jsonSteps(['Open the app']));

    const { steps, degraded } = await convertImportedStepsWithAI('Top-Up', fiveSteps);

    expect(degraded).toBe(true);
    expect(steps).toHaveLength(5);
    expect(steps.map((s) => s.description)).toEqual([
      'Open the app',
      'Tap Profile',
      'Tap Top-Up',
      'Select card',
      'Confirm payment',
    ]);
    expect(mockGetChatCompletion).toHaveBeenCalledTimes(2);
  });

  it('does not retry when the model returns every step (no wasted call)', async () => {
    mockGetChatCompletion.mockResolvedValue(
      jsonSteps(['Open the app', 'Tap Profile', 'Tap Top-Up', 'Select card', 'Confirm payment']),
    );

    const { steps, degraded } = await convertImportedStepsWithAI('Top-Up', fiveSteps);

    expect(degraded).toBe(false);
    expect(steps).toHaveLength(5);
    expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('accepts extra steps from splitting a composite action (no retry)', async () => {
    // "Confirm payment" split into two → 6 out for 5 in, above floor.
    mockGetChatCompletion.mockResolvedValue(
      jsonSteps(['Open the app', 'Tap Profile', 'Tap Top-Up', 'Select card', 'Enter PIN', 'Confirm']),
    );

    const { steps, degraded } = await convertImportedStepsWithAI('Top-Up', fiveSteps);

    expect(degraded).toBe(false);
    expect(steps).toHaveLength(6);
    expect(mockGetChatCompletion).toHaveBeenCalledTimes(1);
  });
});

describe('step conservation — prompt is platform-aware', () => {
  const step = [{ type: 'step', description: 'Tap Login' }];

  it('frames the system prompt for mobile when platform is mobile', async () => {
    mockGetChatCompletion.mockResolvedValue(jsonSteps(['Tap Login']));

    await convertImportedStepsWithAI('t', step, 'mobile_android');

    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === 'system')!.content;
    expect(system).toMatch(/mobile application/i);
    expect(system).not.toMatch(/web application testing platform/i);
  });

  it('frames the system prompt for web by default', async () => {
    mockGetChatCompletion.mockResolvedValue(jsonSteps(['Tap Login']));

    await convertImportedStepsWithAI('t', step);

    const messages = mockGetChatCompletion.mock.calls[0][0] as Array<{ role: string; content: string }>;
    const system = messages.find((m) => m.role === 'system')!.content;
    expect(system).toMatch(/web application/i);
  });
});

describe('finalizeTypedSteps — deterministic PDF finalizer (no second LLM pass)', () => {
  it('preserves every step and appends one assert per expected result, in order', () => {
    const steps = finalizeTypedSteps([
      { type: 'navigate', description: 'Open Top-Up page' },
      { type: 'click', description: 'Select payment method', expected: ['Only KZ methods shown', 'Card is default'] },
      { type: 'click', description: 'Confirm' },
    ]);

    expect(steps.map((s) => ({ type: s.type, d: s.description }))).toEqual([
      { type: 'navigate', d: 'Open Top-Up page' },
      { type: 'click', d: 'Select payment method' },
      { type: 'assert', d: 'Only KZ methods shown' },
      { type: 'assert', d: 'Card is default' },
      { type: 'click', d: 'Confirm' },
    ]);
  });

  it('coerces an unknown action type to click and drops empty-description steps', () => {
    const steps = finalizeTypedSteps([
      { type: 'frobnicate', description: 'Do the thing' },
      { type: 'click', description: '   ' },
      { type: 'type', description: 'Enter code', value: '1234' },
    ]);

    expect(steps).toHaveLength(2);
    expect(steps[0].type).toBe('click');
    expect(steps[1].type).toBe('type');
    expect(steps[1].value).toBe('1234');
  });
});
