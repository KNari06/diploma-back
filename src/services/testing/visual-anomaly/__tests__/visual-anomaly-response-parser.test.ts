import { normalizeCategoryList, normalizeConfidence, normalizeFindings, dedupeByCategory } from '../visual-anomaly-response-parser';
import { logger } from '@/utils/core/logger';

const mockLoggerInfo = logger.info as jest.Mock;
const mockLoggerWarn = logger.warn as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
});

describe('normalizeCategoryList', () => {
  it('wraps a bare valid category string into a single-element list', () => {
    expect(normalizeCategoryList('broken_image')).toEqual(['broken_image']);
  });

  it('unwraps a single-element array — the 2026-07-10 incident shape', () => {
    expect(normalizeCategoryList(['overlapping_cutoff_ui'])).toEqual(['overlapping_cutoff_ui']);
  });

  it('expands a multi-element array into multiple categories — the 2026-07-11 pilot incident shape', () => {
    expect(normalizeCategoryList(['placeholder_text', 'broken_image'])).toEqual(['placeholder_text', 'broken_image']);
  });

  it('falls back to "other" for a value outside the known category set', () => {
    expect(normalizeCategoryList('some_new_category_gemini_invented')).toEqual(['other']);
  });

  it('drops non-string entries and de-dups repeated values', () => {
    expect(normalizeCategoryList(['broken_image', 123, 'broken_image', null])).toEqual(['broken_image']);
  });

  it('returns an empty list for a non-string, non-array value', () => {
    expect(normalizeCategoryList(null)).toEqual([]);
    expect(normalizeCategoryList(42)).toEqual([]);
  });
});

describe('normalizeConfidence', () => {
  it('clamps a valid number to [0,1]', () => {
    expect(normalizeConfidence(0.5)).toBe(0.5);
    expect(normalizeConfidence(1.5)).toBe(1);
    expect(normalizeConfidence(-0.5)).toBe(0);
  });

  it('coerces a string-wrapped number', () => {
    expect(normalizeConfidence('0.9')).toBe(0.9);
  });

  it('falls back to 0 for a non-numeric value', () => {
    expect(normalizeConfidence('not-a-number')).toBe(0);
    expect(normalizeConfidence(null)).toBe(0);
    expect(normalizeConfidence(undefined)).toBe(0);
  });

  it('unwraps a single-element array — mirrors normalizeCategoryList\'s defense against the same array-wrapping pattern Gemini has already shown on category', () => {
    expect(normalizeConfidence([0.92])).toBe(0.92);
  });

  it('falls back to 0 for a multi-element array (no single value to unwrap) rather than silently treating a real high confidence as noise', () => {
    expect(normalizeConfidence([0.9, 0.8])).toBe(0);
  });
});

describe('normalizeFindings', () => {
  it('parses the documented {findings:[...]} shape', () => {
    const result = normalizeFindings({
      findings: [{ category: 'placeholder_text', description: 'Lorem ipsum.', confidence: 0.9 }],
    });
    expect(result).toEqual([{ category: 'placeholder_text', description: 'Lorem ipsum.', confidence: 0.9 }]);
  });

  it('tolerates a bare array response with no {findings:[...]} wrapper', () => {
    const result = normalizeFindings([{ category: 'broken_image', description: 'Missing image.', confidence: 1 }]);
    expect(result).toEqual([{ category: 'broken_image', description: 'Missing image.', confidence: 1 }]);
  });

  it('expands one raw entry with a multi-category array into multiple normalized findings sharing the same description/confidence', () => {
    const result = normalizeFindings({
      findings: [{ category: ['placeholder_text', 'broken_image'], description: 'Placeholder image area.', confidence: 1 }],
    });
    expect(result).toEqual([
      { category: 'placeholder_text', description: 'Placeholder image area.', confidence: 1 },
      { category: 'broken_image', description: 'Placeholder image area.', confidence: 1 },
    ]);
  });

  it('drops a raw entry with no resolvable category', () => {
    const result = normalizeFindings({ findings: [{ category: null, description: 'n/a', confidence: 0.5 }] });
    expect(result).toEqual([]);
  });

  it('ignores non-object entries and defaults description to "" when missing', () => {
    const result = normalizeFindings({ findings: [null, 'a string entry', { category: 'other' }] });
    expect(result).toEqual([{ category: 'other', description: '', confidence: 0 }]);
  });

  it('returns an empty list for an empty findings array (no anomaly)', () => {
    expect(normalizeFindings({ findings: [] })).toEqual([]);
  });

  it('returns an empty list when the payload has neither an array nor a findings array', () => {
    expect(normalizeFindings({ somethingElse: true })).toEqual([]);
  });

  it('tolerates the OLD pre-ADR-0016 flat single-finding shape (no findings wrapper) instead of silently dropping a real detection', () => {
    const result = normalizeFindings({ category: 'broken_image', description: 'Missing product image.', confidence: 0.9 });
    expect(result).toEqual([{ category: 'broken_image', description: 'Missing product image.', confidence: 0.9 }]);
  });

  it('logs when a raw finding entry contributes zero categories, instead of dropping it with no trace', () => {
    normalizeFindings({ findings: [{ category: 42, description: 'A real defect Gemini could not categorize as a string.', confidence: 0.9 }] });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[VISUAL_ANOMALY] Dropping finding with unresolvable category',
      expect.objectContaining({ rawCategory: 42 }),
    );
  });

  it('logs when a raw findings-array entry is not an object (e.g. a bare string) before dropping it', () => {
    normalizeFindings({ findings: ['placeholder_text'] });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      '[VISUAL_ANOMALY] Dropping non-object finding entry — no category to resolve',
      expect.objectContaining({ entry: 'placeholder_text' }),
    );
  });
});

describe('dedupeByCategory', () => {
  it('keeps both findings when categories differ — the core compound-bug case ADR-0016 exists for', () => {
    const result = dedupeByCategory([
      { category: 'broken_image', description: 'Missing image.', confidence: 1 },
      { category: 'placeholder_text', description: 'Lorem ipsum.', confidence: 1 },
    ]);
    expect(result).toHaveLength(2);
  });

  it('collapses two same-category findings, keeping the higher-confidence one', () => {
    const result = dedupeByCategory([
      { category: 'broken_image', description: 'Lower confidence.', confidence: 0.6 },
      { category: 'broken_image', description: 'Higher confidence.', confidence: 0.95 },
    ]);
    expect(result).toEqual([{ category: 'broken_image', description: 'Higher confidence.', confidence: 0.95 }]);
  });

  it('keeps the first finding when a later same-category finding has equal or lower confidence', () => {
    const result = dedupeByCategory([
      { category: 'broken_image', description: 'First seen.', confidence: 0.9 },
      { category: 'broken_image', description: 'Same confidence, seen later.', confidence: 0.9 },
    ]);
    expect(result).toEqual([{ category: 'broken_image', description: 'First seen.', confidence: 0.9 }]);
  });

  it('logs a collapse when two same-category findings are deduped', () => {
    dedupeByCategory([
      { category: 'broken_image', description: 'Lower.', confidence: 0.6 },
      { category: 'broken_image', description: 'Higher.', confidence: 0.95 },
    ]);
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      '[VISUAL_ANOMALY] Collapsing duplicate-category finding within one screenshot',
      expect.objectContaining({ category: 'broken_image', kept: 'Higher.', dropped: 'Lower.' }),
    );
  });

  it('NEVER collapses `other`-category findings against each other — `other` is a heterogeneous catch-all, not a real recurring category, so two `other` findings are not reliably the same defect', () => {
    const result = dedupeByCategory([
      { category: 'other', description: 'Weird defect A.', confidence: 0.6 },
      { category: 'other', description: 'Weird defect B.', confidence: 0.9 },
    ]);
    expect(result).toHaveLength(2);
    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ description: 'Weird defect A.' }),
      expect.objectContaining({ description: 'Weird defect B.' }),
    ]));
  });

  it('does not log a collapse for `other`-category findings, since none are ever collapsed', () => {
    dedupeByCategory([
      { category: 'other', description: 'A.', confidence: 0.6 },
      { category: 'other', description: 'B.', confidence: 0.9 },
    ]);
    expect(mockLoggerInfo).not.toHaveBeenCalled();
  });

  it('still collapses known-category duplicates normally when `other` findings are also present in the same list', () => {
    const result = dedupeByCategory([
      { category: 'broken_image', description: 'Lower.', confidence: 0.6 },
      { category: 'broken_image', description: 'Higher.', confidence: 0.9 },
      { category: 'other', description: 'Weird A.', confidence: 0.5 },
      { category: 'other', description: 'Weird B.', confidence: 0.5 },
    ]);
    expect(result).toHaveLength(3);
  });
});
