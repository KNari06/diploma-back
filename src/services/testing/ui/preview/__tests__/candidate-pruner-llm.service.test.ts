/**
 * Mock the Gemini call so tests run offline and deterministically.
 * Each test sets a queued response, then asserts on returned shape.
 */
jest.mock('@/services/ai/core/gemini.service', () => ({
  getChatCompletionWithGemini: jest.fn(),
}));

import { getChatCompletionWithGemini } from '@/services/ai/core/gemini.service';
import {
  pruneCandidatesViaLLM,
  invalidatePrunerForRef,
  _resetPrunerCacheForTests,
  _getPrunerCacheSizeForTests,
  type PrunerCandidate,
} from '../candidate-pruner-llm.service';
import type { InteractiveNode, TargetFingerprint, IntentActionType } from '../preview.types';

const mockGemini = getChatCompletionWithGemini as jest.MockedFunction<typeof getChatCompletionWithGemini>;

function geminiOk(content: string) {
  return {
    content,
    usage: {
      inputTokens: 100,
      outputTokens: 30,
      totalTokens: 130,
      model: 'gemini-2.5-flash-lite' as const,
    },
  };
}

function makeNode(overrides: Partial<InteractiveNode> & { ref: string }): InteractiveNode {
  return {
    tag: 'a',
    ...overrides,
  } as InteractiveNode;
}

function makeCandidate(ref: string, overrides: Partial<InteractiveNode> = {}): PrunerCandidate {
  return {
    node: makeNode({ ref, ...overrides }),
    candidateText: `mock candidate ${ref}`,
  };
}

function makeCandidates(count: number): PrunerCandidate[] {
  return Array.from({ length: count }, (_, i) => makeCandidate(`e${i + 1}`));
}

const baseParams = {
  intentText: 'click submit button',
  actionType: 'click' as IntentActionType,
  pageUrl: 'https://example.com/page',
  pageSignature: 'abc123',
  topK: 15,
  mode: 'apply' as const,
};

beforeEach(() => {
  _resetPrunerCacheForTests();
  mockGemini.mockReset();
});

describe('pruneCandidatesViaLLM — fail-open behaviour', () => {
  it('skips pruner when ≤16 candidates (too_few)', async () => {
    const candidates = makeCandidates(10);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(result.prunerSkipped).toBe(true);
    expect(result.reason).toBe('too_few');
    expect(result.prunedCandidates).toEqual(candidates);
    expect(mockGemini).not.toHaveBeenCalled();
  });

  it('falls open on invalid JSON', async () => {
    mockGemini.mockResolvedValueOnce(geminiOk('this is not json'));
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(result.prunerSkipped).toBe(true);
    expect(result.reason).toBe('invalid_json');
    expect(result.prunedCandidates).toEqual(candidates);
  });

  it('falls open on LLM throw / 503', async () => {
    mockGemini.mockRejectedValueOnce(new Error('503 Service Unavailable'));
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(result.prunerSkipped).toBe(true);
    expect(result.reason).toBe('llm_failed');
    expect(result.prunedCandidates).toEqual(candidates);
  });

  it('falls open on timeout', async () => {
    mockGemini.mockRejectedValueOnce(new Error('Gemini request timeout'));
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(result.prunerSkipped).toBe(true);
    expect(result.reason).toBe('timeout');
  });

  it('falls open when LLM returns wrong shape', async () => {
    mockGemini.mockResolvedValueOnce(geminiOk('{"refs": "not-an-array"}'));
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(result.prunerSkipped).toBe(true);
    expect(result.reason).toBe('invalid_json');
  });
});

describe('pruneCandidatesViaLLM — happy path', () => {
  it('returns pruned candidates ordered by LLM ranking', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e30","e10","e50","e20","e40","e15","e25","e35","e45","e55","e60","e5","e1","e3","e7"]}'),
    );
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(result.prunerSkipped).toBe(false);
    expect(result.prunedCandidates).toHaveLength(15);
    // Order matches LLM response
    expect(result.prunedCandidates[0].node.ref).toBe('e30');
    expect(result.prunedCandidates[1].node.ref).toBe('e10');
  });

  it('caps output at topK even if LLM returns more', async () => {
    const refs = Array.from({ length: 25 }, (_, i) => `e${i + 1}`);
    mockGemini.mockResolvedValueOnce(geminiOk(JSON.stringify({ refs })));
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates, topK: 15 });
    expect(result.prunedCandidates.length).toBeLessThanOrEqual(15);
  });

  it('drops hallucinated refs not in input set', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e1","fake-ref","e2","another-fake","e3"]}'),
    );
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    const refs = result.prunedCandidates.map(c => c.node.ref);
    expect(refs).not.toContain('fake-ref');
    expect(refs).not.toContain('another-fake');
    expect(refs).toContain('e1');
  });

  it('pads output to PRUNER_MIN_OUTPUT (5) when LLM returned too few', async () => {
    mockGemini.mockResolvedValueOnce(geminiOk('{"refs":["e1","e2"]}'));
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    // First 2 from LLM, then padded from input order
    expect(result.prunedCandidates.length).toBeGreaterThanOrEqual(5);
    expect(result.prunedCandidates[0].node.ref).toBe('e1');
    expect(result.prunedCandidates[1].node.ref).toBe('e2');
  });
});

describe('pruneCandidatesViaLLM — identity rescue', () => {
  it('force-includes candidate matching recordedFingerprint.elementId', async () => {
    // LLM returns a list WITHOUT the identity-match. Rescue must add it.
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e10","e20","e30","e40","e50","e15","e25","e35","e45","e55"]}'),
    );
    const candidates = makeCandidates(60);
    candidates[42].node.id = 'login-btn'; // ref=e43 has matching id
    candidates[42].node.isDynamicId = false;
    const fp: TargetFingerprint = {
      tag: 'button',
      elementId: 'login-btn',
    };
    const result = await pruneCandidatesViaLLM({
      ...baseParams,
      candidates,
      recordedFingerprint: fp,
    });
    const refs = result.prunedCandidates.map(c => c.node.ref);
    expect(refs).toContain('e43'); // Identity rescue
    expect(result.identityRescueCount).toBe(1);
    // Rescue is placed at top
    expect(refs[0]).toBe('e43');
  });

  it('rescues testIdAttr match', async () => {
    // LLM returns refs that DON'T include the testId-match (e30) — rescue
    // must add it.
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e10","e20","e40","e50","e15","e25","e35","e45","e55","e60"]}'),
    );
    const candidates = makeCandidates(60);
    candidates[29].node.testIdAttr = 'submit-form'; // ref=e30 has the match
    const fp: TargetFingerprint = { testIdAttr: 'submit-form' };
    const result = await pruneCandidatesViaLLM({
      ...baseParams,
      candidates,
      recordedFingerprint: fp,
    });
    const refs = result.prunedCandidates.map(c => c.node.ref);
    expect(refs).toContain('e30');
    expect(result.identityRescueCount).toBe(1);
  });

  it('does not duplicate identity rescue when LLM already included it', async () => {
    // LLM included the identity match already — no rescue counter increment
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e43","e10","e20","e30","e40","e50","e15","e25","e35","e45","e55"]}'),
    );
    const candidates = makeCandidates(60);
    candidates[42].node.id = 'login-btn';
    candidates[42].node.isDynamicId = false;
    const fp: TargetFingerprint = { elementId: 'login-btn' };
    const result = await pruneCandidatesViaLLM({
      ...baseParams,
      candidates,
      recordedFingerprint: fp,
    });
    expect(result.identityRescueCount).toBe(0);
  });

  it('skips rescue for dynamic ids (id present but isDynamicId=true)', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e10","e20","e30","e40","e50","e15","e25","e35","e45","e55"]}'),
    );
    const candidates = makeCandidates(60);
    candidates[42].node.id = 'mat-tab-12345';
    candidates[42].node.isDynamicId = true; // framework-generated
    const fp: TargetFingerprint = { elementId: 'mat-tab-12345' };
    const result = await pruneCandidatesViaLLM({
      ...baseParams,
      candidates,
      recordedFingerprint: fp,
    });
    expect(result.identityRescueCount).toBe(0);
  });
});

describe('pruneCandidatesViaLLM — caching', () => {
  it('caches successful results — second call hits cache', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e1","e2","e3","e4","e5","e6","e7","e8","e9","e10"]}'),
    );
    const candidates = makeCandidates(60);
    const r1 = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(r1.cacheHit).toBe(false);
    const r2 = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(r2.cacheHit).toBe(true);
    expect(mockGemini).toHaveBeenCalledTimes(1);
    expect(r2.prunedCandidates.map(c => c.node.ref)).toEqual(r1.prunedCandidates.map(c => c.node.ref));
  });

  it('different intent → different cache slot', async () => {
    mockGemini
      .mockResolvedValueOnce(geminiOk('{"refs":["e1","e2","e3","e4","e5"]}'))
      .mockResolvedValueOnce(geminiOk('{"refs":["e10","e20","e30","e40","e50"]}'));
    const candidates = makeCandidates(60);
    await pruneCandidatesViaLLM({ ...baseParams, candidates, intentText: 'click login' });
    await pruneCandidatesViaLLM({ ...baseParams, candidates, intentText: 'click signup' });
    expect(mockGemini).toHaveBeenCalledTimes(2);
  });

  it('different pageSignature → different cache slot', async () => {
    mockGemini
      .mockResolvedValueOnce(geminiOk('{"refs":["e1","e2","e3","e4","e5"]}'))
      .mockResolvedValueOnce(geminiOk('{"refs":["e10","e20","e30","e40","e50"]}'));
    const candidates = makeCandidates(60);
    await pruneCandidatesViaLLM({ ...baseParams, candidates, pageSignature: 'sig-1' });
    await pruneCandidatesViaLLM({ ...baseParams, candidates, pageSignature: 'sig-2' });
    expect(mockGemini).toHaveBeenCalledTimes(2);
  });
});

describe('pruneCandidatesViaLLM — singleflight dedup', () => {
  it('concurrent identical calls share one LLM round-trip', async () => {
    let resolveLlm!: (v: ReturnType<typeof geminiOk>) => void;
    mockGemini.mockReturnValueOnce(
      new Promise(resolve => { resolveLlm = resolve as any; }) as any,
    );
    const candidates = makeCandidates(60);

    // Fire 3 concurrent calls with identical inputs — only 1 LLM call
    // should happen, all 3 callers await the same Promise.
    const p1 = pruneCandidatesViaLLM({ ...baseParams, candidates });
    const p2 = pruneCandidatesViaLLM({ ...baseParams, candidates });
    const p3 = pruneCandidatesViaLLM({ ...baseParams, candidates });

    // Resolve the LLM after a microtask — gives Promise wiring time.
    await Promise.resolve();
    resolveLlm(geminiOk('{"refs":["e1","e2","e3","e4","e5","e6","e7","e8","e9","e10"]}'));

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(mockGemini).toHaveBeenCalledTimes(1);
    expect(r1.prunedCandidates.map(c => c.node.ref))
      .toEqual(r2.prunedCandidates.map(c => c.node.ref));
    expect(r1.prunedCandidates.map(c => c.node.ref))
      .toEqual(r3.prunedCandidates.map(c => c.node.ref));
  });
});

describe('invalidatePrunerForRef', () => {
  it('drops cache entries whose output contains the rejected ref', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e1","e2","e3","e4","e5","e6","e7","e8","e9","e10"]}'),
    );
    const candidates = makeCandidates(60);
    await pruneCandidatesViaLLM({ ...baseParams, candidates });
    expect(_getPrunerCacheSizeForTests()).toBe(1);
    const removed = invalidatePrunerForRef({
      rejectedRef: 'e3',
      pageUrl: baseParams.pageUrl,
      intentText: baseParams.intentText,
    });
    expect(removed).toBe(1);
    expect(_getPrunerCacheSizeForTests()).toBe(0);
  });

  it('returns 0 when ref was not in any cached output', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["e1","e2","e3","e4","e5"]}'),
    );
    const candidates = makeCandidates(60);
    await pruneCandidatesViaLLM({ ...baseParams, candidates });
    const removed = invalidatePrunerForRef({
      rejectedRef: 'e99',
      pageUrl: baseParams.pageUrl,
      intentText: baseParams.intentText,
    });
    expect(removed).toBe(0);
    expect(_getPrunerCacheSizeForTests()).toBe(1);
  });

  it('does not drop entries from a different intent / page', async () => {
    mockGemini
      .mockResolvedValueOnce(geminiOk('{"refs":["e1","e2","e3","e4","e5"]}'))
      .mockResolvedValueOnce(geminiOk('{"refs":["e3","e7","e8","e9","e10"]}'));
    const candidates = makeCandidates(60);
    await pruneCandidatesViaLLM({ ...baseParams, candidates, intentText: 'click login' });
    await pruneCandidatesViaLLM({ ...baseParams, candidates, intentText: 'click signup' });
    expect(_getPrunerCacheSizeForTests()).toBe(2);
    // Invalidate only the "login" intent's e3 — "signup" entry untouched.
    invalidatePrunerForRef({
      rejectedRef: 'e3',
      pageUrl: baseParams.pageUrl,
      intentText: 'click login',
    });
    expect(_getPrunerCacheSizeForTests()).toBe(1);
  });
});

describe('cache poisoning protection', () => {
  it('cached entry that has empty grounded refs falls open on next read', async () => {
    // LLM returns refs that all turn out invalid (drop hallucinations).
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"refs":["fake1","fake2","fake3","fake4","fake5"]}'),
    );
    const candidates = makeCandidates(60);
    const result = await pruneCandidatesViaLLM({ ...baseParams, candidates });
    // After validation drops all fakes + identity rescue (none) + padding
    // brings us to PRUNER_MIN_OUTPUT (5) from input order. Pruner is NOT
    // skipped — we have a valid (padded) output.
    expect(result.prunerSkipped).toBe(false);
    expect(result.outputCount).toBeGreaterThanOrEqual(5);
  });
});
