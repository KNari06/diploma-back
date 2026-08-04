/**
 * Product Analyst (Phase 0) orchestration.
 *
 * The contract under test is mostly about what happens when things go WRONG:
 * Phase 0 is an enhancement, so every failure must return `undefined` with a
 * NAMED reason and let exploration proceed exactly as it does today. A silent
 * skip would be its own bug — that is how the audit's "silent degradation" class
 * (Cartographer/Scout swallowing failures) came about in the first place.
 */

jest.mock('@/services/ai/core/openai.service', () => ({
  getChatCompletionWithMessages: jest.fn(),
}));
// The reuse gate reads/writes the stored brief. Unmocked, every test in this
// file waits on a real network round trip to Supabase — the suite still passes
// (the gate is best-effort and swallows failures) but takes minutes. Mocked as
// "nothing stored", which is the correct baseline for these tests: they assert
// what Phase 0 DERIVES, not what it reuses.
jest.mock('@/services/testing/exploration/db/product-brief.db', () => ({
  fetchProductBrief: jest.fn().mockResolvedValue(null),
  upsertProductBrief: jest.fn().mockResolvedValue(undefined),
  recordProductBriefReuse: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../evidence-collector', () => ({
  collectProductEvidence: jest.fn(),
  MAX_EVIDENCE_CHARS: 40_000,
}));

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { collectProductEvidence } from '../evidence-collector';
import { runProductAnalyst } from '../product-analyst';
import type { ExplorationConfig } from '../../types';
import type { ProductEvidence } from '../evidence-collector';

const mockedAi = getChatCompletionWithMessages as jest.MockedFunction<any>;
const mockedEvidence = collectProductEvidence as jest.MockedFunction<any>;

const config = (over: Partial<ExplorationConfig> = {}): ExplorationConfig =>
  ({
    entryUrl: 'https://acme.com/',
    explorationId: 'expl-1',
    projectId: 'p1',
    budget: {} as ExplorationConfig['budget'],
    preset: 'full',
    ...over,
  }) as ExplorationConfig;

const evidence = (over: Partial<ProductEvidence> = {}): ProductEvidence => ({
  originUrl: 'https://acme.com/',
  sources: ['/', '/robots.txt'],
  documents: [{ path: '/', ok: true, status: 200, body: '<h1>Acme</h1>' }],
  disallowedPaths: [],
  robotsDisallowsAll: false,
  pathSegments: [{ segment: 'products', count: 40 }],
  sitemapUrlCount: 40,
  thirdPartyHosts: [],
  localeHints: ['en'],
  durationMs: 500,
  budgetExhausted: false,
  ...over,
});

/** A minimal response the normalizer will accept as carrying signal. */
const goodResponse = JSON.stringify({
  purpose: { value: 'An online shop', source: 'observed', confidence: 'high', basis: 'og:description' },
  productType: { value: 'ecommerce', source: 'observed', confidence: 'high', basis: 'JSON-LD Product' },
  criticalFlows: {
    value: [{ name: 'Guest checkout', successSignal: 'order number appears', rank: 1, source: 'inferred' }],
    source: 'inferred',
    confidence: 'medium',
    basis: 'CTA chain',
  },
  overallConfidence: 'medium',
  openQuestions: ['environmentKind'],
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedEvidence.mockResolvedValue(evidence());
  mockedAi.mockResolvedValue({ content: goodResponse });
});

describe('happy path', () => {
  it('builds a brief from the evidence', async () => {
    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBeUndefined();
    expect(result.brief).toBeDefined();
    expect(result.brief!.productType.value).toBe('ecommerce');
    expect(result.brief!.criticalFlows.value).toHaveLength(1);
  });

  it('stamps the evidence sources onto the brief, not whatever the LLM claimed', async () => {
    mockedAi.mockResolvedValue({
      content: JSON.stringify({
        ...JSON.parse(goodResponse),
        evidenceSources: ['/i-made-this-up'],
      }),
    });

    const result = await runProductAnalyst(config());

    expect(result.brief!.evidenceSources).toEqual(['/', '/robots.txt']);
  });

  it('stamps the configured origin, never one from the response', async () => {
    mockedAi.mockResolvedValue({
      content: JSON.stringify({ ...JSON.parse(goodResponse), originUrl: 'https://evil.example.com/' }),
    });

    const result = await runProductAnalyst(config());

    expect(result.brief!.originUrl).toBe('https://acme.com/');
  });

  it('passes the scope hint through to the prompt', async () => {
    await runProductAnalyst(config({ scopeHint: 'checkout' }));

    const userMessage = mockedAi.mock.calls[0][0][1].content as string;
    expect(userMessage).toContain('checkout');
  });

  it('reports duration so a caller can see what Phase 0 cost', async () => {
    const result = await runProductAnalyst(config());
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('preset gate', () => {
  it('skips on the quick preset BEFORE spending anything', async () => {
    const result = await runProductAnalyst(config({ preset: 'quick' }));

    expect(result.skipReason).toBe('quick_preset');
    expect(result.brief).toBeUndefined();
    // The cheapest possible exit: no fetches, no LLM call.
    expect(mockedEvidence).not.toHaveBeenCalled();
    expect(mockedAi).not.toHaveBeenCalled();
  });

  it('RUNS when the preset is absent — chat producers pass no budget and get full', async () => {
    const result = await runProductAnalyst(config({ preset: undefined }));

    expect(result.skipReason).toBeUndefined();
    expect(result.brief).toBeDefined();
  });

  it('runs on the full preset', async () => {
    const result = await runProductAnalyst(config({ preset: 'full' }));
    expect(result.brief).toBeDefined();
  });
});

describe('never fails the run — each failure is NAMED, not silent', () => {
  it('skips with no_evidence when nothing could be fetched', async () => {
    mockedEvidence.mockResolvedValue(evidence({ sources: [], documents: [] }));

    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBe('no_evidence');
    // No point paying for an LLM call that would invent from an empty page.
    expect(mockedAi).not.toHaveBeenCalled();
  });

  it('skips with ai_failed when the LLM call rejects', async () => {
    mockedAi.mockRejectedValue(new Error('502 upstream'));

    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBe('ai_failed');
    expect(result.brief).toBeUndefined();
  });

  it('skips with unparseable on non-JSON output', async () => {
    mockedAi.mockResolvedValue({ content: 'Sure! Here is your brief: (not json)' });

    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBe('unparseable');
  });

  it('skips with unparseable when the model returns an array', async () => {
    mockedAi.mockResolvedValue({ content: '[{"purpose":"x"}]' });

    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBe('unparseable');
  });

  it('skips with no_signal on an all-unknown brief', async () => {
    // Valid JSON, valid shape, zero information — threading it into four prompts
    // would cost tokens for nothing.
    mockedAi.mockResolvedValue({ content: '{"overallConfidence":"low"}' });

    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBe('no_signal');
  });

  it('survives the evidence collector throwing', async () => {
    mockedEvidence.mockRejectedValue(new Error('socket exploded'));

    const result = await runProductAnalyst(config());

    expect(result.skipReason).toBe('ai_failed');
    expect(result.brief).toBeUndefined();
  });

  it('strips code fences the model wrapped the JSON in', async () => {
    mockedAi.mockResolvedValue({ content: '```json\n' + goodResponse + '\n```' });

    const result = await runProductAnalyst(config());

    expect(result.brief).toBeDefined();
  });
});

describe('safety carried from the normalizer', () => {
  it('refuses an allowed_sandbox payment grant the model gave itself', async () => {
    mockedAi.mockResolvedValue({
      content: JSON.stringify({
        ...JSON.parse(goodResponse),
        paymentPolicy: { value: 'allowed_sandbox', source: 'inferred', confidence: 'high', basis: 'looks like staging' },
      }),
    });

    const result = await runProductAnalyst(config());

    // Only a HUMAN can authorise completing a real payment. The prompt forbids
    // this, but a prompt is not a guard — an LLM that decided a hostname "looked
    // like staging" would otherwise place real orders.
    expect(result.brief!.paymentPolicy.value).toBe('stop_before_commit');
  });

  it('forces stopBeforeCommit on inferred critical flows', async () => {
    const result = await runProductAnalyst(config());
    expect(result.brief!.criticalFlows.value[0].stopBeforeCommit).toBe(true);
  });

  it('redacts credentials the analyst echoed back', async () => {
    mockedAi.mockResolvedValue({
      content: JSON.stringify({
        ...JSON.parse(goodResponse),
        dataHints: { value: 'login with s3cret-pw', source: 'observed', confidence: 'high', basis: '/docs' },
      }),
    });

    const result = await runProductAnalyst(
      config({ credentials: { password: 's3cret-pw' } } as Partial<ExplorationConfig>),
    );

    expect(JSON.stringify(result.brief)).not.toContain('s3cret-pw');
  });
});
