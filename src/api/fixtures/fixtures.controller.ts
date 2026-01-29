/**
 * Fixtures Controller
 * API endpoints for test fixtures CRUD
 */

import { FixtureService } from '@/services/testing/fixtures/fixture.service';
import { NotFoundError, ValidationError } from '@/types';
import type { FixtureScope } from '@/types/testing.types';
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
 * Create a new test fixture
 */
export async function createFixture(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, name, description, data, scope, moduleId, tags } = req.body;

    if (!projectId || !name || !data) {
      res.status(400).json({ success: false, error: 'projectId, name, and data are required' });
      return;
    }

    const userId = getUserId(req);

    const fixture = await FixtureService.create({
      projectId,
      userId,
      name,
      description,
      data,
      scope,
      moduleId,
      tags,
    });

    res.json({ success: true, data: fixture, timestamp: new Date() });
  } catch (error) {
    logger.error('[FIXTURES_API] Failed to create fixture', { error });
    handleError(res, error, 'Failed to create fixture');
  }
}

/**
 * Get a fixture by ID
 */
export async function getFixture(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    const fixture = await FixtureService.getById(id, userId);
    if (!fixture) {
      res.status(404).json({ success: false, error: 'Fixture not found' });
      return;
    }

    res.json({ success: true, data: fixture, timestamp: new Date() });
  } catch (error) {
    logger.error('[FIXTURES_API] Failed to get fixture', { error });
    handleError(res, error, 'Failed to get fixture');
  }
}

/**
 * List fixtures for a project
 */
export async function listFixtures(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { projectId, scope } = req.query;

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }

    const userId = getUserId(req);

    const fixtures = await FixtureService.listByProject(
      projectId,
      userId,
      scope as FixtureScope | undefined
    );

    res.json({ success: true, data: fixtures, timestamp: new Date() });
  } catch (error) {
    logger.error('[FIXTURES_API] Failed to list fixtures', { error });
    handleError(res, error, 'Failed to list fixtures');
  }
}

/**
 * Update a fixture
 */
export async function updateFixture(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const { name, description, data, scope, moduleId, tags } = req.body;
    const userId = getUserId(req);

    const fixture = await FixtureService.update({
      id,
      userId,
      name,
      description,
      data,
      scope,
      moduleId,
      tags,
    });

    res.json({ success: true, data: fixture, timestamp: new Date() });
  } catch (error) {
    logger.error('[FIXTURES_API] Failed to update fixture', { error });
    handleError(res, error, 'Failed to update fixture');
  }
}

/**
 * Delete a fixture
 */
export async function deleteFixture(req: AuthenticatedRequest, res: Response): Promise<void> {
  try {
    const { id } = req.params;
    const userId = getUserId(req);

    await FixtureService.delete(id, userId);

    res.json({ success: true, message: 'Fixture deleted', timestamp: new Date() });
  } catch (error) {
    logger.error('[FIXTURES_API] Failed to delete fixture', { error });
    handleError(res, error, 'Failed to delete fixture');
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
