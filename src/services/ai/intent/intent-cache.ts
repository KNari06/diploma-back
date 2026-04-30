/**
 * Intent-parser short-TTL cache.
 *
 * Purpose: kill duplicates from double-submits, rapid retries, and the
 * occasional UI bug where the same message fires twice. NOT a correctness
 * cache — if the user's situation changed, the cache MUST miss.
 *
 * Key design:
 *   The cache key is a sha256 over `(message, projectId, availableIntents,
 *   context-digest)`. The context-digest covers every field of
 *   IntentParserContext that can change the classifier's correct answer
 *   (mode, previewSessionId, mobileSessionId, lastTestId, lastFailedTestId,
 *   last 3 chat messages). Anything that doesn't affect the answer — RAG
 *   docs, traces — is excluded so we don't miss cache on cosmetic drift.
 *
 * TTL: 60s. Long enough to absorb double-submits (<2s) and rage-clicks
 * (~10-30s), short enough that stale context never wins over a genuine
 * re-query. Deliberately NOT longer — 1 minute is the ceiling.
 *
 * Size cap: 500 entries. LRU-ish via Map insertion order (Map preserves
 * insertion order, so `keys().next().value` gives the oldest entry).
 *
 * Kill-switch: INTENT_CACHE_DISABLED=true in env.
 */

import { createHash } from 'node:crypto';
import type { IntentResult } from '@/types';
import type { IntentParserContext } from '@/ai/prompts/index';
import { env } from '@/config/environment/env';
import { logger } from '@/utils/core/logger';

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_SIZE = 500;
const CLEANUP_INTERVAL_MS = 5 * 60_000;

interface CacheEntry {
  result: IntentResult;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();

// Metrics — exposed so phase 3 / future dashboards can read hit rate.
let hits = 0;
let misses = 0;

// Periodic sweep. Held over the module lifetime; harmless in tests.
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of cache.entries()) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logger.debug('[INTENT_CACHE] expired sweep', {
      cleaned,
      remaining: cache.size,
    });
  }
}, CLEANUP_INTERVAL_MS).unref?.();

// ─────────────────────────────────────────────────────────────────────────
// Key building — must be deterministic and cover everything that can flip
// the correct answer. Adding a new context field? Add it here.
// ─────────────────────────────────────────────────────────────────────────

export function buildIntentCacheKey(
  message: string,
  context: IntentParserContext | undefined,
  projectId: string | undefined,
  availableIntents: string[] | undefined,
): string {
  const contextDigest = context
    ? {
        mode: context.mode ?? null,
        preview: context.previewSessionId ?? null,
        mobile: context.mobileSessionId ?? null,
        lastTest: context.lastTestId ?? null,
        lastFailed: context.lastFailedTestId ?? null,
        currentStatus: context.currentTestStatus ?? null,
        // Only the last 3 turns matter for intent classification. Full
        // history would explode the cardinality and give ~0% hit rate.
        history: (context.chatHistory ?? [])
          .slice(-3)
          .map((m) => `${m.role}:${(m.content || '').slice(0, 200)}`),
      }
    : null;

  const payload = JSON.stringify({
    m: message.trim(),
    p: projectId ?? null,
    i: availableIntents ? [...availableIntents].sort() : null,
    c: contextDigest,
  });
  return createHash('sha256').update(payload).digest('hex');
}

// ─────────────────────────────────────────────────────────────────────────
// Read / write
// ─────────────────────────────────────────────────────────────────────────

export function getCachedIntent(key: string): IntentResult | null {
  if (env.INTENT_CACHE_DISABLED === true) return null;
  const entry = cache.get(key);
  if (!entry) {
    misses++;
    return null;
  }
  if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(key);
    misses++;
    return null;
  }
  hits++;
  return entry.result;
}

export function setCachedIntent(key: string, result: IntentResult): void {
  if (env.INTENT_CACHE_DISABLED === true) return;
  // Evict the oldest entry when full. Map.keys() returns insertion order,
  // so the first key is the least-recently-added.
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { result, timestamp: Date.now() });
}

export function getIntentCacheStats(): {
  size: number;
  hits: number;
  misses: number;
  hitRate: number;
} {
  const total = hits + misses;
  return {
    size: cache.size,
    hits,
    misses,
    hitRate: total > 0 ? hits / total : 0,
  };
}

/** Test-only helper. */
export function __resetIntentCacheForTests(): void {
  cache.clear();
  hits = 0;
  misses = 0;
}
