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

  /**
   * Calculate next run time from cron expression.
   *
   * Supports the subset of 5-field cron used by the scheduler:
   *   minute hour day-of-month month day-of-week
   *
   * Handles:
   *  - Specific minute + hour (e.g. "30 9 * * *")
   *  - Day-of-week lists  (e.g. "0 9 * * 1,3,5" = Mon/Wed/Fri)
   *  - Timezone via Intl.DateTimeFormat (falls back to UTC on unknown tz)
   *
   * Scans up to 8 days ahead to find the next matching slot.
   */
  /** Public so RegressionPlanService.syncSchedule can reuse the same logic. */
  static calculateNextRun(cronExpression: string, timezone: string): string {
    const now = new Date();

    const parts = cronExpression.split(' ');
    if (parts.length !== 5) {
      // Invalid cron → fallback 1 hour from now
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }

    const [minuteStr, hourStr, , , dowStr] = parts;

    // We only handle specific minute + hour (no wildcards in those fields)
    const minute = parseInt(minuteStr, 10);
    const hour = parseInt(hourStr, 10);
    if (isNaN(minute) || isNaN(hour)) {
      return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    }

    // Parse day-of-week field: "*" → all days, "1,3,5" → Set{1,3,5}
    let allowedDays: Set<number> | null = null; // null = every day
    if (dowStr !== '*') {
      const parsed = dowStr
        .split(',')
        .map((d) => parseInt(d.trim(), 10))
        .filter((n) => n >= 0 && n <= 7);
      if (parsed.length > 0) {
        allowedDays = new Set<number>();
        for (const d of parsed) {
          // cron: 0 = Sunday, 7 = Sunday (both valid)
          allowedDays.add(d === 7 ? 0 : d);
        }
      }
    }

    // Resolve "now" in the target timezone so we compare correctly.
    // Intl.DateTimeFormat gives us the local hour/minute/day-of-week in that tz.
    const tz = this.resolveTimezone(timezone);
    const nowInTz = this.datePartsInTimezone(now, tz);

    // Build candidate date starting from today-in-tz.
    // We scan up to 8 days to cover every day-of-week combination.
    for (let dayOffset = 0; dayOffset <= 7; dayOffset++) {
      const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const candidateParts = this.datePartsInTimezone(candidate, tz);

      // Check day-of-week constraint
      if (allowedDays && !allowedDays.has(candidateParts.dow)) {
        continue;
      }

      // Build the exact Date for this candidate day at the target hour:minute in tz.
      // We use a trick: start from the candidate date at midnight UTC, then adjust.
      const targetUtc = this.buildDateInTimezone(
        candidateParts.year,
        candidateParts.month,
        candidateParts.day,
        hour,
        minute,
        tz
      );

      // Must be strictly in the future
      if (targetUtc > now) {
        return targetUtc.toISOString();
      }
    }

    // Fallback (should never reach here for valid cron)
    return new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
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
