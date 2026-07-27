import { RetrievalPlannerService } from '../retrieval-planner.service';

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';

describe('RetrievalPlannerService.sanitize', () => {
  it('parses a valid plan and clamps/dedupes/trims', () => {
    const p = RetrievalPlannerService.sanitize(JSON.stringify({
      searchTerms: ['checkout flow', ' checkout flow ', 'Stripe', ''],
      entities: ['checkout page'],
      hypotheses: ['invalid card rejected'],
    }));
    expect(p.searchTerms).toEqual(['checkout flow', 'Stripe']); // dedup (case/space) + drop empty
    expect(p.entities).toEqual(['checkout page']);
    expect(p.hypotheses).toEqual(['invalid card rejected']);
  });

  it('returns an empty plan on garbage / non-array fields', () => {
    expect(RetrievalPlannerService.sanitize('not json')).toEqual({ searchTerms: [], entities: [], hypotheses: [] });
    expect(RetrievalPlannerService.sanitize(JSON.stringify({ searchTerms: 'nope' }))).toEqual({ searchTerms: [], entities: [], hypotheses: [] });
    expect(RetrievalPlannerService.sanitize(undefined)).toEqual({ searchTerms: [], entities: [], hypotheses: [] });
  });

  it('caps term counts', () => {
    const many = Array.from({ length: 30 }, (_, i) => `term ${i}`);
    expect(RetrievalPlannerService.sanitize(JSON.stringify({ searchTerms: many })).searchTerms).toHaveLength(8);
  });

  it('drops absurdly long tokens', () => {
    const p = RetrievalPlannerService.sanitize(JSON.stringify({ searchTerms: ['ok', 'x'.repeat(200)] }));
    expect(p.searchTerms).toEqual(['ok']);
  });
});

describe('RetrievalPlannerService.enrichQuery', () => {
  it('returns the raw query unchanged when the plan is empty', () => {
    expect(RetrievalPlannerService.enrichQuery('Login broken', { searchTerms: [], entities: [], hypotheses: [] }))
      .toBe('Login broken');
  });

  it('appends terms + entities, deduped against the raw query', () => {
    const out = RetrievalPlannerService.enrichQuery('checkout broken', {
      searchTerms: ['checkout flow', 'Stripe'], entities: ['checkout broken'], hypotheses: [],
    });
    expect(out).toContain('checkout broken');
    expect(out).toContain('checkout flow');
    expect(out).toContain('Stripe');
    // "checkout broken" appears once (entity dup of raw query dropped)
    expect(out.match(/checkout broken/g)).toHaveLength(1);
  });
});

describe('RetrievalPlannerService.plan', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns the sanitized plan from the LLM', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockResolvedValue({
      content: JSON.stringify({ searchTerms: ['payment form'], entities: [], hypotheses: [] }),
    });
    const p = await RetrievalPlannerService.plan({ summary: 'Payment broken' });
    expect(p.searchTerms).toEqual(['payment form']);
  });

  it('never throws — returns empty plan on LLM failure (caller falls back to raw query)', async () => {
    (getChatCompletionWithMessages as jest.Mock).mockRejectedValue(new Error('LLM down'));
    await expect(RetrievalPlannerService.plan({ summary: 'x' })).resolves
      .toEqual({ searchTerms: [], entities: [], hypotheses: [] });
  });
});
