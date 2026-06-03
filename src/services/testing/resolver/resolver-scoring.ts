/**
 * Resolver Scoring — shared, pure(ish) scoring helpers
 *
 * Extracted from TestCaseResolverService so both that service and the
 * descriptor-oriented TestQueryResolverService score candidates identically
 * (DRY — see CLAUDE.md invariant 8). Kept free of DB access: the only async
 * dependency is the embedding service, which is itself cached here.
 *
 * Everything in this file is unit-testable in isolation:
 *   - computeNameSimilarity / computeUrlScore are pure.
 *   - scoreCandidates is pure given an embed() function (injectable in tests).
 */

import { generateEmbedding, cosineSimilarity } from '@/services/ai/core/embedding.service';
import { logger } from '@/utils/core/logger';

// ============================================================================
// WEIGHTS & CONSTANTS (single source of truth for both resolvers)
// ============================================================================

export const SCORING_WEIGHTS = {
  embedding: 0.7,
  name: 0.2,
  url: 0.1,
} as const;

const SCORE_URL_SAME_PAGE = 0.75;
const SCORE_URL_AUTH_PATH = 0.7;
const SCORE_URL_SAME_DOMAIN = 0.35;

const AUTH_PATH_KEYWORDS = [
  'login', 'auth', 'signin', 'sign-in',
  'register', 'signup', 'sign-up', 'onboarding',
];

// Embedding cache (in-memory, TTL 10min). Keyed by a caller-supplied stable
// key (typically `${id}:${updatedAt}`) so a changed row re-embeds.
const embeddingCache = new Map<string, { embedding: number[]; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_CLEANUP_THRESHOLD = 200;

// ============================================================================
// PURE SCORING
// ============================================================================

/**
 * Normalized token-overlap similarity (Jaccard over word tokens),
 * case- and punctuation-insensitive, unicode-aware. Pure.
 */
export function computeNameSimilarity(message: string, name: string): number {
  if (!message || !name) return 0;

  const tokenize = (text: string): Set<string> =>
    new Set(
      text
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length > 1),
    );

  const msgTokens = tokenize(message);
  const nameTokens = tokenize(name);
  if (msgTokens.size === 0 || nameTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of nameTokens) {
    if (msgTokens.has(token)) overlap++;
  }

  const union = new Set([...msgTokens, ...nameTokens]).size;
  return union > 0 ? overlap / union : 0;
}

/**
 * URL relevance score: same page > auth-path same-domain > same-domain.
 * Returns 0 for cross-domain or unparseable URLs. Pure.
 */
export function computeUrlScore(currentUrl: string, candidateUrl: string): number {
  if (!currentUrl || !candidateUrl) return 0;

  try {
    const current = new URL(currentUrl);
    const candidate = new URL(candidateUrl);

    if (current.origin + current.pathname === candidate.origin + candidate.pathname) {
      return SCORE_URL_SAME_PAGE;
    }

    if (current.hostname === candidate.hostname) {
      if (AUTH_PATH_KEYWORDS.some((k) => candidate.pathname.toLowerCase().includes(k))) {
        return SCORE_URL_AUTH_PATH;
      }
      return SCORE_URL_SAME_DOMAIN;
    }
  } catch {
    // Invalid URL — no signal.
  }

  return 0;
}

/**
 * Combined hybrid score from its three components, using the shared weights.
 * Negative embedding similarity is clamped to 0. Pure.
 */
export function combinedScore(embeddingSim: number, nameSim: number, urlScore: number): number {
  return (
    SCORING_WEIGHTS.embedding * Math.max(0, embeddingSim) +
    SCORING_WEIGHTS.name * nameSim +
    SCORING_WEIGHTS.url * urlScore
  );
}

/**
 * Human-readable reason string for a score breakdown. Pure.
 */
export function scoreReason(embeddingSim: number, nameSim: number, urlScore: number): string {
  const reasons: string[] = [];
  if (embeddingSim >= 0.7) reasons.push(`embed=${embeddingSim.toFixed(2)}`);
  if (nameSim >= 0.5) reasons.push(`name=${nameSim.toFixed(2)}`);
  if (urlScore > 0) reasons.push(`url=${urlScore.toFixed(2)}`);
  return reasons.join(', ') || 'low similarity';
}

// ============================================================================
// EMBEDDING CACHE (shared across resolvers)
// ============================================================================

/**
 * Embed `text`, caching by `cacheKey` for 10min. Returns null on empty text
 * or embedding failure (callers degrade to name-only scoring).
 */
export async function getCachedEmbedding(
  cacheKey: string,
  text: string,
): Promise<number[] | null> {
  const now = Date.now();

  const cached = embeddingCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.embedding;
  }

  if (!text.trim()) return null;

  try {
    const embedding = await generateEmbedding(text);
    embeddingCache.set(cacheKey, { embedding, expiresAt: now + CACHE_TTL_MS });

    if (embeddingCache.size > CACHE_CLEANUP_THRESHOLD) {
      for (const [key, val] of embeddingCache) {
        if (val.expiresAt <= now) embeddingCache.delete(key);
      }
    }

    return embedding;
  } catch (err) {
    logger.warn('[RESOLVER_SCORING] Failed to generate embedding', {
      cacheKey,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/** Re-export so the hybrid path can compute message-vs-candidate similarity. */
export { generateEmbedding, cosineSimilarity };
