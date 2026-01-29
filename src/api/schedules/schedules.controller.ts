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
 * Create a new test schedule
 */
export async function createSchedule(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, name, cronExpression, timezone, moduleId, suiteId, planId, parameters } = req.body;

    if (!projectId || !name || !cronExpression) {
      res.status(400).json({ success: false, error: 'projectId, name, and cronExpression are required' });
      return;
    }

    const userId = getUserId(req);

    const schedule = await ScheduleService.create({
      projectId,
      userId,
      name,
      cronExpression,
      timezone,
      moduleId,
      suiteId,
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
    const { name, cronExpression, timezone, parameters, isActive } = req.body;
    const userId = getUserId(req);

    const schedule = await ScheduleService.update({
      id,
      userId,
      name,
      cronExpression,
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
