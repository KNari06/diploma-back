/**
 * Execution Service
 * Unified execution tracking for UI and API tests
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
    CreateTestExecutionParams,
    ExecutionStats,
    ExecutionStatus,
    TestExecution,
    UpdateExecutionStatusParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Service for managing test executions
 * Provides unified execution tracking across UI and API tests
 */
export class ExecutionService {
  /**
   * Create a single test execution record
   * @param params - Execution creation parameters
   * @returns Created execution
   */
  static async create(params: CreateTestExecutionParams): Promise<TestExecution> {
    const {
      runId,
      testType,
      testCaseId,
      moduleId,
      flowId,
      browser,
      environment,
    } = params;

    const { data, error } = await supabaseAdmin
      .from('test_executions')
      .insert({
        run_id: runId,
        test_type: testType,
        test_case_id: testCaseId,
        module_id: moduleId || null,
        flow_id: flowId || null,
        browser: browser || null,
        environment: environment || null,
        status: 'pending',
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[EXECUTION_SERVICE] Failed to create execution', { error });
      throw new Error(`Failed to create execution: ${error.message}`);
    }

    return this.mapToTestExecution(data);
  }

  /**
   * Create multiple test execution records in batch
   * @param runId - Run ID
   * @param testCases - Array of test case references
   * @returns Created executions
   */
  static async createBatch(
    runId: string,
    testCases: Array<{
      testCaseId: string;
      testType: 'ui' | 'api';
      moduleId?: string;
      flowId?: string;
      browser?: string;
      environment?: string;
      isNegative?: boolean;
      /**
       * Raw `intent_test_cases.platform` value — denormalised onto the
       * execution row so reports / WS events can render the right
       * mobile/web artifacts without extra joins. Optional for API cases.
       */
      platform?: string | null;
    }>
  ): Promise<TestExecution[]> {
    if (testCases.length === 0) {
      return [];
    }

    logger.info('[EXECUTION_SERVICE] Creating batch executions', {
      runId,
      count: testCases.length,
    });

    const records = testCases.map((tc) => ({
      run_id: runId,
      test_type: tc.testType,
      test_case_id: tc.testCaseId,
      module_id: tc.moduleId || null,
      flow_id: tc.flowId || null,
      browser: tc.browser || null,
      environment: tc.environment || null,
      status: 'pending' as const,
      ...(tc.isNegative && { is_negative: true }),
      ...(tc.platform ? { platform: tc.platform } : {}),
    }));

    const { data, error } = await supabaseAdmin
      .from('test_executions')
      .insert(records)
      .select('*');

    if (error) {
      logger.error('[EXECUTION_SERVICE] Failed to create batch executions', { error });
      throw new Error(`Failed to create executions: ${error.message}`);
    }

    return (data || []).map(this.mapToTestExecution);
  }

  /**
   * Update execution status
   * @param params - Update parameters
   */
  static async updateStatus(params: UpdateExecutionStatusParams): Promise<void> {
    const { id, status, durationMs, result, errorMessage, screenshotUrl, traceUrl } =
      params;

    const updates: Record<string, any> = { status };

    if (durationMs !== undefined) updates.duration_ms = durationMs;
    if (result !== undefined) updates.result = result;
    if (errorMessage !== undefined) updates.error_message = errorMessage;
    if (screenshotUrl !== undefined) updates.screenshot_url = screenshotUrl;
    if (traceUrl !== undefined) updates.trace_url = traceUrl;

    // Set timestamps based on status
    if (status === 'running') {
      updates.started_at = new Date().toISOString();
    } else if (['passed', 'failed', 'skipped', 'cancelled'].includes(status)) {
      updates.completed_at = new Date().toISOString();
    }

    const { error } = await supabaseAdmin
      .from('test_executions')
      .update(updates)
      .eq('id', id);

    if (error) {
      logger.error('[EXECUTION_SERVICE] Failed to update execution status', {
        error,
        id,
        status,
      });
      throw new Error(`Failed to update execution: ${error.message}`);
    }
  }

  /**
   * Get execution by ID
   * @param id - Execution ID
   * @returns Execution or null
   */
  static async getById(id: string): Promise<TestExecution | null> {
    const { data, error } = await supabaseAdmin
      .from('test_executions')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw new Error(`Failed to get execution: ${error.message}`);
    }

    return this.mapToTestExecution(data);
  }

  /**
   * Get all executions for a run
   * @param runId - Run ID
   * @returns List of executions
   */
  static async getByRunId(runId: string): Promise<TestExecution[]> {
    const { data, error } = await supabaseAdmin
      .from('test_executions')
      .select('*')
      .eq('run_id', runId)
      .order('created_at', { ascending: true });

    if (error) {
      logger.error('[EXECUTION_SERVICE] Failed to get executions by run', {
        error,
        runId,
      });
      throw new Error(`Failed to get executions: ${error.message}`);
    }

    return (data || []).map(this.mapToTestExecution);
  }

  /**
   * Get execution statistics for a run
   * @param runId - Run ID
   * @returns Aggregated stats
   */
  static async getStats(runId: string): Promise<ExecutionStats> {
    const { data, error } = await supabaseAdmin
      .from('test_executions')
      .select('status, duration_ms')
      .eq('run_id', runId);

    if (error) {
      throw new Error(`Failed to get stats: ${error.message}`);
    }

    return this.calculateStats(data || []);
  }

  /**
   * Get execution statistics for a module
   * @param moduleId - Module ID
   * @param days - Number of days to include (default: 30)
   * @returns Aggregated stats
   */
  static async getStatsByModule(
    moduleId: string,
    days: number = 30
  ): Promise<ExecutionStats> {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await supabaseAdmin
      .from('test_executions')
      .select('status, duration_ms')
      .eq('module_id', moduleId)
      .gte('created_at', since.toISOString());

    if (error) {
      throw new Error(`Failed to get module stats: ${error.message}`);
    }

    return this.calculateStats(data || []);
  }

  /**
   * Calculate statistics from execution records
   */
  private static calculateStats(
    records: Array<{ status: ExecutionStatus; duration_ms: number | null }>
  ): ExecutionStats {
    const total = records.length;
    const passed = records.filter((r) => r.status === 'passed').length;
    const failed = records.filter((r) => r.status === 'failed' || r.status === 'timeout').length;
    const skipped = records.filter((r) => r.status === 'skipped').length;
    const pending = records.filter((r) => r.status === 'pending').length;
    const running = records.filter((r) => r.status === 'running').length;
    const cancelled = records.filter((r) => r.status === 'cancelled').length;

    const completed = passed + failed;
    const passRate = completed > 0 ? Math.round((passed / completed) * 100) : 0;

    const durations = records
      .filter((r) => r.duration_ms !== null)
      .map((r) => r.duration_ms!);
    const avgDurationMs =
      durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : undefined;

    return {
      total,
      passed,
      failed,
      skipped,
      pending,
      running,
      cancelled,
      passRate,
      avgDurationMs,
    };
  }

  /**
   * Map database row to TestExecution type
   */
  private static mapToTestExecution(row: any): TestExecution {
    return {
      id: row.id,
      runId: row.run_id,
      testType: row.test_type,
      testCaseId: row.test_case_id,
      moduleId: row.module_id || undefined,
      flowId: row.flow_id || undefined,
      status: row.status,
      durationMs: row.duration_ms || undefined,
      startedAt: row.started_at || undefined,
      completedAt: row.completed_at || undefined,
      result: row.result || {},
      errorMessage: row.error_message || undefined,
      screenshotUrl: row.screenshot_url || undefined,
      traceUrl: row.trace_url || undefined,
      browser: row.browser || undefined,
      environment: row.environment || undefined,
      // Denormalised from intent_test_cases.platform at batch create time
      // (see createBatch). Null for legacy rows created before the
      // 20260417_test_executions_platform migration.
      platform: row.platform || undefined,
      createdAt: row.created_at,
      isNegative: row.is_negative ?? undefined,
    };
  }
}
