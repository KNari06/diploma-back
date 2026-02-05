/**
 * LLM Disambiguation Service
 *
 * Provides LLM-based disambiguation for ambiguous element matching scenarios.
 * Used when embeddings produce multiple candidates with high similarity and
 * deterministic rules cannot select a single best match.
 *
 * Architecture:
 * 1. Receives topK candidates already ranked by embeddings
 * 2. Builds a privacy-safe prompt with minimal element info
 * 3. Calls gpt-4o-mini for fast disambiguation
 * 4. Validates response (ref must exist in candidate list)
 * 5. Returns selected ref + confidence or null if LLM can't decide
 *
 * Features:
 * - TTL cache to avoid repeated LLM calls for same intent+candidates
 * - Hard validation: returned ref MUST be in candidate list
 * - Confidence threshold for aggressive auto-selection
 * - Timeout handling with graceful fallback
 */

import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { IntentActionType, InteractiveNode } from './preview.types';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/** Confidence threshold for auto-selection (aggressive mode) */
const CONFIDENCE_THRESHOLD = 0.75;

/** Maximum candidates to send to LLM */
const MAX_CANDIDATES_FOR_LLM = 5;

/** LLM timeout in milliseconds */
const LLM_TIMEOUT_MS = 2000;

/** Cache TTL in milliseconds (5 minutes) */
const CACHE_TTL_MS = 5 * 60 * 1000;

/** Maximum allowed candidates before skipping LLM (to avoid waste) */
const MAX_ALLOWED_FOR_LLM = 50;

/** Model to use for disambiguation */
const LLM_MODEL = 'gpt-4o-mini';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Timeout error used by this service to classify LLM call timeouts.
 */
class LLMTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMTimeoutError';
  }
}

/**
 * Run a promise with a hard timeout, clearing timers correctly.
 *
 * IMPORTANT: We MUST clear the timeout timer when the main promise resolves
 * to avoid leaking timers (Jest open handles) and late unhandled rejections.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new LLMTimeoutError(timeoutMessage)), timeoutMs);
    // Avoid keeping the Node.js event loop alive (helps tests / workers exit)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (timeoutId as any)?.unref?.();
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Candidate info passed to LLM (privacy-safe subset of InteractiveNode)
 */
export interface DisambiguationCandidate {
  ref: string;
  labelText?: string;
  ariaLabel?: string;
  text?: string;
  placeholder?: string;
  name?: string;
  tag: string;
  role?: string;
  containerTitles?: string[];
  boundingBox?: { x: number; y: number; width: number; height: number };
}

/**
 * LLM disambiguation result
 */
export interface DisambiguationResult {
  /** Selected ref (null if LLM couldn't decide) */
  selectedRef: string | null;
  /** LLM confidence score (0-1) */
  confidence: number;
  /** LLM reasoning for the selection */
  reason: string;
  /** Whether result came from cache */
  cacheHit: boolean;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Whether LLM was skipped (too many candidates, timeout, etc.) */
  skipped: boolean;
  /** Reason for skipping (if applicable) */
  skipReason?: string;
}

/**
 * Parameters for disambiguation
 */
export interface DisambiguationParams {
  /** User's intent description (sanitized) */
  userIntent: string;
  /** Action type (click, type, etc.) */
  actionType: IntentActionType;
  /** Current page URL */
  pageUrl: string;
  /** Candidates already ranked by embeddings (topK) */
  candidates: DisambiguationCandidate[];
  /** Total allowed candidates count (for skip decision) */
  totalAllowedCount: number;
  /** Page signature for cache key */
  pageSignature: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// CACHE
// ═══════════════════════════════════════════════════════════════════════════

interface CacheEntry {
  result: DisambiguationResult;
  createdAt: number;
}

/**
 * Cache key: pageSignature + actionType + hash(intentText) + topCandidateRefs
 */
function buildCacheKey(params: DisambiguationParams): string {
  const refsHash = params.candidates
    .slice(0, MAX_CANDIDATES_FOR_LLM)
    .map(c => c.ref)
    .sort()
    .join(',');
  return `${params.pageSignature}|${params.actionType}|${hashString(params.userIntent)}|${refsHash}`;
}

/**
 * Simple string hash for cache key
 */
function hashString(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/** In-memory cache for disambiguation results */
const disambiguationCache = new Map<string, CacheEntry>();

/**
 * Get cached result if valid
 */
function getCachedResult(key: string): DisambiguationResult | null {
  const entry = disambiguationCache.get(key);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    disambiguationCache.delete(key);
    return null;
  }

  return { ...entry.result, cacheHit: true };
}

/**
 * Store result in cache
 */
function cacheResult(key: string, result: DisambiguationResult): void {
  disambiguationCache.set(key, {
    result,
    createdAt: Date.now(),
  });
}

/**
 * Clear disambiguation cache (for testing or session cleanup)
 */
export function clearDisambiguationCache(): void {
  disambiguationCache.clear();
}

// ═══════════════════════════════════════════════════════════════════════════
// PROMPT BUILDING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * System prompt for disambiguation
 * Concise and focused on selecting the single best element
 */
const DISAMBIGUATION_SYSTEM_PROMPT = `You are an AI element selector for a browser testing tool.

TASK: Given a user's intent (any language) and multiple matching UI elements, select the SINGLE best element.

RULES:
1. Select the element that BEST matches the user's intent semantically (do not translate literally; use multilingual understanding)
2. Use action-type semantics to prefer the correct *kind* of control:
   - click: prefer <button>, <a>, <input type=button|submit>, or role=button|link. Avoid plain <span>/<div> unless it has an interactive role (e.g., role=button) or is clearly a control.
   - type: prefer <input>, <textarea>, or role=textbox/searchbox. Avoid non-editable containers.
   - select: prefer <select> or role=combobox.
   - check/uncheck/toggle: prefer checkbox/radio/switch controls (input[type=checkbox|radio] or role=checkbox|radio|switch).
3. Consider: label text, aria-label, placeholder, visible text, container context, and position.
4. Tie-breaker when truly equal: prefer the one higher on the page (smaller y), then more to the left (smaller x).
5. ONLY use refs from the provided list - never invent refs.
6. If you cannot confidently select exactly one, return ref as null.
7. Respond ONLY with valid JSON, no markdown or extra text.

OUTPUT FORMAT:
{
  "ref": "eXX",
  "confidence": 0.0-1.0,
  "reason": "brief explanation"
}

If you cannot confidently select exactly one element, set "ref" to null (still return valid JSON).`;

/**
 * Build user prompt with candidate info
 */
function buildDisambiguationPrompt(params: DisambiguationParams): string {
  const candidateList = params.candidates
    .slice(0, MAX_CANDIDATES_FOR_LLM)
    .map((c, i) => {
      const attrs: string[] = [];
      if (c.labelText) attrs.push(`label="${c.labelText}"`);
      if (c.ariaLabel) attrs.push(`aria-label="${c.ariaLabel}"`);
      if (c.text) attrs.push(`text="${c.text.slice(0, 50)}"`);
      if (c.placeholder) attrs.push(`placeholder="${c.placeholder}"`);
      if (c.name) attrs.push(`name="${c.name}"`);
      if (c.role) attrs.push(`role="${c.role}"`);
      if (c.containerTitles && c.containerTitles.length > 0) {
        attrs.push(`container="${c.containerTitles.slice(0, 2).join(' > ')}"`);
      }
      if (c.boundingBox) {
        attrs.push(`position=(${Math.round(c.boundingBox.x)},${Math.round(c.boundingBox.y)})`);
      }
      return `${i + 1}. ref="${c.ref}" <${c.tag}> ${attrs.join(' ')}`;
    })
    .join('\n');

  return `USER INTENT: "${params.userIntent}"
ACTION: ${params.actionType}
PAGE: ${params.pageUrl}

CANDIDATE ELEMENTS:
${candidateList}

Select the single best matching element. If unsure, return ref: null.`;
}

// ═══════════════════════════════════════════════════════════════════════════
// RESPONSE PARSING
// ═══════════════════════════════════════════════════════════════════════════

interface LLMResponse {
  ref: string | null;
  confidence: number;
  reason: string;
}

/**
 * Parse LLM response with strict validation
 */
function parseDisambiguationResponse(
  response: string,
  validRefs: Set<string>
): LLMResponse | null {
  try {
    // Extract JSON from response (handles markdown code blocks)
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[LLM_DISAMBIGUATION] No JSON found in response', {
        responsePreview: response.slice(0, 200),
      });
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as Partial<LLMResponse>;

    // Validate ref (null is allowed)
    if (parsed.ref !== null && typeof parsed.ref !== 'string') {
      logger.warn('[LLM_DISAMBIGUATION] Invalid ref type', { ref: parsed.ref });
      return null;
    }

    // CRITICAL: Validate ref exists in candidate list (guardrail against hallucination)
    if (parsed.ref !== null && !validRefs.has(parsed.ref)) {
      logger.warn('[LLM_DISAMBIGUATION] Hallucinated ref rejected', {
        ref: parsed.ref,
        validRefs: Array.from(validRefs),
      });
      return null;
    }

    // Validate confidence
    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(1, Math.max(0, parsed.confidence))
      : 0;

    // Validate reason
    const reason = typeof parsed.reason === 'string'
      ? parsed.reason.slice(0, 200)
      : 'No reason provided';

    return {
      ref: parsed.ref ?? null,
      confidence,
      reason,
    };
  } catch (error) {
    logger.warn('[LLM_DISAMBIGUATION] Failed to parse response', {
      error: error instanceof Error ? error.message : String(error),
      responsePreview: response.slice(0, 200),
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN DISAMBIGUATION FUNCTION
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Disambiguate between multiple candidates using LLM
 *
 * This is called when embeddings ranking produces multiple candidates
 * and deterministic rules cannot select a single best match.
 *
 * @param params - Disambiguation parameters
 * @returns Disambiguation result with selected ref or null
 */
export async function disambiguateWithLLM(
  params: DisambiguationParams
): Promise<DisambiguationResult> {
  const startTime = Date.now();

  // Skip if too many candidates (waste of LLM tokens)
  if (params.totalAllowedCount > MAX_ALLOWED_FOR_LLM) {
    logger.debug('[LLM_DISAMBIGUATION] Skipped: too many candidates', {
      totalAllowedCount: params.totalAllowedCount,
      threshold: MAX_ALLOWED_FOR_LLM,
    });
    return {
      selectedRef: null,
      confidence: 0,
      reason: 'Too many candidates for LLM disambiguation',
      cacheHit: false,
      latencyMs: 0,
      skipped: true,
      skipReason: 'too_many_candidates',
    };
  }

  // Skip if no candidates
  if (params.candidates.length === 0) {
    return {
      selectedRef: null,
      confidence: 0,
      reason: 'No candidates provided',
      cacheHit: false,
      latencyMs: 0,
      skipped: true,
      skipReason: 'no_candidates',
    };
  }

  // Skip if only one candidate (should be resolved by caller)
  if (params.candidates.length === 1) {
    return {
      selectedRef: params.candidates[0].ref,
      confidence: 0.9,
      reason: 'Single candidate auto-selected',
      cacheHit: false,
      latencyMs: 0,
      skipped: false,
    };
  }

  // Check cache first
  const cacheKey = buildCacheKey(params);
  const cachedResult = getCachedResult(cacheKey);
  if (cachedResult) {
    logger.debug('[LLM_DISAMBIGUATION] Cache hit', {
      cacheKey: cacheKey.slice(0, 50),
      selectedRef: cachedResult.selectedRef,
    });
    return cachedResult;
  }

  // Build prompt
  const userPrompt = buildDisambiguationPrompt(params);
  const validRefs = new Set(params.candidates.map(c => c.ref));

  // Call LLM with timeout
  try {
    const llmPromise = getChatCompletionWithMessages(
      [
        { role: 'system', content: DISAMBIGUATION_SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      {
        model: LLM_MODEL,
        temperature: 0.1, // Low temperature for consistent selection
        max_tokens: 150, // Short response needed
        response_format: { type: 'json_object' },
      }
    );

    const response = await withTimeout(llmPromise, LLM_TIMEOUT_MS, 'LLM_TIMEOUT');
    const latencyMs = Date.now() - startTime;

    // Parse response
    const parsed = parseDisambiguationResponse(response.content, validRefs);

    if (!parsed) {
      logger.warn('[LLM_DISAMBIGUATION] Failed to parse LLM response', {
        latencyMs,
        responsePreview: response.content.slice(0, 100),
      });
      const result: DisambiguationResult = {
        selectedRef: null,
        confidence: 0,
        reason: 'Failed to parse LLM response',
        cacheHit: false,
        latencyMs,
        skipped: false,
      };
      cacheResult(cacheKey, result);
      return result;
    }

    // Apply confidence threshold
    const shouldSelect = parsed.ref !== null && parsed.confidence >= CONFIDENCE_THRESHOLD;

    const result: DisambiguationResult = {
      selectedRef: shouldSelect ? parsed.ref : null,
      confidence: parsed.confidence,
      reason: parsed.reason,
      cacheHit: false,
      latencyMs,
      skipped: false,
    };

    // Log decision
    logger.info('[LLM_DISAMBIGUATION] Disambiguation complete', {
      event: 'llm_disambiguation',
      selectedRef: result.selectedRef,
      confidence: parsed.confidence,
      confidenceThreshold: CONFIDENCE_THRESHOLD,
      meetsThreshold: shouldSelect,
      latencyMs,
      candidateCount: params.candidates.length,
      reason: parsed.reason.slice(0, 100),
    });

    // Cache result
    cacheResult(cacheKey, result);

    return result;
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorMessage = error instanceof Error ? error.message : String(error);
    const isTimeout = error instanceof LLMTimeoutError || errorMessage === 'LLM_TIMEOUT';

    logger.warn('[LLM_DISAMBIGUATION] LLM call failed', {
      error: errorMessage,
      isTimeout,
      latencyMs,
    });

    return {
      selectedRef: null,
      confidence: 0,
      reason: isTimeout ? 'LLM timeout' : 'LLM call failed',
      cacheHit: false,
      latencyMs,
      skipped: true,
      skipReason: isTimeout ? 'timeout' : 'error',
    };
  }
}

/**
 * Convert InteractiveNode to DisambiguationCandidate
 * Extracts only privacy-safe fields needed for LLM
 */
export function nodeToDisambiguationCandidate(node: InteractiveNode): DisambiguationCandidate {
  return {
    ref: node.ref || '',
    labelText: node.labelText,
    ariaLabel: node.ariaLabel,
    text: node.text,
    placeholder: node.placeholder,
    name: node.name,
    tag: node.tag,
    role: node.role,
    containerTitles: node.containerTitles,
    boundingBox: node.boundingBox,
  };
}
