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
});

