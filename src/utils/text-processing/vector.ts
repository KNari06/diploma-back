/**
 * Vector operations for embeddings
 */

/**
 * Calculate cosine similarity between two vectors
 * @param a - First vector (must be array of finite numbers)
 * @param b - Second vector (must be array of finite numbers)
 * @returns Similarity score between -1 and 1 (1 = identical, -1 = opposite)
 * @throws Error if vectors are invalid or have different lengths
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  // Validate inputs
  if (!a || !Array.isArray(a)) {
    throw new Error('First vector must be an array');
  }

  if (!b || !Array.isArray(b)) {
    throw new Error('Second vector must be an array');
  }

  if (a.length === 0 || b.length === 0) {
    throw new Error('Vectors cannot be empty');
  }

  if (a.length !== b.length) {
    throw new Error(`Vectors must have the same length (got ${a.length} and ${b.length})`);
  }

  // Validate all values are finite numbers
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) {
      throw new Error(`Invalid number at index ${i} in first vector: ${a[i]}`);
    }
    if (!Number.isFinite(b[i])) {
      throw new Error(`Invalid number at index ${i} in second vector: ${b[i]}`);
    }
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  // Handle edge case: zero vectors
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) {
    // Both vectors are zero vectors
    return 0;
  }

  const similarity = dotProduct / denominator;

  // Clamp to [-1, 1] to handle floating point errors
  return Math.max(-1, Math.min(1, similarity));
}

/**
 * Calculate euclidean distance between two vectors
 * @param a - First vector (must be array of finite numbers)
 * @param b - Second vector (must be array of finite numbers)
 * @returns Distance (lower = more similar, always >= 0)
 * @throws Error if vectors are invalid or have different lengths
 */
export function euclideanDistance(a: number[], b: number[]): number {
  // Validate inputs
  if (!a || !Array.isArray(a)) {
    throw new Error('First vector must be an array');
  }

  if (!b || !Array.isArray(b)) {
    throw new Error('Second vector must be an array');
  }

  if (a.length === 0 || b.length === 0) {
    throw new Error('Vectors cannot be empty');
  }

  if (a.length !== b.length) {
    throw new Error(`Vectors must have the same length (got ${a.length} and ${b.length})`);
  }

  // Validate all values are finite numbers
  for (let i = 0; i < a.length; i++) {
    if (!Number.isFinite(a[i])) {
      throw new Error(`Invalid number at index ${i} in first vector: ${a[i]}`);
    }
    if (!Number.isFinite(b[i])) {
      throw new Error(`Invalid number at index ${i} in second vector: ${b[i]}`);
    }
  }

  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const diff = a[i] - b[i];
    sum += diff * diff;
  }

  const distance = Math.sqrt(sum);

  // Ensure non-negative (should always be, but handle NaN/Infinity)
  return Number.isFinite(distance) ? Math.max(0, distance) : Infinity;
}

/**
 * Normalize vector to unit length
 * @param vector - Input vector (must be array of finite numbers)
 * @returns Normalized vector (unit length = 1.0)
 * @throws Error if vector is invalid or empty
 */
export function normalizeVector(vector: number[]): number[] {
  // Validate input
  if (!vector || !Array.isArray(vector)) {
    throw new Error('Vector must be an array');
  }

  if (vector.length === 0) {
    throw new Error('Vector cannot be empty');
  }

  // Validate all values are finite numbers
  for (let i = 0; i < vector.length; i++) {
    if (!Number.isFinite(vector[i])) {
      throw new Error(`Invalid number at index ${i}: ${vector[i]}`);
    }
  }

  // Calculate norm (magnitude)
  let sumSquares = 0;
  for (let i = 0; i < vector.length; i++) {
    sumSquares += vector[i] * vector[i];
  }

  const norm = Math.sqrt(sumSquares);

  // Handle zero vector - return zero vector (cannot normalize)
  if (norm === 0 || !Number.isFinite(norm)) {
    // Return zero vector of same length
    return new Array(vector.length).fill(0);
  }

  // Normalize by dividing each component by norm
  const normalized = new Array(vector.length);
  for (let i = 0; i < vector.length; i++) {
    normalized[i] = vector[i] / norm;
    // Validate result is finite
    if (!Number.isFinite(normalized[i])) {
      throw new Error(`Normalization produced non-finite value at index ${i}`);
    }
  }

  return normalized;
}
