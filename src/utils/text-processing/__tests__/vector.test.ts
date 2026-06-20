import { cosineSimilarity, euclideanDistance, normalizeVector } from '../vector';

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1, 10);
  });

  it('returns 1 for parallel vectors of different magnitude', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1, 10);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 10);
  });

  it('returns 0 when either vector is a zero vector', () => {
    expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    expect(cosineSimilarity([1, 2, 3], [0, 0, 0])).toBe(0);
  });

  it('clamps the result to the [-1, 1] range despite floating point drift', () => {
    const result = cosineSimilarity([0.1, 0.2, 0.3], [0.1, 0.2, 0.3]);
    expect(result).toBeLessThanOrEqual(1);
    expect(result).toBeGreaterThanOrEqual(-1);
  });

  it('throws when the first argument is not an array', () => {
    expect(() => cosineSimilarity(null as any, [1])).toThrow('First vector must be an array');
  });

  it('throws when the second argument is not an array', () => {
    expect(() => cosineSimilarity([1], undefined as any)).toThrow('Second vector must be an array');
  });

  it('throws when either vector is empty', () => {
    expect(() => cosineSimilarity([], [])).toThrow('Vectors cannot be empty');
  });

  it('throws when vectors have different lengths', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(
      'Vectors must have the same length (got 2 and 3)',
    );
  });

  it('throws when a value is not finite', () => {
    expect(() => cosineSimilarity([1, NaN], [1, 2])).toThrow(
      'Invalid number at index 1 in first vector: NaN',
    );
    expect(() => cosineSimilarity([1, 2], [1, Infinity])).toThrow(
      'Invalid number at index 1 in second vector: Infinity',
    );
  });
});

describe('euclideanDistance', () => {
  it('returns 0 for identical vectors', () => {
    expect(euclideanDistance([1, 2, 3], [1, 2, 3])).toBe(0);
  });

  it('computes the classic 3-4-5 distance', () => {
    expect(euclideanDistance([0, 0], [3, 4])).toBeCloseTo(5, 10);
  });

  it('is symmetric', () => {
    expect(euclideanDistance([1, 2], [4, 6])).toBeCloseTo(
      euclideanDistance([4, 6], [1, 2]),
      10,
    );
  });

  it('throws when the first argument is not an array', () => {
    expect(() => euclideanDistance(null as any, [1])).toThrow('First vector must be an array');
  });

  it('throws when the second argument is not an array', () => {
    expect(() => euclideanDistance([1], null as any)).toThrow('Second vector must be an array');
  });

  it('throws when either vector is empty', () => {
    expect(() => euclideanDistance([], [])).toThrow('Vectors cannot be empty');
  });

  it('throws when vectors have different lengths', () => {
    expect(() => euclideanDistance([1], [1, 2])).toThrow(
      'Vectors must have the same length (got 1 and 2)',
    );
  });

  it('throws when a value is not finite', () => {
    expect(() => euclideanDistance([1, Infinity], [1, 2])).toThrow(
      'Invalid number at index 1 in first vector: Infinity',
    );
  });
});

describe('normalizeVector', () => {
  it('returns a unit-length vector', () => {
    const result = normalizeVector([3, 4]);
    expect(result[0]).toBeCloseTo(0.6, 10);
    expect(result[1]).toBeCloseTo(0.8, 10);
    const magnitude = Math.sqrt(result.reduce((s, v) => s + v * v, 0));
    expect(magnitude).toBeCloseTo(1, 10);
  });

  it('preserves a vector that is already unit length', () => {
    const result = normalizeVector([1, 0, 0]);
    expect(result).toEqual([1, 0, 0]);
  });

  it('returns a zero vector unchanged (cannot normalize)', () => {
    expect(normalizeVector([0, 0, 0])).toEqual([0, 0, 0]);
  });

  it('throws when the argument is not an array', () => {
    expect(() => normalizeVector(null as any)).toThrow('Vector must be an array');
  });

  it('throws when the vector is empty', () => {
    expect(() => normalizeVector([])).toThrow('Vector cannot be empty');
  });

  it('throws when a value is not finite', () => {
    expect(() => normalizeVector([1, NaN])).toThrow('Invalid number at index 1: NaN');
  });
});
