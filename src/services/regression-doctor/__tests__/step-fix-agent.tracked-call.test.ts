/**
 * The analysis must bill through the tracked wrapper, not the raw OpenAI client.
 *
 * `getSharedOpenAIClient()` returns the SDK object; only
 * `getChatCompletionWithMessages` reads `response.usage` and hands it to
 * `AIUsageTracker`. The agent originally used the raw client, so every vision
 * call — the whole reason this feature sits behind a manual button — was billed
 * by the provider and recorded in no ledger. `ai_usage_log` had zero Doctor rows
 * for the feature's entire life, and nothing failed to make that visible.
 *
 * A refactor reaching for the raw client again would be silent in exactly the
 * same way, so it is pinned here.
 */

const getChatCompletionWithMessages = jest.fn();
const getSharedOpenAIClient = jest.fn(() => {
  throw new Error('the agent must not use the raw client — it bypasses cost tracking');
});

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...a: unknown[]) => getChatCompletionWithMessages(...a),
  getSharedOpenAIClient: () => getSharedOpenAIClient(),
}));

jest.mock('../screenshot-inline', () => ({ collectScreenshots: jest.fn(async () => []) }));

jest.mock('@/services/kb/kb.service', () => ({
  searchKB: jest.fn(),
  expandChunkForLLM: jest.fn(() => ''),
}));

jest.mock('@/utils/core/logger', () => ({
  logger: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { analyzeFailedStep } from '../step-fix-agent';
import type { FailedStepEvidence } from '../types';

const evidence = {
  testId: 't1',
  testCaseId: 'tc1',
  testCaseName: 'TC-03 Wallet',
  platform: 'mobile_flutter',
  projectId: 'p1',
  step: { id: 's2', type: 'click', description: 'wallet' },
  stepId: 's2',
  stepIndex: 1,
  precedingSteps: [],
  followingStep: null,
  action: 'click',
  failedReason: 'element_not_found',
  failureExplanation: 'no element matched',
  failScreenshotUrl: undefined,
  priorScreenshotUrl: undefined,
  currentApp: undefined,
  aiClassification: null,
  aiSummary: null,
} as unknown as FailedStepEvidence;

describe('the step-fix agent bills through the tracked wrapper', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getChatCompletionWithMessages.mockResolvedValue({
      content: JSON.stringify({
        verdict: 'app_bug',
        diagnosis: 'the screen never loaded',
        confidence: 0.9,
        patch: null,
      }),
      usage: { inputTokens: 100, outputTokens: 20, totalTokens: 120, model: 'gpt-5.4-mini' },
    });
  });

  it('calls the tracked helper and never the raw client', async () => {
    const verdict = await analyzeFailedStep({ evidence, kbChunks: [] });

    expect(verdict.verdict).toBe('app_bug');
    expect(getChatCompletionWithMessages).toHaveBeenCalledTimes(1);
    expect(getSharedOpenAIClient).not.toHaveBeenCalled();
  });

  it('sends the system prompt and asks for strict JSON', async () => {
    await analyzeFailedStep({ evidence, kbChunks: [] });

    const [messages, options] = getChatCompletionWithMessages.mock.calls[0];
    expect(messages[0]).toMatchObject({ role: 'system' });
    expect(messages[1]).toMatchObject({ role: 'user' });
    expect(options).toMatchObject({ response_format: { type: 'json_object' } });
    expect(options.model).toBeTruthy();
  });
});
