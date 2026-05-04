/**
 * Recorded-description LLM service (Etap 1D.3)
 *
 * Single responsibility: given the structural data the recorder captured
 * for a clicked/typed element (tag, role, text, ariaLabel, ancestor
 * landmarks, container titles, ...), return a short natural-language
 * description ("the Save button inside the user profile modal").
 *
 * Where the description goes:
 *   - persisted on `IntentStep.recordedDescription` (Etap 1D.3)
 *   - read at replay by the LLM element resolver as a 3rd channel
 *     alongside `recordedFingerprint` and the live page snapshot
 *     (Etap 1D.4 — wiring lands separately)
 *
 * Why LLM, not a template ("Click the {tag} {text}"):
 *   Templates work for buttons with strong text but produce awful
 *   descriptions for icon-only elements ("Click the button" — useless).
 *   The LLM weighs structural context (modal, landmark, container titles)
 *   to write something a human would understand. Multilingual support is
 *   free — Kazakh/Russian/English elements all get sensible phrasing.
 *
 * Performance:
 *   - Cache by hash of normalized input fields (in-memory, 24h TTL).
 *     Repeat captures of the same element type → 0ms.
 *   - Throttle: max 3 parallel LLM calls. Bursts (rapid clicks) queue;
 *     never dropped.
 *   - Per-call timeout 2500ms, fail-open (returns undefined).
 *
 * What this module does NOT do:
 *   - Read it back at replay (resolver does, in 1D.4).
 *   - Persist (`recording-capture.service.ts` orchestrates emit + save).
 *   - Validate description against the live DOM (would defeat the point —
 *     description is a soft hint, not a selector).
 */

import { createHash } from 'crypto';
import { generateTextWithGemini } from '@/services/ai/core/gemini.service';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { AI_MODELS, AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import type { ProbedElement } from './recording-capture.service';

// ───────────────────────────────────────────────────────────────────────
// Cache
// ───────────────────────────────────────────────────────────────────────

const DESC_CACHE_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const DESC_CACHE_EMPTY_TTL_MS = 60 * 60 * 1000;        // 1h
const DESC_CACHE_MAX_SIZE = 1000;
/** Bump when the prompt template changes — invalidates older cache entries. */
const PROMPT_VERSION = 'v1';
const MAX_DESCRIPTION_LEN = 120;

interface DescCacheEntry {
  description: string | undefined;
  createdAt: number;
}

const descCache = new Map<string, DescCacheEntry>();

function evictIfFull(): void {
  if (descCache.size < DESC_CACHE_MAX_SIZE) return;
  // FIFO evict — Map iteration order is insertion order in V8.
  const oldest = descCache.keys().next().value;
  if (oldest !== undefined) descCache.delete(oldest);
}

/**
 * Build a cache key from the stable subset of probe fields. Mutable
 * fields (boundingBox, ref) are excluded — repeat clicks on the same
 * element should hit cache even if the bbox shifted by a pixel.
 */
function buildCacheKey(element: ProbedElement): string {
  const e = element as any;
  const parts = [
    PROMPT_VERSION,
    element.tag || '',
    element.role || '',
    (element.text || '').trim().slice(0, 80),
    (element.ariaLabel || '').trim().slice(0, 80),
    element.labelText || '',
    element.placeholder || '',
    element.title || '',
    element.alt || '',
    e.iconLabel || '',
    e.svgIcon || '',
    e.customElementTag || '',
    element.nearestLandmark || '',
    (element.containerTitles || []).slice(0, 2).join('|'),
    // Etap 1B.2 identity fields — without these in the key, two inputs
    // with different formControlName ("email" vs "password") in the same
    // form collapse onto one cache entry and steal each other's
    // descriptions.
    e.formControlName || '',
    e.routerLink || '',
    // HTML form `name` is a primary disambiguator for `<input>` elements;
    // testIdAttr is the gold-standard identity. Both fields make it into
    // the prompt below, so the cache must reflect them.
    e.name || '',
    e.testId || e.testIdAttr || '',
  ];
  return createHash('sha256').update(parts.join('␟')).digest('hex');
}

// ───────────────────────────────────────────────────────────────────────
// Throttle (max 3 parallel)
// ───────────────────────────────────────────────────────────────────────

const MAX_PARALLEL = 3;
/**
 * Cap on queued (waiting-for-slot) requests. A burst of 1000 rapid clicks
 * would otherwise grow the queue unbounded and pin memory until each slot
 * resolves at ~150-300ms each (5 minutes for 1000 entries). Beyond the cap
 * we reject — caller treats `null` description the same as a failed LLM
 * call, no recording impact.
 */
const MAX_QUEUE_SIZE = 50;
let inFlight = 0;
const queue: Array<() => void> = [];

/**
 * Returns false when the queue is full — caller should skip the LLM
 * call entirely. We don't drop the OLDEST waiter (would surprise its
 * awaiter and risk a never-resolving promise) — we reject the NEWEST.
 */
function acquireSlot(): Promise<boolean> {
  if (inFlight < MAX_PARALLEL) {
    inFlight++;
    return Promise.resolve(true);
  }
  if (queue.length >= MAX_QUEUE_SIZE) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    queue.push(() => {
      inFlight++;
      resolve(true);
    });
  });
}

function releaseSlot(): void {
  inFlight--;
  const next = queue.shift();
  if (next) next();
}

// ───────────────────────────────────────────────────────────────────────
// Prompt
// ───────────────────────────────────────────────────────────────────────

function buildPrompt(element: ProbedElement): string {
  // Compact field rendering — only include fields that are actually
  // populated, so the prompt doesn't waste tokens on `ariaLabel: ""`.
  const lines: string[] = [];
  const push = (label: string, value: string | number | undefined): void => {
    if (value === undefined || value === null || value === '') return;
    const v = String(value).slice(0, 100);
    lines.push(`  ${label}: ${v}`);
  };
  const e = element as any;
  push('tag', element.tag);
  push('role', element.role);
  push('text', element.text);
  push('ariaLabel', element.ariaLabel);
  push('labelText', element.labelText);
  push('placeholder', element.placeholder);
  push('title', element.title);
  push('alt', element.alt);
  push('iconLabel', e.iconLabel);
  push('svgIcon', e.svgIcon);
  push('customElementTag', e.customElementTag);
  push('landmark', element.nearestLandmark);
  if (element.containerTitles && element.containerTitles.length > 0) {
    push('containerTitles', element.containerTitles.slice(0, 2).join(' > '));
  }
  // Etap 1B.2 identity fields. formControlName disambiguates form
  // inputs ("email" vs "password" inputs that look identical at tag
  // level). routerLink reveals navigation intent ("./profile" → user
  // profile link). HTML name is the legacy form identifier. testId is
  // the strongest signal when present — surface it explicitly so the
  // model can produce "the [data-testid] element" wording when nothing
  // visible distinguishes the target.
  push('formControlName', e.formControlName);
  push('routerLink', e.routerLink);
  push('name', e.name);
  push('testId', e.testId || e.testIdAttr);

  return [
    'Describe this UI element in ONE short sentence so a future test',
    'replay can find it again. Use its purpose plus the nearest visible',
    'context (modal name, section heading, table row label).',
    '',
    'Examples of GOOD descriptions:',
    '  - the Save button inside the user profile modal',
    '  - the notification bell icon in the header navigation',
    '  - the first row Edit button in the courses table',
    '  - the email input in the login form',
    '',
    'Rules:',
    '  - 1 sentence, ≤ 100 characters.',
    '  - No quotes. No trailing period.',
    '  - Use the element\'s language if its text is non-English.',
    '  - If you cannot identify a meaningful purpose, return an empty string.',
    '  - Output ONLY the description (or empty), nothing else.',
    '',
    'Element data:',
    ...lines,
  ].join('\n');
}

// ───────────────────────────────────────────────────────────────────────
// Public API
// ───────────────────────────────────────────────────────────────────────

/**
 * Generate a natural-language description of a probed element.
 *
 * Returns `undefined` for any of:
 *   - Element has no identifiable fields (empty everywhere)
 *   - LLM call fails / times out
 *   - LLM returns empty string (model judged the element undescribable)
 *
 * Returned string is capped at MAX_DESCRIPTION_LEN. Trimmed; surrounding
 * quotes / trailing period stripped defensively in case the model
 * ignores the prompt rules.
 *
 * Safe to fire-and-forget — fail-open by design. The recorder should
 * NOT block emit on this call.
 *
 * Cache: in-memory, 24h on success / 1h on empty. Repeat captures of
 * the same element shape are 0ms.
 */
export async function generateRecordedDescription(
  element: ProbedElement | null | undefined,
): Promise<string | undefined> {
  // Defensive — call sites guard with `if (probedElement)` but the type
  // system doesn't enforce non-null at every entry point, so we double-
  // check here. Without this, the cache key + prompt builders would
  // dereference undefined and throw.
  if (!element) return undefined;

  // Fast skip: elements with absolutely no descriptors → no point asking
  // the LLM, it'll return empty anyway and we'd burn cache + latency.
  const hasAnyDescriptor =
    !!element.text
    || !!element.ariaLabel
    || !!element.labelText
    || !!element.placeholder
    || !!element.title
    || !!element.alt
    || !!(element as any).iconLabel
    || !!(element as any).svgIcon
    || !!(element as any).customElementTag
    || !!element.nearestLandmark
    || (element.containerTitles && element.containerTitles.length > 0);
  if (!hasAnyDescriptor) return undefined;

  const key = buildCacheKey(element);
  const cached = descCache.get(key);
  if (cached) {
    const ttl = cached.description !== undefined
      ? DESC_CACHE_SUCCESS_TTL_MS
      : DESC_CACHE_EMPTY_TTL_MS;
    if (Date.now() - cached.createdAt < ttl) {
      return cached.description;
    }
  }

  // Throttle: drop on overflow rather than queue-forever. Empty result
  // tells caller "we couldn't enrich"; recording is unaffected.
  const acquired = await acquireSlot();
  if (!acquired) {
    logger.warn('[RECORDED_DESC_LLM] Queue full — dropping description', {
      tag: element.tag,
      role: element.role,
      queueDepth: queue.length,
    });
    // Cache the dropped attempt as empty so a flood of identical clicks
    // doesn't repeatedly try to acquire a slot. Short TTL (use the empty
    // bucket) so we retry the next time the user clicks this same shape.
    evictIfFull();
    descCache.set(key, { description: undefined, createdAt: Date.now() });
    return undefined;
  }
  let description: string | undefined;
  const startedAt = Date.now();
  // Primary: Gemini Flash Lite (cheap, fast, multilingual, native short-text).
  // Fallback: AI_MODELS.fast (gpt-5.4-mini) when Gemini is down (503 / timeout
  // / quota). Symmetric to stable-tokens-llm.service fallback pattern. We do
  // not retry the same provider — both calls together stay within a 5s soft
  // budget so the fire-and-forget hook's `:update` event arrives close enough
  // to feel "instant" on the editor.
  let rawContent: string | null = null;
  let providerUsed: 'gemini' | 'openai' | 'none' = 'none';
  try {
    const prompt = buildPrompt(element);
    try {
      const response = await generateTextWithGemini({
        prompt,
        model: AI_TASK_MODELS.recordedDescription,
        // temp=0.2 — slight creativity for phrasing while staying mostly
        // deterministic on identical inputs (same element clicked twice
        // shouldn't yield wildly different descriptions, otherwise the
        // resolver hint flips between runs).
        temperature: 0.2,
        maxTokens: 60,
        timeout: 2500,
      });
      rawContent = response.content || null;
      providerUsed = 'gemini';
    } catch (primaryErr) {
      const FALLBACK = AI_MODELS.fast;
      // Skip fallback when both primary and fallback are the same provider —
      // a Gemini outage cannot be rescued by another Gemini call. Detected
      // by prefix because models are named `gemini-*` / `gpt-*`.
      const sameProvider =
        AI_TASK_MODELS.recordedDescription.startsWith('gemini-') === FALLBACK.startsWith('gemini-');
      if (sameProvider) {
        logger.warn('[RECORDED_DESC_LLM] Primary failed and fallback is same provider — giving up', {
          tag: element.tag,
          role: element.role,
          latencyMs: Date.now() - startedAt,
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
      } else {
        logger.warn('[RECORDED_DESC_LLM] Primary Gemini failed, retrying with OpenAI fallback', {
          primary: AI_TASK_MODELS.recordedDescription,
          fallback: FALLBACK,
          tag: element.tag,
          error: primaryErr instanceof Error ? primaryErr.message : String(primaryErr),
        });
        try {
          const response = await getChatCompletionWithMessages(
            [{ role: 'user', content: prompt }],
            {
              model: FALLBACK,
              temperature: 0.2,
              max_tokens: 60,
              // No response_format — description is free text, not JSON.
            },
          );
          rawContent = response.content || null;
          providerUsed = 'openai';
        } catch (fallbackErr) {
          logger.warn('[RECORDED_DESC_LLM] Fallback OpenAI also failed — leaving description undefined', {
            tag: element.tag,
            latencyMs: Date.now() - startedAt,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
        }
      }
    }

    if (rawContent !== null) {
      description = sanitize(rawContent);
    }
  } finally {
    releaseSlot();
  }

  evictIfFull();
  descCache.set(key, { description, createdAt: Date.now() });

  logger.info('[RECORDED_DESC_LLM] Generated', {
    tag: element.tag,
    role: element.role,
    descLen: description?.length ?? 0,
    cacheKey: key.slice(0, 12),
    provider: providerUsed,
    latencyMs: Date.now() - startedAt,
  });

  return description;
}

/**
 * Strip surrounding quotes, trailing period, and clamp length. Trimmed
 * empty becomes undefined so callers can `if (description)` cleanly.
 */
function sanitize(raw: string): string | undefined {
  let s = raw.trim();
  // Strip wrapping quotes (model occasionally adds despite the rule).
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith('\'') && s.endsWith('\''))) {
    s = s.slice(1, -1).trim();
  }
  // Strip trailing punctuation.
  s = s.replace(/[.!?]+$/, '').trim();
  if (s.length === 0) return undefined;
  return s.slice(0, MAX_DESCRIPTION_LEN);
}
