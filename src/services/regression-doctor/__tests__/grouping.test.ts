/**
 * Tests for Regression Doctor grouping logic.
 *
 * The grouping is pure / deterministic, so these tests run without any
 * DB / LLM / filesystem dependencies.
 */

import { computePatternKey, groupByPattern, type DriftFailureInput } from '../grouping';
import type { DriftSignals } from '@/types';

const makeSignals = (overrides: Partial<DriftSignals> = {}): DriftSignals => ({
  urlPattern: '/tutors/:id',
  targetElementKey: 'button:Подготовка к ВОУД',
  errorShape: 'selector_not_found',
  ...overrides,
});

const makeFailure = (
  id: string,
  signals: DriftSignals,
  testCaseId: string | null = `case-${id}`,
): DriftFailureInput => ({
  testResultId: `result-${id}`,
  testId: `test-${id}`,
  testCaseId,
  driftSignals: signals,
});

describe('computePatternKey', () => {
  it('returns stable hash for the same inputs', () => {
    const signals = makeSignals();
    expect(computePatternKey(signals)).toBe(computePatternKey(signals));
  });

  it('normalizes whitespace in targetElementKey before hashing', () => {
    // The LLM sometimes returns trailing spaces; two failures that differ
    // ONLY in trailing whitespace must group together.
    const a = makeSignals({ targetElementKey: 'button:Submit' });
    const b = makeSignals({ targetElementKey: '  button:Submit  ' });
    expect(computePatternKey(a)).toBe(computePatternKey(b));
  });

  it('normalizes whitespace in urlPattern before hashing', () => {
    const a = makeSignals({ urlPattern: '/tutors/:id' });
    const b = makeSignals({ urlPattern: '/tutors/:id ' });
    expect(computePatternKey(a)).toBe(computePatternKey(b));
  });

  it('differs when urlPattern differs', () => {
    const a = makeSignals({ urlPattern: '/tutors/:id' });
    const b = makeSignals({ urlPattern: '/lesson/:id' });
    expect(computePatternKey(a)).not.toBe(computePatternKey(b));
  });

  it('differs when targetElementKey differs', () => {
    const a = makeSignals({ targetElementKey: 'button:Submit' });
    const b = makeSignals({ targetElementKey: 'button:Cancel' });
    expect(computePatternKey(a)).not.toBe(computePatternKey(b));
  });

  it('differs when errorShape differs', () => {
    const a = makeSignals({ errorShape: 'selector_not_found' });
    const b = makeSignals({ errorShape: 'covered_by_overlay' });
    expect(computePatternKey(a)).not.toBe(computePatternKey(b));
  });

  it('returns 40-char hex (SHA-1) — stable format for DB indexing', () => {
    const key = computePatternKey(makeSignals());
    expect(key).toMatch(/^[0-9a-f]{40}$/);
  });

  it('avoids separator collision when a field contains "||"', () => {
    // If the separator were `||`, these two distinct tuples would hash
    // to the same canonical string `x||y||z||selector_not_found`.
    // The NUL separator makes this impossible because no legitimate
    // URL / element key can contain a NUL byte.
    const a = makeSignals({
      urlPattern: 'x||y',
      targetElementKey: 'z',
      errorShape: 'selector_not_found',
    });
    const b = makeSignals({
      urlPattern: 'x',
      targetElementKey: 'y||z',
      errorShape: 'selector_not_found',
    });
    expect(computePatternKey(a)).not.toBe(computePatternKey(b));
  });
});

describe('groupByPattern', () => {
  it('returns empty array for empty input', () => {
    expect(groupByPattern([])).toEqual([]);
  });

  it('puts each unique pattern in its own group', () => {
    const input = [
      makeFailure('1', makeSignals({ targetElementKey: 'button:A' })),
      makeFailure('2', makeSignals({ targetElementKey: 'button:B' })),
      makeFailure('3', makeSignals({ targetElementKey: 'button:C' })),
    ];
    const groups = groupByPattern(input);
    expect(groups).toHaveLength(3);
    expect(groups.map((g) => g.targetElementKey).sort()).toEqual(['button:A', 'button:B', 'button:C']);
    expect(groups.every((g) => g.failures.length === 1)).toBe(true);
  });

  it('collapses identical patterns into one group', () => {
    const sig = makeSignals();
    const input = [
      makeFailure('1', sig),
      makeFailure('2', sig),
      makeFailure('3', sig),
    ];
    const groups = groupByPattern(input);
    expect(groups).toHaveLength(1);
    expect(groups[0].failures).toHaveLength(3);
  });

  it('sorts groups by failure count DESC then by patternKey ASC', () => {
    const a = makeSignals({ targetElementKey: 'button:Small' });
    const b = makeSignals({ targetElementKey: 'button:Big' });
    // 1 failure for 'Small', 3 for 'Big'
    const input = [
      makeFailure('1', a),
      makeFailure('2', b),
      makeFailure('3', b),
      makeFailure('4', b),
    ];
    const groups = groupByPattern(input);
    expect(groups).toHaveLength(2);
    expect(groups[0].targetElementKey).toBe('button:Big');
    expect(groups[0].failures).toHaveLength(3);
    expect(groups[1].targetElementKey).toBe('button:Small');
    expect(groups[1].failures).toHaveLength(1);
  });

  it('is stable — same input → same output order', () => {
    const sigs = [
      makeSignals({ targetElementKey: 'button:X' }),
      makeSignals({ targetElementKey: 'button:Y' }),
      makeSignals({ targetElementKey: 'button:Z' }),
    ];
    const inputA = [
      makeFailure('a', sigs[0]),
      makeFailure('b', sigs[1]),
      makeFailure('c', sigs[2]),
    ];
    const inputB = [
      makeFailure('c', sigs[2]),
      makeFailure('a', sigs[0]),
      makeFailure('b', sigs[1]),
    ];
    const keysA = groupByPattern(inputA).map((g) => g.patternKey);
    const keysB = groupByPattern(inputB).map((g) => g.patternKey);
    expect(keysA).toEqual(keysB);
  });

  it('preserves all failures across multiple groups', () => {
    const input = [
      makeFailure('1', makeSignals({ targetElementKey: 'button:A' })),
      makeFailure('2', makeSignals({ targetElementKey: 'button:A' })),
      makeFailure('3', makeSignals({ targetElementKey: 'button:B' })),
    ];
    const groups = groupByPattern(input);
    const total = groups.reduce((acc, g) => acc + g.failures.length, 0);
    expect(total).toBe(3);
  });
});
