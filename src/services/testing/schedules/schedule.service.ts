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
      runAt,
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

    // Timing: exactly one of cronExpression (recurring) or runAt (one_time).
    // Mirrors the exactly-one-target guard above.
    const isOneTime = !!runAt;
    if (!!cronExpression === isOneTime) {
      throw new Error('Provide exactly one of cronExpression or runAt');
    }

    // Defence-in-depth: refuse to persist a bad timing value. The controllers
    // also validate, but other internal callers (e.g. RegressionPlanService.
    // syncSchedule) may bypass them and we don't want a row that misfires.
    let nextRunAt: string;
    if (isOneTime) {
      nextRunAt = this.parseFutureRunAt(runAt as string);
    } else {
      if (!this.parseCron(cronExpression as string)) {
        throw new Error(`Invalid cron expression: "${cronExpression}"`);
      }
      nextRunAt = this.calculateNextRun(cronExpression as string, timezone || 'UTC');
    }

    // Verify the target exists AND the user may access it. Without this a
    // schedule could be created against a foreign/non-existent module or plan;
    // it would then fail at run time and self-deactivate with a misleading
    // message — and it's an authorization gap (scheduling someone else's target).
    // Runs AFTER timing validation so a bad cron/runAt returns its precise error first.
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
      scheduleType: isOneTime ? 'one_time' : 'recurring',
      cronExpression: isOneTime ? undefined : cronExpression,
      runAt: isOneTime ? nextRunAt : undefined,
    });

    const { data, error } = await supabaseAdmin
      .from('test_schedules')
      .insert({
        project_id: projectId,
        user_id: userId,
        name,
        schedule_type: isOneTime ? 'one_time' : 'recurring',
        cron_expression: isOneTime ? null : cronExpression,
        run_at: isOneTime ? nextRunAt : null,
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
    const { id, userId, name, cronExpression, runAt, timezone, parameters, isActive } = params;

    // Timing fields are mutually exclusive, same as create(). Sending both
    // would leave the row violating check_schedule_mode no matter how we
    // reconcile — reject it up front with a clear message instead of letting
    // the DB raise an opaque constraint error.
    if (cronExpression !== undefined && runAt !== undefined) {
      throw new Error('Provide at most one of cronExpression or runAt, not both');
    }

    // Defence-in-depth — controllers also validate, but other internal
    // callers may bypass them. Refuse to persist an unparseable cron / bad runAt.
    if (cronExpression !== undefined && !this.parseCron(cronExpression)) {
      throw new Error(`Invalid cron expression: "${cronExpression}"`);
    }
    let runAtIso: string | undefined;
    if (runAt !== undefined) {
      runAtIso = this.parseFutureRunAt(runAt);
    }

    const updates: Record<string, any> = {};
    if (name !== undefined) updates.name = name;
    if (timezone !== undefined) updates.timezone = timezone;
    if (parameters !== undefined) updates.parameters = parameters;
    if (isActive !== undefined) updates.is_active = isActive;

    // Switching to / staying one_time: write ALL four mode columns consistently
    // (schedule_type, run_at, cron_expression=null, next_run_at) so the row
    // satisfies check_schedule_mode even when the previous mode was recurring.
    if (runAtIso !== undefined) {
      updates.schedule_type = 'one_time';
      updates.run_at = runAtIso;
      updates.cron_expression = null;
      updates.next_run_at = runAtIso;
      // Re-arm: supplying a fresh future runAt is an explicit intent to schedule
      // another run, so reactivate a row that a prior fire deactivated — unless
      // the caller is simultaneously setting isActive explicitly (respect that).
      if (isActive === undefined) updates.is_active = true;
    } else if (cronExpression !== undefined) {
      // Switching to / staying recurring: mirror image. Recompute next_run_at
      // from the new cron (+ new or existing timezone).
      const current = timezone === undefined ? await this.getById(id, userId) : null;
      const tz = timezone ?? current?.timezone ?? 'UTC';
      updates.schedule_type = 'recurring';
      updates.cron_expression = cronExpression;
      updates.run_at = null;
      updates.next_run_at = this.calculateNextRun(cronExpression, tz);
    } else if (timezone !== undefined) {
      // Timezone-only change. Recompute next_run_at ONLY for a recurring row;
      // a one_time row's next_run_at is an absolute instant unaffected by tz.
      const current = await this.getById(id, userId);
      if (current && current.scheduleType === 'recurring' && current.cronExpression) {
        updates.next_run_at = this.calculateNextRun(current.cronExpression, timezone);
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
    // A one_time schedule that already fired was deactivated by claimDueSchedule
    // with next_run_at = null (run_at is left intact as a record of when it ran).
    // Flipping is_active back to true would NOT make it run again — getDueSchedules
    // requires next_run_at <= now, and NULL never matches — so the user would
    // silently see an "active" schedule that never fires. Reject with guidance to
    // re-arm it via a fresh runAt instead.
    const current = await this.getById(id, userId);
    if (current && current.scheduleType === 'one_time' && !current.nextRunAt) {
      throw new Error(
        'This one-time schedule has already run and cannot be re-activated. Update it with a new runAt to schedule another run.'
      );
    }
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
      const base = {
        scheduleId: row.id,
        projectId: row.project_id,
        userId: row.user_id,
        scheduleType: (row.schedule_type as 'recurring' | 'one_time') || 'recurring',
        parameters: row.parameters || {},
      };
      if (row.module_id) {
        return { ...base, targetType: 'module', targetId: row.module_id };
      }
      if (row.plan_id) {
        return { ...base, targetType: 'plan', targetId: row.plan_id };
      }
      return { ...base, targetType: 'suite', targetId: row.suite_id || null };
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
      .select('schedule_type, cron_expression, timezone')
      .eq('id', id)
      .single();

    if (fetchError || !schedule) {
      logger.error('[SCHEDULE_SERVICE] Failed to fetch schedule for update', { error: fetchError, id });
      return false;
    }

    // One-time schedule: fires exactly once, then deactivate so it never
    // re-appears in getDueSchedules(). The is_active=true + next_run_at<=now
    // WHERE clause is the same atomic single-claim guard as the cron path —
    // a second instance that lost the race matches 0 rows and returns false.
    if (schedule.schedule_type === 'one_time') {
      const { data: claimed, error: claimError } = await supabaseAdmin
        .from('test_schedules')
        .update({ last_run_at: nowIso, is_active: false, next_run_at: null })
        .eq('id', id)
        .eq('is_active', true)
        .lte('next_run_at', nowIso)
        .select('id');

      if (claimError) {
        logger.error('[SCHEDULE_SERVICE] Failed to claim one-time schedule', { error: claimError, id });
        return false;
      }
      return Array.isArray(claimed) ? claimed.length > 0 : !!claimed;
    }

    const nextRunAt = this.calculateNextRunOrNull(
      schedule.cron_expression,
      schedule.timezone
    );

    // Unsatisfiable cron (e.g. "0 9 30 2 *"). Don't advance next_run_at (that
    // would fire it daily forever via a stale value) — deactivate so it stops
    // being due. The scheduler's pre-claim guard normally catches this first
    // and notifies the user; this is the defensive backstop.
    if (nextRunAt === null) {
      logger.warn('[SCHEDULE_SERVICE] Unsatisfiable cron — deactivating schedule', {
        id,
        cronExpression: schedule.cron_expression,
      });
      await supabaseAdmin
        .from('test_schedules')
        .update({ is_active: false })
        .eq('id', id);
      return false;
    }

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
    const next = this.calculateNextRunOrNull(cronExpression, timezone);
    if (next === null) {
      // The cron is structurally valid but can NEVER occur (e.g. "0 9 30 2 *"
      // — Feb 30). Previously this fell through to a now+24h fallback, so an
      // impossible cron silently ran every single day forever. Throw instead so
      // the persisting layer (create/update) rejects it, and the scheduler's
      // claim path deactivates it rather than firing daily. See callers.
      throw new Error(`Unsatisfiable cron expression: "${cronExpression}"`);
    }
    return next;
  }

  /**
   * True if an ISO-8601 datetime string carries an explicit UTC offset — a
   * trailing `Z` or a `±HH:MM` / `±HHMM` suffix on the time part. Offset-naive
   * strings (e.g. "2026-06-10T14:30:00") are rejected because JS parses them as
   * server-local time, which would silently anchor a one_time run to the
   * server's timezone. Public so the controller validates with the SAME rule.
   */
  static hasUtcOffset(value: string): boolean {
    // Match the offset only AFTER the time component, so a date-only "2026-06-10"
    // (no time) doesn't falsely pass and a date's "-" separators aren't read as
    // an offset sign.
    return /T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(value.trim());
  }

  /**
   * Validate a one_time runAt: offset-aware, parseable, strictly in the future.
   * Returns the normalized absolute UTC ISO string. Throws on any failure.
   * Single source of truth for create() + update() (controller mirrors hasUtcOffset).
   */
  static parseFutureRunAt(runAt: string): string {
    if (!this.hasUtcOffset(runAt)) {
      throw new Error(
        `runAt must include a timezone offset (a trailing "Z" or "±HH:MM"): "${runAt}"`
      );
    }
    const t = Date.parse(runAt);
    if (Number.isNaN(t)) {
      throw new Error(`Invalid runAt: "${runAt}" (expected an ISO-8601 datetime)`);
    }
    if (t <= Date.now()) {
      throw new Error('runAt must be in the future');
    }
    return new Date(t).toISOString();
  }

  /**
   * Format an absolute ISO instant into a human-readable wall-clock string in
   * the given timezone, e.g. "Jun 10, 2026, 2:30 PM (Asia/Almaty)". Falls back
   * to the raw value if it can't be parsed/formatted, so callers never throw.
   * Used for chat confirmation/success messages so users see a readable date
   * instead of a raw ISO string.
   */
  static formatRunAtForHuman(runAt: string, timezone?: string): string {
    const t = Date.parse(runAt);
    if (Number.isNaN(t)) return runAt;
    const tz = this.resolveTimezone(timezone || 'UTC');
    try {
      const formatted = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
      }).format(new Date(t));
      return `${formatted} (${tz})`;
    } catch {
      return runAt;
    }
  }

  // Like calculateNextRun but returns null instead of throwing when the cron is
  // unsatisfiable. The scheduler uses this to deactivate impossible schedules
  // without try/catch; create/update go through the throwing wrapper above.
  static calculateNextRunOrNull(cronExpression: string, timezone: string): string | null {
    const now = new Date();

    const parsed = this.parseCron(cronExpression);
    if (!parsed) {
      // Structurally invalid — log loudly. Persisting layers reject before this,
      // but keep a safe +1h fallback so a bad legacy row never explodes.
      logger.error('[SCHEDULE_SERVICE] calculateNextRun: invalid cron — falling back to +1h', {
        cronExpression,
      });
      return new Date(now.getTime() + 60 * 60 * 1000).toISOString();
    }

    const { minutes, hours, doms, months, dows } = parsed;
    const tz = this.resolveTimezone(timezone);
    const sortedMinutes = [...minutes].sort((a, b) => a - b);
    const sortedHours = [...hours].sort((a, b) => a - b);

    // POSIX cron day semantics: when BOTH day-of-month and day-of-week are
    // restricted (neither is '*'), a day matches if EITHER matches (OR). When
    // only one is restricted, it alone gates the day (the other being '*' = all
    // days). Detect "restricted" by comparing to the full materialised range:
    // dom '*' → 31 values (1..31); dow '*' → 7 values (0..6) after 7→0 normalise.
    const domRestricted = doms.size !== 31;
    const dowRestricted = dows.size !== 7;

    // Scan up to 1500 days (>4 years) so legitimate leap-day crons ("0 9 29 2 *")
    // resolve to the next real Feb 29 (up to ~1461 days out) instead of being
    // misclassified as unsatisfiable.
    for (let dayOffset = 0; dayOffset <= 1500; dayOffset++) {
      const candidate = new Date(now.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const candidateParts = this.datePartsInTimezone(candidate, tz);

      if (!months.has(candidateParts.month)) continue;

      const domMatch = doms.has(candidateParts.day);
      const dowMatch = dows.has(candidateParts.dow);
      const dayMatch =
        domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch;
      if (!dayMatch) continue;

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

    // Scan exhausted → the cron can never occur within the horizon. Signal
    // unsatisfiable (caller decides: throw on create, deactivate in scheduler).
    return null;
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
    //   On the DST-forward day (e.g. NY 2026-03-08 2:30 AM doesn't exist — the
    //   clock jumps 2:00 → 3:00), the requested wall-clock time is non-existent;
    //   the single-step Newton correction can't land on it. Detect that by
    //   verifying the result maps back to the requested HOUR:MINUTE in the
    //   target tz. If it doesn't, the local time is non-existent — return EPOCH
    //   so `targetUtc > now` fails and the dayOffset loop advances (POSIX cron
    //   SKIPS non-existent local times rather than firing twice).
    //
    //   IMPORTANT: verify HOUR:MINUTE, NOT the calendar day. A correct result
    //   legitimately rolls to the next calendar day for late hours in a positive
    //   UTC offset (e.g. 23:00 Asia/Almaty = 18:00 UTC, which is the *next* day
    //   in UTC terms after the Newton step). The old `verify.day !== day` check
    //   false-positived on EVERY such time, returning EPOCH → the whole cron was
    //   misclassified "unsatisfiable" → schedules at hour ≥ (24 - offset) in any
    //   ahead-of-UTC tz (incl. Asia/Almaty UTC+5, so any time ≥ 19:00) silently
    //   never got created. That was the root cause of "I set 23:00 and nothing runs".
    const verify = this.datePartsInTimezone(result, tz);
    if (verify.hour !== hour || verify.minute !== minute) {
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
   *
   * Lazy imports: RegressionPlanService imports ScheduleService, so a top-level
   * import back would create a require cycle. These run at call time only.
   *
   * Returns `false` ONLY for a definitive "missing or no access" (getById → null).
   * A transient/unexpected error (DB blip, WorkspaceAccess hiccup) is RE-THROWN,
   * NOT collapsed to false — because callers act irreversibly on false (the
   * scheduler deactivates the schedule). The caller must distinguish "the user
   * genuinely lost access" (deactivate) from "we couldn't check right now"
   * (skip this tick, retry next time). Swallowing here once permanently disabled
   * valid schedules on a momentary blip.
   */
  static async userOwnsTarget(
    userId: string,
    target: { moduleId?: string; planId?: string }
  ): Promise<boolean> {
    if (target.moduleId) {
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
      scheduleType: (row.schedule_type as 'recurring' | 'one_time') || 'recurring',
      cronExpression: row.cron_expression || undefined,
      runAt: row.run_at || undefined,
      timezone: row.timezone,
      isActive: row.is_active,
      parameters: row.parameters || {},
      lastRunAt: row.last_run_at || undefined,
      nextRunAt: row.next_run_at || undefined,
      createdAt: row.created_at,
    };
  }
}
