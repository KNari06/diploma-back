/**
 * Embeddings Resolver Service V2
 * Language-agnostic element resolution using multilingual embeddings
 * Primary resolver for step editor with 4-branch decision policy
 */

import { generateEmbedding, generateEmbeddings } from '@/services/ai/core/embedding.service';
import { logger } from '@/utils/core/logger';
import { cosineSimilarity } from '@/utils/text-processing/vector';
import type {
    IntentActionType,
    IntentStep,
    InteractiveNode,
    LintCandidate,
    LintResult,
    LintStatus,
} from './preview.types';

// ═══════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

/** Maximum length for candidate text (characters) */
const MAX_CANDIDATE_TEXT_LENGTH = 200;

/** Maximum length for intent text (characters) */
const MAX_INTENT_TEXT_LENGTH = 500;

/** Maximum candidates to embed in one batch */
const MAX_CANDIDATES_TO_EMBED = 50;

/** Embedding API timeout (milliseconds) */
const EMBEDDING_TIMEOUT_MS = 5000;

/** Circuit breaker: max consecutive failures before opening */
const CIRCUIT_BREAKER_THRESHOLD = 3;

/** Circuit breaker: time to wait before retrying (milliseconds) */
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000;

/** Cache TTL (milliseconds) - same as session TTL */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Per-action thresholds for decision policy
 * T_resolve: minimum similarity to consider resolved
 * T_min: minimum similarity to consider valid candidate
 * T_delta: minimum gap between top and second to be confident
 */
const ACTION_THRESHOLDS: Record<string, { resolve: number; min: number; delta: number }> = {
  fill: { resolve: 0.40, min: 0.25, delta: 0.08 },
  click: { resolve: 0.35, min: 0.20, delta: 0.06 },
  select: { resolve: 0.40, min: 0.25, delta: 0.08 },
  check: { resolve: 0.45, min: 0.30, delta: 0.10 },
  uncheck: { resolve: 0.45, min: 0.30, delta: 0.10 },
  toggle: { resolve: 0.40, min: 0.25, delta: 0.08 },
  open: { resolve: 0.40, min: 0.25, delta: 0.08 },
  close: { resolve: 0.40, min: 0.25, delta: 0.08 },
  hover: { resolve: 0.35, min: 0.20, delta: 0.06 },
  scroll: { resolve: 0.35, min: 0.20, delta: 0.06 },
  press: { resolve: 0.35, min: 0.20, delta: 0.06 },
  assert: { resolve: 0.35, min: 0.20, delta: 0.06 },
  // Default for unknown actions
  default: { resolve: 0.35, min: 0.20, delta: 0.06 },
};

/**
 * Action type to expected element tags mapping
 * Used for structural post-filter
 */
const ACTION_TO_TAGS: Record<string, string[]> = {
  fill: ['input', 'textarea'],
  click: ['button', 'a', 'input', 'div', 'span', 'label'],
  select: ['select'],
  check: ['input'],
  uncheck: ['input'],
  toggle: ['input', 'button', 'div', 'span'],
  open: ['button', 'div', 'select', 'summary', 'details'],
  close: ['button', 'div', 'summary', 'details'],
  hover: ['button', 'a', 'div', 'span', 'img'],
  scroll: ['div', 'section', 'main', 'body', 'html'],
  press: ['input', 'textarea', 'button'],
};

/** Actions that require writable state (not readonly) */
const WRITABLE_ACTIONS = new Set(['fill', 'type', 'clear']);

/** Actions that require specific element state */
const STATE_AWARE_ACTIONS: Record<string, { requiredState: string; field: keyof InteractiveNode }> = {
  check: { requiredState: 'unchecked', field: 'checked' },
  uncheck: { requiredState: 'checked', field: 'checked' },
  open: { requiredState: 'closed', field: 'ariaExpanded' },
  close: { requiredState: 'open', field: 'ariaExpanded' },
};

// ═══════════════════════════════════════════════════════════════════════════
// EMBEDDING CACHE
// ═══════════════════════════════════════════════════════════════════════════

interface CachedEmbedding {
  textHash: string;
  embedding: number[];
}

interface EmbeddingCacheEntry {
  pageSignature: string;
  candidates: Map<string, CachedEmbedding>;
  createdAt: number;
}

/** Cache: previewSessionId -> EmbeddingCacheEntry */
const embeddingCaches = new Map<string, EmbeddingCacheEntry>();

/** Circuit breaker state */
let circuitBreakerFailures = 0;
let circuitBreakerOpenUntil = 0;

/**
 * Compute simple hash for text (for cache invalidation)
 */
function computeTextHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

/**
 * Compute page signature for cache key
 * Based on URL and DOM node refs
 */
function computePageSignature(url: string, nodes: InteractiveNode[]): string {
  const refs = nodes.map(n => n.ref || '').join(',');
  const data = `${url}|${nodes.length}|${refs}`;
  return Buffer.from(data).toString('base64').substring(0, 32);
}

/**
 * Get cached embeddings for a session
 */
function getCachedEmbeddings(
  previewSessionId: string,
  pageSignature: string
): Map<string, CachedEmbedding> | null {
  const entry = embeddingCaches.get(previewSessionId);
  if (!entry) return null;

  // Check TTL
  if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
    embeddingCaches.delete(previewSessionId);
    return null;
  }

  // Check signature match
  if (entry.pageSignature !== pageSignature) {
    embeddingCaches.delete(previewSessionId);
    return null;
  }

  return entry.candidates;
}

/**
 * Store embeddings in cache
 */
function cacheEmbeddings(
  previewSessionId: string,
  pageSignature: string,
  candidates: Map<string, CachedEmbedding>
): void {
  embeddingCaches.set(previewSessionId, {
    pageSignature,
    candidates,
    createdAt: Date.now(),
  });
}

/**
 * Invalidate cache for a session
 */
export function invalidateEmbeddingCache(previewSessionId: string): void {
  embeddingCaches.delete(previewSessionId);
}

/**
 * Check if circuit breaker is open
 */
function isCircuitBreakerOpen(): boolean {
  if (Date.now() < circuitBreakerOpenUntil) {
    return true;
  }
  // Circuit breaker has cooled down
  if (circuitBreakerOpenUntil > 0) {
    circuitBreakerFailures = 0;
    circuitBreakerOpenUntil = 0;
  }
  return false;
}

/**
 * Record embedding failure for circuit breaker
 */
function recordEmbeddingFailure(): void {
  circuitBreakerFailures++;
  if (circuitBreakerFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    circuitBreakerOpenUntil = Date.now() + CIRCUIT_BREAKER_COOLDOWN_MS;
    logger.warn('[EMBEDDINGS_RESOLVER] Circuit breaker opened', {
      failures: circuitBreakerFailures,
      cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
    });
  }
}

/**
 * Record embedding success (reset circuit breaker)
 */
function recordEmbeddingSuccess(): void {
  circuitBreakerFailures = 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// CANDIDATE TEXT BUILDER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build semantic text representation for a candidate node
 * Priority-ordered template with length cap
 * @param node - Interactive node from DOM analysis
 * @returns Semantic text for embedding (max 200 chars)
 */
export function buildCandidateText(node: InteractiveNode): string {
  const parts: string[] = [];

  // Container context FIRST (hierarchy awareness)
  if (node.containerTitles && node.containerTitles.length > 0) {
    const containerPath = node.containerTitles.slice(0, 2).join(' > ');
    parts.push(`[${containerPath}]`);
  }

  // Primary labels (most semantic) - mutually exclusive
  if (node.labelText) {
    parts.push(node.labelText);
  } else if (node.ariaLabel) {
    parts.push(node.ariaLabel);
  }

  // Secondary hints
  if (node.placeholder) {
    parts.push(`placeholder: ${node.placeholder}`);
  }

  // Text content (if different from label and short enough)
  if (node.text && node.text !== node.labelText && node.text.length <= 50) {
    parts.push(node.text);
  }

  // Structural hints (lower priority)
  if (node.autocomplete) {
    parts.push(`autocomplete: ${node.autocomplete}`);
  }

  // Name attribute (if not dynamic)
  if (node.name && !node.isDynamicId && node.name !== node.id) {
    parts.push(`name: ${node.name}`);
  }

  // Test ID (useful for disambiguation)
  if (node.testIdAttr) {
    parts.push(`testid: ${node.testIdAttr}`);
  }

  // Tag/role/type (last, for disambiguation)
  let tagPart = `<${node.tag}`;
  if (node.role && node.role !== node.tag) {
    tagPart += ` role=${node.role}`;
  }
  if (node.type) {
    tagPart += ` type=${node.type}`;
  }
  tagPart += '>';
  parts.push(tagPart);

  // Join and cap length
  const result = parts.join(' | ');
  return result.slice(0, MAX_CANDIDATE_TEXT_LENGTH);
}

/**
 * Sanitize user intent for embedding
 * Redacts step value if present in description
 * @param step - Intent step from user
 * @returns Sanitized intent text (max 500 chars)
 */
export function sanitizeIntent(step: IntentStep): string {
  let intent = step.description || '';

  // Redact value if accidentally included in description
  if (step.value && step.value.length > 0) {
    intent = intent.replace(new RegExp(escapeRegex(step.value), 'gi'), '[VALUE]');
  }

  return intent.trim().slice(0, MAX_INTENT_TEXT_LENGTH);
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ═══════════════════════════════════════════════════════════════════════════
// STRUCTURAL FILTERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Filter result with reason
 */
interface FilterResult {
  passed: boolean;
  hardReject: boolean;
  reason?: string;
}

/**
 * Apply structural filters to a candidate node
 * Language-agnostic checks for visibility, state, action compatibility
 * @param node - Interactive node
 * @param actionType - Action being performed
 * @returns Filter result with reasons
 */
export function applyStructuralFilters(
  node: InteractiveNode,
  actionType: IntentActionType
): FilterResult {
  // Not visible
  if (node.isVisible === false) {
    return { passed: false, hardReject: true, reason: 'Not visible' };
  }

  // Disabled
  if (node.isDisabled) {
    return { passed: false, hardReject: true, reason: 'Disabled' };
  }

  // Readonly for writable actions
  if (WRITABLE_ACTIONS.has(actionType) && node.readOnly) {
    return { passed: false, hardReject: true, reason: 'Readonly field' };
  }

  // State-aware action checks
  const stateCheck = STATE_AWARE_ACTIONS[actionType];
  if (stateCheck) {
    const currentState = node[stateCheck.field];
    if (currentState !== undefined) {
      const isCorrectState =
        (stateCheck.requiredState === 'unchecked' && currentState === false) ||
        (stateCheck.requiredState === 'checked' && currentState === true) ||
        (stateCheck.requiredState === 'closed' && currentState === false) ||
        (stateCheck.requiredState === 'open' && currentState === true);

      if (!isCorrectState) {
        return {
          passed: false,
          hardReject: true,
          reason: `Already ${currentState ? 'checked/open' : 'unchecked/closed'}`,
        };
      }
    }
  }

  // Covered by overlay (soft reject)
  if (node.isTopMostAtCenter === false) {
    return { passed: true, hardReject: false, reason: 'Covered by overlay' };
  }

  return { passed: true, hardReject: false };
}

/**
 * Check if candidate tag is compatible with action type
 * Used as structural post-filter
 */
function isTagCompatibleWithAction(tag: string, actionType: IntentActionType): boolean {
  const allowedTags = ACTION_TO_TAGS[actionType];
  if (!allowedTags || allowedTags.length === 0) {
    return true; // No restriction
  }
  return allowedTags.includes(tag.toLowerCase());
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBEDDINGS RANKER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ranked candidate with similarity score
 */
interface RankedCandidate {
  node: InteractiveNode;
  candidateText: string;
  similarity: number;
  filterReason?: string;
}

/**
 * Generate embeddings with timeout
 */
class EmbeddingsTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingsTimeoutError';
  }
}

/**
 * Run promise with a hard timeout.
 * Note: OpenAI SDK calls here do not accept AbortSignal, so we use Promise.race.
 */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutMessage: string): Promise<T> {
  let timeoutId: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new EmbeddingsTimeoutError(timeoutMessage)), timeoutMs);
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
 * Generate single embedding with timeout.
 */
async function generateEmbeddingWithTimeout(text: string, timeoutMs: number): Promise<number[]> {
  return withTimeout(generateEmbedding(text), timeoutMs, 'embeddings_timeout');
}

/**
 * Generate embeddings with timeout.
 */
async function generateEmbeddingsWithTimeout(texts: string[], timeoutMs: number): Promise<number[][]> {
  return withTimeout(generateEmbeddings(texts), timeoutMs, 'embeddings_timeout');
}

/**
 * Rank candidates by embedding similarity
 * Uses cache when available
 */
async function rankCandidatesByEmbedding(params: {
  intentText: string;
  candidates: Array<{ node: InteractiveNode; candidateText: string }>;
  previewSessionId: string;
  pageSignature: string;
}): Promise<{
  ranked: RankedCandidate[];
  cacheHit: boolean;
  latencyMs: number;
}> {
  const startTime = Date.now();
  const { intentText, candidates, previewSessionId, pageSignature } = params;

  if (candidates.length === 0) {
    return { ranked: [], cacheHit: false, latencyMs: 0 };
  }

  // Generate intent embedding
  const intentEmbedding = await generateEmbeddingWithTimeout(intentText, EMBEDDING_TIMEOUT_MS);

  // Check cache for candidate embeddings
  const cached = getCachedEmbeddings(previewSessionId, pageSignature);
  let cacheHit = false;
  let candidateEmbeddings: number[][] = [];
  const textsToEmbed: string[] = [];
  const indexMapping: number[] = []; // Maps textsToEmbed index to candidate index

  if (cached) {
    // Check which candidates need embedding
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const textHash = computeTextHash(c.candidateText);
      const cachedEmb = c.node.ref ? cached.get(c.node.ref) : null;

      if (cachedEmb && cachedEmb.textHash === textHash) {
        candidateEmbeddings[i] = cachedEmb.embedding;
        cacheHit = true;
      } else {
        textsToEmbed.push(c.candidateText);
        indexMapping.push(i);
      }
    }
  } else {
    // No cache, embed all
    for (let i = 0; i < candidates.length; i++) {
      textsToEmbed.push(candidates[i].candidateText);
      indexMapping.push(i);
    }
  }

  // Generate embeddings for uncached candidates
  if (textsToEmbed.length > 0) {
    const newEmbeddings = await generateEmbeddingsWithTimeout(textsToEmbed, EMBEDDING_TIMEOUT_MS);

    // Map back to candidate embeddings
    for (let i = 0; i < newEmbeddings.length; i++) {
      const candidateIndex = indexMapping[i];
      candidateEmbeddings[candidateIndex] = newEmbeddings[i];
    }

    // Update cache
    const newCache = new Map<string, CachedEmbedding>(cached || []);
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      if (c.node.ref && candidateEmbeddings[i]) {
        newCache.set(c.node.ref, {
          textHash: computeTextHash(c.candidateText),
          embedding: candidateEmbeddings[i],
        });
      }
    }
    cacheEmbeddings(previewSessionId, pageSignature, newCache);
  }

  // Compute similarities and rank
  const ranked: RankedCandidate[] = candidates.map((c, i) => ({
    node: c.node,
    candidateText: c.candidateText,
    similarity: candidateEmbeddings[i]
      ? cosineSimilarity(intentEmbedding, candidateEmbeddings[i])
      : 0,
  }));

  // Sort by similarity descending
  ranked.sort((a, b) => b.similarity - a.similarity);

  const latencyMs = Date.now() - startTime;
  return { ranked, cacheHit: cacheHit && textsToEmbed.length === 0, latencyMs };
}

// ═══════════════════════════════════════════════════════════════════════════
// DECISION POLICY
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decision result from 4-branch policy
 */
interface DecisionResult {
  status: LintStatus;
  message: string;
  confidence: number;
  topSimilarity: number;
  similarityDelta: number;
  selectedCandidates: RankedCandidate[];
}

/**
 * Apply 4-branch decision policy
 * @param ranked - Ranked candidates by similarity
 * @param actionType - Action type for threshold lookup
 * @returns Decision result
 */
function applyDecisionPolicy(
  ranked: RankedCandidate[],
  actionType: IntentActionType
): DecisionResult {
  const thresholds = ACTION_THRESHOLDS[actionType] || ACTION_THRESHOLDS.default;

  if (ranked.length === 0) {
    return {
      status: 'not_found',
      message: 'No matching elements found on page',
      confidence: 0,
      topSimilarity: 0,
      similarityDelta: 0,
      selectedCandidates: [],
    };
  }

  const topSim = ranked[0].similarity;
  const secondSim = ranked.length > 1 ? ranked[1].similarity : 0;
  const delta = topSim - secondSim;

  // Calculate average similarity for relative threshold
  const avgSim = ranked.reduce((sum, r) => sum + r.similarity, 0) / ranked.length;

  // Branch 1: not_found - all similarities too low
  if (topSim < thresholds.min) {
    return {
      status: 'not_found',
      message: 'No elements match the description with sufficient confidence',
      confidence: topSim,
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: [],
    };
  }

  // Branch 1b: not_found - relative threshold (top not significantly better than average)
  if (topSim < 1.5 * avgSim && ranked.length > 3) {
    return {
      status: 'not_found',
      message: 'Multiple elements match equally, but none stands out',
      confidence: topSim,
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: [],
    };
  }

  // Check container diversity for top-3
  const top3 = ranked.slice(0, 3);
  const uniqueContainers = new Set(top3.map(r => r.node.containerRef || 'none'));
  const containerDiverse = uniqueContainers.size >= 3;

  // Branch 2: needs_clarification - ambiguous (multiple close candidates or container diversity)
  if ((delta < thresholds.delta && ranked.length > 1) || containerDiverse) {
    return {
      status: 'needs_clarification',
      message: containerDiverse
        ? 'Found similar elements in different sections. Please specify which one.'
        : 'Found multiple matching elements. Please clarify which one you mean.',
      confidence: topSim,
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: top3,
    };
  }

  // Branch 3: resolved - single confident winner
  if (topSim >= thresholds.resolve && delta >= thresholds.delta) {
    return {
      status: 'resolved',
      message: 'Element found with high confidence',
      confidence: topSim,
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: [ranked[0]],
    };
  }

  // Branch 3b: resolved with moderate confidence
  if (topSim >= thresholds.min && delta >= thresholds.delta) {
    return {
      status: 'resolved',
      message: 'Element found with moderate confidence',
      confidence: topSim,
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: [ranked[0]],
    };
  }

  // Default: needs_clarification
  return {
    status: 'needs_clarification',
    message: 'Please select the correct element',
    confidence: topSim,
    topSimilarity: topSim,
    similarityDelta: delta,
    selectedCandidates: top3,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Resolve step using embeddings-based matching
 * Primary resolver for multilingual step targeting
 *
 * Pipeline:
 * 1. Snapshot + structural filters
 * 2. CandidateText builder
 * 3. Embeddings ranking (cached)
 * 4. Decision policy (4 branches)
 *
 * @returns LintResult with embeddings-specific metrics
 */
export async function resolveWithEmbeddings(params: {
  previewSessionId: string;
  stepDraft: IntentStep;
  domNodes: InteractiveNode[];
  pageUrl: string;
}): Promise<LintResult> {
  const { previewSessionId, stepDraft, domNodes, pageUrl } = params;
  const startTime = Date.now();

  logger.debug('[EMBEDDINGS_RESOLVER] Starting resolution', {
    previewSessionId,
    stepType: stepDraft.type,
    description: stepDraft.description.slice(0, 50),
    nodeCount: domNodes.length,
  });

  // Non-targeting actions don't need element resolution
  if (['navigate', 'wait'].includes(stepDraft.type)) {
    return {
      status: 'resolved',
      message: `Action "${stepDraft.type}" does not require element targeting`,
      confidence: 1,
      candidates: [],
      highlight: [],
    };
  }

  if (domNodes.length === 0) {
    return {
      status: 'not_found',
      message: 'No interactive elements found on page',
      confidence: 0,
      candidates: [],
      highlight: [],
    };
  }

  // Step 1: Apply structural filters
  const filteredCandidates: Array<{ node: InteractiveNode; candidateText: string }> = [];

  for (const node of domNodes) {
    // Must have valid ref
    if (!node.ref || node.ref.trim().length === 0) {
      continue;
    }

    // Apply structural filters
    const filterResult = applyStructuralFilters(node, stepDraft.type);
    if (filterResult.hardReject) {
      continue;
    }

    // Build candidate text
    const candidateText = buildCandidateText(node);
    filteredCandidates.push({ node, candidateText });
  }

  if (filteredCandidates.length === 0) {
    return {
      status: 'not_found',
      message: 'All matching elements are disabled, readonly, or in wrong state',
      confidence: 0,
      candidates: [],
      highlight: [],
    };
  }

  // Limit candidates to prevent excessive API calls
  const candidatesToEmbed = filteredCandidates.slice(0, MAX_CANDIDATES_TO_EMBED);

  // Step 2: Prepare intent text
  const intentText = sanitizeIntent(stepDraft);

  // Compute page signature for cache
  const pageSignature = computePageSignature(pageUrl, domNodes);

  // Step 3: Rank by embeddings
  let ranked: RankedCandidate[];
  let cacheHit = false;
  let embeddingsLatencyMs = 0;
  let degradedMode = false;
  let degradedReason: string | undefined;

  // Check circuit breaker
  if (isCircuitBreakerOpen()) {
    degradedMode = true;
    degradedReason = 'circuit_breaker_open';
    logger.warn('[EMBEDDINGS_RESOLVER] Circuit breaker is open, skipping embeddings');
    ranked = [];
  } else {
    try {
      const rankResult = await rankCandidatesByEmbedding({
        intentText,
        candidates: candidatesToEmbed,
        previewSessionId,
        pageSignature,
      });

      ranked = rankResult.ranked;
      cacheHit = rankResult.cacheHit;
      embeddingsLatencyMs = rankResult.latencyMs;

      recordEmbeddingSuccess();
    } catch (error) {
      recordEmbeddingFailure();
      degradedMode = true;

      const errorMessage = error instanceof Error ? error.message : String(error);
      if (errorMessage.includes('429') || errorMessage.includes('rate')) {
        degradedReason = 'rate_limited';
      } else if (errorMessage.includes('embeddings_timeout') || errorMessage.toLowerCase().includes('timeout')) {
        degradedReason = 'timeout';
      } else {
        degradedReason = 'embedding_error';
      }

      logger.warn('[EMBEDDINGS_RESOLVER] Embeddings failed', {
        previewSessionId,
        error: errorMessage,
        degradedReason,
      });

      ranked = [];
    }
  }

  // If embeddings failed, return degraded result
  if (degradedMode || ranked.length === 0) {
    return {
      status: 'not_found',
      message: 'Element resolution failed. Please try again or add more specific hints.',
      confidence: 0,
      candidates: [],
      highlight: [],
      degradedMode: true,
      degradedReason,
      needsAiFallback: true,
    };
  }

  // Step 4: Apply structural post-filter (tag compatibility)
  const tagFilteredRanked = ranked.filter(r =>
    isTagCompatibleWithAction(r.node.tag, stepDraft.type)
  );

  // If all filtered out, use original ranked but with lower confidence
  const finalRanked = tagFilteredRanked.length > 0 ? tagFilteredRanked : ranked;

  // Step 5: Apply decision policy
  const decision = applyDecisionPolicy(finalRanked, stepDraft.type);

  // Build lint candidates
  const lintCandidates: LintCandidate[] = decision.selectedCandidates.map(r => ({
    ref: r.node.ref,
    label: r.node.labelText || r.node.ariaLabel || r.node.text || r.node.placeholder || `<${r.node.tag}>`,
    reason: `Similarity: ${(r.similarity * 100).toFixed(0)}%`,
    confidence: r.similarity,
    boundingBox: r.node.boundingBox,
  }));

  // Build highlight
  const highlight = decision.selectedCandidates.map((r, idx) => ({
    ref: r.node.ref,
    boundingBox: r.node.boundingBox,
    type: (decision.status === 'resolved' && idx === 0 ? 'success' : 'warning') as 'success' | 'warning' | 'error',
  }));

  const totalLatencyMs = Date.now() - startTime;

  // Log decision metrics
  logger.info('[EMBEDDINGS_RESOLVER] Resolution complete', {
    event: 'lint_decision',
    previewSessionId,
    stepType: stepDraft.type,
    topSim: decision.topSimilarity.toFixed(3),
    delta: decision.similarityDelta.toFixed(3),
    status: decision.status,
    cacheHit,
    embeddingsLatencyMs,
    totalLatencyMs,
    candidateCount: finalRanked.length,
    degradedMode,
  });

  return {
    status: decision.status,
    message: decision.message,
    confidence: decision.confidence,
    candidates: lintCandidates,
    highlight,
    topSimilarity: decision.topSimilarity,
    similarityDelta: decision.similarityDelta,
    cacheHit,
    embeddingsLatencyMs,
    degradedMode: false,
  };
}

/**
 * Prefetch embeddings for all candidates on a page
 * Call after subscribe:preview to warm the cache
 */
export async function prefetchEmbeddings(params: {
  previewSessionId: string;
  domNodes: InteractiveNode[];
  pageUrl: string;
}): Promise<void> {
  const { previewSessionId, domNodes, pageUrl } = params;

  if (domNodes.length === 0) return;
  if (isCircuitBreakerOpen()) return;

  try {
    // Build candidate texts
    const candidateTexts: string[] = [];
    const validNodes: InteractiveNode[] = [];

    for (const node of domNodes) {
      if (!node.ref || node.ref.trim().length === 0) continue;
      if (node.isVisible === false || node.isDisabled) continue;

      const text = buildCandidateText(node);
      candidateTexts.push(text);
      validNodes.push(node);

      if (candidateTexts.length >= MAX_CANDIDATES_TO_EMBED) break;
    }

    if (candidateTexts.length === 0) return;

    // Generate embeddings
    const embeddings = await generateEmbeddingsWithTimeout(candidateTexts, EMBEDDING_TIMEOUT_MS);

    // Store in cache
    const pageSignature = computePageSignature(pageUrl, domNodes);
    const cache = new Map<string, CachedEmbedding>();

    for (let i = 0; i < validNodes.length; i++) {
      const node = validNodes[i];
      if (node.ref && embeddings[i]) {
        cache.set(node.ref, {
          textHash: computeTextHash(candidateTexts[i]),
          embedding: embeddings[i],
        });
      }
    }

    cacheEmbeddings(previewSessionId, pageSignature, cache);
    recordEmbeddingSuccess();

    logger.info('[EMBEDDINGS_RESOLVER] Prefetch complete', {
      previewSessionId,
      cachedCount: cache.size,
    });
  } catch (error) {
    recordEmbeddingFailure();
    logger.warn('[EMBEDDINGS_RESOLVER] Prefetch failed', {
      previewSessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
