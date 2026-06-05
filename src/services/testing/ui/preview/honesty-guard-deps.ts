/**
 * Dependency closures for the honesty guard's L2 (embedding) and L3 (LLM-judge)
 * layers. Kept OUT of `semantic-match.util.ts` (which must stay pure / no
 * network) and OUT of the already-huge `element-resolver.service.ts`.
 *
 * The guard receives these as injected closures — so the pure module never
 * imports the AI stack, and unit tests inject fakes instead of mocking network.
 *
 * Both layers are best-effort and fail-OPEN:
 *   - L2 embedding errors degrade to the lexical reject (never block resolve).
 *   - L3 judge is flag-gated (default OFF) and only consulted in the ambiguous
 *     cosine band; errors degrade to reject.
 *
 * Caching:
 *   - embeddings: Redis, content-addressed (`honesty:emb:v1:<sha1(text)>`),
 *     1h TTL — page-stable labels are reused across many steps.
 *   - judge verdicts: in-process Map + TTL (page+text keyed).
 * Cost: best-effort via the injected `testId` (skipped when absent).
 */

import { createHash } from 'crypto';
import { generateEmbedding } from '@/services/ai/core/embedding.service';
import { generateText } from '@/services/ai/core/ai-provider.service';
import { cosineSimilarity } from '@/utils/text-processing/vector';
import { cache } from '@/utils/core/redis-cache';
import { cacheMetrics } from '@/utils/core/cache-metrics';
import { logger } from '@/utils/core/logger';
import type { HonestySemanticDeps, HonestyJudgeDeps } from './semantic-match.util';

const EMB_TTL_SECONDS = 60 * 60; // 1h — embeddings are content-stable
const JUDGE_TTL_MS = 60 * 60 * 1000;
const JUDGE_CACHE_MAX = 500;

/**
 * L3 judge is the only non-deterministic layer. Shipped dark: default OFF.
 * Flip `HONESTY_GUARD_JUDGE=true|1|yes|on` once band-hit rate + sampled verdicts
 * look right in logs.
 */
export function isJudgeEnabled(): boolean {
  const v = (process.env.HONESTY_GUARD_JUDGE || '').trim().toLowerCase();
  return v === 'true' || v === '1' || v === 'yes' || v === 'on';
}

const sha1 = (s: string): string => createHash('sha1').update(s).digest('hex');

/** Embedding closures with Redis caching + best-effort cost. */
export function buildSemanticDeps(testId?: string): HonestySemanticDeps {
  const embed = async (text: string): Promise<number[]> => {
    const key = `honesty:emb:v1:${sha1(text)}`;
    try {
      const cached = await cache.get<number[]>(key);
      if (cached && Array.isArray(cached) && cached.length > 0) {
        cacheMetrics.inc('honesty-embed', 'hit');
        return cached;
      }
    } catch { /* cache miss / down — proceed to compute */ }
    cacheMetrics.inc('honesty-embed', 'miss');
    const vec = await generateEmbedding(text); // throws → caught by guard (fail-open)
    try { await cache.set(key, vec, EMB_TTL_SECONDS); } catch { /* non-fatal */ }
    recordCostBestEffort(testId, 'honesty_embed', 'text-embedding-3-small', Math.ceil(text.length / 4), 0);
    return vec;
  };
  return { embed, cosine: cosineSimilarity };
}

/** Judge closure (yes/no) with in-process verdict cache + best-effort cost. */
export function buildJudgeDeps(pageKey: string, testId?: string): HonestyJudgeDeps {
  const ask = async (intent: string, label: string): Promise<boolean | null> => {
    const key = `${pageKey}:${sha1(intent)}:${sha1(label)}`;
    const hit = judgeCacheGet(key);
    if (hit !== undefined) { cacheMetrics.inc('honesty-judge', 'hit'); return hit; }
    cacheMetrics.inc('honesty-judge', 'miss');
    const prompt =
      `You verify whether a UI element matches a user's intent.\n` +
      `INTENT: "${intent.slice(0, 120)}"\n` +
      `ELEMENT LABEL: "${label.slice(0, 120)}"\n` +
      `Could a user reasonably mean this element by that intent? Answer one word: yes or no.`;
    let verdict: boolean | null = null;
    try {
      const res = await generateText({ prompt, task: 'fast', temperature: 0, maxTokens: 5, timeout: 5000 });
      const ans = (res?.content || '').trim().toLowerCase();
      verdict = ans.startsWith('yes') ? true : ans.startsWith('no') ? false : null;
      const u = res?.usage;
      if (u) recordCostBestEffort(testId, 'honesty_judge', u.model || 'gemini-2.5-flash-lite', u.inputTokens || 0, u.outputTokens || 0);
    } catch (err) {
      logger.debug('[HONESTY_JUDGE] ask failed — fail-open to reject', { error: err instanceof Error ? err.message : String(err) });
      verdict = null;
    }
    judgeCacheSet(key, verdict);
    return verdict;
  };
  return { ask };
}

// ── in-process judge verdict cache (TTL + simple size cap) ──────────────────
const judgeCache = new Map<string, { v: boolean | null; ts: number }>();
function judgeCacheGet(key: string): boolean | null | undefined {
  const e = judgeCache.get(key);
  if (!e) return undefined;
  if (Date.now() - e.ts >= JUDGE_TTL_MS) { judgeCache.delete(key); return undefined; }
  return e.v;
}
function judgeCacheSet(key: string, v: boolean | null): void {
  if (judgeCache.size >= JUDGE_CACHE_MAX) {
    const oldest = judgeCache.keys().next().value;
    if (oldest !== undefined) judgeCache.delete(oldest);
  }
  judgeCache.set(key, { v, ts: Date.now() });
}

// ── best-effort cost recording (never throws) ───────────────────────────────
function recordCostBestEffort(
  testId: string | undefined,
  operation: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
): void {
  if (!testId) return;
  try {
    // Lazy require to avoid a hard import cycle / pulling cost stack into the
    // pure-ish resolver path when cost tracking isn't configured.
    const { getCostManager } = require('@/services/ai/cost/ai-cost-manager.service');
    getCostManager(testId).recordOperation({ operation, model, inputTokens, outputTokens });
  } catch { /* best-effort — telemetry/cost writes never fail the resolve path */ }
}
