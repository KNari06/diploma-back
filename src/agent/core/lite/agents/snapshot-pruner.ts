/**
 * Snapshot Pruner — Pre-LLM Context-Aware Element Filter
 *
 * Fast LLM layer between collect() and format() that removes irrelevant elements
 * based on the test goal. NOT a decision-maker — just a cleaner that understands context.
 *
 * - Receives goal → keeps only relevant elements
 * - Cached by url|contentHash|goalHash → repeated calls = 0ms
 * - Replaces hardcoded slice(0, 80) with dynamic, goal-aware filtering
 * - Understands popups/modals/dropdowns naturally via LLM (no z-index heuristics)
 *
 * Model: gemini-2.5-flash-lite (~1-2s latency)
 * Fallback: on timeout/error → returns null → caller uses legacy format() behavior
 */

import { LITE_ENGINE_FLAGS } from '@/config/testing/intelligent-test-limits';
import { AI_TASK_MODELS } from '@/config/ai/ai-models.config';
import { logger } from '@/utils/core/logger';
import { LitePromptBuilder } from '../prompt/lite-prompt-builder';
import type { LiteElement } from '../lite-types';

// ═══════════════════════════════════════════════════════════════════════════
// INTERFACES
// ═══════════════════════════════════════════════════════════════════════════

export interface PrunerInput {
  /** Raw snapshot elements */
  elements: LiteElement[];
  /** Test goal for context-aware filtering */
  goal: string;
  /** Current page URL */
  url: string;
  /** Content hash of the snapshot (from LiteState.computeContentHash) */
  contentHash: string;
  /** Active modal ref — pruner must always keep modal elements */
  activeModalRef?: string;
}

export interface PrunerResult {
  /** Set of ref IDs to keep */
  keepRefs: Set<string>;
  /** Whether result came from cache */
  fromCache: boolean;
  /** Time taken in ms (0 if cached) */
  durationMs: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// PRUNER CACHE (same pattern as ObserverCache)
// ═══════════════════════════════════════════════════════════════════════════

interface PrunerCacheEntry {
  keepRefs: Set<string>;
  timestamp: number;
  url: string;
}

class PrunerCache {
  private cache = new Map<string, PrunerCacheEntry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(ttlMs: number, maxEntries: number) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
  }

  buildKey(url: string, contentHash: string, goalHash: string): string {
    return `${url}|${contentHash}|${goalHash}`;
  }

  get(key: string): Set<string> | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      logger.debug('[PRUNER_CACHE] Entry expired', { url: entry.url.slice(0, 50) });
      return null;
    }

    logger.debug('[PRUNER_CACHE] Cache hit', { url: entry.url.slice(0, 50) });
    return entry.keepRefs;
  }

  set(key: string, keepRefs: Set<string>, url: string): void {
    // Evict oldest if at capacity
    if (this.cache.size >= this.maxEntries && !this.cache.has(key)) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [k, v] of this.cache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { keepRefs, timestamp: Date.now(), url });
    logger.debug('[PRUNER_CACHE] Cached pruning result', {
      url: url.slice(0, 50),
      keepCount: keepRefs.size,
      cacheSize: this.cache.size,
    });
  }

  invalidateForUrl(url: string): void {
    const targetBase = PrunerCache.getUrlBase(url);
    for (const [key, entry] of this.cache) {
      if (PrunerCache.getUrlBase(entry.url) === targetBase) {
        this.cache.delete(key);
      }
    }
  }

  private static getUrlBase(url: string): string {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      return url;
    }
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// SNAPSHOT PRUNER
// ═══════════════════════════════════════════════════════════════════════════

export class SnapshotPruner {
  private cache: PrunerCache;

  constructor() {
    this.cache = new PrunerCache(
      LITE_ENGINE_FLAGS.prunerCacheTtlMs,
      LITE_ENGINE_FLAGS.prunerCacheMaxEntries,
    );
  }

  /**
   * Prune snapshot elements using a fast LLM call.
   * Returns keepRefs set on success, null on failure (caller falls back to legacy).
   */
  async prune(input: PrunerInput): Promise<PrunerResult | null> {
    const startMs = Date.now();

    // Skip if too few elements — no pruning needed
    if (input.elements.length <= LITE_ENGINE_FLAGS.snapshotMaxElements) {
      return null; // Let format() pass all elements through
    }

    // 1. Check cache
    const goalHash = SnapshotPruner.computeHash(input.goal);
    const cacheKey = this.cache.buildKey(input.url, input.contentHash, goalHash);
    const cached = this.cache.get(cacheKey);
    if (cached) {
      return { keepRefs: cached, fromCache: true, durationMs: 0 };
    }

    // 2. Build compact prompt
    const prompt = SnapshotPruner.buildPrompt(
      input.elements, input.goal, input.url, input.activeModalRef,
    );

    // 3. LLM call with timeout
    const result = await LitePromptBuilder.askJson<{ keep: string[] }>(prompt, {
      model: AI_TASK_MODELS.snapshotPruning as string,
      temperature: 0.0,
      maxTokens: 2000,
      timeoutMs: LITE_ENGINE_FLAGS.prunerTimeoutMs,
    });

    // 4. Validate response
    if (!result || !Array.isArray(result.keep) || result.keep.length === 0) {
      logger.warn('[SNAPSHOT_PRUNER] LLM returned invalid or empty response, falling back', {
        hasResult: !!result,
        keepLength: result?.keep?.length ?? 0,
      });
      return null;
    }

    // 5. Build keepRefs set + force-include modal elements
    const validRefs = new Set(input.elements.map(el => el.ref));
    const keepRefs = new Set<string>();
    for (const ref of result.keep) {
      if (validRefs.has(ref)) {
        keepRefs.add(ref);
      }
    }

    // Force-include all elements inside active modal (safety net)
    if (input.activeModalRef) {
      for (const el of input.elements) {
        if (el.isInsideActiveModal) {
          keepRefs.add(el.ref);
        }
      }
    }

    // Safety: if LLM kept too few, fall back to legacy.
    // P2 fix — threshold lifted to LITE_ENGINE_FLAGS.prunerMinKeepRefs
    // (was hardcoded 5 inline). Tunable per-deploy without rebuild.
    if (keepRefs.size < LITE_ENGINE_FLAGS.prunerMinKeepRefs) {
      logger.warn('[SNAPSHOT_PRUNER] LLM kept too few elements, falling back', {
        kept: keepRefs.size,
        total: input.elements.length,
        minRequired: LITE_ENGINE_FLAGS.prunerMinKeepRefs,
      });
      return null;
    }

    // 6. Cache and return
    const durationMs = Date.now() - startMs;
    this.cache.set(cacheKey, keepRefs, input.url);

    logger.debug('[SNAPSHOT_PRUNER] Pruned snapshot', {
      total: input.elements.length,
      kept: keepRefs.size,
      pruned: input.elements.length - keepRefs.size,
      durationMs,
    });

    return { keepRefs, fromCache: false, durationMs };
  }

  /** Invalidate cache entries for a URL */
  invalidateForUrl(url: string): void {
    this.cache.invalidateForUrl(url);
  }

  /** Clear entire cache */
  clear(): void {
    this.cache.clear();
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Build compact element list for pruner prompt.
   * ~50-80 chars per element. For 300 elements = ~20KB, well within gemini-2.5-flash-lite context.
   */
  private static buildCompactList(elements: LiteElement[]): string {
    return elements.map(el => {
      const flags: string[] = [];
      if (el.disabled) flags.push('D');
      if (el.hasValue) flags.push('V');
      if (el.isInsideActiveModal) flags.push('M');
      if (el.required) flags.push('R');
      if (el.isTopMostAtCenter === false) flags.push('C');
      const flagStr = flags.length > 0 ? ` [${flags.join('')}]` : '';
      const name = (el.name || el.placeholder || '').slice(0, 40);
      return `${el.ref}|${el.tag}|${el.role}|${name}|${el.type || ''}${flagStr}`;
    }).join('\n');
  }

  /**
   * Build the pruner LLM prompt.
   */
  private static buildPrompt(
    elements: LiteElement[],
    goal: string,
    url: string,
    activeModalRef?: string,
  ): string {
    const compact = SnapshotPruner.buildCompactList(elements);
    const modalLine = activeModalRef
      ? `\nACTIVE_MODAL: ${activeModalRef} (ALWAYS keep ALL elements with [M] flag)\n`
      : '';

    return `You are a fast element filter for a web testing AI agent.

GOAL: ${goal}
URL: ${url}${modalLine}
PAGE ELEMENTS (${elements.length} total, format: ref|tag|role|name|type [flags]):
Flags: D=disabled, V=has_value, M=inside_modal, R=required, C=covered_by_overlay
${compact}

TASK: Return a JSON object with a "keep" array listing ref IDs the testing agent will need.

RULES:
1. KEEP elements relevant to the GOAL (forms, buttons, links, inputs the agent might interact with)
2. KEEP ALL elements with [M] flag (inside active modal)
3. KEEP navigation elements that help reach the goal (menus, breadcrumbs, tabs)
4. KEEP form submit buttons, error indicators, headings for orientation
5. REMOVE purely decorative elements, redundant footer/sidebar navigation, social media icons
6. REMOVE elements with [C] flag (covered by overlay) unless they have [M] flag
7. REMOVE disabled [D] elements that are clearly irrelevant to the goal
8. When in doubt, KEEP the element — it is better to have extra elements than miss something critical

Respond ONLY with valid JSON: {"keep": ["e0", "e1", "e5", ...]}`;
  }

  /**
   * DJB2 hash (same pattern as LiteState.computeContentHash)
   */
  private static computeHash(str: string): string {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
    }
    return hash.toString(36);
  }
}
