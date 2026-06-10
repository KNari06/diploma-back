/**
 * Schedules Controller
 * API endpoints for test schedules CRUD
 */

import { ScheduleService } from '@/services/testing/schedules/schedule.service';
import { NotFoundError, ValidationError } from '@/types';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

interface AuthenticatedRequest extends Request {
  user?: { id: string; email: string; role: string };
}

function getUserId(req: AuthenticatedRequest): string {
  const userId = req.user?.id;
  if (!userId) throw new Error('User ID not found');
  return userId;
}

/**
 * Validate a cron expression. Rejects anything that ScheduleService cannot
 * parse — previously the parser would silently fall back to "now + 1h",
 * which created schedules that ran hourly forever despite the user
 * thinking they had set up a daily / weekly / etc. cron.
 *
 * Returns null on success, or an error message string on failure.
 */
function validateCronExpression(cronExpression: unknown): string | null {
  if (typeof cronExpression !== 'string') {
    return 'cronExpression must be a string';
  }
  const parsed = ScheduleService.parseCron(cronExpression);
  if (!parsed) {
    return `Invalid cron expression: "${cronExpression}". Expected 5 fields: minute hour day-of-month month day-of-week.`;
  }
  return null;
}

/**
 * Validate a one-time runAt instant. Must be an offset-aware ISO-8601 datetime
 * in the future. `run_at` is stored as an absolute UTC instant, so an
 * offset-naive string (e.g. "2026-06-10T14:30:00") is REJECTED — JS would parse
 * it as server-local time, silently anchoring the run to whatever timezone the
 * server happens to run in. The client must include a `Z` or `±HH:MM` offset.
 *
 * Returns null on success, or an error message string on failure.
 */
function validateRunAt(runAt: unknown): string | null {
  if (typeof runAt !== 'string') return 'runAt must be an ISO datetime string';
  if (!ScheduleService.hasUtcOffset(runAt)) {
    return `runAt must include a timezone offset (a trailing "Z" or "±HH:MM"), e.g. "2026-06-10T14:30:00Z". Got "${runAt}".`;
  }
  const t = Date.parse(runAt);
  if (Number.isNaN(t)) {
    return `Invalid runAt: "${runAt}". Expected an ISO-8601 datetime like "2026-06-10T14:30:00Z".`;
  }
  if (t <= Date.now()) return 'runAt must be in the future';
  return null;
}

/**
 * Validate an IANA timezone string against Intl. UTC is always allowed.
 * Empty / undefined is allowed (service defaults to UTC).
 */
function validateTimezone(timezone: unknown): string | null {
  if (timezone === undefined || timezone === null || timezone === '') return null;
  if (typeof timezone !== 'string') return 'timezone must be a string';
  try {
    // `Intl.DateTimeFormat` throws RangeError on unknown TZ ids.
    Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return null;
  } catch {
    return `Invalid timezone: "${timezone}". Expected IANA name like "Asia/Almaty" or "UTC".`;
  }
}

/**
 * Create a new test schedule
 */
export async function createSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, name, cronExpression, runAt, timezone, moduleId, planId, parameters } = req.body;

    if (!projectId || !name) {
      res.status(400).json({ success: false, error: 'projectId and name are required' });
      return;
    }

    // Timing: exactly one of cronExpression (recurring) or runAt (one-time).
    const hasCron = cronExpression !== undefined && cronExpression !== null && cronExpression !== '';
    const hasRunAt = runAt !== undefined && runAt !== null && runAt !== '';
    if (hasCron === hasRunAt) {
      res.status(400).json({
        success: false,
        error: 'Provide exactly one of cronExpression (recurring) or runAt (one-time)',
      });
      return;
    }
    if (hasCron) {
      const cronError = validateCronExpression(cronExpression);
      if (cronError) {
        res.status(400).json({ success: false, error: cronError });
        return;
      }
    } else {
      const runAtError = validateRunAt(runAt);
      if (runAtError) {
        res.status(400).json({ success: false, error: runAtError });
        return;
      }
    }
    const tzError = validateTimezone(timezone);
    if (tzError) {
      res.status(400).json({ success: false, error: tzError });
      return;
    }

    const userId = getUserId(req);

    const schedule = await ScheduleService.create({
      projectId,
      userId,
      name,
      cronExpression: hasCron ? cronExpression : undefined,
      runAt: hasRunAt ? runAt : undefined,
      timezone,
      moduleId,
      planId,
      parameters,
    });

    res.json({ success: true, data: schedule, timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to create schedule', { error });
    handleError(res, error, 'Failed to create schedule');
  }
}

/**
 * Get a schedule by ID
 */
export async function getSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const schedule = await ScheduleService.getById(id, userId);
    if (!schedule) {
      res.status(404).json({ success: false, error: 'Schedule not found' });
      return;
    }

    res.json({ success: true, data: schedule, timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to get schedule', { error });
    handleError(res, error, 'Failed to get schedule');
  }
}

/**
 * List schedules for a project
 */
export async function listSchedules(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);

    const schedules = await ScheduleService.listByProject(projectId, userId);

    res.json({ success: true, data: schedules, timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to list schedules', { error });
    handleError(res, error, 'Failed to list schedules');
  }
}

/**
 * Update a schedule
 */
export async function updateSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, cronExpression, runAt, timezone, parameters, isActive } = req.body;
    const userId = getUserId(req);

    // Validate ONLY the fields the caller is actually changing — partial
    // updates are allowed and we don't want to force the FE to round-trip
    // unchanged fields just to satisfy validation.
    // Timing fields are mutually exclusive (a schedule is recurring XOR
    // one-time); reject both with a clean 400 rather than letting the service
    // throw a generic 500.
    if (cronExpression !== undefined && runAt !== undefined) {
      res.status(400).json({
        success: false,
        error: 'Provide at most one of cronExpression or runAt, not both',
      });
      return;
    }
    if (cronExpression !== undefined) {
      const cronError = validateCronExpression(cronExpression);
      if (cronError) {
        res.status(400).json({ success: false, error: cronError });
        return;
      }
    }
    if (runAt !== undefined) {
      const runAtError = validateRunAt(runAt);
      if (runAtError) {
        res.status(400).json({ success: false, error: runAtError });
        return;
      }
    }
    if (timezone !== undefined) {
      const tzError = validateTimezone(timezone);
      if (tzError) {
        res.status(400).json({ success: false, error: tzError });
        return;
      }
    }

    const schedule = await ScheduleService.update({
      id,
      userId,
      name,
      cronExpression,
      runAt,
      timezone,
      parameters,
      isActive,
    });

    res.json({ success: true, data: schedule, timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to update schedule', { error });
    handleError(res, error, 'Failed to update schedule');
  }
}

/**
 * Delete a schedule
 */
export async function deleteSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await ScheduleService.delete(id, userId);

    res.json({ success: true, message: 'Schedule deleted', timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to delete schedule', { error });
    handleError(res, error, 'Failed to delete schedule');
  }
}

/**
 * Activate a schedule
 */
export async function activateSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const schedule = await ScheduleService.activate(id, userId);

    res.json({ success: true, data: schedule, timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to activate schedule', { error });
    handleError(res, error, 'Failed to activate schedule');
  }
}

/**
 * Deactivate a schedule
 */
export async function deactivateSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const schedule = await ScheduleService.deactivate(id, userId);

    res.json({ success: true, data: schedule, timestamp: new Date() });
  } catch (error) {
    logger.error('[SCHEDULES_API] Failed to deactivate schedule', { error });
    handleError(res, error, 'Failed to deactivate schedule');
  }
}

function handleError(res: Response, error: unknown, defaultMessage: string): void {
  if (res.headersSent) return;

  if (error instanceof NotFoundError) {
    res.status(404).json({ success: false, error: 'Not found', message: error.message });
    return;
  }

  if (error instanceof ValidationError) {
    res.status(422).json({ success: false, error: 'Validation error', message: error.message });
    return;
  }

  res.status(500).json({
    success: false,
    error: defaultMessage,
    message: error instanceof Error ? error.message : 'Unknown error',
  });
}
