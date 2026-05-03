/**
 * Mock the Gemini call so tests run offline and deterministically.
 * Each test sets a queued response, then asserts on extracted tokens.
 */
jest.mock('@/services/ai/core/gemini.service', () => ({
  generateTextWithGemini: jest.fn(),
}));

import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import {
  extractStableTokensViaLLM,
  invalidateTokensForText,
  _resetTokenCacheForTests,
  _getTokenCacheSizeForTests,
} from '../stable-tokens-llm.service';

const mockGemini = generateTextWithGemini as jest.MockedFunction<typeof generateTextWithGemini>;

function geminiOk(content: string) {
  return {
    content,
    usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, model: 'gemini-2.5-flash-lite' },
  };
}

beforeEach(() => {
  _resetTokenCacheForTests();
  mockGemini.mockReset();
});

describe('extractStableTokensViaLLM', () => {
  it('returns [] for empty / short input without calling LLM', async () => {
    expect(await extractStableTokensViaLLM('')).toEqual([]);
    expect(await extractStableTokensViaLLM(null)).toEqual([]);
    expect(await extractStableTokensViaLLM(undefined)).toEqual([]);
    expect(await extractStableTokensViaLLM('Save')).toEqual([]); // <10 chars
    expect(mockGemini).not.toHaveBeenCalled();
  });

  it('extracts brand + author from juz40-style card label', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toEqual(['МАТ-SMART', 'Бекнұр']);
    expect(mockGemini).toHaveBeenCalledTimes(1);
  });

  it('drops hallucinated tokens that are not substrings of the input', async () => {
    // LLM "translated" "ЖЕЛТОҚСАН" → "December" (not in original).
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "December", "Бекнұр"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toContain('МАТ-SMART');
    expect(tokens).toContain('Бекнұр');
    expect(tokens).not.toContain('December');
  });

  it('returns [] when LLM throws / times out', async () => {
    mockGemini.mockRejectedValueOnce(new Error('Gemini request timeout'));
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toEqual([]);
  });

  it('returns [] on malformed JSON', async () => {
    mockGemini.mockResolvedValueOnce(geminiOk('this is not json'));
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toEqual([]);
  });

  it('returns [] when LLM returns wrong shape (tokens not array)', async () => {
    mockGemini.mockResolvedValueOnce(geminiOk('{"tokens": "single string"}'));
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toEqual([]);
  });

  it('caches successful results — second call does not invoke LLM', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'),
    );
    const text = 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды';
    const first = await extractStableTokensViaLLM(text);
    const second = await extractStableTokensViaLLM(text);
    expect(first).toEqual(second);
    expect(mockGemini).toHaveBeenCalledTimes(1);
  });

  it('caches empty results with a SHORTER TTL — within TTL re-call hits cache', async () => {
    // Two-tier TTL: empty is cached for 1h (cheap re-ask hourly to recover
    // from transient failures), success for 24h. Within the empty TTL the
    // second call must NOT invoke the LLM — burning budget on every plan
    // build for fully-dynamic labels would be expensive.
    mockGemini.mockResolvedValueOnce(geminiOk('{"tokens": []}'));
    const text = 'Order #492837 placed at 14:32:15 by user_8273';
    expect(await extractStableTokensViaLLM(text)).toEqual([]);
    expect(await extractStableTokensViaLLM(text)).toEqual([]);
    expect(mockGemini).toHaveBeenCalledTimes(1);
  });

  it('drops over-long tokens (likely paraphrases)', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "this is a long paraphrase that should never be a token returned by the LLM that exceeds sixty characters easily"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toEqual(['МАТ-SMART']);
  });

  it('drops single-char tokens (too generic)', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["A", "Бекнұр"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды A',
    );
    expect(tokens).not.toContain('A');
    expect(tokens).toContain('Бекнұр');
  });

  it('caps at 3 tokens even if LLM returned more', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "ЖЕЛТОҚСАН", "Бекнұр", "Курс", "аяқталды"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens.length).toBeLessThanOrEqual(3);
  });

  it('de-duplicates case variants', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "мат-smart"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр',
    );
    // After dedup, only one of the two case-equivalent forms survives.
    expect(tokens.length).toBe(1);
  });

  it('failed LLM calls cache empty for short TTL — invalidate to recover sooner', async () => {
    mockGemini.mockRejectedValueOnce(new Error('Gemini request timeout'));
    const text = 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды';
    expect(await extractStableTokensViaLLM(text)).toEqual([]);
    // Short TTL means hourly re-ask in production. For a fast manual
    // recovery (e.g. wrong-element guard hits) callers invalidate the
    // entry explicitly via invalidateTokensForText().
    invalidateTokensForText(text);
    mockGemini.mockResolvedValueOnce(geminiOk('{"tokens": ["МАТ-SMART"]}'));
    const second = await extractStableTokensViaLLM(text);
    expect(second).toEqual(['МАТ-SMART']);
    expect(mockGemini).toHaveBeenCalledTimes(2);
  });

  it('treats whitespace-only differences as cache hits', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'),
    );
    await extractStableTokensViaLLM('МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды');
    await extractStableTokensViaLLM('  МАТ-SMART  ЖЕЛТОҚСАН  Т. Бекнұр • Курс аяқталды  ');
    expect(mockGemini).toHaveBeenCalledTimes(1);
  });

  it('survives a real-world multilang label', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["Save", "Сохранить", "Сақтау"]}'),
    );
    const tokens = await extractStableTokensViaLLM('Save / Сохранить / Сақтау');
    expect(tokens).toContain('Save');
    expect(tokens).toContain('Сохранить');
    expect(tokens).toContain('Сақтау');
  });
});

describe('cache key — collision resistance', () => {
  it('treats two long labels with same 500-char prefix as DISTINCT', async () => {
    // Two labels longer than 500 chars sharing the boilerplate prefix used
    // by Russian/Kazakh course dashboards. Earlier impl truncated the key
    // to 500 chars and would collide; sha256 of full text never collides.
    const prefix = 'Курс по математике для школьников начальной школы '.repeat(12);
    const labelA = `${prefix} Вариант: МАТ-SMART Бекнұр`;
    const labelB = `${prefix} Вариант: ХИМИЯ-PRO Тулегенов`;
    expect(labelA.length).toBeGreaterThan(500);
    expect(labelB.length).toBeGreaterThan(500);
    expect(labelA.slice(0, 500)).toBe(labelB.slice(0, 500));

    mockGemini
      .mockResolvedValueOnce(geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'))
      .mockResolvedValueOnce(geminiOk('{"tokens": ["ХИМИЯ-PRO", "Тулегенов"]}'));
    const aTokens = await extractStableTokensViaLLM(labelA);
    const bTokens = await extractStableTokensViaLLM(labelB);
    expect(aTokens).toEqual(['МАТ-SMART', 'Бекнұр']);
    expect(bTokens).toEqual(['ХИМИЯ-PRO', 'Тулегенов']);
    // Both calls happened — no collision-induced cache hit.
    expect(mockGemini).toHaveBeenCalledTimes(2);
  });
});

describe('substring validation — Cyrillic↔Latin glyph fold', () => {
  it('accepts Latin spelling of Cyrillic brand ("MAT-SMART" for "МАТ-SMART")', async () => {
    // LLM occasionally normalises Cyrillic glyph-twin letters to Latin.
    // Original text has Cyrillic М/А/Т; LLM returns Latin spelling.
    // Without fold: substring check rejects → valid token lost.
    // With fold: both sides fold to "mat-smart" → accepted.
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["MAT-SMART", "Бекнұр"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды',
    );
    expect(tokens).toContain('MAT-SMART');
    expect(tokens).toContain('Бекнұр');
  });

  it('still rejects truly hallucinated translations', async () => {
    // "December" doesn't fold to anything in "ЖЕЛТОҚСАН" — must reject.
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "December"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр',
    );
    expect(tokens).toContain('МАТ-SMART');
    expect(tokens).not.toContain('December');
  });

  it('dedups Cyrillic and Latin variants of the same brand', async () => {
    // LLM returns both spellings; fold-based dedup keeps the first.
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "MAT-SMART", "Бекнұр"]}'),
    );
    const tokens = await extractStableTokensViaLLM(
      'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр',
    );
    // First brand wins, second variant deduped, "Бекнұр" preserved.
    expect(tokens).toEqual(['МАТ-SMART', 'Бекнұр']);
  });
});

describe('invalidateTokensForText', () => {
  it('drops cached tokens for the given text → next call re-asks LLM', async () => {
    mockGemini
      .mockResolvedValueOnce(geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'))
      .mockResolvedValueOnce(geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'));
    const text = 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды';
    await extractStableTokensViaLLM(text);
    expect(mockGemini).toHaveBeenCalledTimes(1);

    // Cache HIT — no second LLM call.
    await extractStableTokensViaLLM(text);
    expect(mockGemini).toHaveBeenCalledTimes(1);

    // Invalidate then re-ask — LLM called again.
    expect(invalidateTokensForText(text)).toBe(true);
    await extractStableTokensViaLLM(text);
    expect(mockGemini).toHaveBeenCalledTimes(2);
  });

  it('returns false when text was never cached', () => {
    expect(invalidateTokensForText('never-seen-label')).toBe(false);
  });

  it('returns false for empty / short input (no-op, no key)', () => {
    expect(invalidateTokensForText('')).toBe(false);
    expect(invalidateTokensForText(null)).toBe(false);
    expect(invalidateTokensForText(undefined)).toBe(false);
    expect(invalidateTokensForText('Save')).toBe(false);
  });

  it('whitespace variants share an entry — invalidate one drops both', async () => {
    mockGemini.mockResolvedValueOnce(
      geminiOk('{"tokens": ["МАТ-SMART", "Бекнұр"]}'),
    );
    await extractStableTokensViaLLM('МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр • Курс аяқталды');
    // Invalidating with the same logical content but messy whitespace
    // should still hit (cache key normalises whitespace).
    expect(invalidateTokensForText('  МАТ-SMART  ЖЕЛТОҚСАН  Т. Бекнұр • Курс аяқталды  ')).toBe(true);
  });

  it('only drops the targeted entry, leaves others intact', async () => {
    mockGemini
      .mockResolvedValueOnce(geminiOk('{"tokens": ["МАТ-SMART"]}'))
      .mockResolvedValueOnce(geminiOk('{"tokens": ["ХИМИЯ-PRO"]}'));
    const a = 'МАТ-SMART ЖЕЛТОҚСАН Т. Бекнұр';
    const b = 'ХИМИЯ-PRO Тулегенов Курс по химии';
    await extractStableTokensViaLLM(a);
    await extractStableTokensViaLLM(b);
    expect(_getTokenCacheSizeForTests()).toBe(2);

    invalidateTokensForText(a);
    expect(_getTokenCacheSizeForTests()).toBe(1);

    // b still cached — no LLM call.
    await extractStableTokensViaLLM(b);
    expect(mockGemini).toHaveBeenCalledTimes(2);
  });
});

describe('cache eviction', () => {
  it('does not crash when cache size grows', async () => {
    // Spam the cache with distinct labels; only checking it doesn't blow up.
    for (let i = 0; i < 20; i++) {
      mockGemini.mockResolvedValueOnce(
        geminiOk(`{"tokens": ["Brand${i}"]}`),
      );
      await extractStableTokensViaLLM(`Brand${i} qwerty asdfgh`);
    }
    expect(_getTokenCacheSizeForTests()).toBeGreaterThan(0);
  });
});
