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

    // Include cron_expression in WHERE to guard against concurrent config changes.
    // If the user updated the cron between our SELECT and this UPDATE, the row
    // won't match and we return false — the next poll will pick up the new cron.
    const { data: updated, error: updateError } = await supabaseAdmin
      .from('test_schedules')
      .update({
        last_run_at: nowIso,
        next_run_at: nextRunAt,
      })
      .eq('id', id)
      .eq('is_active', true)
      .eq('cron_expression', schedule.cron_expression)
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

  // Calculate next run time from cron expression.
  //
  // Supports the full 5-field cron: minute hour day-of-month month day-of-week
  //
  // Handles: specific values, step values (star-slash-N), day-of-month, month,
  // day-of-week lists, ranges, and timezone via Intl.DateTimeFormat.
  // Scans up to 400 days ahead to cover yearly cron patterns.
  //
  // Public so RegressionPlanService.syncSchedule can reuse the same logic.
  static calculateNextRun(cronExpression: string, timezone: string): string {
    const now = new Date();

    const parts = cronExpression.split(' ');
    if (parts.length !== 5) {
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }

    const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

    // Parse each field into a set of allowed values
    const allowedMinutes = this.parseCronField(minuteStr, 0, 59);
    const allowedHours = this.parseCronField(hourStr, 0, 23);
    const allowedDoms = this.parseCronField(domStr, 1, 31);
    const allowedMonths = this.parseCronField(monthStr, 1, 12);
    let allowedDows = this.parseCronField(dowStr, 0, 7);

    // Normalize dow=7 (Sunday) to dow=0
    if (allowedDows && allowedDows.has(7)) {
      allowedDows.add(0);
      allowedDows.delete(7);
    }

    if (!allowedMinutes || !allowedHours) {
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }

    const tz = this.resolveTimezone(timezone);
    const sortedMinutes = [...allowedMinutes].sort((a, b) => a - b);
    const sortedHours = [...allowedHours].sort((a, b) => a - b);

    // Scan up to 400 days to cover monthly/yearly patterns
    for (let dayOffset = 0; dayOffset <= 400; dayOffset++) {
      const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const candidateParts = this.datePartsInTimezone(candidate, tz);

      // Check month constraint
      if (allowedMonths && !allowedMonths.has(candidateParts.month)) {
        continue;
      }

      // Check day-of-month constraint
      if (allowedDoms && !allowedDoms.has(candidateParts.day)) {
        continue;
      }

      // Check day-of-week constraint
      if (allowedDows && !allowedDows.has(candidateParts.dow)) {
        continue;
      }

      // Try each allowed hour:minute combination on this day
      for (const hour of sortedHours) {
        for (const minute of sortedMinutes) {
          const targetUtc = this.buildDateInTimezone(
            candidateParts.year,
            candidateParts.month,
            candidateParts.day,
            hour,
            minute,
            tz
          );

          if (targetUtc > now) {
            return targetUtc.toISOString();
          }
        }
      }
    }

    // Fallback (should never reach here for valid cron)
    return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  }

  // Parse a single cron field into a Set of allowed integer values.
  // Supports: "*", specific numbers, comma-separated lists, step values,
  // and ranges (e.g. "1-5"). Returns null for "*" (all values allowed).
  private static parseCronField(field: string, min: number, max: number): Set<number> | null {
    if (field === '*') return null;

    // Step value: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      if (isNaN(step) || step <= 0) return null;
      const set = new Set<number>();
      for (let i = min; i <= max; i += step) {
        set.add(i);
      }
      return set;
    }

    // Comma-separated list, possibly with ranges: "1,3,5" or "1-5" or "1-3,5"
    const set = new Set<number>();
    for (const part of field.split(',')) {
      const trimmed = part.trim();
      if (trimmed.includes('-')) {
        const [startStr, endStr] = trimmed.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (!isNaN(start) && !isNaN(end)) {
          for (let i = start; i <= end; i++) {
            if (i >= min && i <= max) set.add(i);
          }
        }
      } else {
        const n = parseInt(trimmed, 10);
        if (!isNaN(n) && n >= min && n <= max) set.add(n);
      }
    }
    return set.size > 0 ? set : null;
  }

  /**
   * Resolve timezone string, falling back to UTC on invalid input.
   */
  private static resolveTimezone(tz: string): string {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return tz;
    } catch {
      return 'UTC';
    }
  }

  /**
   * Get year/month/day/hour/minute/dow in a given timezone.
   */
  private static datePartsInTimezone(
    date: Date,
    tz: string
  ): { year: number; month: number; day: number; hour: number; minute: number; dow: number } {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    });
    const partsMap = new Map<string, string>();
    for (const p of fmt.formatToParts(date)) {
      partsMap.set(p.type, p.value);
    }

    const dowMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

    return {
      year: parseInt(partsMap.get('year') || '2000', 10),
      month: parseInt(partsMap.get('month') || '1', 10),
      day: parseInt(partsMap.get('day') || '1', 10),
      hour: parseInt(partsMap.get('hour') || '0', 10),
      minute: parseInt(partsMap.get('minute') || '0', 10),
      dow: dowMap[partsMap.get('weekday') || 'Sun'] ?? 0,
    };
  }

  /**
   * Build a UTC Date for a given date+time in a specific timezone.
   * E.g. "2026-02-23 09:00 in America/New_York" → correct UTC instant.
   */
  private static buildDateInTimezone(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    tz: string
  ): Date {
    // Strategy: construct a guess in UTC, then measure the offset and correct.
    // This handles DST transitions correctly.
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));

    // What time does `guess` represent in the target timezone?
    const guessParts = this.datePartsInTimezone(guess, tz);
    const guessMinutes = guessParts.hour * 60 + guessParts.minute;
    const targetMinutes = hour * 60 + minute;
    const diffMinutes = guessMinutes - targetMinutes;

    // Adjust: if guess shows 14:00 in tz but we want 09:00, shift by +5h
    return new Date(guess.getTime() + diffMinutes * 60 * 1000);
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
