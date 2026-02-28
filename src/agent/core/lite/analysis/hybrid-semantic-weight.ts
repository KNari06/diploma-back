/**
 * Hybrid Semantic Weight Calculator (Precision-First)
 *
 * Combines fast heuristics with slow AI audit for gray zone elements.
 *
 * Architecture:
 * 1. Fast Path (sync): Error detection (0.95), goal-specific forms (1.0), clear categories
 * 2. Slow Path (async): AI audit for gray zone (0.1-0.7) elements
 * 3. In-Memory Cache: LRU with max 500 entries, per test run
 *
 * Keyword matching uses token/boundary-aware matching + light EN/RU stemming
 * to reduce false positives (e.g. "catalog" should NOT match "log").
 */

import {
  DECORATIVE_KEYWORDS,
  ERROR_KEYWORDS,
  GOAL_KEYWORD_MAP,
  NAVIGATION_KEYWORDS,
  PRIMARY_ACTION_KEYWORDS,
} from '@/config/testing/semantic-keywords';
import { getChatCompletionWithMessages } from '@/services/ai/core/openai.service';
import { logger } from '@/utils/core/logger';
import type { LiteElement, ProgressSentiment, StateDiff } from '../lite-types';
import { FunnelAnalyzer, FunnelPhase } from './funnel-analyzer';
import type { ExpandedGoal } from './goal-expander';

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface CachedWeight {
  weight: number;
  source: 'heuristic' | 'ai';
  category?: string;
  timestamp: number;
}

interface AIAuditResult {
  ref: string;
  weight: number;
  category: 'goal-action' | 'navigation' | 'informational' | 'decorative';
  reasoning: string;
}

interface HeuristicResult {
  weight: number;
  needsAI: boolean;
  category?: string;
}

export interface EnrichedElement extends LiteElement {
  semanticWeight: number;
  category?: string;
  aiEnriched?: boolean;
}

export interface EnrichedStateDiff extends StateDiff {
  addedElements: EnrichedElement[];
  removedElements?: EnrichedElement[];
}

interface CalculatorStats {
  cacheHits: number;
  cacheMisses: number;
  aiCalls: number;
  aiTimeouts: number;
  totalLatencyMs: number;
  errorElementsDetected: number;
  // Z-index layering stats
  elementsWithZIndex: number;
  coveredElementsDetected: number;
}

/**
 * Rule interface for heuristic classification
 * Rules are evaluated in order; first matching rule wins
 */
interface HeuristicRule {
  /** Rule name for debugging */
  name: string;
  /** Priority (lower = evaluated first) */
  priority: number;
  /** Check if rule applies to element */
  matches: (el: LiteElement, ctx: RuleContext) => boolean;
  /** Calculate weight and category */
  evaluate: (el: LiteElement, ctx: RuleContext) => HeuristicResult;
}

/**
 * Context passed to rules for dynamic evaluation
 */
interface RuleContext {
  /** Goal keywords for dynamic priority */
  goalKeywords: string[];
  /** Stats reference for counting */
  stats: CalculatorStats;
  /** Helper: check if element matches any keyword */
  matchesKeyword: (text: string, keyword: string) => boolean;
  /** Helper: check if element matches any keyword in list */
  matchesAnyKeyword: (text: string, keywords: readonly string[]) => boolean;
}

// ═══════════════════════════════════════════════════════════════════════════
// TEXT NORMALIZATION & TOKEN MATCHING (Light Stemming EN/RU)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize text for matching:
 * - lowercase
 * - ё → е (Russian)
 * - split camelCase and kebab-case
 * - normalize separators
 */
function normalizeText(text: string): string {
  if (!text) return '';

  return text
    .toLowerCase()
    // Russian: ё → е
    .replace(/ё/g, 'е')
    // Split camelCase: "signIn" → "sign In"
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    // Split Cyrillic camelCase: "войтиВ" → "войти В"
    .replace(/([а-яё])([А-ЯЁ])/g, '$1 $2')
    // Normalize separators (kebab, snake, dots) to spaces
    .replace(/[-_.]+/g, ' ')
    // Collapse multiple spaces
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Tokenize text into words
 */
function tokenize(text: string): string[] {
  const normalized = normalizeText(text);
  // Match English and Russian words (4+ chars for meaningful words, but keep all for matching)
  return normalized.split(/\s+/).filter(t => t.length > 0);
}

/**
 * Light English stemming (conservative - only common suffixes)
 * Reduces "signing" → "sign", "logged" → "log", "submits" → "submit"
 */
function stemEnglish(word: string): string {
  if (word.length < 4) return word;

  // Skip if contains non-ASCII (not English)
  if (!/^[a-z]+$/.test(word)) return word;

  // Order matters: longer suffixes first
  const suffixes = [
    { suffix: 'ying', minLen: 5, replace: 'y' },   // dying → dy (but we skip short)
    { suffix: 'ing', minLen: 5, replace: '' },     // signing → sign, logging → logg (note: not perfect)
    { suffix: 'ied', minLen: 5, replace: 'y' },    // applied → apply
    { suffix: 'ies', minLen: 5, replace: 'y' },    // applies → apply
    { suffix: 'ed', minLen: 4, replace: '' },      // logged → logg, saved → sav
    { suffix: 'es', minLen: 4, replace: '' },      // deletes → delet
    { suffix: 's', minLen: 4, replace: '' },       // submits → submit
  ];

  for (const { suffix, minLen, replace } of suffixes) {
    if (word.length >= minLen && word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length) + replace;
      // Only return if stem is at least 3 chars
      if (stem.length >= 3) return stem;
    }
  }

  return word;
}

/**
 * Light Russian stemming (very conservative - common verb/noun endings)
 * Reduces "войдите" → "войд", "вошёл" → "вош"
 */
function stemRussian(word: string): string {
  if (word.length < 4) return word;

  // Skip if contains non-Cyrillic
  if (!/^[а-яё]+$/.test(word)) return word;

  // Common Russian endings (very conservative to avoid over-stripping)
  const endings = [
    'ться', 'ться', 'ите', 'ешь', 'ёшь', 'ать', 'ять', 'еть',
    'уть', 'оть', 'ил', 'ла', 'ло', 'ли', 'ый', 'ий', 'ой',
    'ая', 'яя', 'ое', 'ее', 'ие', 'ые',
  ];

  for (const ending of endings) {
    if (word.length > ending.length + 2 && word.endsWith(ending)) {
      return word.slice(0, -ending.length);
    }
  }

  return word;
}

/**
 * Apply light stemming based on language detection
 */
function stem(word: string): string {
  if (/^[a-z]+$/.test(word)) {
    return stemEnglish(word);
  }
  if (/^[а-яё]+$/.test(word)) {
    return stemRussian(word);
  }
  return word; // Mixed or unknown
}

/**
 * Check if text contains a keyword using token/boundary matching
 * Prevents false positives like "catalog" matching "log"
 *
 * @param text Text to search in
 * @param keyword Keyword to find
 * @param useStemming Whether to use light stemming
 * @returns True if keyword matches
 */
export function matchesKeyword(text: string, keyword: string, useStemming = true): boolean {
  const textTokens = tokenize(text);
  const keywordTokens = tokenize(keyword);

  if (keywordTokens.length === 0) return false;

  // Apply stemming if enabled
  const processedTextTokens = useStemming
    ? textTokens.map(t => stem(t))
    : textTokens;
  const processedKeywordTokens = useStemming
    ? keywordTokens.map(t => stem(t))
    : keywordTokens;

  // Single word keyword: exact token match
  if (processedKeywordTokens.length === 1) {
    const kw = processedKeywordTokens[0];
    return processedTextTokens.some(t => t === kw);
  }

  // Multi-word keyword (e.g. "sign in"): token sequence match
  // Find first token, then check if remaining tokens follow
  const firstKw = processedKeywordTokens[0];
  for (let i = 0; i < processedTextTokens.length; i++) {
    if (processedTextTokens[i] === firstKw) {
      let matches = true;
      for (let j = 1; j < processedKeywordTokens.length; j++) {
        if (processedTextTokens[i + j] !== processedKeywordTokens[j]) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }

  return false;
}

/**
 * Check if text matches any keyword in a list
 */
function matchesAnyKeyword(
  text: string,
  keywords: readonly string[],
  useStemming = true
): boolean {
  for (const kw of keywords) {
    if (matchesKeyword(text, kw, useStemming)) {
      return true;
    }
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// ERROR DETECTION (Highest Priority - Weight 0.95)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Detect error/alert/warning elements (highest priority)
 * @param el Element to check
 * @returns True if element is error-related
 */
export function isErrorElement(el: LiteElement): boolean {
  // Check role first (most reliable - ARIA takes precedence)
  if (el.role === 'alert') return true;

  // Combine all text signals
  const textToCheck = [
    el.htmlId || '',
    el.htmlName || '',
    el.name || '',
    el.context || '',
  ].join(' ');

  // Use token matching for error keywords
  return matchesAnyKeyword(textToCheck, ERROR_KEYWORDS, false); // No stemming for errors
}

// ═══════════════════════════════════════════════════════════════════════════
// GOAL KEYWORD PARSING (Dynamic Priority)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Parse goal text into relevant keywords for dynamic priority
 * Uses GOAL_KEYWORD_MAP from config + extracts words from goal text
 *
 * @param goal User's goal text
 * @returns Array of relevant keywords (stemmed)
 */
export function parseGoalKeywords(goal: string): string[] {
  const goalNormalized = normalizeText(goal);
  const goalTokens = tokenize(goal);
  const keywords: string[] = [];

  // Check against synonym map
  for (const [key, values] of Object.entries(GOAL_KEYWORD_MAP)) {
    // Check if goal contains the key or any synonym
    const keyMatches = matchesKeyword(goalNormalized, key, true);
    const valueMatches = values.some(v => matchesKeyword(goalNormalized, v, true));

    if (keyMatches || valueMatches) {
      // Add all synonyms for this category
      keywords.push(...values);
    }
  }

  // Also extract individual words from goal (4+ chars)
  const meaningfulTokens = goalTokens
    .filter(t => t.length >= 4)
    .map(t => stem(t));
  keywords.push(...meaningfulTokens);

  // Deduplicate
  return [...new Set(keywords)];
}

// ═══════════════════════════════════════════════════════════════════════════
// HEURISTIC RULES REGISTRY (Scalable Pattern)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Ordered list of heuristic rules for element classification
 * Rules are evaluated in priority order; first matching rule wins
 *
 * To add new rules (e.g. for MUI, Ant Design):
 * 1. Create a rule object with matches() and evaluate()
 * 2. Insert it at appropriate priority level
 */
const HEURISTIC_RULES: HeuristicRule[] = [
  // ─────────────────────────────────────────────────────────────────────────
  // Priority 1: Error Detection (0.95) - HIGHEST PRIORITY
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'ErrorRule',
    priority: 1,
    matches: (el: LiteElement) => isErrorElement(el),
    evaluate: (_el: LiteElement, ctx: RuleContext) => {
      ctx.stats.errorElementsDetected++;
      return { weight: 0.95, needsAI: false, category: 'error' };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 2: Goal-Specific Form (1.0)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'GoalFormRule',
    priority: 2,
    matches: (el: LiteElement) => el.tag === 'form',
    evaluate: (el: LiteElement, ctx: RuleContext) => {
      const combinedText = `${el.name || ''} ${el.context || ''}`;
      const isRelevant = ctx.goalKeywords.some((kw: string) =>
        ctx.matchesKeyword(combinedText, kw)
      );
      if (isRelevant) {
        return { weight: 1.0, needsAI: false, category: 'goal-form' };
      }
      return { weight: 0.8, needsAI: false, category: 'form' };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 3: Primary Action Button (0.9)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'PrimaryActionRule',
    priority: 3,
    matches: (el: LiteElement, ctx: RuleContext) => {
      // Match buttons by tag or role (covers custom button components)
      const isButton = el.tag === 'button' || el.role === 'button';
      // Match interactive toggles/switches that act as primary actions
      const isToggleAction = el.role === 'switch';
      if (!isButton && !isToggleAction) return false;
      const nameText = el.name || '';
      return ctx.matchesAnyKeyword(nameText, PRIMARY_ACTION_KEYWORDS);
    },
    evaluate: (el: LiteElement, ctx: RuleContext) => {
      const nameText = el.name || '';
      const isRelevant = ctx.goalKeywords.some((kw: string) =>
        ctx.matchesKeyword(nameText, kw)
      );
      const weight = isRelevant ? Math.min(0.9 * 2.0, 1.0) : 0.9;
      return { weight, needsAI: false, category: 'primary-action' };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 4: Credential Inputs (0.7)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'CredentialInputRule',
    priority: 4,
    matches: (el: LiteElement) => {
      if (el.tag !== 'input') return false;
      // Core credential types
      if (el.type === 'email' || el.type === 'password' || el.type === 'tel') return true;
      // Autocomplete-hinted credential fields (text inputs with credential autocomplete)
      if (el.autocomplete && /^(username|email|tel|new-password|current-password)/.test(el.autocomplete)) return true;
      return false;
    },
    evaluate: () => ({ weight: 0.7, needsAI: false, category: 'credential-input' }),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 5: Search Input (0.7)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'SearchInputRule',
    priority: 5,
    matches: (el: LiteElement, ctx: RuleContext) => {
      if (el.tag !== 'input') return false;
      if (el.type !== 'text' && el.type !== 'search') return false;
      const nameText = el.name || '';
      return ctx.matchesKeyword(nameText, 'search') || ctx.matchesKeyword(nameText, 'поиск');
    },
    evaluate: () => ({ weight: 0.7, needsAI: false, category: 'search-input' }),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 5b: Specialized Interactive Inputs (0.6)
  // Date, range, color, datetime-local — user-interactable but not credential
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'SpecializedInputRule',
    priority: 5.5,
    matches: (el: LiteElement) => {
      if (el.tag !== 'input') return false;
      const specializedTypes = new Set(['date', 'datetime-local', 'time', 'month', 'week', 'range', 'color', 'number']);
      return specializedTypes.has(el.type || '');
    },
    evaluate: () => ({ weight: 0.6, needsAI: false, category: 'specialized-input' }),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 6: Navigation Links (0.5)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'NavigationRule',
    priority: 6,
    matches: (el: LiteElement, ctx: RuleContext) => {
      if (el.tag !== 'a' && el.role !== 'link') return false;
      const nameText = el.name || '';
      return ctx.matchesAnyKeyword(nameText, NAVIGATION_KEYWORDS);
    },
    evaluate: (el: LiteElement, ctx: RuleContext) => {
      const nameText = el.name || '';
      const isRelevant = ctx.goalKeywords.some((kw: string) =>
        ctx.matchesKeyword(nameText, kw)
      );
      const weight = isRelevant ? Math.min(0.5 * 2.0, 1.0) : 0.5;
      return { weight, needsAI: false, category: 'navigation' };
    },
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 7: Decorative Elements (0.05)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'DecorativeRule',
    priority: 7,
    matches: (el: LiteElement, ctx: RuleContext) => {
      if (el.tag === 'img' || el.tag === 'svg' || el.role === 'img') return true;
      const combinedText = `${el.name || ''} ${el.context || ''}`;
      return ctx.matchesAnyKeyword(combinedText, DECORATIVE_KEYWORDS);
    },
    evaluate: () => ({ weight: 0.05, needsAI: false, category: 'decorative' }),
  },

  // ─────────────────────────────────────────────────────────────────────────
  // Priority 8: Gray Zone Fallbacks (need AI audit)
  // ─────────────────────────────────────────────────────────────────────────
  {
    name: 'ButtonGrayZoneRule',
    priority: 8,
    matches: (el: LiteElement) => el.tag === 'button' || el.role === 'button',
    evaluate: () => ({ weight: 0.5, needsAI: true, category: 'button' }),
  },
  {
    name: 'InputGrayZoneRule',
    priority: 9,
    matches: (el: LiteElement) => {
      // Standard input tags
      if (el.tag === 'input' || el.tag === 'textarea' || el.tag === 'select') return true;
      // ARIA widget roles that represent interactive inputs
      const inputRoles = new Set([
        'textbox', 'searchbox', 'spinbutton', 'combobox', 'listbox',
        'slider', 'switch', 'checkbox', 'radio',
        'menuitemcheckbox', 'menuitemradio',
      ]);
      return inputRoles.has(el.role || '');
    },
    evaluate: () => ({ weight: 0.5, needsAI: true, category: 'input' }),
  },
  {
    name: 'LinkGrayZoneRule',
    priority: 10,
    matches: (el: LiteElement) => el.tag === 'a' || el.role === 'link',
    evaluate: () => ({ weight: 0.5, needsAI: true, category: 'link' }),
  },
  {
    name: 'HeaderGrayZoneRule',
    priority: 11,
    matches: (el: LiteElement) => el.tag === 'h1' || el.tag === 'h2',
    evaluate: () => ({ weight: 0.3, needsAI: true, category: 'header' }),
  },
  {
    name: 'TextGrayZoneRule',
    priority: 12,
    matches: (el: LiteElement) => el.tag === 'p' || el.tag === 'span' || el.tag === 'label',
    evaluate: () => ({ weight: 0.1, needsAI: true, category: 'text' }),
  },
  {
    name: 'DefaultGrayZoneRule',
    priority: 99,
    matches: () => true, // Fallback for everything else
    evaluate: () => ({ weight: 0.2, needsAI: true, category: 'unknown' }),
  },
].sort((a, b) => a.priority - b.priority);

// ═══════════════════════════════════════════════════════════════════════════
// Z-INDEX / LAYERING SCORING (Percentile-based, no hardcoded thresholds)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Compute z-index percentile ranking for a set of elements
 * Returns a Map of ref → percentile (0.0 - 1.0)
 *
 * Uses RELATIVE ranking (percentile) instead of fixed thresholds.
 * This works correctly regardless of site's z-index scale (10, 100, 1000+).
 *
 * @param elements Array of elements with optional computedZIndex
 * @returns Map of ref → percentile (0.0 = lowest, 1.0 = highest)
 */
function computeZIndexPercentiles(elements: LiteElement[]): Map<string, number> {
  // Filter to elements with numeric z-index
  const withZIndex = elements.filter(
    el => typeof el.computedZIndex === 'number' && el.computedZIndex !== null
  );

  if (withZIndex.length === 0) {
    return new Map(); // No z-index data → no percentiles
  }

  // Sort by z-index (ascending)
  const sorted = [...withZIndex].sort(
    (a, b) => (a.computedZIndex as number) - (b.computedZIndex as number)
  );

  // Assign percentile based on position
  const result = new Map<string, number>();
  const totalWithZ = sorted.length;

  sorted.forEach((el, index) => {
    // Percentile: position / (total - 1), clamped to [0, 1]
    // For single element, percentile = 1.0 (it's the highest AND lowest)
    const percentile = totalWithZ === 1 ? 1.0 : index / (totalWithZ - 1);
    result.set(el.ref, percentile);
  });

  return result;
}

/**
 * Layering context for an element (computed once per snapshot)
 */
interface LayeringInfo {
  /** Z-index percentile within snapshot (0.0 - 1.0, undefined if no z-index) */
  zPercentile?: number;
  /** Whether element is positioned (participates in stacking context) */
  isPositioned: boolean;
  /** Whether element is topmost at its center (not covered by overlay) */
  isTopMostAtCenter?: boolean;
  /** Whether element is likely covered (isTopMostAtCenter === false) */
  likelyCovered: boolean;
}

/**
 * Compute layering info for all elements in a snapshot
 *
 * @param elements Snapshot elements
 * @returns Map of ref → LayeringInfo
 */
function computeLayeringInfo(elements: LiteElement[]): Map<string, LayeringInfo> {
  const percentiles = computeZIndexPercentiles(elements);
  const result = new Map<string, LayeringInfo>();

  for (const el of elements) {
    const zPercentile = percentiles.get(el.ref);

    result.set(el.ref, {
      zPercentile,
      isPositioned: el.isPositioned ?? false,
      isTopMostAtCenter: el.isTopMostAtCenter,
      // Element is likely covered if:
      // 1. isTopMostAtCenter is explicitly false (something is on top of it)
      // 2. AND it's positioned (participates in stacking) - static elements are often OK
      likelyCovered: el.isTopMostAtCenter === false && (el.isPositioned ?? false),
    });
  }

  return result;
}

/**
 * Apply layering multiplier to semantic weight
 * Uses percentile-based scoring (no fixed z-index thresholds).
 *
 * Multiplier range: 0.8 (bottom) to 1.2 (top)
 * - Bottom 25% z-index: 0.8 - 0.9 multiplier (deprioritize background elements)
 * - Middle 50% z-index: 0.9 - 1.1 multiplier (neutral)
 * - Top 25% z-index: 1.1 - 1.2 multiplier (boost foreground elements)
 *
 * Coverage penalty: if isTopMostAtCenter === false → weight × 0.6 (significant downweight)
 *
 * @param weight Base semantic weight
 * @param layering Layering info for element
 * @returns Adjusted weight (clamped to 0.0 - 1.0)
 */
function applyLayeringMultiplier(weight: number, layering: LayeringInfo): number {
  let adjustedWeight = weight;

  // 1. Apply z-index percentile multiplier (if available)
  if (typeof layering.zPercentile === 'number') {
    // Linear interpolation: percentile 0→0.8, percentile 1→1.2
    const multiplier = 0.8 + layering.zPercentile * 0.4;
    adjustedWeight *= multiplier;
  }

  // 2. Apply coverage penalty (if element is likely covered)
  if (layering.likelyCovered) {
    adjustedWeight *= 0.6; // Significant downweight for covered elements
  }

  // 3. Clamp to valid range
  return Math.max(0, Math.min(1, adjustedWeight));
}

// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY LRU CACHE
// ═══════════════════════════════════════════════════════════════════════════

class SemanticWeightCache {
  private cache: Map<string, CachedWeight> = new Map();
  private readonly MAX_SIZE = 500;
  private hits = 0;
  private misses = 0;

  /**
   * Generate cache key from element
   * Includes parent context to avoid SPA collisions (e.g., multiple "Save" buttons)
   * Key format: tag:type:role:name:context(30)
   */
  getCacheKey(el: LiteElement): string {
    const context = normalizeText(el.context || '').slice(0, 30);
    const name = normalizeText(el.name).slice(0, 40);
    return `${el.tag}:${el.type || ''}:${el.role}:${name}:${context}`;
  }

  get(key: string): CachedWeight | null {
    const cached = this.cache.get(key);
    if (cached) {
      this.hits++;
      return cached;
    }
    this.misses++;
    return null;
  }

  set(key: string, value: CachedWeight): void {
    // LRU eviction if max size reached
    if (this.cache.size >= this.MAX_SIZE) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
  }

  getStats(): { hits: number; misses: number; size: number } {
    return { hits: this.hits, misses: this.misses, size: this.cache.size };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// HYBRID SEMANTIC WEIGHT CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════

export class HybridSemanticWeightCalculator {
  private cache: SemanticWeightCache;
  private goal: string;
  private goalKeywords: string[];
  private stats: CalculatorStats;
  private testId: string;
  // L2 Manus Integration
  private expandedGoal: ExpandedGoal | null = null;
  private currentFunnelPhase: FunnelPhase = FunnelPhase.DISCOVERY;

  /**
   * Constructor supports both legacy (goal string) and new (ExpandedGoal) modes.
   *
   * @param goalOrExpanded Raw goal string OR ExpandedGoal from GoalExpander
   * @param testId Optional test ID for logging
   */
  constructor(goalOrExpanded: string | ExpandedGoal, testId?: string) {
    // Support both legacy string goal and new ExpandedGoal
    if (typeof goalOrExpanded === 'string') {
      this.goal = goalOrExpanded;
      this.goalKeywords = parseGoalKeywords(goalOrExpanded);
      this.expandedGoal = null;
    } else {
      this.goal = goalOrExpanded.original;
      this.expandedGoal = goalOrExpanded;
      // Use expanded keywords if available, fallback to parsed
      this.goalKeywords = goalOrExpanded.allKeywords.size > 0
        ? [...goalOrExpanded.allKeywords]
        : parseGoalKeywords(goalOrExpanded.original);
    }

    this.cache = new SemanticWeightCache();
    this.testId = testId || 'unknown';
    this.stats = {
      cacheHits: 0,
      cacheMisses: 0,
      aiCalls: 0,
      aiTimeouts: 0,
      totalLatencyMs: 0,
      errorElementsDetected: 0,
      elementsWithZIndex: 0,
      coveredElementsDetected: 0,
    };

    logger.debug('[HYBRID_SEMANTIC] Initialized', {
      testId: this.testId,
      goal: this.goal.slice(0, 50),
      goalKeywordsCount: this.goalKeywords.length,
      keywords: this.goalKeywords.slice(0, 10),
      hasExpandedGoal: !!this.expandedGoal,
      funnelPhase: this.currentFunnelPhase,
    });
  }

  /**
   * Update goal when refined (L2 Goal Refinement)
   * Called when funnel phase or URL changes significantly
   */
  updateGoal(newExpandedGoal: ExpandedGoal): void {
    this.expandedGoal = newExpandedGoal;
    this.goal = newExpandedGoal.original;
    this.goalKeywords = [...newExpandedGoal.allKeywords];

    logger.debug('[HYBRID_SEMANTIC] Goal updated', {
      testId: this.testId,
      keywordCount: this.goalKeywords.length,
      phase: newExpandedGoal.phase,
      refinedAt: newExpandedGoal.refinedAt,
    });
  }

  /**
   * Update funnel phase (L2 Funnel Logic)
   * Affects weight multipliers for element categories
   */
  updateFunnelPhase(phase: FunnelPhase): void {
    if (this.currentFunnelPhase !== phase) {
      logger.debug('[HYBRID_SEMANTIC] Funnel phase updated', {
        testId: this.testId,
        from: this.currentFunnelPhase,
        to: phase,
      });
      this.currentFunnelPhase = phase;
    }
  }

  /**
   * Get current funnel phase
   */
  getFunnelPhase(): FunnelPhase {
    return this.currentFunnelPhase;
  }

  /**
   * Check if element matches negative keywords (dead-ends)
   */
  matchesNegativeKeywords(element: LiteElement): boolean {
    if (!this.expandedGoal || this.expandedGoal.negativeKeywords.size === 0) {
      return false;
    }
    const text = (element.name || '').toLowerCase();
    for (const kw of this.expandedGoal.negativeKeywords) {
      if (text.includes(kw)) return true;
    }
    return false;
  }

  /**
   * Calculate heuristic weight for element (Fast Path - Sync)
   * Uses HEURISTIC_RULES registry for scalable rule-based classification
   *
   * Weight categories:
   * - 0.95: Error elements (highest priority)
   * - 1.0: Goal-specific form
   * - 0.9: Primary action button
   * - 0.7: Credential inputs
   * - 0.5: Regular buttons, navigation links (GRAY ZONE)
   * - 0.3: Headers (GRAY ZONE)
   * - 0.1: Text/labels (GRAY ZONE)
   * - 0.05: Decorative elements
   *
   * L2 Manus Integration:
   * - Applies funnel phase multipliers
   * - Applies negative keyword penalty
   * - Uses ExpandedGoal keywords for better matching
   */
  calculateHeuristic(el: LiteElement): HeuristicResult {
    // Build rule context with helpers
    const ctx: RuleContext = {
      goalKeywords: this.goalKeywords,
      stats: this.stats,
      matchesKeyword: (text, kw) => matchesKeyword(text, kw, true),
      matchesAnyKeyword: (text, keywords) => matchesAnyKeyword(text, keywords, true),
    };

    // Evaluate rules in priority order; first matching rule wins
    let result: HeuristicResult = { weight: 0.2, needsAI: true, category: 'unknown' };
    for (const rule of HEURISTIC_RULES) {
      if (rule.matches(el, ctx)) {
        result = rule.evaluate(el, ctx);
        break;
      }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // L2 MANUS INTEGRATION: Funnel Multiplier + Negative Penalty
    // ═══════════════════════════════════════════════════════════════════════

    let weight = result.weight;

    // Apply funnel phase multiplier (L2)
    const elementCategory = FunnelAnalyzer.categorizeElement(el);
    const funnelMultipliers = FunnelAnalyzer.getMultipliers(this.currentFunnelPhase);
    const funnelMultiplier = funnelMultipliers[elementCategory] ?? 1.0;

    if (funnelMultiplier !== 1.0) {
      const adjustedWeight = Math.min(weight * funnelMultiplier, 1.0);
      logger.debug('[HYBRID_SEMANTIC] Funnel multiplier applied', {
        ref: el.ref?.slice(0, 20),
        category: elementCategory,
        phase: this.currentFunnelPhase,
        multiplier: funnelMultiplier,
        original: weight.toFixed(2),
        adjusted: adjustedWeight.toFixed(2),
      });
      weight = adjustedWeight;
    }

    // Apply negative keyword penalty (L2)
    if (this.matchesNegativeKeywords(el)) {
      const penalizedWeight = weight * 0.1; // Heavy penalty for dead-ends
      logger.debug('[HYBRID_SEMANTIC] Negative keyword penalty applied', {
        ref: el.ref?.slice(0, 20),
        name: el.name?.slice(0, 30),
        original: weight.toFixed(2),
        penalized: penalizedWeight.toFixed(2),
      });
      weight = penalizedWeight;
    }

    // Apply ExpandedGoal keyword boost (L2)
    if (this.expandedGoal && this.expandedGoal.allKeywords.size > 0) {
      const text = (el.name || '').toLowerCase();
      let hasKeywordMatch = false;
      for (const kw of this.expandedGoal.allKeywords) {
        if (text.includes(kw)) {
          hasKeywordMatch = true;
          break;
        }
      }
      if (hasKeywordMatch && weight < 0.9) {
        // Boost goal-relevant elements, but cap at 1.0
        const boostedWeight = Math.min(weight * 1.5, 1.0);
        weight = boostedWeight;
      }
    }

    return {
      ...result,
      weight,
    };
  }

  /**
   * Enrich StateDiff with AI audit for gray zone elements (Slow Path - Async)
   * Called AFTER StateDiffComputer.compute(), BEFORE prompt build
   *
   * Now includes Z-index layering scoring (percentile-based, no hardcoded thresholds)
   *
   * @param diff Original StateDiff
   * @param removedElements Elements that were removed (for semantic weight calculation)
   * @returns Enriched StateDiff with AI-classified weights + layering adjustments
   */
  async enrichWithAI(
    diff: StateDiff,
    removedElements: LiteElement[] = []
  ): Promise<EnrichedStateDiff> {
    const startTime = Date.now();

    // 0. Compute layering info (z-index percentiles + coverage) for all elements
    const allRawElements = [...diff.addedElements, ...removedElements];
    const layeringMap = computeLayeringInfo(allRawElements);

    // Track layering stats
    let elementsWithZIndex = 0;
    let coveredElements = 0;
    for (const info of layeringMap.values()) {
      if (typeof info.zPercentile === 'number') elementsWithZIndex++;
      if (info.likelyCovered) coveredElements++;
    }
    this.stats.elementsWithZIndex += elementsWithZIndex;
    this.stats.coveredElementsDetected += coveredElements;

    if (elementsWithZIndex > 0 || coveredElements > 0) {
      logger.debug('[HYBRID_SEMANTIC] Layering analysis', {
        testId: this.testId,
        totalElements: allRawElements.length,
        withZIndex: elementsWithZIndex,
        covered: coveredElements,
      });
    }

    // 1. Enrich all elements with heuristic weights + layering adjustments
    const enrichedAdded: EnrichedElement[] = diff.addedElements.map(el => {
      const cached = this.cache.get(this.cache.getCacheKey(el));
      const layering = layeringMap.get(el.ref);

      if (cached) {
        this.stats.cacheHits++;
        // Apply layering multiplier to cached weight
        const adjustedWeight = layering
          ? applyLayeringMultiplier(cached.weight, layering)
          : cached.weight;
        return {
          ...el,
          semanticWeight: adjustedWeight,
          category: cached.category,
          aiEnriched: cached.source === 'ai',
        };
      }

      this.stats.cacheMisses++;
      const heuristic = this.calculateHeuristic(el);

      // Apply layering multiplier to heuristic weight
      const adjustedWeight = layering
        ? applyLayeringMultiplier(heuristic.weight, layering)
        : heuristic.weight;

      return {
        ...el,
        semanticWeight: adjustedWeight,
        category: heuristic.category,
        aiEnriched: false,
      };
    });

    const enrichedRemoved: EnrichedElement[] = removedElements.map(el => {
      const cached = this.cache.get(this.cache.getCacheKey(el));
      const layering = layeringMap.get(el.ref);

      if (cached) {
        const adjustedWeight = layering
          ? applyLayeringMultiplier(cached.weight, layering)
          : cached.weight;
        return {
          ...el,
          semanticWeight: adjustedWeight,
          category: cached.category,
          aiEnriched: cached.source === 'ai',
        };
      }

      const heuristic = this.calculateHeuristic(el);
      const adjustedWeight = layering
        ? applyLayeringMultiplier(heuristic.weight, layering)
        : heuristic.weight;

      return {
        ...el,
        semanticWeight: adjustedWeight,
        category: heuristic.category,
        aiEnriched: false,
      };
    });

    // 2. Find gray zone elements (need AI audit)
    // Now includes covered elements (likelyCovered = true → force AI audit)
    const allElements = [...enrichedAdded, ...enrichedRemoved];
    const grayZone = allElements.filter(el => {
      const cached = this.cache.get(this.cache.getCacheKey(el));
      if (cached) return false; // Already classified

      const heuristic = this.calculateHeuristic(el);
      const layering = layeringMap.get(el.ref);

      // Force AI audit if:
      // 1. Heuristic says needsAI AND weight is in gray zone (0.1-0.7), OR
      // 2. Element is likely covered (need AI to decide if it's a blocker)
      const isCovered = layering?.likelyCovered ?? false;
      const isGrayZone = heuristic.needsAI && heuristic.weight >= 0.1 && heuristic.weight <= 0.7;

      return isGrayZone || isCovered;
    });

    if (grayZone.length === 0) {
      logger.debug('[HYBRID_SEMANTIC] No gray zone elements, skipping AI', {
        testId: this.testId,
        addedCount: enrichedAdded.length,
        removedCount: enrichedRemoved.length,
      });
      // Calculate total weight for early return
      const totalWeight =
        enrichedAdded.reduce((sum, el) => sum + el.semanticWeight, 0) +
        enrichedRemoved.reduce((sum, el) => sum + el.semanticWeight, 0);

      return {
        ...diff,
        addedElements: enrichedAdded,
        removedElements: enrichedRemoved,
        semanticWeight: totalWeight,
        meaningfulChange: totalWeight >= 0.1,
        significantChange: totalWeight >= 0.5,
        progressSentiment: this.calculateProgressSentiment(diff, totalWeight),
      };
    }

    logger.debug('[HYBRID_SEMANTIC] AI audit for gray zone', {
      testId: this.testId,
      grayZoneCount: grayZone.length,
      totalElements: allElements.length,
    });

    // 3. Batch AI audit with timeout (1500ms)
    try {
      const aiResults = await Promise.race([
        this.batchAudit(grayZone.slice(0, 15)), // Max 15 elements per batch
        new Promise<null>((_, reject) =>
          setTimeout(() => reject(new Error('AI timeout')), 1500)
        ),
      ]);

      if (aiResults && aiResults.length > 0) {
        this.stats.aiCalls++;

        // Update cache and enriched elements with AI results
        for (const result of aiResults) {
          const el = grayZone.find(e => e.ref === result.ref);
          if (el) {
            const cacheKey = this.cache.getCacheKey(el);
            this.cache.set(cacheKey, {
              weight: result.weight,
              source: 'ai',
              category: result.category,
              timestamp: Date.now(),
            });

            // Update in enriched arrays
            const addedIdx = enrichedAdded.findIndex(e => e.ref === result.ref);
            if (addedIdx !== -1) {
              enrichedAdded[addedIdx] = {
                ...enrichedAdded[addedIdx],
                semanticWeight: result.weight,
                category: result.category,
                aiEnriched: true,
              };
            }
            const removedIdx = enrichedRemoved.findIndex(e => e.ref === result.ref);
            if (removedIdx !== -1) {
              enrichedRemoved[removedIdx] = {
                ...enrichedRemoved[removedIdx],
                semanticWeight: result.weight,
                category: result.category,
                aiEnriched: true,
              };
            }
          }
        }

        const latency = Date.now() - startTime;
        this.stats.totalLatencyMs += latency;

        logger.debug('[HYBRID_SEMANTIC] AI audit complete', {
          testId: this.testId,
          resultsCount: aiResults.length,
          latencyMs: latency,
        });
      }
    } catch (error) {
      this.stats.aiTimeouts++;
      const latency = Date.now() - startTime;
      this.stats.totalLatencyMs += latency;

      logger.warn('[HYBRID_SEMANTIC] AI audit failed/timeout, using heuristics', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
        latencyMs: latency,
      });
      // Fallback: use heuristic weights (already calculated above)
    }

    // 4. Recalculate total semantic weight
    const totalWeight =
      enrichedAdded.reduce((sum, el) => sum + el.semanticWeight, 0) +
      enrichedRemoved.reduce((sum, el) => sum + el.semanticWeight, 0);

    return {
      ...diff,
      addedElements: enrichedAdded,
      removedElements: enrichedRemoved,
      semanticWeight: totalWeight,
      meaningfulChange: totalWeight >= 0.1,
      significantChange: totalWeight >= 0.5,
      progressSentiment: this.calculateProgressSentiment(diff, totalWeight),
    };
  }

  /**
   * Calculate progress sentiment based on diff and semantic weight
   * CRITICAL: This method fixes the bug where progressSentiment was always 'No Effect'
   */
  private calculateProgressSentiment(diff: StateDiff, totalWeight: number): ProgressSentiment {
    // 1. Check for errors first - highest priority
    const hasErrors =
      (diff.newPageErrors && diff.newPageErrors.length > 0) ||
      (diff.newConsoleErrors && diff.newConsoleErrors.length > 0) ||
      (diff.newNetworkErrors && diff.newNetworkErrors.length > 0) ||
      (diff.validationApiErrors && diff.validationApiErrors.length > 0);

    if (hasErrors) {
      return 'Negative Change';
    }

    // 2. Check for major progress indicators
    // URL change is always major progress
    if (diff.urlChanged) {
      return 'Major Progress';
    }

    // Goal-relevant form with high semantic weight
    const hasRelevantForm = diff.addedElements?.some(
      (el) => el.tag === 'input' && totalWeight >= 0.5
    );
    if (hasRelevantForm) {
      return 'Major Progress';
    }

    // 3. Check for significant change
    if (totalWeight >= 0.5) {
      return 'Significant Change';
    }

    // Successful API responses indicate significant change even without visual changes
    if (diff.successfulApiResponses && diff.successfulApiResponses.length > 0) {
      return 'Significant Change';
    }

    // 4. Check for minor change
    if (totalWeight >= 0.1) {
      return 'Minor Change';
    }

    // 5. Default: no effect
    return 'No Effect';
  }

  /**
   * Batch AI audit for gray zone elements
   * Uses gpt-4o-mini for fast classification
   */
  private async batchAudit(elements: LiteElement[]): Promise<AIAuditResult[]> {
    if (elements.length === 0) return [];

    const prompt = this.buildAuditPrompt(elements);

    try {
      const response = await getChatCompletionWithMessages(
        [{ role: 'user', content: prompt }],
        {
          model: 'gpt-4o-mini',
          temperature: 0,
          response_format: { type: 'json_object' },
          max_tokens: 400,
        }
      );

      const content = response.content?.replace(/```json\s*|```\s*/g, '').trim();
      if (!content) return [];

      const parsed = JSON.parse(content);
      return parsed.elements || parsed || [];
    } catch (error) {
      logger.error('[HYBRID_SEMANTIC] Batch audit failed', {
        testId: this.testId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Build prompt for AI batch audit
   */
  private buildAuditPrompt(batch: LiteElement[]): string {
    const elementsText = batch.map((el, i) => {
      const context = (el.context || '').slice(0, 40);
      const name = el.name.slice(0, 30);
      return `${i + 1}. ref=${el.ref}, tag=${el.tag}, name="${name}", context="${context}"`;
    }).join('\n');

    return `USER'S GOAL: ${this.goal}

ELEMENTS TO CLASSIFY (determine importance for achieving the goal):
${elementsText}

For each element, determine:
- weight (0.0-1.0): How important is this element for achieving the goal?
  - 0.9-1.0: Critical for goal (submit button, target form)
  - 0.6-0.8: Helpful for goal (relevant navigation, inputs)
  - 0.3-0.5: Neutral (general content)
  - 0.0-0.2: Not relevant (decorative, footer)
- category: goal-action | navigation | informational | decorative
- reasoning: Brief explanation (max 10 words)

Return JSON: {"elements": [{"ref": "e1", "weight": 0.8, "category": "goal-action", "reasoning": "login button matches goal"}, ...]}`;
  }

  /**
   * Build Goal-Oriented Summary for Core Brain prompt (Secret Sauce)
   * Generates English summary of what changed and why it matters
   *
   * Priority:
   * 1. Errors (highest)
   * 2. Forms
   * 3. Goal-relevant changes
   * 4. Navigation changes
   */
  buildGoalOrientedSummary(diff: EnrichedStateDiff): string {
    const lines: string[] = [];
    const added = diff.addedElements as EnrichedElement[];
    const removed = diff.removedElements || [];

    // 1. Errors first (highest priority)
    const errors = added.filter(el => el.category === 'error' || isErrorElement(el));
    if (errors.length > 0) {
      const errorNames = errors.map(e => e.name.slice(0, 30)).slice(0, 3).join(', ');
      lines.push(`⚠️ Errors appeared: ${errorNames}`);
    }

    // 2. Validation API errors
    if (diff.validationApiErrors && diff.validationApiErrors.length > 0) {
      const firstError = diff.validationApiErrors[0];
      const msg = firstError.message || firstError.errors?.join(', ') || 'validation failed';
      lines.push(`⚠️ API validation: ${msg.slice(0, 50)}`);
    }

    // 3. Forms
    const forms = added.filter(el => el.tag === 'form');
    if (forms.length > 0) {
      const formName = forms[0].name || 'unnamed';
      lines.push(`📝 New form: ${formName.slice(0, 30)}`);
    }

    // 4. Goal-relevant elements (from AI category or heuristic)
    const goalRelevant = added.filter(el =>
      el.category === 'goal-action' ||
      el.category === 'goal-form' ||
      el.category === 'primary-action'
    );
    if (goalRelevant.length > 0) {
      const names = goalRelevant.map(e => e.name.slice(0, 20)).slice(0, 3).join(', ');
      lines.push(`🎯 Goal-relevant: ${names}`);
    }

    // 5. URL change
    if (diff.urlChanged) {
      lines.push(`🔗 Navigated to: ${diff.urlAfter.slice(0, 50)}`);
    }

    // 6. API success
    if (diff.successfulApiResponses && diff.successfulApiResponses.length > 0) {
      lines.push(`✅ API success: Server confirmed action`);
    }

    // 7. Significant removals
    if (removed.length > 3) {
      const highWeightRemoved = removed.filter(el => el.semanticWeight >= 0.5);
      if (highWeightRemoved.length > 0) {
        lines.push(`➖ Removed: ${highWeightRemoved.length} significant elements`);
      }
    }

    // 8. Progress sentiment
    const sentiment = this.getSentimentEmoji(diff.progressSentiment);
    if (diff.progressSentiment !== 'No Effect') {
      lines.push(`${sentiment} Progress: ${diff.progressSentiment}`);
    }

    if (lines.length === 0) {
      return 'Minimal changes detected.';
    }

    return lines.join('\n');
  }

  private getSentimentEmoji(sentiment: ProgressSentiment): string {
    switch (sentiment) {
      case 'Major Progress': return '🎯';
      case 'Significant Change': return '✅';
      case 'Minor Change': return '↗️';
      case 'No Effect': return '❌';
      case 'Negative Change': return '⚠️';
      default: return '•';
    }
  }

  /**
   * Clear cache (call on test completion)
   */
  clearCache(): void {
    this.cache.clear();
    logger.debug('[HYBRID_SEMANTIC] Cache cleared', { testId: this.testId });
  }

  /**
   * Get calculator stats for monitoring
   */
  getStats(): CalculatorStats & { cacheStats: { hits: number; misses: number; size: number } } {
    return {
      ...this.stats,
      cacheStats: this.cache.getStats(),
    };
  }
}
