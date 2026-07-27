import { DeveloperFixPromptService } from '../developer-fix-prompt.service';
import type { AISummary, BugReport } from '@/types';

// Mock the LLM boundary — return the assembled user prompt so we can assert inputs.
jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(async (messages: any[]) => ({
    content: `FIXPROMPT<<${messages[1].content}>>`,
  })),
}));

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';

const bug = (over: Partial<BugReport> = {}): BugReport => ({
  id: 'b1', title: 'Checkout 500', description: 'server error on submit',
  severity: 'high', category: 'functional',
  steps: ['open /checkout', 'submit'], expectedResult: 'order placed', actualResult: '500 error',
  domSelector: '#submit', ...over,
});

const summary = (bugs: BugReport[]): AISummary => ({
  summary: 's', bugs, recommendations: [], severity: 'high', confidence: 80, generatedAt: new Date(),
  rootCauseStep: 2, failureClassification: 'real_bug' as any,
});

describe('DeveloperFixPromptService.generate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns null when there are no bugs', async () => {
    const md = await DeveloperFixPromptService.generate({ testResult: {}, aiSummary: summary([]) });
    expect(md).toBeNull();
    expect(getChatCompletionWithMessages).not.toHaveBeenCalled();
  });

  it('generates markdown from the primary (highest-severity) bug', async () => {
    const md = await DeveloperFixPromptService.generate({
      testResult: { url: 'https://app.example.com/checkout' },
      aiSummary: summary([bug({ severity: 'low', title: 'minor' }), bug({ severity: 'critical', title: 'Critical crash' })]),
    });
    expect(md).toContain('FIXPROMPT');
    // primary bug is the critical one
    expect(md).toContain('Critical crash');
  });

  it('includes black-box evidence (selector, console, network) but not raw source', async () => {
    const md = await DeveloperFixPromptService.generate({
      testResult: {
        url: 'https://app.example.com/checkout',
        errors: ['TypeError: undefined is not a function'],
        network_logs: [{ method: 'post', url: '/api/checkout', status: 500 }, { method: 'get', url: '/ok', status: 200 }],
      },
      aiSummary: summary([bug()]),
    });
    expect(md).toContain('#submit');                    // selector
    expect(md).toContain('TypeError');                  // console
    expect(md).toContain('POST /api/checkout → 500');   // network failure (only non-2xx)
    expect(md).not.toContain('→ 200');                  // 2xx filtered out
  });

  it('never throws when the LLM fails — returns null', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockRejectedValueOnce(new Error('LLM down'));
    const md = await DeveloperFixPromptService.generate({ testResult: {}, aiSummary: summary([bug()]) });
    expect(md).toBeNull();
  });
});
