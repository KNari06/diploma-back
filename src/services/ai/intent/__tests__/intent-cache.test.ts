/**
 * Tests for the intent-parser short-TTL cache.
 *
 * It exists to kill double-submits, NOT as a correctness cache — so the key
 * MUST change whenever anything that could flip the classifier's answer
 * changes (message, projectId, available intents, or any digested context
 * field), and MUST stay stable on cosmetic drift (intent ORDER, chat history
 * older than the last 3 turns). A key bug here serves a stale intent for a
 * changed situation — a correctness incident, not just a perf miss.
 */

import {
  buildIntentCacheKey,
  getCachedIntent,
  setCachedIntent,
  getIntentCacheStats,
  __resetIntentCacheForTests,
} from '../intent-cache';
import { env } from '@/config/environment/env';
import type { IntentParserContext } from '@/ai/prompts/index';
import type { IntentResult } from '@/types';

jest.mock('@/config/environment/env', () => ({ env: { INTENT_CACHE_DISABLED: false } }));
jest.mock('@/utils/core/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const result = (intent: string) => ({ intent } as unknown as IntentResult);
const ctx = (over: Partial<IntentParserContext> = {}): IntentParserContext =>
  ({ mode: 'lite', ...over } as IntentParserContext);

beforeEach(() => {
  __resetIntentCacheForTests();
  (env as { INTENT_CACHE_DISABLED: boolean }).INTENT_CACHE_DISABLED = false;
});

describe('buildIntentCacheKey', () => {
  it('is a deterministic 64-char hex digest', () => {
    const k1 = buildIntentCacheKey('hello', ctx(), 'p1', ['a', 'b']);
    const k2 = buildIntentCacheKey('hello', ctx(), 'p1', ['a', 'b']);
    expect(k1).toMatch(/^[0-9a-f]{64}$/);
    expect(k1).toBe(k2);
  });

  it('trims the message (cosmetic whitespace does not miss)', () => {
    expect(buildIntentCacheKey('  hi  ', ctx(), 'p1', [])).toBe(buildIntentCacheKey('hi', ctx(), 'p1', []));
  });

  it('is independent of available-intents ORDER (sorted before hashing)', () => {
    expect(buildIntentCacheKey('m', ctx(), 'p1', ['b', 'a', 'c'])).toBe(
      buildIntentCacheKey('m', ctx(), 'p1', ['a', 'b', 'c']),
    );
  });

  it('changes when the message / projectId / intents change', () => {
    const base = buildIntentCacheKey('m', ctx(), 'p1', ['a']);
    expect(buildIntentCacheKey('m2', ctx(), 'p1', ['a'])).not.toBe(base);
    expect(buildIntentCacheKey('m', ctx(), 'p2', ['a'])).not.toBe(base);
    expect(buildIntentCacheKey('m', ctx(), 'p1', ['a', 'z'])).not.toBe(base);
  });

  it.each([
    ['mode', { mode: 'pro' as const }],
    ['previewSessionId', { previewSessionId: 'ps1' }],
    ['mobileSessionId', { mobileSessionId: 'ms1' }],
    ['lastTestId', { lastTestId: 't1' }],
    ['lastFailedTestId', { lastFailedTestId: 'tf1' }],
    ['currentTestStatus', { currentTestStatus: 'failed' }],
  ])('changes when context.%s changes', (_label, over) => {
    const base = buildIntentCacheKey('m', ctx(), 'p1', ['a']);
    expect(buildIntentCacheKey('m', ctx(over as Partial<IntentParserContext>), 'p1', ['a'])).not.toBe(base);
  });

  it('only the last 3 chat turns affect the key', () => {
    const mk = (history: { role: string; content: string }[]) =>
      buildIntentCacheKey('m', ctx({ chatHistory: history as IntentParserContext['chatHistory'] }), 'p1', ['a']);
    const last3 = [
      { role: 'user', content: 'one' },
      { role: 'ai', content: 'two' },
      { role: 'user', content: 'three' },
    ];
    // Prepending OLDER turns (beyond the last 3) must not change the key.
    expect(mk([{ role: 'user', content: 'ancient' }, ...last3])).toBe(mk(last3));
    // But changing one of the last 3 does.
    expect(mk([{ role: 'user', content: 'one' }, { role: 'ai', content: 'CHANGED' }, { role: 'user', content: 'three' }])).not.toBe(
      mk(last3),
    );
  });

  it('treats undefined context distinctly from an empty-ish context', () => {
    expect(buildIntentCacheKey('m', undefined, 'p1', ['a'])).not.toBe(buildIntentCacheKey('m', ctx(), 'p1', ['a']));
  });
});

describe('get / set', () => {
  it('round-trips a stored result', () => {
    const key = buildIntentCacheKey('m', ctx(), 'p1', ['a']);
    expect(getCachedIntent(key)).toBeNull(); // miss first
    setCachedIntent(key, result('run_regression'));
    expect(getCachedIntent(key)).toEqual({ intent: 'run_regression' });
  });

  it('expires entries after the 60s TTL', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
    const key = 'k';
    setCachedIntent(key, result('x'));
    nowSpy.mockReturnValue(1_000_000 + 60_001); // past TTL
    expect(getCachedIntent(key)).toBeNull();
    nowSpy.mockRestore();
  });

  it('still hits just under the TTL boundary', () => {
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(2_000_000);
    setCachedIntent('k', result('x'));
    nowSpy.mockReturnValue(2_000_000 + 60_000); // exactly TTL — not strictly greater
    expect(getCachedIntent('k')).toEqual({ intent: 'x' });
    nowSpy.mockRestore();
  });

  it('honours the INTENT_CACHE_DISABLED kill-switch (get null, set no-op)', () => {
    (env as { INTENT_CACHE_DISABLED: boolean }).INTENT_CACHE_DISABLED = true;
    setCachedIntent('k', result('x'));
    expect(getCachedIntent('k')).toBeNull();
  });
});

describe('eviction + stats', () => {
  it('evicts the oldest entry when the 500-cap is exceeded', () => {
    for (let i = 0; i < 500; i++) setCachedIntent(`k${i}`, result(`r${i}`));
    expect(getIntentCacheStats().size).toBe(500);
    setCachedIntent('k500', result('r500')); // evicts k0 (oldest)
    expect(getIntentCacheStats().size).toBe(500);
    expect(getCachedIntent('k0')).toBeNull();
    expect(getCachedIntent('k500')).toEqual({ intent: 'r500' });
  });

  it('tracks hits, misses, and hitRate', () => {
    setCachedIntent('k', result('x'));
    getCachedIntent('k'); // hit
    getCachedIntent('missing'); // miss
    const stats = getIntentCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(0.5);
  });

  it('reports hitRate 0 when there is no traffic', () => {
    expect(getIntentCacheStats().hitRate).toBe(0);
  });
});
