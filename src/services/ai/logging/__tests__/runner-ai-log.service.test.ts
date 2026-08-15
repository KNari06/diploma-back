/**
 * The mobile runner reported $0 of AI spend for its entire existence:
 * `forwardAILog` accepts `costUSD` but no call site passes it, so every
 * runner-originated row landed with `cost_usd = null`. Mobile is the platform
 * carrying the 4x credit multiplier, so "mobile costs nothing" was the single
 * most misleading number in the cost model. These tests pin the server-side
 * derivation that replaces it.
 */

import {
  deriveRunnerCallCost,
  normaliseRunnerEvent,
  sanitizeTokenCount,
} from '../runner-ai-log.service';
import { AI_PRICING } from '../../cost/ai-cost-manager.service';

describe('sanitizeTokenCount', () => {
  it('accepts a plain positive count', () => {
    expect(sanitizeTokenCount(1234)).toBe(1234);
  });

  it('rejects negatives, non-numbers and non-finite values', () => {
    expect(sanitizeTokenCount(-1)).toBeNull();
    expect(sanitizeTokenCount('900')).toBeNull();
    expect(sanitizeTokenCount(NaN)).toBeNull();
    expect(sanitizeTokenCount(Infinity)).toBeNull();
    expect(sanitizeTokenCount(undefined)).toBeNull();
  });

  it('floors fractional counts', () => {
    expect(sanitizeTokenCount(10.9)).toBe(10);
  });

  it('clamps an absurd count so one bad payload cannot skew the ledger', () => {
    expect(sanitizeTokenCount(9e12)).toBe(5_000_000);
  });
});

describe('deriveRunnerCallCost', () => {
  it('prices an OpenAI call from the shared AI_PRICING table', () => {
    const cost = deriveRunnerCallCost({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(cost).toBeCloseTo(
      AI_PRICING['gpt-4.1-mini'].input * 1_000_000 + AI_PRICING['gpt-4.1-mini'].output * 1_000_000,
    );
  });

  it('prices a Gemini call at the Gemini rate, not the OpenAI one', () => {
    const gemini = deriveRunnerCallCost({
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(gemini).toBeCloseTo(0.3 + 2.5);
  });

  it('falls back to the model name when the provider is missing', () => {
    const cost = deriveRunnerCallCost({
      provider: undefined,
      model: 'gemini-2.5-flash',
      tokensIn: 1_000_000,
      tokensOut: 1_000_000,
    });
    expect(cost).toBeCloseTo(0.3 + 2.5);
  });

  it('returns null — NOT zero — when token counts are absent', () => {
    // Zero would make an unmeasured call indistinguishable from a free one,
    // which is exactly how mobile came to look costless.
    expect(
      deriveRunnerCallCost({ provider: 'openai', model: 'gpt-4.1-mini', tokensIn: null, tokensOut: null }),
    ).toBeNull();
  });

  it('returns null when the model is unknown to us', () => {
    expect(
      deriveRunnerCallCost({ provider: 'openai', model: '', tokensIn: 100, tokensOut: 10 }),
    ).toBeNull();
  });

  it('prices a call that reported only input tokens', () => {
    const cost = deriveRunnerCallCost({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tokensIn: 1_000_000,
      tokensOut: null,
    });
    expect(cost).toBeCloseTo(AI_PRICING['gpt-4.1-mini'].input * 1_000_000);
  });
});

describe('normaliseRunnerEvent', () => {
  it('derives cost even though the runner sent none', () => {
    const out = normaliseRunnerEvent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tokens_in: 1_000_000,
      tokens_out: 0,
    });
    expect(out.cost_usd).toBeCloseTo(AI_PRICING['gpt-4.1-mini'].input * 1_000_000);
  });

  it('ignores a client-supplied cost entirely', () => {
    const out = normaliseRunnerEvent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tokens_in: 1000,
      tokens_out: 100,
      cost_usd: 999_999,
    });
    expect(out.cost_usd).toBeLessThan(1);
  });

  it('does not let a hostile payload write a negative cost', () => {
    const out = normaliseRunnerEvent({
      provider: 'openai',
      model: 'gpt-4.1-mini',
      tokens_in: -5_000,
      tokens_out: -5_000,
      cost_usd: -1000,
    });
    expect(out.tokens_in).toBeNull();
    expect(out.tokens_out).toBeNull();
    expect(out.cost_usd).toBeNull();
  });

  it('drops an unrecognised provider rather than storing it', () => {
    const out = normaliseRunnerEvent({ provider: 'anthropic', model: 'x', tokens_in: 1 });
    expect(out.provider).toBeNull();
  });

  it('keeps duration when sane and drops it when not', () => {
    expect(normaliseRunnerEvent({ duration_ms: 850 }).duration_ms).toBe(850);
    expect(normaliseRunnerEvent({ duration_ms: -5 }).duration_ms).toBeNull();
    expect(normaliseRunnerEvent({ duration_ms: 'slow' }).duration_ms).toBeNull();
  });

  it('yields all-null for an empty body without throwing', () => {
    const out = normaliseRunnerEvent({});
    expect(out).toEqual({
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      duration_ms: null,
      provider: null,
      model: null,
    });
  });
});
