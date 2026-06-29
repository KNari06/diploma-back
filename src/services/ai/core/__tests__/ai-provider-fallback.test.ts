/**
 * Cross-provider fall-over: when the configured provider is Gemini and it
 * fails with a transient/timeout error, the AI provider must hop to OpenAI
 * (when configured) instead of failing the task — mirrors the runner's
 * `callLlmWithFallback`. Permanent errors still throw; with no OpenAI key it
 * rethrows. (2026-06-29: backend had NO fall-over — a Gemini timeout just
 * failed the task.)
 */

jest.mock('@/config/environment/env', () => ({
  env: { AI_PROVIDER_FAST: 'gemini', AI_PROVIDER_SMART: 'gemini', GEMINI_API_KEY: 'g', OPENAI_API_KEY: 'o' },
}));
jest.mock('@/config/ai/ai-models.config', () => ({ AI_MODELS: { fast: 'gpt-fast', smart: 'gpt-smart' } }));
jest.mock('@/utils/core/logger', () => ({ logger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() } }));

const generateTextWithGemini = jest.fn();
const getChatCompletionWithGemini = jest.fn();
const getChatCompletionWithMessages = jest.fn();

jest.mock('@/services/ai/core/gemini.service', () => ({
  generateTextWithGemini: (...a: unknown[]) => generateTextWithGemini(...a),
  getChatCompletionWithGemini: (...a: unknown[]) => getChatCompletionWithGemini(...a),
  // Real-ish predicate: transient on 503/timeout, permanent otherwise.
  _retryInternals: {
    isTransientGeminiError: (err: unknown) => {
      const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
      return m.includes('503') || m.includes('timeout') || m.includes('overloaded');
    },
  },
}));
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: (...a: unknown[]) => getChatCompletionWithMessages(...a),
}));

import { generateText, generateChatCompletion } from '@/services/ai/core/ai-provider.service';

const OPENAI_OK = { content: 'from-openai', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'gpt-fast' } };

describe('ai-provider Gemini → OpenAI fall-over', () => {
  beforeEach(() => jest.clearAllMocks());

  it('generateText falls over to OpenAI on a Gemini timeout', async () => {
    generateTextWithGemini.mockRejectedValue(new Error('Gemini request timeout'));
    getChatCompletionWithMessages.mockResolvedValue(OPENAI_OK);

    const r = await generateText({ prompt: 'hi', task: 'fast' });

    expect(generateTextWithGemini).toHaveBeenCalledTimes(1);
    expect(getChatCompletionWithMessages).toHaveBeenCalledTimes(1);
    expect(r.usage.provider).toBe('openai');
    expect(r.content).toBe('from-openai');
  });

  it('generateChatCompletion falls over to OpenAI on a transient 503', async () => {
    getChatCompletionWithGemini.mockRejectedValue(new Error('503 high demand'));
    getChatCompletionWithMessages.mockResolvedValue(OPENAI_OK);

    const r = await generateChatCompletion({ messages: [{ role: 'user', content: 'q' }], task: 'fast' });

    expect(r.usage.provider).toBe('openai');
    expect(getChatCompletionWithMessages).toHaveBeenCalledTimes(1);
  });

  it('does NOT fall over on a permanent Gemini error — rethrows', async () => {
    generateTextWithGemini.mockRejectedValue(new Error('400 Bad Request'));

    await expect(generateText({ prompt: 'hi', task: 'fast' })).rejects.toThrow('400');
    expect(getChatCompletionWithMessages).not.toHaveBeenCalled();
  });
});
