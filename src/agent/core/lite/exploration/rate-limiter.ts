/**
 * ═══════════════════════════════════════════════════════════════════════════
 * RATE LIMITER — Centralized rate-limit coordination for exploration
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Thread-safe coordinator shared between SurveyAgent and FlowRunner.
 * Enforces pacing between external requests (navigation + AI API) and
 * provides exponential backoff with degradation on repeated 429s.
 *
 * Reuses:
 *   - sleep() from services/skills/retry.ts
 *   - Async mutex pattern from BudgetTracker
 */

import { logger } from '@/utils/core/logger';
import { sleep } from '@/services/skills/retry';
import type { RateLimitingConfig } from './types';
import type { BudgetTracker } from './budget-tracker';

export type RateLimitTarget = 'openai' | 'target_site';
type SlotType = 'navigation' | 'ai';

const DEFAULTS: Required<RateLimitingConfig> = {
  minDelayBetweenNavigationsMs: 500,
  minDelayBetweenAiCallsMs: 200,
  maxConsecutiveRateLimits: 3,
  baseBackoffMs: 5_000,
  maxBackoffMs: 30_000,
};

export class RateLimiter {
  private readonly cfg: Required<RateLimitingConfig>;
  private readonly consecutiveFailures = new Map<RateLimitTarget, number>();
  private readonly degraded = new Set<RateLimitTarget>();
  private readonly lastRequestTime = new Map<SlotType, number>();
  private mutexPromise: Promise<void> = Promise.resolve();

  constructor(
    config: RateLimitingConfig | undefined,
    private readonly budget: BudgetTracker,
  ) {
    this.cfg = { ...DEFAULTS, ...config };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // PACING
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Enforce minimum delay between requests of the given type.
   * Returns false if the corresponding target is degraded (caller should fallback).
   */
  async acquireSlot(type: SlotType): Promise<boolean> {
    const target: RateLimitTarget = type === 'navigation' ? 'target_site' : 'openai';
    if (this.degraded.has(target)) return false;

    const minDelay = type === 'navigation'
      ? this.cfg.minDelayBetweenNavigationsMs
      : this.cfg.minDelayBetweenAiCallsMs;

    // Mutex-protected read/write of lastRequestTime.
    // We store the projected "slot available at" time so concurrent callers
    // queue correctly: each one reads the previous slot's end time and extends it.
    let waitMs = 0;
    await this.withMutex(() => {
      const now = Date.now();
      const slotAvailableAt = this.lastRequestTime.get(type) ?? 0;
      waitMs = Math.max(0, slotAvailableAt - now);
      // Reserve this slot: next caller must wait until after our slot ends
      this.lastRequestTime.set(type, now + waitMs + minDelay);
    });

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // SUCCESS / FAILURE TRACKING
  // ═══════════════════════════════════════════════════════════════════════

  /** Reset consecutive failure count on successful request. */
  recordSuccess(target: RateLimitTarget): void {
    if (this.consecutiveFailures.has(target)) {
      this.consecutiveFailures.set(target, 0);
    }
  }

  /**
   * Handle a request failure. Only reacts to rate-limit (429) errors.
   * Non-429 errors are passed through to the caller.
   */
  async recordFailure(
    target: RateLimitTarget,
    error: Error,
  ): Promise<{ shouldRetry: boolean; isDegraded: boolean; backoffMs: number }> {
    if (!RateLimiter.isRateLimitError(error)) {
      return { shouldRetry: false, isDegraded: false, backoffMs: 0 };
    }

    let count = 0;
    let nowDegraded = false;

    await this.withMutex(() => {
      count = (this.consecutiveFailures.get(target) ?? 0) + 1;
      this.consecutiveFailures.set(target, count);

      if (count >= this.cfg.maxConsecutiveRateLimits) {
        this.degraded.add(target);
        nowDegraded = true;
      }
    });

    if (nowDegraded) {
      await this.budget.markDegraded(target);
      logger.warn('[RATE_LIMITER] Target degraded after repeated 429s', {
        target,
        consecutiveFailures: count,
      });
      return { shouldRetry: false, isDegraded: true, backoffMs: 0 };
    }

    // Exponential backoff with ±20% jitter
    const baseDelay = this.cfg.baseBackoffMs * Math.pow(2, count - 1);
    const capped = Math.min(baseDelay, this.cfg.maxBackoffMs);
    const jitter = capped * 0.2 * (Math.random() * 2 - 1);
    const backoffMs = Math.round(capped + jitter);

    logger.info('[RATE_LIMITER] Rate limited, backing off', {
      target,
      attempt: count,
      backoffMs,
    });

    // Sleep AFTER releasing mutex (withMutex already completed)
    await sleep(backoffMs);

    return { shouldRetry: true, isDegraded: false, backoffMs };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATUS CHECKS
  // ═══════════════════════════════════════════════════════════════════════

  /** Check if a target has been marked as degraded. */
  isDegraded(target: RateLimitTarget): boolean {
    return this.degraded.has(target);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // STATIC HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  /** Narrow check: only matches HTTP 429 / rate-limit errors. */
  static isRateLimitError(error: Error): boolean {
    const err = error as Error & { status?: number; statusCode?: number };
    if (err.status === 429 || err.statusCode === 429) return true;
    if (/rate.?limit|too many requests|429/i.test(error.message)) return true;
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // INTERNAL: async mutex (same pattern as BudgetTracker)
  // ═══════════════════════════════════════════════════════════════════════

  private async withMutex(fn: () => void): Promise<void> {
    const prev = this.mutexPromise;
    let resolve: () => void;
    this.mutexPromise = new Promise<void>((r) => {
      resolve = r;
    });
    await prev;
    try {
      fn();
    } finally {
      resolve!();
    }
  }
}
