/**
 * ═══════════════════════════════════════════════════════════════════════════
 * DRAFT STEPS CACHE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Lightweight in-memory cache for draft test steps generated in editor mode.
 * Keyed by chatSessionId (not previewSessionId) because chat sessions persist
 * across preview reconnects, while preview sessions are ephemeral.
 *
 * Ensures the AI agent can retrieve structured steps between conversation
 * turns, avoiding the need to re-parse prose from message history.
 *
 * Pattern: module-scoped Map (like activeRuns in preview-run.service.ts)
 *          + TTL with lazy cleanup (like confirmPreviews in skill-registry.ts)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { IntentStep } from './preview.types';
import { logger } from '@/utils/core/logger';

interface CachedDraftSteps {
  steps: IntentStep[];
  startUrl: string;
  createdAt: number;
  userId: string;
}

/** TTL: 30 minutes — generous enough for slow human workflows */
const DRAFT_CACHE_TTL_MS = 30 * 60 * 1000;

/** Lazy cleanup threshold (matches skill-registry.ts pattern) */
const CLEANUP_THRESHOLD = 50;

/**
 * Module-scoped Map. Key = chatSessionId.
 * Uses chatSessionId because:
 * - Chat sessions persist across preview reconnects
 * - One workspace has one chat session (shared by all members)
 * - Steps are conversation-scoped, not preview-scoped
 */
const cache = new Map<string, CachedDraftSteps>();

export const DraftStepsCache = {
  /**
   * Store draft steps for a chat session.
   * Overwrites any existing entry (e.g., when user modifies steps and re-runs).
   */
  set(chatSessionId: string, data: Omit<CachedDraftSteps, 'createdAt'>): void {
    cache.set(chatSessionId, { ...data, createdAt: Date.now() });

    // Lazy cleanup when map grows beyond threshold
    if (cache.size > CLEANUP_THRESHOLD) {
      const now = Date.now();
      for (const [key, entry] of cache) {
        if (now - entry.createdAt > DRAFT_CACHE_TTL_MS) {
          cache.delete(key);
        }
      }
    }

    logger.debug('[DRAFT_STEPS_CACHE] Cached draft steps', {
      chatSessionId,
      stepCount: data.steps.length,
      startUrl: data.startUrl,
    });
  },

  /**
   * Retrieve cached draft steps. Returns undefined if not found or expired.
   */
  get(chatSessionId: string): CachedDraftSteps | undefined {
    const entry = cache.get(chatSessionId);
    if (!entry) return undefined;

    // Check TTL — evict expired entries on read
    if (Date.now() - entry.createdAt > DRAFT_CACHE_TTL_MS) {
      cache.delete(chatSessionId);
      logger.debug('[DRAFT_STEPS_CACHE] Entry expired', { chatSessionId });
      return undefined;
    }

    return entry;
  },

  /**
   * Explicitly clear cached steps (e.g., after qa_create_test_case saves them to DB).
   */
  delete(chatSessionId: string): boolean {
    const deleted = cache.delete(chatSessionId);
    if (deleted) {
      logger.debug('[DRAFT_STEPS_CACHE] Entry cleared', { chatSessionId });
    }
    return deleted;
  },

  /** @internal TEST-ONLY: prevent cross-test leakage */
  __dangerousClearForTests(): void {
    cache.clear();
  },
};
