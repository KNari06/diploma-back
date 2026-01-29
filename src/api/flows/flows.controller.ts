/**
 * Flows Controller
 * API endpoints for test flows CRUD
 */

import { FlowService } from '@/services/testing/flows/flow.service';
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
 * Create a new test flow
 */
export async function createFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId, name, description, flowType, tags, priority, preconditions, expectedResult } = req.body;

    if (!suiteId || !name) {
      res.status(400).json({ success: false, error: 'suiteId and name are required' });
      return;
    }

    const userId = getUserId(req);

    const flow = await FlowService.create({
      suiteId,
      userId,
      name,
      description,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
    });

    res.json({ success: true, data: flow, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to create flow', { error });
    handleError(res, error, 'Failed to create flow');
  }
}

/**
 * Get a flow by ID
 */
export async function getFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const flow = await FlowService.getById(id, userId);
    if (!flow) {
      res.status(404).json({ success: false, error: 'Flow not found' });
      return;
    }

    res.json({ success: true, data: flow, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to get flow', { error });
    handleError(res, error, 'Failed to get flow');
  }
}

/**
 * List flows for a suite
 */
export async function listFlows(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId } = req.query;

    if (!suiteId || typeof suiteId !== 'string') {
      res.status(400).json({ success: false, error: 'suiteId is required' });
      return;
    }

    const userId = getUserId(req);

    const flows = await FlowService.listBySuite(suiteId, userId);

    res.json({ success: true, data: flows, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to list flows', { error });
    handleError(res, error, 'Failed to list flows');
  }
}

/**
 * Update a flow
 */
export async function updateFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, flowType, tags, priority, preconditions, expectedResult, orderIndex } = req.body;
    const userId = getUserId(req);

    const flow = await FlowService.update({
      id,
      userId,
      name,
      description,
      flowType,
      tags,
      priority,
      preconditions,
      expectedResult,
      orderIndex,
    });

    res.json({ success: true, data: flow, timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to update flow', { error });
    handleError(res, error, 'Failed to update flow');
  }
}

/**
 * Delete a flow
 */
export async function deleteFlow(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await FlowService.delete(id, userId);

    res.json({ success: true, message: 'Flow deleted', timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to delete flow', { error });
    handleError(res, error, 'Failed to delete flow');
  }
}

/**
 * Reorder flows within a suite
 */
export async function reorderFlows(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { suiteId, flowIds } = req.body;

    if (!suiteId || !flowIds || !Array.isArray(flowIds)) {
      res.status(400).json({ success: false, error: 'suiteId and flowIds array are required' });
      return;
    }

    const userId = getUserId(req);

    await FlowService.reorder(suiteId, flowIds, userId);

    res.json({ success: true, message: 'Flows reordered', timestamp: new Date() });
  } catch (error) {
    logger.error('[FLOWS_API] Failed to reorder flows', { error });
    handleError(res, error, 'Failed to reorder flows');
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
