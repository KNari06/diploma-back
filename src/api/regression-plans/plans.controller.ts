/**
 * Regression Plans Controller
 * API endpoints for regression plans CRUD
 */

import { RegressionPlanService } from '@/services/testing/plans/regression-plan.service';
import { NotFoundError, ValidationError } from '@/types';
import type { PlanItemType, TestType } from '@/types/testing.types';
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
 * Create a new regression plan
 */
export async function createPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, name, description, isDefault, tags } = req.body;

    if (!projectId || !name) {
      res.status(400).json({ success: false, error: 'projectId and name are required' });
      return;
    }

    const userId = getUserId(req);

    const plan = await RegressionPlanService.create({
      projectId,
      userId,
      name,
      description,
      isDefault,
      tags,
    });

    res.json({ success: true, data: plan, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to create plan', { error });
    handleError(res, error, 'Failed to create plan');
  }
}

/**
 * Get a plan by ID with items
 */
export async function getPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const plan = await RegressionPlanService.getWithItems(id, userId);
    if (!plan) {
      res.status(404).json({ success: false, error: 'Plan not found' });
      return;
    }

    res.json({ success: true, data: plan, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to get plan', { error });
    handleError(res, error, 'Failed to get plan');
  }
}

/**
 * List plans for a project
 */
export async function listPlans(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);

    const plans = await RegressionPlanService.listByProject(projectId, userId);

    res.json({ success: true, data: plans, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to list plans', { error });
    handleError(res, error, 'Failed to list plans');
  }
}

/**
 * Update a plan
 */
export async function updatePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, isDefault, tags } = req.body;
    const userId = getUserId(req);

    const plan = await RegressionPlanService.update({
      id,
      userId,
      name,
      description,
      isDefault,
      tags,
    });

    res.json({ success: true, data: plan, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to update plan', { error });
    handleError(res, error, 'Failed to update plan');
  }
}

/**
 * Delete a plan
 */
export async function deletePlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await RegressionPlanService.delete(id, userId);

    res.json({ success: true, message: 'Plan deleted', timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to delete plan', { error });
    handleError(res, error, 'Failed to delete plan');
  }
}

/**
 * Add an item to a plan
 */
export async function addItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { itemType, moduleId, suiteId, flowId, testCaseId, testCaseType, parametersOverride } = req.body;

    if (!itemType) {
      res.status(400).json({ success: false, error: 'itemType is required' });
      return;
    }

    const item = await RegressionPlanService.addItem({
      planId: id,
      itemType: itemType as PlanItemType,
      moduleId,
      suiteId,
      flowId,
      testCaseId,
      testCaseType: testCaseType as TestType,
      parametersOverride,
    });

    res.json({ success: true, data: item, timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to add item', { error });
    handleError(res, error, 'Failed to add item');
  }
}

/**
 * Remove an item from a plan
 */
export async function removeItem(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { itemId } = req.params;
    const userId = getUserId(req);

    await RegressionPlanService.removeItem(itemId, userId);

    res.json({ success: true, message: 'Item removed', timestamp: new Date() });
  } catch (error) {
    logger.error('[PLANS_API] Failed to remove item', { error });
    handleError(res, error, 'Failed to remove item');
  }
}

/**
 * Expand a plan to individual test cases
 */
export async function expandPlan(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;

    const testCases = await RegressionPlanService.expandPlan(id);

    res.json({
      success: true,
      data: {
        testCases,
        totalCount: testCases.length,
      },
      timestamp: new Date(),
    });
  } catch (error) {
    logger.error('[PLANS_API] Failed to expand plan', { error });
    handleError(res, error, 'Failed to expand plan');
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
