/**
 * Schedule Service
 * CRUD operations for test schedules
 */

import { supabaseAdmin } from '@/db/supabase';
import type {
  CreateTestScheduleParams,
  DueSchedule,
  TestSchedule,
  UpdateTestScheduleParams,
} from '@/types/testing.types';
import { logger } from '@/utils/core/logger';

/**
 * Service for managing test schedules
 * Schedules define when to run tests (cron-based)
 */
export class ScheduleService {
  /**
   * Create a new test schedule
   * @param params - Schedule creation parameters
   * @returns Created schedule
   */
  static async create(params: CreateTestScheduleParams): Promise<TestSchedule> {
    const {
      projectId,
      userId,
      name,
      cronExpression,
      timezone,
      moduleId,
      planId,
      parameters,
    } = params;

    // Validate exactly one target is set
    const targetCount = [moduleId, planId].filter(Boolean).length;
    if (targetCount !== 1) {
      throw new Error('Exactly one of moduleId or planId must be set');
    }

    logger.info('[SCHEDULE_SERVICE] Creating schedule', {
      projectId,
      userId,
      name,
      cronExpression,
    });

    // Calculate next run time
    const nextRunAt = this.calculateNextRun(cronExpression, timezone || 'UTC');

    const { data, error } = await supabaseAdmin
      .from('test_schedules')
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        cron_expression: cronExpression,
        timezone: timezone || 'UTC',
        module_id: moduleId || null,
        plan_id: planId || null,
        parameters: parameters || {},
        next_run_at: nextRunAt,
        is_active: true,
      })
      .select('*')
      .single();

    if (error) {
      logger.error('[SCHEDULE_SERVICE] Failed to create schedule', { error });
      throw new Error(`Failed to create schedule: ${error.message}`);
    }

    return this.mapToTestSchedule(data);
  }

  /**
   * Get a schedule by ID
   * @param id - Schedule ID
   * @param userId - User ID for access control
   * @returns Schedule or null if not found
   */
  static async getById(id: string, userId: string): Promise<TestSchedule | null> {
    const { data, error } = await supabaseAdmin
      .from('test_schedules')
      .select('*')
      .eq('id', id)
      .eq('user_id', userId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      logger.error('[SCHEDULE_SERVICE] Failed to get schedule', { error, id });
      throw new Error(`Failed to get schedule: ${error.message}`);
    }

    return this.mapToTestSchedule(data);
  }

  /**
   * List schedules for a project
   * @param projectId - Project ID
   * @param userId - User ID for access control
   * @returns List of schedules
   */
  static async listByProject(
    projectId: string,
    userId: string
  ): Promise<TestSchedule[]> {
    const { data, error } = await supabaseAdmin
      .from('test_schedules')
      .select('*')
      .eq('project_id', projectId)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (error) {
      logger.error('[SCHEDULE_SERVICE] Failed to list schedules', { error, projectId });
      throw new Error(`Failed to list schedules: ${error.message}`);
    }

    return (data || []).map(this.mapToTestSchedule);
  }

  /**
   * Update a schedule
   * @param params - Update parameters
   * @returns Updated schedule
   */
  static async update(params: UpdateTestScheduleParams): Promise<TestSchedule> {
    const { id, userId, name, cronExpression, timezone, parameters, isActive } = params;

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (cronExpression !== undefined) updates.cron_expression = cronExpression;
    if (timezone !== undefined) updates.timezone = timezone;
    if (parameters !== undefined) updates.parameters = parameters;
    if (isActive !== undefined) updates.is_active = isActive;

    // Recalculate next run if cron or timezone changed
    if (cronExpression !== undefined || timezone !== undefined) {
      // Get current values if not provided
      const current = await this.getById(id, userId);
      if (current) {
        const cron = cronExpression || current.cronExpression;
        const tz = timezone || current.timezone;
        updates.next_run_at = this.calculateNextRun(cron, tz);
      }
    }

    if (Object.keys(updates).length === 0) {
      throw new Error('No fields to update');
    }

    logger.info('[SCHEDULE_SERVICE] Updating schedule', {
      id,
      updatedFields: Object.keys(updates),
    });

    const { data, error } = await supabaseAdmin
      .from('test_schedules')
      .update(updates)
      .eq('id', id)
      .eq('user_id', userId)
      .select('*')
      .single();

    if (error) {
      logger.error('[SCHEDULE_SERVICE] Failed to update schedule', { error, id });
      throw new Error(`Failed to update schedule: ${error.message}`);
    }

    return this.mapToTestSchedule(data);
  }

  /**
   * Delete a schedule
   * @param id - Schedule ID
   * @param userId - User ID for access control
   * @returns True if deleted
   */
  static async delete(id: string, userId: string): Promise<boolean> {
    logger.info('[SCHEDULE_SERVICE] Deleting schedule', { id });

    const { error } = await supabaseAdmin
      .from('test_schedules')
      .delete()
      .eq('id', id)
      .eq('user_id', userId);

    if (error) {
      logger.error('[SCHEDULE_SERVICE] Failed to delete schedule', { error, id });
      throw new Error(`Failed to delete schedule: ${error.message}`);
    }

    return true;
  }

  /**
   * Activate a schedule
   * @param id - Schedule ID
   * @param userId - User ID for access control
   * @returns Updated schedule
   */
  static async activate(id: string, userId: string): Promise<TestSchedule> {
    return this.update({ id, userId, isActive: true });
  }

  /**
   * Deactivate a schedule
   * @param id - Schedule ID
   * @param userId - User ID for access control
   * @returns Updated schedule
   */
  static async deactivate(id: string, userId: string): Promise<TestSchedule> {
    return this.update({ id, userId, isActive: false });
  }

  /**
   * Get all schedules that are due for execution
   * @returns List of due schedules
   */
  static async getDueSchedules(): Promise<DueSchedule[]> {
    const { data, error } = await supabaseAdmin
      .from('test_schedules')
      .select('*')
      .eq('is_active', true)
      .lte('next_run_at', new Date().toISOString());

    if (error) {
      logger.error('[SCHEDULE_SERVICE] Failed to get due schedules', { error });
      throw new Error(`Failed to get due schedules: ${error.message}`);
    }

    return (data || []).map((row: any) => ({
      scheduleId: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      targetType: row.module_id ? 'module' : 'plan',
      targetId: row.module_id || row.plan_id,
      parameters: row.parameters || {},
    }));
  }

  /**
   * Claim a due schedule (atomic best-effort).
   * Updates last_run_at and next_run_at only if schedule is still due.
   * This prevents duplicate execution when multiple scheduler instances run.
   *
   * @param id - Schedule ID
   * @returns true if claimed, false if already claimed or not due
   */
  static async claimDueSchedule(id: string): Promise<boolean> {
    const nowIso = new Date().toISOString();

    const { data: schedule, error: fetchError } = await supabaseAdmin
      .from('test_schedules')
      .select('cron_expression, timezone')
      .eq('id', id)
      .single();

    if (fetchError || !schedule) {
      logger.error('[SCHEDULE_SERVICE] Failed to fetch schedule for update', { error: fetchError, id });
      return false;
    }

    const nextRunAt = this.calculateNextRun(
      schedule.cron_expression,
      schedule.timezone
    );

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('test_schedules')
      .update({
        last_run_at: nowIso,
        next_run_at: nextRunAt,
      })
      .eq('id', id)
      .eq('is_active', true)
      .lte('next_run_at', nowIso)
      .select('id');

    if (updateError) {
      logger.error('[SCHEDULE_SERVICE] Failed to mark schedule as executed', {
        error: updateError,
        id,
      });
      return false;
    }

    return Array.isArray(updated) ? updated.length > 0 : !!updated;
  }

  /**
   * Mark a schedule as executed and calculate next run (non-atomic).
   * Prefer claimDueSchedule() in scheduler loops.
   *
   * @param id - Schedule ID
   */
  static async markExecuted(id: string): Promise<void> {
    await this.claimDueSchedule(id);
  }

  /**
   * Calculate next run time from cron expression
   * Simple implementation - for production, use a proper cron parser
   * @param cronExpression - Cron expression (minute hour day month weekday)
   * @param _timezone - Timezone (reserved for future cron parsing)
   * @returns ISO string of next run time
   */
  private static calculateNextRun(cronExpression: string, _timezone: string): string {
    // Mark as intentionally unused for now (reserved for future cron parsing)
    void _timezone;

    // Simple implementation: add 1 day for now
    // In production, use a library like 'cron-parser'
    const now = new Date();

    // Parse simple cron patterns
    const parts = cronExpression.split(' ');
    if (parts.length !== 5) {
      // Invalid cron, default to 1 hour from now
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }

    const [minute, hour] = parts;

    // Simple case: specific time daily (e.g., "0 0 * * *" = midnight)
    if (!minute.includes('*') && !hour.includes('*')) {
      const nextRun = new Date(now);
      nextRun.setHours(parseInt(hour, 10), parseInt(minute, 10), 0, 0);

      // If time has passed today, schedule for tomorrow
      if (nextRun <= now) {
        nextRun.setDate(nextRun.getDate() + 1);
      }

      return nextRun.toISOString();
    }

    // Default: 24 hours from now
    return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }

  /**
   * Map database row to TestSchedule type
   */
  private static mapToTestSchedule(row: any): TestSchedule {
    return {
      id: row.id,
      projectId: row.project_id,
      userId: row.user_id,
      name: row.name,
      moduleId: row.module_id || undefined,
      planId: row.plan_id || undefined,
      cronExpression: row.cron_expression,
      timezone: row.timezone,
      isActive: row.is_active,
      parameters: row.parameters || {},
      lastRunAt: row.last_run_at || undefined,
      nextRunAt: row.next_run_at || undefined,
      createdAt: row.created_at,
    };
  }
}
