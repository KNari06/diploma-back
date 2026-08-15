/**
 * AI Usage Tracker (Singleton)
 * Accumulates AI usage in-memory per session, flushes to DB post-hoc.
 * Automatically tracks all OpenAI/Gemini calls via interceptors.
 */

import { logger } from '@/utils/core/logger';
import { insertAIUsageLog, isSchemaDriftError } from './db/ai-usage-log.db';
import { AI_PRICING, type AIModel } from '../cost/ai-cost-manager.service';
import { getAIContext, type AITrackingContext } from './ai-context';

export interface AIUsageRecord {
  provider: 'openai' | 'gemini';
  model: string;
  inputTokens: number;
  /** Subset of inputTokens served from OpenAI's automatic prompt cache. */
  cachedInputTokens?: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  timestamp: number;
  durationMs?: number;
}

export interface AIUsageSessionSummary {
  totalInputTokens: number;
  totalCachedInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  aiCallCount: number;
  breakdown: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    cachedInputTokens: number;
    outputTokens: number;
    count: number;
  }>;
}

interface AIUsageSession {
  context: AITrackingContext;
  records: AIUsageRecord[];
  startedAt: number;
  pipelineMetrics?: Record<string, any>;
  /**
   * True when a caller opened this session via `beginSession` and is therefore
   * responsible for closing it. The sweep treats the two kinds differently:
   * an owned session must NOT be flushed out from under its owner just because
   * the work is taking a while (regression runs routinely exceed 10 minutes),
   * whereas an auto-created one has no owner and the sweep is its only path to
   * the database. See `cleanup()`.
   */
  explicit?: boolean;
}

/**
 * Global AI Usage Tracker
 * Lifecycle:
 *   1. beginSession(sessionId, context) — called at test/chat start
 *   2. record(record) — called automatically by interceptors
 *   3. endSession(sessionId) — called after test/operation completes; flushes to DB
 */
export class AIUsageTracker {
  private static sessions = new Map<string, AIUsageSession>();

  /** Latch so schema drift is reported once per process, not once per session. */
  private static schemaDriftReported = false;

  /** How often orphaned sessions are swept and flushed. */
  private static readonly SWEEP_INTERVAL_MS = 2 * 60 * 1000;

  /**
   * Self-starting sweep, one per process.
   *
   * `sessions` is a per-process static Map, so this CANNOT live in the
   * scheduler — the scheduler makes no LLM calls and would sweep an empty map
   * while the API and worker leaked. Every process that records usage needs its
   * own timer, which is what a module-level static gives us. Same pattern as
   * `TestExecutedStepsRedisService.cleanupTimer`.
   *
   * Before this existed, `cleanup()` was defined and documented as "should be
   * called by a background job or cron" — and had no call site anywhere. Any
   * session not explicitly ended (the majority; only 7 call sites pair
   * begin/endSession) was therefore never flushed and never freed.
   */
  private static sweepTimer: ReturnType<typeof setInterval> | null = (() => {
    // Never auto-start under Jest. The timer is registered at import time and
    // outlives the suite that imported it inside a shared worker process, so it
    // can fire in the MIDDLE of an unrelated test file and drive a real DB
    // write through whatever that file has mocked `@/db/supabase` with. That is
    // not hypothetical: it made `artifact-retention.job.test.ts` fail in the
    // full run while passing in isolation. Tests call `cleanup()` directly.
    if (process.env.NODE_ENV === 'test') return null;

    const timer = setInterval(() => {
      try {
        AIUsageTracker.cleanup();
      } catch (err) {
        logger.warn('[AI_USAGE] Sweep failed', {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }, AIUsageTracker.SWEEP_INTERVAL_MS);
    // Never hold the event loop open for a usage sweep.
    if (timer.unref) timer.unref();
    return timer;
  })();

  /**
   * Begin tracking session.
   * Call this at the start of a test, chat message, or any tracked operation.
   */
  static beginSession(sessionId: string, context: AITrackingContext): void {
    if (this.sessions.has(sessionId)) {
      logger.warn('[AI_USAGE] Session already exists, overwriting', { sessionId });
    }

    this.sessions.set(sessionId, {
      context,
      records: [],
      startedAt: Date.now(),
      explicit: true,
    });

    logger.debug('[AI_USAGE] Session started', {
      sessionId,
      workspaceId: context.workspaceId,
      operationType: context.operationType,
    });
  }

  /**
   * Record a single AI call.
   * Called automatically by interceptors in openai.service.ts / gemini.service.ts.
   * Uses AsyncLocalStorage to determine which session to attribute to.
   */
  static record(record: AIUsageRecord): void {
    const ctx = getAIContext();
    if (!ctx) {
      // No tracking context — this is an untracked AI call (e.g., server startup, background job)
      logger.debug('[AI_USAGE] Untracked AI call (no context)', {
        provider: record.provider,
        model: record.model,
        tokens: record.totalTokens,
      });
      return;
    }

    // Find the session this call belongs to.
    //
    // The synthetic key MUST be stable for a given context. It previously ended
    // in `Date.now()`, which minted a brand-new session for every single call
    // that had no `testId` — each holding one record, each auto-created below,
    // and none of them ever passed to `endSession`. The result was two bugs at
    // once: those calls never reached `ai_usage_log` at all, and `sessions` grew
    // without bound for the life of the process. Only the 7 call sites that
    // pair beginSession/endSession were ever recorded; preview/editor element
    // resolution, mobile runs, negative generation, exploration and self-heal
    // were not.
    //
    // Keying on (operationType, workspace, user) instead means concurrent work
    // by one user aggregates into a single session that the sweep below flushes
    // on a ~10-minute cadence. For cost accounting that is the right shape, and
    // the map is now bounded by active users rather than by call volume.
    const sessionId =
      ctx.sessionId ||
      ctx.testId ||
      ctx.runId ||
      `${ctx.operationType || 'unknown'}-${ctx.workspaceId}-${ctx.userId ?? 'anon'}`;
    let session = this.sessions.get(sessionId);

    if (!session) {
      // Auto-create session if within context but no explicit beginSession
      logger.debug('[AI_USAGE] Auto-creating session', {
        sessionId,
        workspaceId: ctx.workspaceId,
      });
      session = {
        context: ctx,
        records: [],
        startedAt: Date.now(),
        explicit: false,
      };
      this.sessions.set(sessionId, session);
    }

    session.records.push(record);

    logger.debug('[AI_USAGE] Recorded AI call', {
      sessionId,
      provider: record.provider,
      model: record.model,
      inputTokens: record.inputTokens,
      outputTokens: record.outputTokens,
      costUSD: record.costUSD.toFixed(6),
    });
  }

  /**
   * Attach pipeline metrics to current session.
   * Called after sub-agent pipeline completes (success or fallback).
   */
  static recordPipelineMetrics(sessionId: string, metrics: Record<string, any>): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.pipelineMetrics = metrics;
    }
  }

  /**
   * End session and flush to database.
   * Returns aggregated stats for caller logging.
   */
  static async endSession(sessionId: string): Promise<AIUsageSessionSummary | null> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      logger.warn('[AI_USAGE] Session not found for endSession', { sessionId });
      return null;
    }

    this.sessions.delete(sessionId);

    if (session.records.length === 0) {
      logger.debug('[AI_USAGE] Session ended with no AI calls', { sessionId });
      return null;
    }

    const summary = this.aggregate(session);

    // Fire-and-forget DB write (non-blocking)
    this.flushToDatabase(session, summary).catch((err) => {
      logger.error('[AI_USAGE] Failed to flush usage to DB', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    logger.info('[AI_USAGE] Session ended', {
      sessionId,
      workspaceId: session.context.workspaceId,
      operationType: session.context.operationType,
      aiCallCount: summary.aiCallCount,
      totalTokens: summary.totalTokens,
      totalCostUSD: summary.totalCostUSD.toFixed(6),
    });

    return summary;
  }

  /**
   * Aggregate session records into summary with breakdown by model.
   */
  private static aggregate(session: AIUsageSession): AIUsageSessionSummary {
    let totalInputTokens = 0;
    let totalCachedInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCostUSD = 0;

    const modelMap = new Map<
      string,
      { provider: string; model: string; inputTokens: number; cachedInputTokens: number; outputTokens: number; count: number }
    >();

    for (const record of session.records) {
      const cachedInputTokens = record.cachedInputTokens || 0;
      totalInputTokens += record.inputTokens;
      totalCachedInputTokens += cachedInputTokens;
      totalOutputTokens += record.outputTokens;
      totalTokens += record.totalTokens;
      totalCostUSD += record.costUSD;

      const key = `${record.provider}:${record.model}`;
      const existing = modelMap.get(key);
      if (existing) {
        existing.inputTokens += record.inputTokens;
        existing.cachedInputTokens += cachedInputTokens;
        existing.outputTokens += record.outputTokens;
        existing.count += 1;
      } else {
        modelMap.set(key, {
          provider: record.provider,
          model: record.model,
          inputTokens: record.inputTokens,
          cachedInputTokens,
          outputTokens: record.outputTokens,
          count: 1,
        });
      }
    }

    const breakdown = Array.from(modelMap.values());

    return {
      totalInputTokens,
      totalCachedInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCostUSD,
      aiCallCount: session.records.length,
      breakdown,
    };
  }

  /**
   * Flush session to database (post-hoc write).
   */
  private static async flushToDatabase(session: AIUsageSession, summary: AIUsageSessionSummary): Promise<void> {
    try {
      await insertAIUsageLog({
        workspace_id: session.context.workspaceId,
        user_id: session.context.userId || null,
        test_id: session.context.testId || null,
        run_id: session.context.runId || null,
        operation_type: session.context.operationType || 'unknown',
        total_input_tokens: summary.totalInputTokens,
        total_output_tokens: summary.totalOutputTokens,
        total_tokens: summary.totalTokens,
        total_cost_usd: summary.totalCostUSD,
        ai_call_count: summary.aiCallCount,
        call_breakdown: summary.breakdown,
        session_duration_ms: Date.now() - session.startedAt,
        ...(session.pipelineMetrics && { pipeline_metrics: session.pipelineMetrics }),
      });

      this.schemaDriftReported = false;

      logger.debug('[AI_USAGE] Usage flushed to DB', {
        workspaceId: session.context.workspaceId,
        totalCostUSD: summary.totalCostUSD.toFixed(6),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      // Schema drift is permanent, not transient: every later write fails the
      // same way until a migration runs. Both callers of this method swallow
      // the rejection into a log line, so without this branch the failure is
      // indistinguishable from noise — which is how `run_id` silently cost us
      // two months of AI cost data (see
      // .claude/migrations/20260605_add_run_id_to_ai_usage_log.md). Report it
      // once per process, unmistakably, rather than once per session forever.
      if (isSchemaDriftError(message)) {
        if (!this.schemaDriftReported) {
          this.schemaDriftReported = true;
          logger.error(
            '[AI_USAGE] SCHEMA DRIFT — ai_usage_log writes are failing and ALL AI cost ' +
              'attribution is being lost. The code is inserting a column the database ' +
              'does not have; a migration has not been applied. This will not recover ' +
              'on its own. See .claude/migrations/.',
            { error: message, workspaceId: session.context.workspaceId },
          );
        }
        throw error;
      }

      logger.error('[AI_USAGE] Database flush error', {
        error: message,
        workspaceId: session.context.workspaceId,
      });
      throw error;
    }
  }

  /**
   * Periodic sweep. Runs on `sweepTimer`, once per process.
   *
   * Two ages on purpose:
   *
   * - **Auto-created sessions** (no `beginSession` caller) have no owner, so
   *   this sweep is their ONLY route to the database. Flush them once they go
   *   idle — `IDLE_MAX_AGE_MS`.
   * - **Explicit sessions** belong to a caller that will `endSession` them.
   *   Flushing one early splits a single logical operation across several
   *   `ai_usage_log` rows and leaves `endSession` returning a summary covering
   *   only the tail — and regression runs routinely exceed ten minutes, so the
   *   short age would hit normal work, not just leaks. They are swept only at
   *   `ORPHAN_MAX_AGE_MS`, where the owner has demonstrably failed to close
   *   them and the leak matters more than the split.
   *
   * `startedAt` is never refreshed, so both ages measure total lifetime rather
   * than idleness. That is what makes the distinction necessary: a busy
   * 30-minute run and an abandoned one look identical by age alone.
   */
  static cleanup(): void {
    const now = Date.now();
    /** Auto-created sessions: the sweep is their only flush path. */
    const IDLE_MAX_AGE_MS = 10 * 60 * 1000;
    /** Explicit sessions: long enough that only a genuine leak trips it. */
    const ORPHAN_MAX_AGE_MS = 2 * 60 * 60 * 1000;
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      const maxAge = session.explicit ? ORPHAN_MAX_AGE_MS : IDLE_MAX_AGE_MS;
      if (now - session.startedAt <= maxAge) continue;

      const detail = {
        sessionId,
        ageMs: now - session.startedAt,
        recordCount: session.records.length,
        operationType: session.context.operationType,
      };

      if (session.explicit) {
        // Reaching the orphan age IS anomalous: the owner never called
        // endSession, so this is a leak worth naming.
        logger.warn('[AI_USAGE] Orphaned explicit session — endSession was never called', detail);
      } else {
        // `debug`, not `warn`. This was a warn only because the sweep never
        // actually ran, so reaching it meant something had gone wrong. It is
        // now the NORMAL flush path for every auto-created session (chat,
        // preview, exploration), and warning here would emit a line per active
        // user per sweep forever, burying real warnings. The aggregate `info`
        // below is the signal worth keeping.
        logger.debug('[AI_USAGE] Sweeping idle session', detail);
      }

      // Flush before removing.
      if (session.records.length > 0) {
        const summary = this.aggregate(session);
        this.flushToDatabase(session, summary).catch((err) => {
          logger.error('[AI_USAGE] Failed to flush swept session', {
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      this.sessions.delete(sessionId);
      cleanedCount++;
    }

    if (cleanedCount > 0) {
      logger.info('[AI_USAGE] Cleanup completed', { cleanedCount });
    }
  }

  /**
   * Get active session count (for monitoring).
   */
  static getActiveSessions(): number {
    return this.sessions.size;
  }
}

/**
 * Calculate cost for OpenAI models.
 * Reuses pricing from ai-cost-manager.service.ts.
 *
 * `cachedInputTokens` is the subset of `inputTokens` that OpenAI served from
 * its automatic prompt cache (`usage.prompt_tokens_details.cached_tokens`).
 * When the model publishes a `cachedInput` rate, that subset is billed at the
 * cheaper rate; otherwise it falls back to the full input rate (never
 * over-discounts billing for a model we haven't priced a cache hit for).
 */
export function calculateOpenAICost(
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): number {
  const pricing = AI_PRICING[model as AIModel] || AI_PRICING['gpt-4.1-mini']; // Fallback to cheapest
  const cached = Math.min(Math.max(cachedInputTokens, 0), inputTokens);
  const cachedRate = 'cachedInput' in pricing ? (pricing as { cachedInput: number }).cachedInput : pricing.input;
  return (inputTokens - cached) * pricing.input + cached * cachedRate + outputTokens * pricing.output;
}

/**
 * Calculate cost for Gemini models.
 * Reuses pricing from ai-cost-manager.service.ts (kept in sync with
 * token-calculator.service.ts's MODEL_PRICING).
 */
export function calculateGeminiCost(model: string, inputTokens: number, outputTokens: number): number {
  const knownPricing = AI_PRICING[model as AIModel];
  if (!knownPricing) {
    logger.warn('[AI_USAGE] Unrecognized Gemini model, pricing as gemini-2.5-flash-lite', { model });
  }
  const pricing = knownPricing || AI_PRICING['gemini-2.5-flash-lite']; // Fallback to cheapest Gemini tier
  return inputTokens * pricing.input + outputTokens * pricing.output;
}
