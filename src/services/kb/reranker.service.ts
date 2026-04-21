/**
 * KB reranker (Phase 2.3)
 *
 * Provider-agnostic cross-encoder reranker. Takes a query + candidate docs
 * and returns them re-ordered by cross-encoder relevance. Bi-encoders
 * (vector search) are fast but approximate; cross-encoders see (query, doc)
 * as a pair and give sharper relevance — biggest single-lift technique per
 * 2026 RAG benchmarks.
 *
 * Safety:
 *   - Off by default (env KB_RERANKER=off). Prod traffic unaffected until
 *     explicitly enabled.
 *   - Timeout + try/catch wrapping every provider call. If the reranker
 *     times out, errors, or returns garbage, we fall back to the original
 *     order — retrieval never blocks on reranker failure.
 *   - No reranker call when candidate pool is ≤ 5 (nothing to reorder that
 *     actually matters; avoid paying an API call for zero gain).
 *
 * Providers:
 *   - 'cohere': Cohere Rerank v3 (API call, ~200-400ms, ~$1/1000 reranks)
 *   - 'bge':    placeholder for self-hosted bge-reranker-v2-m3 via HF/Replicate
 *   - 'off':    no-op, returns input unchanged
 */

import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

export interface RerankInput {
  /** Original search query. */
  query: string;
  /** Candidate documents in current retrieval order. */
  docs: Array<{
    /** Unique id used to identify the doc in the output. */
    id: string;
    /** Text the reranker will score against `query`. */
    content: string;
  }>;
}

export interface RerankHit {
  /** Id of the doc (same as input). */
  id: string;
  /** Reranker-assigned relevance score, higher = more relevant. */
  score: number;
  /** 0-based rank in the reranked output. */
  rank: number;
}

/**
 * Returns the doc ids re-ordered by reranker relevance, ranked best-first.
 * On ANY failure (provider error, timeout, invalid response, disabled flag)
 * returns null — callers should treat null as "keep the original order".
 */
export async function rerank(input: RerankInput): Promise<RerankHit[] | null> {
  const provider = env.KB_RERANKER;

  // 1) Off or trivially small pool → skip silently
  if (provider === 'off') return null;
  if (!input.query || !Array.isArray(input.docs) || input.docs.length < 2) {
    return null;
  }
  // Reranker for 3-5 docs adds latency for marginal quality gain — skip.
  // The point of a reranker is to re-order a pool of 20 → top 5, not to
  // shuffle a pool of 5 → top 3.
  if (input.docs.length < 6) return null;

  const startedAt = Date.now();

  // AbortController lets us cancel the underlying HTTP request on timeout
  // so the socket is released instead of consuming bandwidth in the background
  // for a reply we're about to discard.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(50, env.KB_RERANKER_TIMEOUT_MS));

  try {
    if (provider === 'cohere') {
      return await cohereRerank(input, controller.signal);
    }
    if (provider === 'bge') {
      // Not implemented yet — keep the type exhaustive and safe.
      logger.debug('[RERANKER] bge provider requested but not implemented; skipping');
      return null;
    }
    // Exhaustiveness: unknown provider value → skip
    logger.warn('[RERANKER] Unknown provider', { provider });
    return null;
  } catch (error) {
    logger.warn('[RERANKER] Failed, falling back to original order', {
      provider,
      docsCount: input.docs.length,
      aborted: controller.signal.aborted,
      error: error instanceof Error ? error.message : String(error),
      elapsedMs: Date.now() - startedAt,
    });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Cohere adapter
// ─────────────────────────────────────────────────────────────────────────────

interface CohereRerankResponse {
  results?: Array<{
    index?: number;
    relevance_score?: number;
  }>;
}

async function cohereRerank(
  input: RerankInput,
  signal: AbortSignal
): Promise<RerankHit[] | null> {
  if (!env.COHERE_API_KEY) {
    logger.debug('[RERANKER] COHERE_API_KEY not configured; skipping');
    return null;
  }

  // Cohere Rerank v2 API: POST https://api.cohere.com/v2/rerank
  // Payload: { model, query, documents: string[], top_n?: int }
  const body = {
    model: env.KB_RERANKER_MODEL,
    query: input.query,
    documents: input.docs.map((d) => d.content),
    top_n: input.docs.length, // rerank all, let caller slice top-K
  };

  const res = await fetch('https://api.cohere.com/v2/rerank', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.COHERE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Cohere responded ${res.status}: ${errText.slice(0, 200)}`);
  }

  const payload = (await res.json()) as CohereRerankResponse;
  if (!payload || !Array.isArray(payload.results)) {
    throw new Error('Cohere response missing results[]');
  }

  // Map Cohere's { index, relevance_score } back to our doc ids and tag rank.
  const hits: RerankHit[] = [];
  for (let i = 0; i < payload.results.length; i++) {
    const r = payload.results[i];
    const idx = typeof r?.index === 'number' ? r.index : -1;
    const score = typeof r?.relevance_score === 'number' ? r.relevance_score : 0;
    if (idx < 0 || idx >= input.docs.length) continue;
    const doc = input.docs[idx];
    if (!doc) continue;
    hits.push({ id: doc.id, score, rank: i });
  }

  if (hits.length === 0) {
    throw new Error('Cohere returned no mappable results');
  }

  return hits;
}

/**
 * Convenience: apply rerank hits to a list of items, preserving items that
 * don't appear in hits (push them to the end). Falls back to identity when
 * hits is null. Pure utility, no async.
 */
export function applyRerank<T extends { id: string }>(
  items: T[],
  hits: RerankHit[] | null
): T[] {
  if (!hits || hits.length === 0) return items;

  const byId = new Map<string, T>(items.map((i) => [i.id, i]));
  const ordered: T[] = [];
  const used = new Set<string>();

  for (const hit of hits) {
    const item = byId.get(hit.id);
    if (item && !used.has(hit.id)) {
      ordered.push(item);
      used.add(hit.id);
    }
  }
  // Tail: anything that didn't get a rerank hit (shouldn't happen for
  // correct providers, but be defensive) keeps its original order.
  for (const item of items) {
    if (!used.has(item.id)) {
      ordered.push(item);
    }
  }
  return ordered;
}
