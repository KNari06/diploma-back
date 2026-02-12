/**
 * AI Usage Query Service
 * Provides methods to query AI usage data for analytics and billing.
 */

import { supabaseAdmin } from '@/db/supabase';
import { logger } from '@/utils/core/logger';

export interface AIUsageQueryFilters {
  workspaceId?: string;
  userId?: string;
  testId?: string;
  operationType?: string;
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
}

export interface AIUsageAggregation {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalTokens: number;
  totalCostUSD: number;
  totalCalls: number;
  breakdown: Array<{
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    calls: number;
    costUSD: number;
  }>;
}

export interface AIUsageRecord {
  id: string;
  workspace_id: string;
  user_id: string | null;
  test_id: string | null;
  operation_type: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  ai_call_count: number;
  call_breakdown: any;
  session_duration_ms: number | null;
  created_at: string;
}

/**
 * AI Usage Query Service
 */
export class AIUsageQueryService {
  /**
   * Query AI usage records with filters
   */
  static async queryUsage(filters: AIUsageQueryFilters): Promise<AIUsageRecord[]> {
    try {
      let query = supabaseAdmin.from('ai_usage_log').select('*');

      // Apply filters
      if (filters.workspaceId) {
        query = query.eq('workspace_id', filters.workspaceId);
      }
      if (filters.userId) {
        query = query.eq('user_id', filters.userId);
      }
      if (filters.testId) {
        query = query.eq('test_id', filters.testId);
      }
      if (filters.operationType) {
        query = query.eq('operation_type', filters.operationType);
      }
      if (filters.startDate) {
        query = query.gte('created_at', filters.startDate.toISOString());
      }
      if (filters.endDate) {
        query = query.lte('created_at', filters.endDate.toISOString());
      }

      // Order by date descending
      query = query.order('created_at', { ascending: false });

      // Pagination
      if (filters.limit) {
        query = query.limit(filters.limit);
      }
      if (filters.offset) {
        query = query.range(filters.offset, filters.offset + (filters.limit || 100) - 1);
      }

      const { data, error } = await query;

      if (error) {
        logger.error('[AI_USAGE_QUERY] Failed to query usage', {
          error: error.message,
          filters,
        });
        throw new Error(`Failed to query AI usage: ${error.message}`);
      }

      return data || [];
    } catch (error) {
      logger.error('[AI_USAGE_QUERY] Query error', {
        error: error instanceof Error ? error.message : String(error),
        filters,
      });
      throw error;
    }
  }

  /**
   * Get aggregated AI usage statistics for a workspace
   */
  static async getWorkspaceUsageStats(
    workspaceId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<AIUsageAggregation> {
    try {
      const records = await this.queryUsage({
        workspaceId,
        startDate,
        endDate,
      });

      return this.aggregateRecords(records);
    } catch (error) {
      logger.error('[AI_USAGE_QUERY] Failed to get workspace stats', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      throw error;
    }
  }

  /**
   * Get AI usage for a specific test
   */
  static async getTestUsage(testId: string): Promise<AIUsageRecord | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('ai_usage_log')
        .select('*')
        .eq('test_id', testId)
        .single();

      if (error) {
        if (error.code === 'PGRST116') {
          // No rows returned
          return null;
        }
        logger.error('[AI_USAGE_QUERY] Failed to get test usage', {
          error: error.message,
          testId,
        });
        throw new Error(`Failed to get test usage: ${error.message}`);
      }

      return data;
    } catch (error) {
      logger.error('[AI_USAGE_QUERY] Get test usage error', {
        error: error instanceof Error ? error.message : String(error),
        testId,
      });
      throw error;
    }
  }

  /**
   * Get usage breakdown by operation type for a workspace
   */
  static async getUsageByOperationType(
    workspaceId: string,
    startDate?: Date,
    endDate?: Date
  ): Promise<
    Array<{
      operationType: string;
      totalTokens: number;
      totalCost: number;
      count: number;
    }>
  > {
    try {
      const records = await this.queryUsage({
        workspaceId,
        startDate,
        endDate,
      });

      const byOperationType = new Map<
        string,
        { totalTokens: number; totalCost: number; count: number }
      >();

      for (const record of records) {
        const existing = byOperationType.get(record.operation_type);
        if (existing) {
          existing.totalTokens += record.total_tokens;
          existing.totalCost += Number(record.total_cost_usd);
          existing.count += 1;
        } else {
          byOperationType.set(record.operation_type, {
            totalTokens: record.total_tokens,
            totalCost: Number(record.total_cost_usd),
            count: 1,
          });
        }
      }

      return Array.from(byOperationType.entries()).map(([operationType, stats]) => ({
        operationType,
        ...stats,
      }));
    } catch (error) {
      logger.error('[AI_USAGE_QUERY] Failed to get usage by operation type', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      throw error;
    }
  }

  /**
   * Aggregate multiple records into summary statistics
   */
  private static aggregateRecords(records: AIUsageRecord[]): AIUsageAggregation {
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let totalTokens = 0;
    let totalCostUSD = 0;
    let totalCalls = 0;

    const modelMap = new Map<
      string,
      {
        provider: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        calls: number;
        costUSD: number;
      }
    >();

    for (const record of records) {
      totalInputTokens += record.total_input_tokens;
      totalOutputTokens += record.total_output_tokens;
      totalTokens += record.total_tokens;
      totalCostUSD += Number(record.total_cost_usd);
      totalCalls += record.ai_call_count;

      // Aggregate call breakdown
      if (record.call_breakdown && Array.isArray(record.call_breakdown)) {
        for (const call of record.call_breakdown) {
          const key = `${call.provider}:${call.model}`;
          const existing = modelMap.get(key);
          if (existing) {
            existing.inputTokens += call.inputTokens || 0;
            existing.outputTokens += call.outputTokens || 0;
            existing.calls += call.count || 0;
            // Cost is aggregated from record level, not call level
          } else {
            modelMap.set(key, {
              provider: call.provider,
              model: call.model,
              inputTokens: call.inputTokens || 0,
              outputTokens: call.outputTokens || 0,
              calls: call.count || 0,
              costUSD: 0, // Will be calculated proportionally if needed
            });
          }
        }
      }
    }

    // Calculate cost per model proportionally (rough estimate)
    const breakdown = Array.from(modelMap.values()).map((item) => ({
      ...item,
      costUSD:
        totalTokens > 0
          ? (totalCostUSD * (item.inputTokens + item.outputTokens)) / totalTokens
          : 0,
    }));

    return {
      totalInputTokens,
      totalOutputTokens,
      totalTokens,
      totalCostUSD,
      totalCalls,
      breakdown,
    };
  }

  /**
   * Get daily usage statistics for a workspace (for charting)
   */
  static async getDailyUsage(
    workspaceId: string,
    startDate: Date,
    endDate: Date
  ): Promise<
    Array<{
      date: string;
      totalTokens: number;
      totalCost: number;
      calls: number;
    }>
  > {
    try {
      const records = await this.queryUsage({
        workspaceId,
        startDate,
        endDate,
      });

      // Group by date
      const byDate = new Map<string, { totalTokens: number; totalCost: number; calls: number }>();

      for (const record of records) {
        const date = record.created_at.split('T')[0]; // Extract date part
        const existing = byDate.get(date);
        if (existing) {
          existing.totalTokens += record.total_tokens;
          existing.totalCost += Number(record.total_cost_usd);
          existing.calls += record.ai_call_count;
        } else {
          byDate.set(date, {
            totalTokens: record.total_tokens,
            totalCost: Number(record.total_cost_usd),
            calls: record.ai_call_count,
          });
        }
      }

      return Array.from(byDate.entries())
        .map(([date, stats]) => ({
          date,
          ...stats,
        }))
        .sort((a, b) => a.date.localeCompare(b.date));
    } catch (error) {
      logger.error('[AI_USAGE_QUERY] Failed to get daily usage', {
        error: error instanceof Error ? error.message : String(error),
        workspaceId,
      });
      throw error;
    }
  }
}
