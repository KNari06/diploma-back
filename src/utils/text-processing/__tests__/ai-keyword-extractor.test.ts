import {
  extractKeywordsSync,
  extractKeywordsWithAI,
  clearKeywordCache,
} from '../ai-keyword-extractor';
import { generateText } from '@/services/ai/core/ai-provider.service';

jest.mock('@/services/ai/core/ai-provider.service', () => ({
  generateText: jest.fn(),
}));

const mockGenerateText = generateText as jest.MockedFunction<typeof generateText>;

const aiResponse = (content: string) => ({
  content,
  usage: { provider: 'test', model: 'test-model', totalTokens: 1 },
});

describe('extractKeywordsSync', () => {
  it('returns an empty array for empty or whitespace input', () => {
    expect(extractKeywordsSync('')).toEqual([]);
    expect(extractKeywordsSync('   ')).toEqual([]);
  });

  it('removes generic stop words but keeps the real target token', () => {
    const result = extractKeywordsSync('click the login button');
    expect(result).toContain('login');
    expect(result).not.toContain('click');
    expect(result).not.toContain('button');
    expect(result).not.toContain('the');
  });

  it('drops words of 2 characters or fewer', () => {
    const result = extractKeywordsSync('go to ok page');
    expect(result).not.toContain('go');
    expect(result).not.toContain('ok');
    expect(result).toContain('page');
  });

  it('lowercases and strips punctuation', () => {
    const result = extractKeywordsSync('Checkout, NOW!');
    expect(result).toContain('checkout');
    expect(result).toContain('now');
  });

  it('removes a Russian stop word while keeping the target', () => {
    const result = extractKeywordsSync('нажми войти');
    expect(result).not.toContain('нажми');
    expect(result).toContain('войти');
  });
});

describe('extractKeywordsWithAI', () => {
  beforeEach(() => {
    clearKeywordCache();
    mockGenerateText.mockReset();
  });

  it('returns an empty array without calling the AI for empty input', async () => {
    expect(await extractKeywordsWithAI('   ')).toEqual([]);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it('parses comma-separated keywords, lowercased and trimmed', async () => {
    mockGenerateText.mockResolvedValue(aiResponse('Login, Checkout ,  Payment') as any);
    expect(await extractKeywordsWithAI('test the login and checkout payment')).toEqual([
      'login',
      'checkout',
      'payment',
    ]);
  });

  it('filters out empty and overly long tokens', async () => {
    const longToken = 'x'.repeat(60);
    mockGenerateText.mockResolvedValue(aiResponse(`good, , ${longToken}`) as any);
    expect(await extractKeywordsWithAI('something')).toEqual(['good']);
  });

  it('caches the result so a repeated description does not call the AI again', async () => {
    mockGenerateText.mockResolvedValue(aiResponse('login') as any);
    await extractKeywordsWithAI('open the login screen');
    await extractKeywordsWithAI('open the login screen');
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it('falls back to regex extraction when the AI call fails', async () => {
    mockGenerateText.mockRejectedValue(new Error('AI down'));
    const result = await extractKeywordsWithAI('navigate dashboard quickly');
    expect(result).toEqual(['navigate', 'dashboard', 'quickly']);
  });
});
