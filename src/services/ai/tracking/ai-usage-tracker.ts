/**
 * AI Usage Tracker (Singleton)
 * Accumulates AI usage in-memory per session, flushes to DB post-hoc.
 * Automatically tracks all OpenAI/Gemini calls via interceptors.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';
import { AI_PRICING, type AIModel } from '../cost/ai-cost-manager.service';
import { getAIContext, type AITrackingContext } from './ai-context';

export interface AIUsageRecord {
  provider: 'openai' | 'gemini';
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUSD: number;
  timestamp: number;
  durationMs?: number;
}

export interface AIUsageSessionSummary {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  aiCallCount: number;
  breakdown: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    count: number;
  }>;
}

interface AIUsageSession {
  context: AITrackingContext;
  records: AIUsageRecord[];
  startedAt: number;
  pipelineMetrics?: Record<string, any>;
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

    // Find session by testId or create synthetic key
    const sessionId = ctx.testId || `${ctx.operationType || 'unknown'}-${ctx.userId}-${Date.now()}`;
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
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCostUSD = 0;

    const modelMap = new Map<
      string,
      { provider: string; model: string; inputTokens: number; outputTokens: number; count: number }
    >();

    for (const record of session.records) {
      totalInputTokens += record.inputTokens;
      totalOutputTokens += record.outputTokens;
      totalTokens += record.totalTokens;
      totalCostUSD += record.costUSD;

      const key = `${record.provider}:${record.model}`;
      const existing = modelMap.get(key);
      if (existing) {
        existing.inputTokens += record.inputTokens;
        existing.outputTokens += record.outputTokens;
        existing.count += 1;
      } else {
        modelMap.set(key, {
          provider: record.provider,
          model: record.model,
          inputTokens: record.inputTokens,
          outputTokens: record.outputTokens,
          count: 1,
        });
      }
    }

    const breakdown = Array.from(modelMap.values());

    return {
      totalInputTokens,
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
      const { error } = await supabaseAdmin.from('ai_usage_log').insert({
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

      if (error) {
        logger.error('[AI_USAGE] Failed to insert usage log', {
          error: error.message,
          workspaceId: session.context.workspaceId,
        });
        throw error;
      }

      logger.debug('[AI_USAGE] Usage flushed to DB', {
        workspaceId: session.context.workspaceId,
        totalCostUSD: summary.totalCostUSD.toFixed(6),
      });
    } catch (error) {
      logger.error('[AI_USAGE] Database flush error', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Periodic cleanup for orphaned sessions (>10 min old).
   * Should be called by a background job or cron.
   */
  static cleanup(): void {
    const now = Date.now();
    const maxAge = 10 * 60 * 1000; // 10 minutes
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.startedAt > maxAge) {
        logger.warn('[AI_USAGE] Cleaning up orphaned session', {
          sessionId,
          ageMs: now - session.startedAt,
          recordCount: session.records.length,
        });

        // Flush before removing
        if (session.records.length > 0) {
          const summary = this.aggregate(session);
          this.flushToDatabase(session, summary).catch((err) => {
            logger.error('[AI_USAGE] Failed to flush orphaned session', {
              sessionId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }

        this.sessions.delete(sessionId);
        cleanedCount++;
      }
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
 */
export function calculateOpenAICost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = AI_PRICING[model as AIModel] || AI_PRICING['gpt-4.1-mini']; // Fallback to cheapest
  return inputTokens * pricing.input + outputTokens * pricing.output;
}

/**
 * Calculate cost for Gemini models.
 * Gemini pricing (as of 2024):
 * - Flash: $0.075/1M input, $0.30/1M output
 * - Pro: $1.25/1M input, $5.00/1M output
 */
export function calculateGeminiCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing =
    model.includes('pro')
      ? { input: 1.25 / 1_000_000, output: 5.0 / 1_000_000 }
      : { input: 0.075 / 1_000_000, output: 0.3 / 1_000_000 }; // Flash

  return inputTokens * pricing.input + outputTokens * pricing.output;
}
