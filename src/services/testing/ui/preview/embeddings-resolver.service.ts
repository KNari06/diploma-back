/**
 * Embeddings Resolver Service V6
 * Language-agnostic element resolution using multilingual embeddings
 *
 * Architecture (V6 — simplified):
 * 1. Build HardAllowed/SoftAllowed sets via deterministic DOM-structural rules (sync, fast)
 * 2. Check for exact quoted text short-circuit ('Login', "Submit")
 * 3. Rank allowed candidates by embedding cosine similarity
 * 4. Apply count-based decision policy:
 *    - 0 allowed → Gemini Flash rescue (last-resort AI)
 *    - 1 allowed → resolved
 *    - >1 allowed → LLM disambiguation or needs_clarification
 *
 * Philosophy: DOM-structural rules only (tag, type, visibility, state).
 * All text-based matching (typos, spaces, multilingual) is handled by embeddings + AI.
 * No hardcoded keyword lists, no fuzzy matching, no space-stripping heuristics.
 */

import { generateEmbedding, generateEmbeddings, cosineSimilarity } from '@/services/ai/core/embedding.service';
import { generateText } from '@/services/ai/core/ai-provider.service';
import { logger } from '@/utils/core/logger';
import {
    disambiguateWithLLM,
    nodeToDisambiguationCandidate,
    type DisambiguationResult,
} from './llm-disambiguation.service';
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

/** Minimum semantic similarity to consider a match valid (for semantic-zero check) */
const SEMANTIC_MIN_THRESHOLD = 0.25;

/** Threshold for considering candidates ambiguous (require spatial tie-breaking) */
const AMBIGUOUS_SIMILARITY_DELTA = 0.05;

/**
 * Action type to expected element tags mapping (HardAllowed filter)
 * Elements not in this list are excluded for the action
 * P1 FIX: Expanded click to include modern UI patterns (list items, table cells, images, etc.)
 */
const ACTION_TO_TAGS: Record<string, string[]> = {
  type: ['input', 'textarea'],
  click: ['button', 'a', 'input', 'div', 'span', 'label', 'li', 'td', 'th', 'img', 'svg', 'summary', 'nav', 'header', 'footer', 'section', 'article'],
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

/**
 * Role-based allowlist for click actions
 * P1 FIX: Elements with these ARIA roles are allowed for click regardless of tag
 */
const CLICK_ALLOWED_ROLES = new Set([
  'button',
  'link',
  'tab',
  'menuitem',
  'option',
  'treeitem',
  'row',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'switch',
]);

/**
 * Role-based allowlist for select actions
 * Custom dropdowns with these ARIA roles are allowed for select regardless of tag
 */
const SELECT_ALLOWED_ROLES = new Set([
  'combobox',
  'listbox',
  'option',
  'menu',
  'menuitem',
]);

/**
 * Tags that can serve as custom dropdown triggers (soft-allowed for select action).
 * Many modern frameworks render dropdowns as <button>, <div>, <span>, or <input>
 * without any ARIA roles. These are allowed as soft candidates so the embeddings
 * model can decide via semantic matching.
 */
const SELECT_SOFT_TAGS = new Set([
  'button',
  'div',
  'span',
  'input',
  'a',
  'li',
]);

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
// V3: RULE TRACE TYPES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Rule trace entry for debugging and logging
 * Records which rules were applied and their effects
 */
export interface RuleTraceEntry {
  ruleId: string;
  version: string;
  action: 'exclude' | 'boost' | 'penalize' | 'shortcircuit';
  evidence: string;
  affectedRefs: string[];
}

/**
 * Allowed set classification result
 */
export interface AllowedSetResult {
  /** Elements that pass all hard rules */
  hardAllowed: InteractiveNode[];
  /** Elements that pass hard rules but have soft penalties */
  softAllowed: InteractiveNode[];
  /** Rule trace for debugging */
  ruleTrace: RuleTraceEntry[];
  /** If true, a single element matched exactly (short-circuit to resolved) */
  shortCircuitRef?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// INTENT EMBEDDING CACHE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Cache for intent embeddings — avoids duplicate API calls when the same
 * intent text appears in multiple ranking calls.
 * Key: normalized intent text (lowercased, trimmed, sliced to 200 chars).
 */
const intentEmbeddingCache = new Map<string, number[]>();
const INTENT_EMB_CACHE_MAX_SIZE = 200;

/**
 * In-flight dedup: if two concurrent calls request the same intent embedding,
 * they share one API call instead of making two.
 */
const intentEmbeddingInFlight = new Map<string, Promise<number[]>>();

/**
 * Get or compute intent embedding with caching and in-flight dedup.
 * On error, the promise rejects and is NOT cached — next caller retries fresh.
 */
async function getIntentEmbedding(intentText: string): Promise<number[]> {
  const cacheKey = intentText.toLowerCase().trim().slice(0, 200);

  // 1. Cache hit
  const cached = intentEmbeddingCache.get(cacheKey);
  if (cached) return cached;

  // 2. In-flight dedup — share the existing promise
  const inFlight = intentEmbeddingInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  // 3. Start new request
  const promise = generateEmbedding(intentText)
    .then(embedding => {
      // Cache only on success (don't cache errors)
      if (intentEmbeddingCache.size >= INTENT_EMB_CACHE_MAX_SIZE) {
        const firstKey = intentEmbeddingCache.keys().next().value;
        if (firstKey !== undefined) intentEmbeddingCache.delete(firstKey);
      }
      intentEmbeddingCache.set(cacheKey, embedding);
      return embedding;
    })
    .finally(() => {
      // Always clean up in-flight tracker (success or failure)
      intentEmbeddingInFlight.delete(cacheKey);
    });

  intentEmbeddingInFlight.set(cacheKey, promise);
  return promise;
}

/**
 * Fill action should only target editable text-like inputs.
 * Excludes input types that are not textual (checkbox, radio, submit, etc.).
 */
function isFillCompatibleTextField(node: InteractiveNode): boolean {
  if (node.tag === 'textarea') return true;

  if (node.tag === 'input') {
    const t = (node.type || node.inputType || 'text').toLowerCase();
    const disallowed = new Set([
      'button',
      'submit',
      'reset',
      'image',
      'checkbox',
      'radio',
      'file',
      'range',
      'color',
      'date',
      'datetime-local',
      'month',
      'week',
      'time',
      'hidden',
    ]);
    return !disallowed.has(t);
  }

  // Non-standard textbox components (best-effort support).
  // Note: we don't have a dedicated `contenteditable` flag in InteractiveNode.
  if (node.tag === 'div' && node.role === 'textbox') return true;

  return false;
}

/**
 * Check if node label/aria/placeholder contains exact quoted text from intent
 * Supports: 'exact text' or "exact text" patterns
 */
function matchesExactQuotedText(node: InteractiveNode, intentText: string): boolean {
  // Extract quoted strings from intent
  const singleQuoteMatch = intentText.match(/'([^']+)'/);
  const doubleQuoteMatch = intentText.match(/"([^"]+)"/);
  const quotedText = singleQuoteMatch?.[1] || doubleQuoteMatch?.[1];
  
  if (!quotedText) return false;
  
  const quotedLower = quotedText.toLowerCase();
  const nodeTexts = [
    node.labelText,
    node.ariaLabel,
    node.placeholder,
    node.text,
    node.name,
  ].filter(Boolean).map(t => t!.toLowerCase());
  
  return nodeTexts.some(t => t === quotedLower || t.includes(quotedLower));
}

/**
 * Build HardAllowed and SoftAllowed sets based on deterministic DOM-structural rules.
 * V6: Synchronous — no AI calls. All text-based matching delegated to embeddings + AI.
 *
 * Rules applied (in order):
 * 1. Visibility (isVisible=false → hard exclude)
 * 2. Disabled (isDisabled=true → hard exclude)
 * 3. Readonly for writable actions → hard exclude
 * 3b. Tag/type compatibility for `type` action → hard exclude
 * 4. State-aware action checks (check/uncheck/open/close) → hard exclude
 * 5. Tag/role compatibility for action → hard exclude or soft penalize
 * Soft: covered by overlay, dynamic ID
 * Short-circuit: exact quoted text match ('Login', "Submit")
 */
export function buildAllowedSets(
  nodes: InteractiveNode[],
  actionType: IntentActionType,
  intentText: string
): AllowedSetResult {
  const hardAllowed: InteractiveNode[] = [];
  const softAllowed: InteractiveNode[] = [];
  const ruleTrace: RuleTraceEntry[] = [];
  let shortCircuitRef: string | undefined;

  // Track exact quote match candidates for potential short-circuit
  const exactMatchRefs: string[] = [];

  // P1+P2 CRITICAL: Position-aware modal/dialog/popup layer detection
  // If a modal is present, visible, AND covers a significant portion of the viewport,
  // elements behind it should be HARD excluded.
  // Cookie banners (small, bottom/top-positioned) should NOT trigger full modal exclusion.
  const modalNode = nodes.find(
    (n) =>
      n.isVisible &&
      (n.role === 'dialog' ||
        n.role === 'alertdialog' ||
        n.tag === 'dialog' ||
        (n.isTopMostAtCenter === true &&
         (n.role === 'region' || n.role === 'presentation') &&
         (n.ariaLabel?.toLowerCase().includes('modal') ||
          n.ariaLabel?.toLowerCase().includes('dialog'))))
  );

  // Position-aware: only treat as blocking modal if it covers significant viewport area
  // Cookie banners are typically small (< 30% viewport area) and positioned at edges
  let hasVisibleModal = false;
  if (modalNode) {
    const bb = modalNode.boundingBox;
    if (bb && bb.width > 0 && bb.height > 0) {
      // Estimate viewport as max bounding box across all visible nodes
      let maxRight = 0;
      let maxBottom = 0;
      for (const n of nodes) {
        if (n.boundingBox && n.isVisible) {
          maxRight = Math.max(maxRight, n.boundingBox.x + n.boundingBox.width);
          maxBottom = Math.max(maxBottom, n.boundingBox.y + n.boundingBox.height);
        }
      }
      const viewportArea = maxRight * maxBottom;
      const modalArea = bb.width * bb.height;
      // Modal must cover at least 30% of visible area to be considered blocking
      // This filters out cookie banners, notification bars, etc.
      const coverageRatio = viewportArea > 0 ? modalArea / viewportArea : 0;
      hasVisibleModal = coverageRatio >= 0.3;

      if (!hasVisibleModal) {
        ruleTrace.push({
          ruleId: 'modal.small_overlay_skipped',
          version: 'v2',
          action: 'penalize',
          evidence: `Dialog/modal found but only covers ${(coverageRatio * 100).toFixed(0)}% of viewport (< 30% threshold)`,
          affectedRefs: modalNode.ref ? [modalNode.ref] : [],
        });
      }
    } else {
      // No bounding box info — fall back to treating it as blocking
      hasVisibleModal = true;
    }
  }

  if (hasVisibleModal) {
    ruleTrace.push({
      ruleId: 'modal.detected',
      version: 'v2',
      action: 'exclude',
      evidence: 'Blocking modal/dialog layer detected - background elements will be hard-excluded',
      affectedRefs: modalNode?.ref ? [modalNode.ref] : [],
    });
  }
  
  for (const node of nodes) {
    // Skip nodes without valid ref
    if (!node.ref || node.ref.trim().length === 0) {
      continue;
    }
    
    let excluded = false;
    let isSoft = false;
    const nodeRules: RuleTraceEntry[] = [];
    const isNonStandardTextbox = actionType === 'type' && node.tag === 'div' && node.role === 'textbox';
    
    // ═══════════════════════════════════════════════════════════════════════
    // HARD RULES: Exclude elements that are fundamentally incompatible
    // ═══════════════════════════════════════════════════════════════════════
    
    // Rule 1: Visibility check
    if (node.isVisible === false) {
      excluded = true;
      nodeRules.push({
        ruleId: 'visibility.hidden',
        version: 'v1',
        action: 'exclude',
        evidence: 'isVisible=false',
        affectedRefs: [node.ref],
      });
    }
    
    // Rule 2: Disabled check
    if (!excluded && node.isDisabled) {
      excluded = true;
      nodeRules.push({
        ruleId: 'state.disabled',
        version: 'v1',
        action: 'exclude',
        evidence: 'isDisabled=true',
        affectedRefs: [node.ref],
      });
    }
    
    // Rule 3: Readonly for writable actions
    if (!excluded && WRITABLE_ACTIONS.has(actionType) && node.readOnly) {
      excluded = true;
      nodeRules.push({
        ruleId: 'state.readonly',
        version: 'v1',
        action: 'exclude',
        evidence: `readOnly=true for action=${actionType}`,
        affectedRefs: [node.ref],
      });
    }

    // Rule 3b: Type must target text-like editable fields only
    if (!excluded && actionType === 'type' && !isFillCompatibleTextField(node)) {
      excluded = true;
      nodeRules.push({
        ruleId: 'type.incompatible_field_type',
        version: 'v1',
        action: 'exclude',
        evidence: `tag=${node.tag}, type=${node.type || node.inputType || 'unknown'}`,
        affectedRefs: [node.ref],
      });
    }
    
    // Rule 4: State-aware action checks
    if (!excluded) {
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
            excluded = true;
            nodeRules.push({
              ruleId: 'state.mismatch',
              version: 'v1',
              action: 'exclude',
              evidence: `${stateCheck.field}=${currentState}, required=${stateCheck.requiredState}`,
              affectedRefs: [node.ref],
            });
          }
        }
      }
    }
    
    // Rule 5: Tag compatibility for action
    if (!excluded) {
      const allowedTags = ACTION_TO_TAGS[actionType];
      if (allowedTags && allowedTags.length > 0) {
        const tagMatches = allowedTags.includes(node.tag.toLowerCase());

        // P1 FIX: Role-based allowlist for click actions
        // Elements with interactive ARIA roles should be allowed regardless of tag
        // For select: also allow elements with aria-expanded (dropdown triggers without explicit ARIA role)
        const isDropdownLike = actionType === 'select' && node.ariaExpanded !== undefined;
        const roleMatches =
          (actionType === 'click' && node.role && CLICK_ALLOWED_ROLES.has(node.role)) ||
          (actionType === 'select' && (
            (node.role && SELECT_ALLOWED_ROLES.has(node.role)) || isDropdownLike
          ));

        // For select action: soft-allow common interactive tags as potential custom dropdown triggers.
        // Many modern frameworks render dropdowns as <button>/<div>/<span> without ARIA roles.
        const isSelectSoftTag = actionType === 'select' && !tagMatches && !roleMatches
          && SELECT_SOFT_TAGS.has(node.tag.toLowerCase());

        // Exception: allow non-standard textbox components for type as SoftAllowed.
        if (!tagMatches && !isNonStandardTextbox && !roleMatches && !isSelectSoftTag) {
          excluded = true;
          nodeRules.push({
            ruleId: 'tag.incompatible',
            version: 'v1',
            action: 'exclude',
            evidence: `tag=${node.tag}, role=${node.role || 'none'} not in allowed [${allowedTags.join(',')}] for action=${actionType}`,
            affectedRefs: [node.ref],
          });
        } else if (isNonStandardTextbox) {
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.nonstandard_textbox',
            version: 'v1',
            action: 'penalize',
            evidence: 'div with role=textbox allowed as soft candidate',
            affectedRefs: [node.ref],
          });
        } else if (roleMatches && !tagMatches && actionType === 'click') {
          // Role-based match for click: allow but log for visibility
          nodeRules.push({
            ruleId: 'role.click_allowed',
            version: 'v1',
            action: 'boost',
            evidence: `tag=${node.tag} allowed via role=${node.role} for click`,
            affectedRefs: [node.ref],
          });
        } else if ((roleMatches || isDropdownLike) && !tagMatches && actionType === 'select') {
          // Custom dropdown via ARIA role or aria-expanded: soft-allow (prefer native <select>)
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.custom_dropdown',
            version: 'v1',
            action: 'penalize',
            evidence: `tag=${node.tag}, role=${node.role || 'none'}, ariaExpanded=${node.ariaExpanded} allowed as soft candidate for select`,
            affectedRefs: [node.ref],
          });
        } else if (isSelectSoftTag) {
          // Custom dropdown trigger without ARIA: soft-allow with heavier penalty
          // Embeddings model will decide via semantic matching
          isSoft = true;
          nodeRules.push({
            ruleId: 'structure.custom_dropdown_trigger',
            version: 'v1',
            action: 'penalize',
            evidence: `tag=${node.tag} soft-allowed as potential custom dropdown trigger for select (no ARIA role)`,
            affectedRefs: [node.ref],
          });
        }
      }
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // SOFT RULES: Penalize but don't exclude
    // ═══════════════════════════════════════════════════════════════════════

    if (!excluded) {
      // P1 CRITICAL: When modal is present, covered elements must be HARD excluded
      // Otherwise, soft penalty only
      if (node.isTopMostAtCenter === false) {
        if (hasVisibleModal) {
          // HARD exclude: element is behind modal layer
          excluded = true;
          nodeRules.push({
            ruleId: 'modal.background_element',
            version: 'v1',
            action: 'exclude',
            evidence: 'isTopMostAtCenter=false with modal present',
            affectedRefs: [node.ref],
          });
        } else {
          // SOFT penalty: element is covered but no modal detected
          isSoft = true;
          nodeRules.push({
            ruleId: 'visibility.covered',
            version: 'v1',
            action: 'penalize',
            evidence: 'isTopMostAtCenter=false (no modal)',
            affectedRefs: [node.ref],
          });
        }
      }
      
      // Soft Rule 2: Dynamic ID (less reliable)
      if (node.isDynamicId) {
        isSoft = true;
        nodeRules.push({
          ruleId: 'stability.dynamic_id',
          version: 'v1',
          action: 'penalize',
          evidence: 'isDynamicId=true',
          affectedRefs: [node.ref],
        });
      }
      
      // Soft Rule 3: Non-standard role (e.g., div with role=textbox)
      // Handled earlier (Rule 5 exception) to avoid being excluded by tag checks.
    }
    
    // ═══════════════════════════════════════════════════════════════════════
    // SHORT-CIRCUIT: Check for exact quoted text match
    // ═══════════════════════════════════════════════════════════════════════
    
    if (!excluded && matchesExactQuotedText(node, intentText)) {
      exactMatchRefs.push(node.ref);
      nodeRules.push({
        ruleId: 'match.exact_quote',
        version: 'v1',
        action: 'shortcircuit',
        evidence: 'Node matches quoted text in intent',
        affectedRefs: [node.ref],
      });
    }
    
    // Add to appropriate set
    if (!excluded) {
      if (isSoft) {
        softAllowed.push(node);
      } else {
        hardAllowed.push(node);
      }
    }
    
    // Add all rules for this node to trace
    ruleTrace.push(...nodeRules);
  }
  
  // If exactly one element matches quoted text, short-circuit to resolved
  if (exactMatchRefs.length === 1) {
    shortCircuitRef = exactMatchRefs[0];
    ruleTrace.push({
      ruleId: 'decision.shortcircuit',
      version: 'v1',
      action: 'shortcircuit',
      evidence: `Single exact quote match: ${shortCircuitRef}`,
      affectedRefs: [shortCircuitRef],
    });
  }

  // Log rule trace summary
  logger.debug('[EMBEDDINGS_RESOLVER] Built allowed sets', {
    hardAllowedCount: hardAllowed.length,
    softAllowedCount: softAllowed.length,
    rulesApplied: ruleTrace.length,
    shortCircuitRef,
  });
  
  return { hardAllowed, softAllowed, ruleTrace, shortCircuitRef };
}

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
  const description = (step.description || '').trim();
  const value = (step.value || '').trim();
  let intent = description;

  // Redact value if accidentally included in description
  // Exception: for 'select' actions, keep the value in the description
  // because it's needed for semantic matching against dropdown trigger/options
  if (value.length > 0 && step.type !== 'select') {
    intent = intent.replace(new RegExp(escapeRegex(value), 'gi'), '[VALUE]');
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
// STRUCTURAL FILTERS (Legacy - kept for backward compatibility)
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
 * NOTE: V3 uses buildAllowedSets() instead for more comprehensive filtering
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
 * Generate embeddings with timeout.
 */
async function generateEmbeddingsWithTimeout(texts: string[], timeoutMs: number): Promise<number[][]> {
  return withTimeout(generateEmbeddings(texts), timeoutMs, 'embeddings_timeout');
}

/**
 * Rank candidates by embedding similarity
 * Uses cache when available (unless disableCaching is true)
 */
async function rankCandidatesByEmbedding(params: {
  intentText: string;
  candidates: Array<{ node: InteractiveNode; candidateText: string }>;
  previewSessionId: string;
  pageSignature: string;
  /** V5: When true, skip cache lookup and compute fresh embeddings */
  disableCaching?: boolean;
}): Promise<{
  ranked: RankedCandidate[];
  cacheHit: boolean;
  latencyMs: number;
}> {
  const startTime = Date.now();
  const { intentText, candidates, previewSessionId, pageSignature, disableCaching = false } = params;

  if (candidates.length === 0) {
    return { ranked: [], cacheHit: false, latencyMs: 0 };
  }

  // Get (or compute) intent embedding — shared via in-flight dedup cache
  const intentEmbedding = await withTimeout(
    getIntentEmbedding(intentText),
    EMBEDDING_TIMEOUT_MS,
    'embeddings_timeout'
  );

  // Check cache for candidate embeddings (skip when disableCaching is true)
  const cached = disableCaching ? null : getCachedEmbeddings(previewSessionId, pageSignature);

  if (disableCaching) {
    logger.debug('[EMBEDDINGS_RESOLVER] Cache bypass due to disableCaching flag', {
      previewSessionId,
    });
  }
  let cacheHit = false;
  const candidateEmbeddings: number[][] = new Array(candidates.length);
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
// SPATIAL TIE-BREAK ORDERING
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Apply spatial tie-break ordering for candidates with very close semantic similarity.
 * This must NOT change status decisions or similarity values; it only stabilizes ordering.
 *
 * Tie-break priority:
 * 1) Prefer `isTopMostAtCenter === true` (when available)
 * 2) Prefer smaller `boundingBox.y` (top-to-bottom reading order)
 * 3) Prefer smaller `boundingBox.x` (left-to-right)
 * 4) As last resort, keep original order
 *
 * @param ranked - Candidates already ranked by semantic similarity
 * @returns Same candidates with tie-broken ordering (similarity unchanged)
 */
export function applySpatialTieBreakOrdering(ranked: RankedCandidate[]): {
  ordered: RankedCandidate[];
  applied: boolean;
} {
  const hasAnySpatialSignal = ranked.some(
    (c) => c.node.boundingBox || c.node.isTopMostAtCenter !== undefined
  );
  if (!hasAnySpatialSignal) return { ordered: ranked, applied: false };

  const withIndex = ranked.map((c, idx) => ({ c, idx }));
  withIndex.sort((a, b) => {
    const simDiff = b.c.similarity - a.c.similarity;
    if (Math.abs(simDiff) >= AMBIGUOUS_SIMILARITY_DELTA) return simDiff;

    const aTop = a.c.node.isTopMostAtCenter === true ? 1 : 0;
    const bTop = b.c.node.isTopMostAtCenter === true ? 1 : 0;
    if (aTop !== bTop) return bTop - aTop;

    const aBox = a.c.node.boundingBox;
    const bBox = b.c.node.boundingBox;
    if (aBox && bBox) {
      if (aBox.y !== bBox.y) return aBox.y - bBox.y;
      if (aBox.x !== bBox.x) return aBox.x - bBox.x;
    } else if (aBox && !bBox) {
      return -1;
    } else if (!aBox && bBox) {
      return 1;
    }

    return a.idx - b.idx;
  });

  return { ordered: withIndex.map((x) => x.c), applied: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// V3: DECISION POLICY (Count-based)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Decision result from count-based policy
 */
interface DecisionResult {
  status: LintStatus;
  message: string;
  confidence: number;
  topSimilarity: number;
  similarityDelta: number;
  selectedCandidates: RankedCandidate[];
  /** True if AI fallback is needed (0 allowed or semantic-zero) */
  needsAiFallback?: boolean;
  /** Reason for AI fallback */
  aiFallbackReason?: string;
  /** Rule trace from allowed set building */
  ruleTrace?: RuleTraceEntry[];
}

/**
 * V3: Apply count-based decision policy
 * Decision is based on the NUMBER of allowed elements, not similarity scores:
 * - 0 allowed → AI fallback (not_found with needsAiFallback=true)
 * - 1 allowed → resolved
 * - >1 allowed → needs_clarification (embeddings only sort, never decide)
 * 
 * Special case: semantic-zero
 * If allowed > 0 but all have very low semantic match, trigger AI fallback
 * 
 * @param ranked - Candidates ranked by embedding similarity (already filtered to allowed set)
 * @param allowedCount - Total count of allowed elements (hard + soft)
 * @param shortCircuitRef - If set, single exact match was found (auto-resolve)
 * @param ruleTrace - Rule trace for debugging
 * @returns Decision result
 */
function applyDecisionPolicy(
  ranked: RankedCandidate[],
  allowedCount: number,
  shortCircuitRef?: string,
  ruleTrace?: RuleTraceEntry[]
): DecisionResult {
  const topSim = ranked.length > 0 ? ranked[0].similarity : 0;
  const secondSim = ranked.length > 1 ? ranked[1].similarity : 0;
  const delta = topSim - secondSim;
  
  // Case 0: Short-circuit - exact quoted text match
  if (shortCircuitRef && ranked.length > 0) {
    const shortCircuitCandidate = ranked.find(r => r.node.ref === shortCircuitRef);
    if (shortCircuitCandidate) {
      return {
        status: 'resolved',
        message: 'Element found by exact match',
        confidence: 1.0,
        topSimilarity: shortCircuitCandidate.similarity,
        similarityDelta: delta,
        selectedCandidates: [shortCircuitCandidate],
        ruleTrace,
      };
    }
  }

  // Case 1: No allowed elements → AI fallback
  if (allowedCount === 0) {
    return {
      status: 'not_found',
      message: 'No matching elements found on page',
      confidence: 0,
      topSimilarity: 0,
      similarityDelta: 0,
      selectedCandidates: [],
      needsAiFallback: true,
      aiFallbackReason: 'zero_allowed',
      ruleTrace,
    };
  }

  // Case 2: Exactly one allowed element → resolved
  if (allowedCount === 1 && ranked.length > 0) {
    return {
      status: 'resolved',
      message: 'Element found',
      confidence: Math.max(topSim, 0.8), // High confidence when single match
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: [ranked[0]],
      ruleTrace,
    };
  }

  // Case 3: Multiple allowed elements
  // Check for semantic-zero: allowed > 0 but all have very low semantic match
  if (topSim < SEMANTIC_MIN_THRESHOLD) {
    return {
      status: 'not_found',
      message: 'Found elements but none semantically match your description',
      confidence: topSim,
      topSimilarity: topSim,
      similarityDelta: delta,
      selectedCandidates: ranked.slice(0, 3),
      needsAiFallback: true,
      aiFallbackReason: 'semantic_zero',
      ruleTrace,
    };
  }

  // Case 4: Multiple allowed with good semantic match → needs_clarification
  // Embeddings sorted them, but we don't auto-select.
  // Apply spatial tie-break ordering for very close candidates (delta < threshold).
  let rankedForSelection = ranked;
  if (allowedCount > 1 && topSim >= SEMANTIC_MIN_THRESHOLD && delta < AMBIGUOUS_SIMILARITY_DELTA) {
    const { ordered, applied } = applySpatialTieBreakOrdering(ranked);
    if (applied) {
      rankedForSelection = ordered;
      logger.debug('[EMBEDDINGS_RESOLVER] Spatial tie-break applied', {
        event: 'spatial_tiebreak',
        delta: delta.toFixed(3),
        candidatesWithBbox: ordered.filter(c => c.node.boundingBox).length,
        topMostCount: ordered.filter(c => c.node.isTopMostAtCenter === true).length,
      });
    }
  }

  const top3 = rankedForSelection.slice(0, 3);
  
  return {
    status: 'needs_clarification',
    message: 'Found multiple matching elements',
    confidence: topSim,
    topSimilarity: topSim,
    similarityDelta: delta,
    selectedCandidates: top3,
    ruleTrace,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GEMINI FLASH RESCUE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V6: Last-resort rescue when deterministic rules excluded ALL elements.
 * Calls Gemini Flash (task:'fast') with a 3s timeout to pick the best match
 * from excluded-but-visible nodes. Only used when allowedCount === 0.
 *
 * Uses a high-quality prompt with action-type semantics and multilingual awareness,
 * matching the quality bar of the LLM disambiguation service.
 */
async function rescueWithGeminiFlash(params: {
  intentText: string;
  actionType: IntentActionType;
  excludedNodes: InteractiveNode[];
  pageUrl: string;
}): Promise<{ ref: string; confidence: number; reason: string } | null> {
  const { intentText, actionType, excludedNodes, pageUrl } = params;

  const rescueCandidates = excludedNodes
    .filter(n => n.ref && n.isVisible !== false && !n.isDisabled)
    .slice(0, 10);

  if (rescueCandidates.length === 0) return null;

  const candidateList = rescueCandidates.map((n, i) => {
    const attrs: string[] = [];
    if (n.labelText) attrs.push(`label="${n.labelText}"`);
    if (n.ariaLabel) attrs.push(`aria-label="${n.ariaLabel}"`);
    if (n.placeholder) attrs.push(`placeholder="${n.placeholder}"`);
    if (n.text && n.text.length <= 50) attrs.push(`text="${n.text}"`);
    if (n.name) attrs.push(`name="${n.name}"`);
    if (n.autocomplete) attrs.push(`autocomplete="${n.autocomplete}"`);
    if (n.type || n.inputType) attrs.push(`type="${n.type || n.inputType}"`);
    if (n.role) attrs.push(`role="${n.role}"`);
    return `${i + 1}. ref="${n.ref}" <${n.tag}> ${attrs.join(' ')}`;
  }).join('\n');

  const systemPrompt = `You are an AI element selector for a browser testing tool.

TASK: The user wants to perform a "${actionType}" action. Select the element that BEST matches their intent.

ACTION-TYPE SEMANTICS:
- type/fill: prefer <input>, <textarea>, or role=textbox. The element must be editable.
- click: prefer <button>, <a>, or elements with role=button/link/tab/menuitem.
- select: prefer <select>, role=combobox/listbox, or dropdown-trigger elements.
- check/uncheck/toggle: prefer checkbox/radio/switch controls.
- hover/press/scroll: prefer the closest matching interactive element.

RULES:
1. Match by semantic meaning of the intent to the element's label/aria-label/placeholder/text.
2. Consider action type — e.g., for "type", only editable fields are valid.
3. Use multilingual semantic understanding; do NOT translate literally.
4. If multiple elements could match, pick the one whose label/text is semantically closest.
5. Only use refs from the provided list — never invent refs.
6. If no element is a confident match, return ref as null.
7. Respond ONLY with valid JSON, no markdown or extra text.

OUTPUT FORMAT:
{"ref":"eXX","confidence":0.0-1.0,"reason":"brief explanation"}
If none match: {"ref":null,"confidence":0,"reason":"no match"}`;

  const userPrompt = `USER INTENT: "${intentText}"
ACTION: ${actionType}
PAGE: ${pageUrl}

CANDIDATE ELEMENTS:
${candidateList}

Select the single best matching element. If unsure, return ref: null.`;

  try {
    const response = await generateText({
      prompt: `${systemPrompt}\n\n${userPrompt}`,
      task: 'fast',
      temperature: 0,
      maxTokens: 100,
      timeout: 3000,
    });

    const jsonMatch = response.content.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);

    // ref must be a non-empty string (null or absent = no match)
    if (!parsed.ref || typeof parsed.ref !== 'string') return null;

    const validRefs = new Set(rescueCandidates.map(n => n.ref));
    if (!validRefs.has(parsed.ref)) {
      logger.warn('[EMBEDDINGS_RESOLVER] Gemini Flash rescue: hallucinated ref rejected', {
        ref: parsed.ref,
      });
      return null;
    }

    // Handle confidence as number or numeric string (e.g., "0.85")
    const rawConfidence = typeof parsed.confidence === 'number'
      ? parsed.confidence
      : typeof parsed.confidence === 'string'
        ? parseFloat(parsed.confidence)
        : 0;
    const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0;

    if (confidence < 0.7) return null;

    return {
      ref: parsed.ref,
      confidence,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 200) : 'Gemini Flash rescue',
    };
  } catch (error) {
    logger.warn('[EMBEDDINGS_RESOLVER] Gemini Flash rescue failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN RESOLVER
// ═══════════════════════════════════════════════════════════════════════════

/**
 * V3: Resolve step using embeddings-based matching with deterministic rules
 * 
 * Pipeline:
 * 1. Build HardAllowed/SoftAllowed sets via deterministic rules
 * 2. Check for short-circuit (exact quoted match)
 * 3. If allowed > 0, rank by embeddings
 * 4. Apply count-based decision policy:
 *    - 0 allowed → AI fallback
 *    - 1 allowed → resolved
 *    - >1 allowed → needs_clarification
 *
 * @returns LintResult with embeddings-specific metrics and rule trace
 */
export async function resolveWithEmbeddings(params: {
  previewSessionId: string;
  stepDraft: IntentStep;
  domNodes: InteractiveNode[];
  pageUrl: string;
  /** When true, bypass embeddings cache */
  disableCaching?: boolean;
  /** When true, include candidates in result (for Show Alternatives) */
  includeAlternatives?: boolean;
  /** When true, use LLM to disambiguate between multiple candidates (default: true for aggressive mode) */
  enableLLMDisambiguation?: boolean;
}): Promise<LintResult> {
  const { 
    previewSessionId, 
    stepDraft, 
    domNodes, 
    pageUrl, 
    disableCaching = false,
    includeAlternatives = false,
    enableLLMDisambiguation = true, // Aggressive mode: ON by default
  } = params;
  const startTime = Date.now();

  logger.debug('[EMBEDDINGS_RESOLVER] Starting resolution', {
    previewSessionId,
    stepType: stepDraft.type,
    description: stepDraft.description.slice(0, 50),
    nodeCount: domNodes.length,
  });

  // Non-targeting actions don't need element resolution
  if (['navigate', 'wait', 'wait_for', 'ai_check'].includes(stepDraft.type)) {
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
      needsAiFallback: true,
    };
  }

  // Step 1: Prepare intent text
  const intentText = sanitizeIntent(stepDraft);

  // Step 2: Build HardAllowed/SoftAllowed sets via deterministic DOM-structural rules (sync)
  const allowedResult = buildAllowedSets(domNodes, stepDraft.type, intentText);
  const { hardAllowed, softAllowed, ruleTrace, shortCircuitRef } = allowedResult;
  
  // Combine allowed sets (hardAllowed first, then softAllowed)
  const allAllowed = [...hardAllowed, ...softAllowed];
  const allowedCount = allAllowed.length;

  logger.debug('[EMBEDDINGS_RESOLVER] Allowed sets built', {
    previewSessionId,
    hardAllowedCount: hardAllowed.length,
    softAllowedCount: softAllowed.length,
    totalAllowed: allowedCount,
    shortCircuitRef,
  });

  // Step 3: Handle short-circuit case (exact quoted match)
  if (shortCircuitRef) {
    const shortCircuitNode = allAllowed.find(n => n.ref === shortCircuitRef);
    if (shortCircuitNode) {
      const lintCandidate: LintCandidate = {
        ref: shortCircuitNode.ref,
        label: shortCircuitNode.labelText || shortCircuitNode.ariaLabel || shortCircuitNode.text || shortCircuitNode.placeholder || `<${shortCircuitNode.tag}>`,
        reason: 'Exact match',
        confidence: 1.0,
        boundingBox: shortCircuitNode.boundingBox,
        node: shortCircuitNode,
      };

      logger.info('[EMBEDDINGS_RESOLVER] Short-circuit resolved', {
        event: 'lint_decision',
        previewSessionId,
        stepType: stepDraft.type,
        status: 'resolved',
        shortCircuitRef,
        totalLatencyMs: Date.now() - startTime,
      });

      return {
        status: 'resolved',
        message: 'Element found by exact match',
        confidence: 1.0,
        candidates: [lintCandidate],
        highlight: [{
          ref: shortCircuitNode.ref,
          boundingBox: shortCircuitNode.boundingBox,
          type: 'success',
        }],
        cacheHit: false,
        embeddingsLatencyMs: 0,
        degradedMode: false,
      };
    }
  }

  // Step 4: Handle case of 0 allowed elements
  // V5: Before giving up, try Gemini Flash rescue on excluded-but-visible nodes
  if (allowedCount === 0) {
    const allowedRefs = new Set([...hardAllowed, ...softAllowed].map(n => n.ref));
    const excludedNodes = domNodes.filter(n => n.ref && !allowedRefs.has(n.ref));

    const rescueResult = await rescueWithGeminiFlash({
      intentText,
      actionType: stepDraft.type,
      excludedNodes,
      pageUrl,
    });

    if (rescueResult) {
      const rescuedNode = domNodes.find(n => n.ref === rescueResult.ref);
      if (rescuedNode) {
        logger.info('[EMBEDDINGS_RESOLVER] Gemini Flash rescue succeeded', {
          event: 'gemini_rescue',
          previewSessionId,
          ref: rescueResult.ref,
          confidence: rescueResult.confidence,
          totalLatencyMs: Date.now() - startTime,
        });

        const lintCandidate: LintCandidate = {
          ref: rescuedNode.ref,
          label: rescuedNode.labelText || rescuedNode.ariaLabel || rescuedNode.text || rescuedNode.placeholder || `<${rescuedNode.tag}>`,
          reason: `AI rescue: ${rescueResult.reason}`,
          confidence: rescueResult.confidence,
          boundingBox: rescuedNode.boundingBox,
          node: rescuedNode,
        };

        return {
          status: 'resolved',
          message: `Element found by AI: ${rescueResult.reason}`,
          confidence: rescueResult.confidence,
          candidates: [lintCandidate],
          highlight: [{ ref: rescuedNode.ref, boundingBox: rescuedNode.boundingBox, type: 'success' }],
          cacheHit: false,
          embeddingsLatencyMs: 0,
          degradedMode: false,
        };
      }
    }

    logger.info('[EMBEDDINGS_RESOLVER] Zero allowed elements (rescue failed)', {
      event: 'lint_decision',
      previewSessionId,
      stepType: stepDraft.type,
      status: 'not_found',
      rulesApplied: ruleTrace.length,
      totalLatencyMs: Date.now() - startTime,
    });

    return {
      status: 'not_found',
      message: 'No elements match your description on this page',
      confidence: 0,
      candidates: [],
      highlight: [],
      needsAiFallback: true,
      degradedMode: false,
    };
  }

  // Step 5: Handle case of exactly 1 allowed element → auto-resolve
  if (allowedCount === 1) {
    const singleNode = allAllowed[0];
    const lintCandidate: LintCandidate = {
      ref: singleNode.ref,
      label: singleNode.labelText || singleNode.ariaLabel || singleNode.text || singleNode.placeholder || `<${singleNode.tag}>`,
      reason: 'Single match',
      confidence: 0.9,
      boundingBox: singleNode.boundingBox,
      node: singleNode,
    };

    logger.info('[EMBEDDINGS_RESOLVER] Single allowed element', {
      event: 'lint_decision',
      previewSessionId,
      stepType: stepDraft.type,
      status: 'resolved',
      ref: singleNode.ref,
      totalLatencyMs: Date.now() - startTime,
    });

    return {
      status: 'resolved',
      message: 'Element found',
      confidence: 0.9,
      candidates: [lintCandidate],
      highlight: [{
        ref: singleNode.ref,
        boundingBox: singleNode.boundingBox,
        type: 'success',
      }],
      cacheHit: false,
      embeddingsLatencyMs: 0,
      degradedMode: false,
    };
  }

  // Step 6: Multiple allowed elements → use embeddings to rank, then decide
  // Build candidate texts for embedding
  const candidatesToEmbed: Array<{ node: InteractiveNode; candidateText: string }> = [];
  for (const node of allAllowed.slice(0, MAX_CANDIDATES_TO_EMBED)) {
    const candidateText = buildCandidateText(node);
    candidatesToEmbed.push({ node, candidateText });
  }

  // Compute page signature for cache
  const pageSignature = computePageSignature(pageUrl, domNodes);

  // Rank by embeddings
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
    // Fallback: use candidates in original order
    ranked = candidatesToEmbed.map(c => ({
      node: c.node,
      candidateText: c.candidateText,
      similarity: 0.5, // Default similarity when embeddings unavailable
    }));
  } else {
    try {
      const rankResult = await rankCandidatesByEmbedding({
        intentText,
        candidates: candidatesToEmbed,
        previewSessionId,
        pageSignature,
        disableCaching,
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

      // Fallback: use candidates in original order
      ranked = candidatesToEmbed.map(c => ({
        node: c.node,
        candidateText: c.candidateText,
        similarity: 0.5,
      }));
    }
  }

  // Step 7: Apply count-based decision policy
  let decision = applyDecisionPolicy(ranked, allowedCount, undefined, ruleTrace);

  // Step 7.5: LLM disambiguation for needs_clarification cases
  // V4: If multiple candidates with good similarity, try LLM to auto-select
  let llmDisambiguationResult: DisambiguationResult | undefined;
  if (
    enableLLMDisambiguation &&
    decision.status === 'needs_clarification' &&
    !degradedMode && // Don't call LLM if embeddings already failed
    ranked.length >= 2
  ) {
    const topK = ranked.slice(0, 5); // Use top 5 candidates for LLM
    const disambiguationCandidates = topK.map(r => nodeToDisambiguationCandidate(r.node));

    llmDisambiguationResult = await disambiguateWithLLM({
      userIntent: intentText,
      actionType: stepDraft.type,
      pageUrl,
      candidates: disambiguationCandidates,
      totalAllowedCount: allowedCount,
      pageSignature,
    });

    // If LLM successfully selected a ref with high confidence, override decision
    if (llmDisambiguationResult.selectedRef && !llmDisambiguationResult.skipped) {
      const selectedCandidate = ranked.find(r => r.node.ref === llmDisambiguationResult!.selectedRef);
      if (selectedCandidate) {
        decision = {
          status: 'resolved',
          message: 'Element found by AI disambiguation',
          confidence: llmDisambiguationResult.confidence,
          topSimilarity: decision.topSimilarity,
          similarityDelta: decision.similarityDelta,
          selectedCandidates: [selectedCandidate],
          ruleTrace,
        };

        logger.info('[EMBEDDINGS_RESOLVER] LLM disambiguation resolved', {
          event: 'llm_disambiguation_resolved',
          previewSessionId,
          selectedRef: llmDisambiguationResult.selectedRef,
          confidence: llmDisambiguationResult.confidence,
          llmLatencyMs: llmDisambiguationResult.latencyMs,
          reason: llmDisambiguationResult.reason.slice(0, 100),
        });
      }
    } else if (!llmDisambiguationResult.skipped) {
      // LLM was called but couldn't decide (low confidence or null ref)
      logger.info('[EMBEDDINGS_RESOLVER] LLM disambiguation inconclusive', {
        event: 'llm_disambiguation_inconclusive',
        previewSessionId,
        confidence: llmDisambiguationResult.confidence,
        llmLatencyMs: llmDisambiguationResult.latencyMs,
        reason: llmDisambiguationResult.reason.slice(0, 100),
      });
    }
  }

  // Step 8: Build lint candidates
  // V3: For needs_clarification, only include candidates if includeAlternatives=true
  const shouldIncludeCandidates = 
    decision.status === 'resolved' || 
    decision.status === 'not_found' ||
    includeAlternatives;

  const lintCandidates: LintCandidate[] = shouldIncludeCandidates
    ? decision.selectedCandidates.map(r => ({
        ref: r.node.ref,
        label: r.node.labelText || r.node.ariaLabel || r.node.text || r.node.placeholder || `<${r.node.tag}>`,
        reason: `Match: ${(r.similarity * 100).toFixed(0)}%`,
        confidence: r.similarity,
        boundingBox: r.node.boundingBox,
        node: r.node,
      }))
    : [];

  // Build highlight
  // V3: For needs_clarification without includeAlternatives, don't highlight
  const highlight = shouldIncludeCandidates
    ? decision.selectedCandidates.map((r, idx) => ({
        ref: r.node.ref,
        boundingBox: r.node.boundingBox,
        type: (decision.status === 'resolved' && idx === 0 ? 'success' : 'warning') as 'success' | 'warning' | 'error',
      }))
    : [];

  const totalLatencyMs = Date.now() - startTime;

  // Log decision metrics
  logger.info('[EMBEDDINGS_RESOLVER] Resolution complete', {
    event: 'lint_decision',
    previewSessionId,
    stepType: stepDraft.type,
    topSim: decision.topSimilarity.toFixed(3),
    delta: decision.similarityDelta.toFixed(3),
    status: decision.status,
    allowedCount,
    cacheHit,
    embeddingsLatencyMs,
    totalLatencyMs,
    candidateCount: ranked.length,
    degradedMode,
    includeAlternatives,
    // LLM disambiguation metrics
    llmDisambiguationEnabled: enableLLMDisambiguation,
    llmDisambiguationRan: !!llmDisambiguationResult && !llmDisambiguationResult.skipped,
    llmDisambiguationResolved: llmDisambiguationResult?.selectedRef !== null && llmDisambiguationResult?.selectedRef !== undefined,
    llmDisambiguationLatencyMs: llmDisambiguationResult?.latencyMs,
    llmDisambiguationCacheHit: llmDisambiguationResult?.cacheHit,
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
    degradedMode,
    degradedReason,
    needsAiFallback: decision.needsAiFallback,
    // LLM disambiguation info (if used)
    llmDisambiguationUsed: llmDisambiguationResult?.selectedRef !== null && llmDisambiguationResult?.selectedRef !== undefined,
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
