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

    // Defence-in-depth: refuse to persist an unparseable cron. The
    // controllers also validate, but other internal callers (e.g.
    // RegressionPlanService.syncSchedule) may bypass them and we don't
    // want a bad row that fires every hour forever via the fallback in
    // calculateNextRun. Checked before the (DB-touching) ownership check so a
    // bad cron returns the precise error without a needless query.
    if (!this.parseCron(cronExpression)) {
      throw new Error(`Invalid cron expression: "${cronExpression}"`);
    }

    // Verify the target exists AND the user may access it. Without this a
    // schedule could be created against a foreign/non-existent module or plan;
    // it would then fail at run time and self-deactivate with a misleading
    // message — and it's an authorization gap (scheduling someone else's target).
    const ownsTarget = await this.userOwnsTarget(userId, { moduleId, planId });
    if (!ownsTarget) {
      throw new Error(
        `Schedule target not found or access denied: ${moduleId ? `module ${moduleId}` : `plan ${planId}`}`
      );
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

    // Defence-in-depth — controllers also validate cron, but other internal
    // callers may bypass them. Refuse to persist an unparseable cron.
    if (cronExpression !== undefined && !this.parseCron(cronExpression)) {
      throw new Error(`Invalid cron expression: "${cronExpression}"`);
    }

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

    return (data || []).map((row: any): DueSchedule => {
      // Resolve the target explicitly. The table permits three target columns
      // (module_id / suite_id / plan_id) but only module + plan have a runnable
      // path. Suites are surfaced as 'suite' so the scheduler can reject them
      // with a correct reason instead of misrouting to runPlan(undefined) — the
      // old `row.module_id ? 'module' : 'plan'` mapped a suite row to 'plan'
      // with a null targetId, which then self-deactivated as "target deleted".
      if (row.module_id) {
        return {
          scheduleId: row.id,
          projectId: row.project_id,
          userId: row.user_id,
          targetType: 'module',
          targetId: row.module_id,
          parameters: row.parameters || {},
        };
      }
      if (row.plan_id) {
        return {
          scheduleId: row.id,
          projectId: row.project_id,
          userId: row.user_id,
          targetType: 'plan',
          targetId: row.plan_id,
          parameters: row.parameters || {},
        };
      }
      return {
        scheduleId: row.id,
        projectId: row.project_id,
        userId: row.user_id,
        targetType: 'suite',
        targetId: row.suite_id || null,
        parameters: row.parameters || {},
      };
    });
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

    const parsed = this.parseCron(cronExpression);
    if (!parsed) {
      // Truly invalid cron — log loudly. Persisting layer (controllers)
      // should reject before this is ever reached, but keep a safe
      // fallback so production never explodes on a bad row that
      // pre-dates validation.
      logger.error('[SCHEDULE_SERVICE] calculateNextRun: invalid cron — falling back to +1h', {
        cronExpression,
      });
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }

    const { minutes, hours, doms, months, dows } = parsed;
    const tz = this.resolveTimezone(timezone);
    const sortedMinutes = [...minutes].sort((a, b) => a - b);
    const sortedHours = [...hours].sort((a, b) => a - b);

    // Scan up to 400 days to cover monthly/yearly patterns
    for (let dayOffset = 0; dayOffset <= 400; dayOffset++) {
      const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const candidateParts = this.datePartsInTimezone(candidate, tz);

      if (!months.has(candidateParts.month)) continue;
      if (!doms.has(candidateParts.day)) continue;
      if (!dows.has(candidateParts.dow)) continue;

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

  /**
   * Parse a full cron expression into materialised allowed-value sets.
   *
   * Returns `null` ONLY when the expression is structurally invalid
   * (wrong field count, or any field that fails to parse to at least
   * one allowed value). For wildcards (`*`) we materialise the full
   * range into the Set, so consumers can iterate uniformly without
   * having to treat `null`-as-wildcard specially — that distinction
   * was the source of a silent "every minute" → "every hour" bug.
   *
   * `dow=7` (some crontabs use 7 for Sunday) is normalised to `0`.
   *
   * Public so the controllers can call `parseCron(x) !== null` as
   * a cheap validation check before persisting.
   */
  static parseCron(cronExpression: string): {
    minutes: Set<number>;
    hours: Set<number>;
    doms: Set<number>;
    months: Set<number>;
    dows: Set<number>;
  } | null {
    if (typeof cronExpression !== 'string') return null;
    const parts = cronExpression.trim().split(/\s+/);
    if (parts.length !== 5) return null;

    const [minuteStr, hourStr, domStr, monthStr, dowStr] = parts;

    const minutes = this.parseCronField(minuteStr, 0, 59);
    const hours = this.parseCronField(hourStr, 0, 23);
    const doms = this.parseCronField(domStr, 1, 31);
    const months = this.parseCronField(monthStr, 1, 12);
    const dows = this.parseCronField(dowStr, 0, 7);

    if (!minutes || !hours || !doms || !months || !dows) return null;

    // Normalise dow=7 (Sunday alias) to dow=0
    if (dows.has(7)) {
      dows.add(0);
      dows.delete(7);
    }

    return { minutes, hours, doms, months, dows };
  }

  /**
   * Parse a single cron field into a Set of allowed integer values.
   * Supports: wildcard ("*"), step values ("star-slash-N"), specific
   * numbers, comma-separated lists, and ranges ("1-5").
   *
   * Returns `null` when the field is invalid (would yield no allowed
   * values). For wildcard and step values, returns the fully expanded
   * set so the caller can always iterate / `.has()` without a sentinel
   * check.
   */
  private static parseCronField(field: string, min: number, max: number): Set<number> | null {
    if (typeof field !== 'string' || field.length === 0) return null;

    // Wildcard — every value in range.
    if (field === '*') {
      const set = new Set<number>();
      for (let i = min; i <= max; i++) set.add(i);
      return set;
    }

    // Step value: */N
    if (field.startsWith('*/')) {
      const step = parseInt(field.slice(2), 10);
      if (isNaN(step) || step <= 0) return null;
      const set = new Set<number>();
      for (let i = min; i <= max; i += step) set.add(i);
      return set.size > 0 ? set : null;
    }

    // Comma-separated list, possibly with ranges: "1,3,5" or "1-5" or "1-3,5"
    const set = new Set<number>();
    for (const part of field.split(',')) {
      const trimmed = part.trim();
      if (!trimmed) return null; // "1,,3" is malformed
      if (trimmed.includes('-')) {
        const [startStr, endStr] = trimmed.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end) || start > end) return null;
        for (let i = start; i <= end; i++) {
          if (i >= min && i <= max) set.add(i);
        }
      } else {
        const n = parseInt(trimmed, 10);
        if (isNaN(n) || n < min || n > max) return null;
        set.add(n);
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
   *
   * Sign math:
   *   guess     = UTC instant assuming target naive time IS already UTC
   *   guessParts.hour = what wall-clock that guess shows in the target TZ
   *
   *   If guess in TZ shows 05:00 but we wanted 09:00 (TZ is UTC-4, behind),
   *   the real UTC must be LATER than guess by 4h → subtract a negative diff
   *   (which adds time).
   *
   *   If guess in TZ shows 14:00 but we wanted 09:00 (TZ is UTC+5, ahead),
   *   the real UTC must be EARLIER than guess by 5h → subtract a positive
   *   diff (which subtracts time).
   *
   *   Either way: `realUtc = guess - diffMinutes`. The previous code added
   *   `diffMinutes` and silently broke every non-UTC schedule. Verified
   *   empirically against America/New_York, Asia/Almaty, and UTC.
   */
  private static buildDateInTimezone(
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
    tz: string
  ): Date {
    const guess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
    const guessParts = this.datePartsInTimezone(guess, tz);
    const guessMinutes = guessParts.hour * 60 + guessParts.minute;
    const targetMinutes = hour * 60 + minute;
    const diffMinutes = guessMinutes - targetMinutes;
    const result = new Date(guess.getTime() - diffMinutes * 60 * 1000);

    // DST spring-forward gap guard.
    //   On the DST-forward day in a behind-UTC tz (e.g. NY 2026-03-08
    //   2:30 AM doesn't exist — the clock jumps 2:00 → 3:00), the
    //   single-step Newton correction above lands one DAY too early
    //   instead of one HOUR too late. Detect by checking that the
    //   resulting UTC instant still maps back to the SAME calendar
    //   day in the target tz. If it doesn't, the requested wall-clock
    //   time is non-existent — return EPOCH so the caller's
    //   `targetUtc > now` comparison fails and the dayOffset loop
    //   advances to the next day (where the cron rule may fire at
    //   the same hour:minute, valid by then).
    //
    //   We intentionally don't try to "round forward" to 3:00 AM:
    //   POSIX cron behaviour is to SKIP non-existent local times, and
    //   that's what users expect (a daily 2:30 AM cron fires every day
    //   except the one DST day per year — better than two runs on the
    //   fall-back day).
    const verify = this.datePartsInTimezone(result, tz);
    if (verify.day !== day || verify.month !== month) {
      return new Date(0);
    }
    return result;
  }

  /**
   * Verify a schedule target (module or plan) exists and the user may access it.
   * Delegates to each domain's own access-checked getById — which return null
   * when the row is missing OR the user has no access — so the authorization
   * model stays identical to how the same target is authorized at run time
   * (modules: owner; plans: workspace membership). Reusing those avoids a
   * second, divergent access rule living here.
   */
  private static async userOwnsTarget(
    userId: string,
    target: { moduleId?: string; planId?: string }
  ): Promise<boolean> {
    try {
      if (target.moduleId) {
        // Lazy import: RegressionPlanService imports ScheduleService, so a
        // top-level import back would create a require cycle. These run at
        // call time only, so a dynamic import is both safe and sufficient.
        const { ModuleService } = await import('@/services/testing/modules/module.service');
        const mod = await ModuleService.getById(target.moduleId, userId);
        return !!mod;
      }
      if (target.planId) {
        const { RegressionPlanService } = await import(
          '@/services/testing/plans/regression-plan.service'
        );
        const plan = await RegressionPlanService.getById(target.planId, userId);
        return !!plan;
      }
      return false;
    } catch (error) {
      logger.error('[SCHEDULE_SERVICE] userOwnsTarget check failed', {
        error: error instanceof Error ? error.message : String(error),
        userId,
        target,
      });
      return false;
    }
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
