import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { evaluateAiCheck } from '../ai-check.service';

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));

describe('AiCheckService / evaluateAiCheck', () => {
  it('returns highlightRefs when model provides them', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockResolvedValue({
      content: JSON.stringify({
        pass: true,
        explanation: 'Submit button is present and enabled.',
        confidence: 0.9,
        highlightRefs: ['btn_submit'],
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'gpt-4o-mini' },
    });

    const result = await evaluateAiCheck({
      assertionText: 'Submit button exists',
      url: 'https://example.com',
      html: '<button data-agent-ref="btn_submit">Submit</button>',
    });

    expect(result.pass).toBe(true);
    expect(result.highlightRefs).toEqual(['btn_submit']);
    expect(result.artifactsUsed.html).toBe(true);
    expect(result.artifactsUsed.screenshot).toBe(false);

    const [messages] = (getChatCompletionWithMessages as jest.Mock).mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(String(messages[0].content)).toContain('highlightRefs');
  });

  it('defaults highlightRefs to [] when missing', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockResolvedValue({
      content: JSON.stringify({
        pass: false,
        explanation: 'No submit button found.',
        confidence: 0.8,
      }),
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'gpt-4o-mini' },
    });

    const result = await evaluateAiCheck({
      assertionText: 'Submit button exists',
      url: 'https://example.com',
      html: '<div>No buttons here</div>',
    });

    expect(result.highlightRefs).toEqual([]);
  });

  it('returns failure result (with highlightRefs:[]) on invalid JSON', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockResolvedValue({
      content: '{not-json',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'gpt-4o-mini' },
    });

    const result = await evaluateAiCheck({
      assertionText: 'Anything',
      url: 'https://example.com',
      html: '<div />',
    });

    expect(result.pass).toBe(false);
    expect(result.highlightRefs).toEqual([]);
    expect(result.explanation).toContain('AI check evaluation failed:');
  });

  // ═══════════════════════════════════════════════════════════════════════
  // Console channel — the AI fallback for FUZZY console assertions.
  // The distinction that matters: [] means "we looked, found none" while
  // undefined means "we never looked". Collapsing them would let the model
  // pass "there are no console errors" on missing data.
  // ═══════════════════════════════════════════════════════════════════════
  describe('console error channel', () => {
    const mockPass = () =>
      (getChatCompletionWithMessages as jest.Mock).mockResolvedValue({
        content: JSON.stringify({ pass: true, explanation: 'ok', confidence: 0.9 }),
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, model: 'gpt-4o-mini' },
      });

    const userPromptFrom = (mock: jest.Mock): string => {
      const [messages] = mock.mock.calls[0];
      const user = messages.find((m: any) => m.role === 'user');
      return typeof user.content === 'string'
        ? user.content
        : user.content.find((c: any) => c.type === 'text').text;
    };

    it('lists collected console errors in the prompt', async () => {
      mockPass();

      await evaluateAiCheck({
        assertionText: 'No payment errors',
        url: 'https://example.com',
        consoleErrors: ['[console.error] Payment gateway timeout', '[uncaught] TypeError: x'],
      });

      const prompt = userPromptFrom(getChatCompletionWithMessages as jest.Mock);
      expect(prompt).toContain('CONSOLE ERRORS');
      expect(prompt).toContain('Payment gateway timeout');
      expect(prompt).toContain('TypeError: x');
    });

    it('states an empty console list as a CONFIRMED absence', async () => {
      mockPass();

      const result = await evaluateAiCheck({
        assertionText: 'There are no console errors',
        url: 'https://example.com',
        consoleErrors: [],
      });

      const prompt = userPromptFrom(getChatCompletionWithMessages as jest.Mock);
      expect(prompt).toContain('None observed');
      // The model must be able to distinguish this from missing data.
      expect(prompt).toMatch(/confirmed absence/i);
      expect(result.artifactsUsed.console).toBe(true);
    });

    it('omits the console section entirely when the channel was not collected', async () => {
      mockPass();

      const result = await evaluateAiCheck({
        assertionText: 'Page loaded',
        url: 'https://example.com',
        html: '<div />',
      });

      const prompt = userPromptFrom(getChatCompletionWithMessages as jest.Mock);
      expect(prompt).not.toContain('CONSOLE ERRORS');
      expect(result.artifactsUsed.console).toBe(false);
    });

    it('instructs the model never to infer console state from HTML or screenshot', async () => {
      mockPass();

      await evaluateAiCheck({
        assertionText: 'No console errors',
        url: 'https://example.com',
        consoleErrors: [],
      });

      const [messages] = (getChatCompletionWithMessages as jest.Mock).mock.calls[0];
      const system = String(messages[0].content);
      expect(system).toMatch(/NEVER infer console errors from HTML/i);
    });

    it('masks secrets that appear in console error text', async () => {
      mockPass();

      await evaluateAiCheck({
        assertionText: 'No auth errors',
        url: 'https://example.com',
        consoleErrors: ['Login failed for hunter2secret'],
        secretValues: ['hunter2secret'],
      });

      const prompt = userPromptFrom(getChatCompletionWithMessages as jest.Mock);
      expect(prompt).not.toContain('hunter2secret');
    });
  });
});

