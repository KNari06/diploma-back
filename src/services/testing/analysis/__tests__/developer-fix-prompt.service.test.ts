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

  describe('scrubbing the black-box evidence', () => {
    // The prompt is persisted to ai_summary.fixPrompt and published onward —
    // to the editor copy-card, to a feedback comment, and (since syncOnCreate)
    // to every auto-filed Jira issue, in projects whose members never opted
    // into the Jira-source flow. The evidence is the app-under-test's own
    // console and network traffic, so whatever it puts in a URL travels.

    it('masks a token in a failing request URL, keeping method, host, path and status', async () => {
      const md = await DeveloperFixPromptService.generate({
        testResult: {
          network_logs: [{
            method: 'get',
            url: 'https://api.example.com/v1/orders?access_token=eyJhbGciOiJIUzI1NiJ9.abc&page=2',
            status: 401,
          }],
        },
        aiSummary: summary([bug()]),
      });
      expect(md).not.toContain('eyJhbGciOiJIUzI1NiJ9.abc');
      expect(md).toContain('GET https://api.example.com/v1/orders');
      expect(md).toContain('page=2');   // benign params survive — still debuggable
      expect(md).toContain('→ 401');
    });

    it('masks URL userinfo, which survives in a log line even though browsers hide it', async () => {
      const md = await DeveloperFixPromptService.generate({
        testResult: { network_logs: [{ method: 'get', url: 'https://svc:pa55w0rd@api.example.com/health', status: 503 }] },
        aiSummary: summary([bug()]),
      });
      expect(md).not.toContain('pa55w0rd');
      expect(md).toContain('api.example.com/health');
    });

    it('leaves an ordinary numeric path segment alone — the repro pointer stays readable', async () => {
      const md = await DeveloperFixPromptService.generate({
        testResult: { network_logs: [{ method: 'get', url: 'https://api.example.com/v1/orders/12345', status: 404 }] },
        aiSummary: summary([bug()]),
      });
      expect(md).toContain('/v1/orders/12345');
    });

    it('masks a bearer token and an email echoed into a console line', async () => {
      const md = await DeveloperFixPromptService.generate({
        testResult: { errors: ['auth failed for buyer@acme.test, Authorization: Bearer sk-live-9f3ab21c77'] },
        aiSummary: summary([bug()]),
      });
      expect(md).not.toContain('sk-live-9f3ab21c77');
      expect(md).not.toContain('buyer@acme.test');
      expect(md).toContain('auth failed');   // the diagnostic sentence survives
    });

    it('masks a token in the page URL as well as in the request log', async () => {
      const md = await DeveloperFixPromptService.generate({
        testResult: {},
        aiSummary: summary([bug()]),
        pageUrl: 'https://app.example.com/callback?id_token=zzz999secret&next=/cart',
      });
      expect(md).not.toContain('zzz999secret');
      expect(md).toContain('https://app.example.com/callback');
    });
  });

  it('never throws when the LLM fails — returns null', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockRejectedValueOnce(new Error('LLM down'));
    const md = await DeveloperFixPromptService.generate({ testResult: {}, aiSummary: summary([bug()]) });
    expect(md).toBeNull();
  });
});
