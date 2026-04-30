/**
 * Stable-token extraction via LLM.
 *
 * Single responsibility: given a UI label, return 2-3 identifying tokens
 * that survive state changes (dates, statuses, counters). Used by
 * LocatorPlanBuilder to chain `:has-text()` selectors on long text where
 * the recorded full string is too brittle for replay.
 *
 * Why LLM, not heuristics:
 *   Hardcoded multilingual word lists (STATUS_WORDS / MONTH_WORDS in ru/kk/en)
 *   only cover languages we explicitly enumerate. LLM understands context
 *   regardless of language — "ЖЕЛТОҚСАН" is recognised as Kazakh December
 *   without us listing every Kazakh month. Maintenance cost ~ zero.
 *
 * Why low-temperature JSON mode:
 *   We want deterministic extraction — the same input must produce the
 *   same tokens, otherwise compiled plans drift between recordings of the
 *   same step. temp=0 + JSON schema gives us that.
 *
 * What this function does NOT do:
 *   - Pick selectors / strategies (that's LocatorPlanBuilder's job).
 *   - Pick elements (that's element-resolver's job).
 *   - Run on the live page (zero awareness of DOM — pure text in/out).
 */

import { createHash } from 'crypto';
import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS, AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { foldText } from './text-similarity.util';

// ───────────────────────────────────────────────────────────────────────
// Cache
// ───────────────────────────────────────────────────────────────────────

// In-memory only — tokens are deterministic given (text, prompt version)
// so a process restart re-derives them at most once per unique text. No
// Redis/DB wiring for the first iteration; revisit if hit-rate stays low.
//
// Two TTLs because non-empty and empty results have different cost shapes:
//
// SUCCESS_TTL = 24h — tokens at temp=0 + fixed prompt are deterministic,
//   so the cache COULD live forever. 24h is the self-heal window if Google
//   silently rolls a model update or we ship a buggy prompt without bumping
//   PROMPT_VERSION. Cost: ~$0.0001/call × 1000 unique labels = $0.10/day
//   worst case before any cache hits.
//
// EMPTY_TTL = 1h — empty results come from two sources we can't
//   distinguish: (a) legitimate fully-dynamic labels ("Order #123 placed
//   at 14:32") that will keep returning empty forever, and (b) transient
//   LLM failures whose tokens got rejected by validation. NOT caching
//   empty bursts the LLM on every plan build for case (a). Caching with
//   24h freezes case (b) for a day. 1h compromises: we re-ask the LLM
//   hourly, which catches transient failures on the next replay session
//   while keeping cost bounded for fully-dynamic labels.
const TOKEN_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const TOKEN_CACHE_EMPTY_TTL_MS = 60 * 60 * 1000;        // 1h
const TOKEN_CACHE_MAX_SIZE = 1000;

interface TokenCacheEntry {
  tokens: string[];
  createdAt: number;
}

const tokenCache = new Map<string, TokenCacheEntry>();

function cacheKey(text: string): string {
  // Trim + collapse whitespace so "Save  " and "Save" hit same slot.
  // Hash the FULL normalized text (sha256 → 64-char hex). Earlier
  // implementation truncated to 500 chars without hashing — two distinct
  // labels longer than 500 chars sharing a prefix would collide on the
  // same slot, returning each other's tokens. Realistic on dashboards
  // that prefix every card with the same boilerplate
  // ("Курс по математике для школьников ...") and only differ at the end.
  const normalized = text.trim().replace(/\s+/g, ' ');
  return createHash('sha256').update(normalized).digest('hex');
}

function evictIfFull(): void {
  if (tokenCache.size < TOKEN_CACHE_MAX_SIZE) return;
  // LRU-ish: drop the oldest 10% by createdAt. Map iteration order is
  // insertion order, which is good enough — we don't track read recency
  // for first iteration.
  const dropCount = Math.max(1, Math.floor(TOKEN_CACHE_MAX_SIZE * 0.1));
  const keys = Array.from(tokenCache.keys()).slice(0, dropCount);
  for (const k of keys) tokenCache.delete(k);
}

// ───────────────────────────────────────────────────────────────────────
// Prompt
// ───────────────────────────────────────────────────────────────────────

// Bumped on prompt edits to invalidate caches across deploys without a
// flag — we just want every (text, version) pair to re-derive once.
const PROMPT_VERSION = 'v1';

const SYSTEM_PROMPT = `You extract stable identifying tokens from a UI label so a test runner can find the same element after dynamic parts change.

Rules:
1. Return 2-3 tokens that uniquely identify this element regardless of state.
2. Prefer brand names, proper nouns, IDs, codes. KEEP compound words intact ("МАТ-SMART", "iPhone 14").
3. Drop tokens that change between runs:
   - Dates / months / weekdays in any language
   - Status words ("completed", "active", "draft", "аяқталды", "завершён")
   - Counters / numbers that look like timestamps or counts (#12345, "2 unread")
4. If the label is fully dynamic (e.g. "Order #492837 placed at 14:32") return an empty list.
5. Each returned token MUST appear as a substring in the input — never paraphrase or translate.
6. Tokens are returned with their ORIGINAL casing.

Return JSON only: {"tokens": ["...", "..."]}`;

function buildPrompt(text: string): string {
  // Truncate at 200 chars — long labels typically have brand at the start;
  // anything past that is description/copy that's likely volatile anyway.
  const truncated = text.length > 200 ? text.slice(0, 200) + '…' : text;
  return `${SYSTEM_PROMPT}\n\nLabel: "${truncated}"\n\nJSON:`;
}

// ───────────────────────────────────────────────────────────────────────
// Validation
// ───────────────────────────────────────────────────────────────────────

interface LlmResponseShape {
  tokens?: unknown;
}

/**
 * Strict-validate the LLM response. Returns the tokens array if it
 * conforms, otherwise null. We INTENTIONALLY don't try to be lenient —
 * a malformed response means fall back to no-LLM behaviour, not patch
 * around the model.
 */
function parseAndValidateResponse(raw: string, originalText: string): string[] | null {
  let parsed: LlmResponseShape;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const tokens = parsed.tokens;
  if (!Array.isArray(tokens)) return null;

  // Fold Cyrillic glyph-twins (М→m, А→a, Т→t, ...) before substring
  // check. LLM occasionally returns the Latin spelling of a Cyrillic
  // brand ("MAT-SMART" instead of recorded "МАТ-SMART") because Cyrillic
  // and Latin glyphs are visually identical for ~10 letter pairs and
  // the model's tokenizer can normalise. Without folding, the substring
  // check rejects a perfectly valid token. foldText is the same
  // normalisation our post-click guards use — keeping the two layers
  // symmetric prevents drift between "what builder writes" and "what
  // guard accepts".
  const foldedOriginal = foldText(originalText.toLowerCase());
  const validated: string[] = [];
  for (const t of tokens) {
    if (typeof t !== 'string') continue;
    const trimmed = t.trim();
    // Length sanity bounds: < 2 chars is too generic to anchor on
    // (single letters / digits collide on busy pages); > 60 chars
    // means the LLM returned a paraphrased phrase, not a token.
    if (trimmed.length < 2 || trimmed.length > 60) continue;
    // Substring check (after Cyrillic↔Latin fold + lowercase) catches
    // hallucinations and translations. This is the hardest guard —
    // without it we'd let LLM drift into making up plausible-looking
    // tokens.
    const foldedToken = foldText(trimmed.toLowerCase());
    if (!foldedOriginal.includes(foldedToken)) continue;
    // De-dup against case/script variants we already accepted (folded
    // form is the canonical comparison key).
    if (validated.some(v => foldText(v.toLowerCase()) === foldedToken)) continue;
    validated.push(trimmed);
    if (validated.length >= 3) break;
  }
  return validated;
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

/**
 * Extract up to 3 stable identifying tokens from a UI label via LLM.
 *
 * Returns `[]` for any of:
 *   - Input shorter than 10 chars (short labels work fine with full-text match)
 *   - LLM call fails / times out
 *   - LLM returns invalid JSON
 *   - All returned tokens fail substring validation (hallucinations)
 *
 * Returned tokens are in the ORIGINAL casing — caller decides whether
 * to fold them. Order is the LLM's preferred order (most identifying first).
 *
 * Cache: in-memory, keyed on (PROMPT_VERSION, normalized text). Cache
 * miss costs one Gemini Flash Lite call (~150-300ms). Cache hits are 0ms.
 *
 * Safe to await on hot paths — fail-open by design.
 */
export async function extractStableTokensViaLLM(text: string | undefined | null): Promise<string[]> {
  if (!text || text.length < 10) return [];

  const key = `${PROMPT_VERSION}|${cacheKey(text)}`;
  const cached = tokenCache.get(key);
  if (cached) {
    const ttl = cached.tokens.length > 0
      ? TOKEN_CACHE_SUCCESS_TTL_MS
      : TOKEN_CACHE_EMPTY_TTL_MS;
    if (Date.now() - cached.createdAt < ttl) {
      return cached.tokens;
    }
  }

  let tokens: string[] = [];
  const startedAt = Date.now();
  const prompt = buildPrompt(text);

  // Primary: Gemini Flash Lite (cheap, fast, multilingual).
  // Fallback: AI_MODELS.fast (gpt-5.4-mini) when Gemini is down (503/timeout).
  // Symmetric to intent-step-lint.service V23 fallback pattern.
  let rawContent: string | null = null;
  try {
    const response = await generateTextWithGemini({
      prompt,
      model: AI_TASK_MODELS.stableTokens,
      temperature: 0,
      maxTokens: 200,
      timeout: 3000,
      jsonMode: true,
    });
    rawContent = response.content;
  } catch (primaryErr) {
    const FALLBACK = AI_MODELS.fast;
    const sameProvider = AI_TASK_MODELS.stableTokens.startsWith('gemini-') === FALLBACK.startsWith('gemini-');
    if (sameProvider) {
      logger.warn('[STABLE_TOKENS_LLM] Primary failed and fallback uses same provider — giving up', {
        textLen: text.length,
        latencyMs: Date.now() - startedAt,
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });
    } else {
      logger.warn('[STABLE_TOKENS_LLM] Primary Gemini failed, retrying with OpenAI fallback', {
        primary: AI_TASK_MODELS.stableTokens,
        fallback: FALLBACK,
        error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
      });
      try {
        const response = await getChatCompletionWithMessages(
          [{ role: 'user', content: prompt }],
          {
            model: FALLBACK,
            temperature: 0,
            max_tokens: 200,
            response_format: { type: 'json_object' },
          },
        );
        rawContent = response.content;
      } catch (fallbackErr) {
        logger.warn('[STABLE_TOKENS_LLM] Fallback OpenAI also failed — using empty fallback', {
          textLen: text.length,
          latencyMs: Date.now() - startedAt,
          error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
      }
    }
  }

  if (rawContent !== null) {
    const validated = parseAndValidateResponse(rawContent, text);
    tokens = validated ?? [];
    if (validated === null) {
      logger.warn('[STABLE_TOKENS_LLM] Response validation failed — using empty fallback', {
        textLen: text.length,
        responsePreview: rawContent.slice(0, 80),
      });
    } else {
      logger.info('[STABLE_TOKENS_LLM] Extracted', {
        textPreview: text.slice(0, 60),
        textLen: text.length,
        tokens,
        tokenCount: tokens.length,
        latencyMs: Date.now() - startedAt,
      });
    }
  }

  // Cache both non-empty and empty results, but with different TTLs (see
  // TOKEN_CACHE_SUCCESS_TTL_MS / TOKEN_CACHE_EMPTY_TTL_MS at top). The
  // shorter empty-TTL caches fully-dynamic labels for an hour to bound
  // cost while still re-asking on the next replay session in case the
  // empty was a transient validation failure.
  evictIfFull();
  tokenCache.set(key, { tokens, createdAt: Date.now() });
  return tokens;
}

// ───────────────────────────────────────────────────────────────────────
// Test helpers (not exported through index)
// ───────────────────────────────────────────────────────────────────────

/**
 * Invalidate the cached tokens for a given recorded text.
 *
 * Called by the wrong-element guards (preview-step-apply.service.ts) when
 * a click is rejected as fake-success or wrong target — the compiled plan
 * that drove the click may have used token-based strategies built from
 * cached tokens. If those tokens were the cause of the wrong pick, we
 * MUST drop them so the next plan build re-asks the LLM with a fresh
 * sample. Without this, a single bad LLM response freezes a brittle
 * plan in cache for 24h.
 *
 * Symmetric to `invalidateLlmSelectionsForRef` in element-resolver —
 * both close the feedback loop from "rejection" back to "cached input".
 *
 * Returns true if a cache entry was actually removed; false if the text
 * was not cached. Caller can use this for diagnostics / metrics.
 */
export function invalidateTokensForText(text: string | undefined | null): boolean {
  if (!text || text.length < 10) return false;
  const key = `${PROMPT_VERSION}|${cacheKey(text)}`;
  return tokenCache.delete(key);
}

/** @internal — for tests only. Resets cache between runs. */
export function _resetTokenCacheForTests(): void {
  tokenCache.clear();
}

/** @internal — for tests only. Inspects cache state. */
export function _getTokenCacheSizeForTests(): number {
  return tokenCache.size;
}
