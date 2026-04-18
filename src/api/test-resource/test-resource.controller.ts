/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Test Resource Controller — HTTP surface for the universal resource layer
 *
 * Thin wrapper: validation + response shaping. All actual work in
 * TestResourceService. One controller handles every `kind` because the
 * resource schema is polymorphic — clients pass `kind` on create and
 * filter by it on list.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { Request, Response } from 'express';
import { logger } from '@/utils/core/logger';
import * as TestResourceService from '@/services/test-resource/test-resource.service';
import type {
  ResourceKind,
  ResourcePlatform,
} from '@/services/test-resource/types';

function getUserId(req: Request): string | null {
  const userId = (req as any).user?.id || (req as any).userId;
  return userId && typeof userId === 'string' ? userId : null;
}

function requireAuthed(req: Request, res: Response): string | null {
  const userId = getUserId(req);
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return null;
  }
  return userId;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/test-resource
// ─────────────────────────────────────────────────────────────────────────────

export async function createResource(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  try {
    const {
      projectId,
      kind,
      name,
      description,
      scope,
      config,
      sensitive,
      ttlSeconds,
      refreshMethod,
      refreshConfig,
      recipe,
      // UX shortcut: "use for all new tests matching this scope" checkbox.
      setAsDefault,
      defaultUrl,
    } = req.body ?? {};

    if (!projectId || typeof projectId !== 'string') {
      res.status(400).json({ success: false, error: 'projectId is required' });
      return;
    }
    if (!kind || typeof kind !== 'string') {
      res.status(400).json({ success: false, error: 'kind is required' });
      return;
    }
    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'name is required' });
      return;
    }

    const resource = await TestResourceService.createResource({
      userId,
      projectId,
      kind: kind as ResourceKind,
      name,
      description,
      scope,
      config,
      sensitive,
      ttlSeconds,
      refreshMethod,
      refreshConfig,
      recipe: Array.isArray(recipe) ? recipe : undefined,
    });

    if (setAsDefault) {
      try {
        await TestResourceService.setDefaultResource({
          userId,
          projectId,
          resourceId: resource.id,
          kind: resource.kind,
          platform: (resource.scope.platform ?? 'web') as ResourcePlatform,
          url: defaultUrl ?? resource.scope.domain ?? null,
          appPackage: resource.scope.app_package ?? null,
          urlPattern: resource.scope.url_pattern ?? null,
        });
      } catch (err) {
        // Non-fatal — creation succeeded, default wiring is a separate concern.
        logger.warn('[TEST_RESOURCE] setAsDefault failed after create', {
          id: resource.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    res.json({ success: true, resource });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    logger.error('[TEST_RESOURCE] create failed', { error: msg });
    res.status(400).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/test-resource/project/:projectId?kind=auth
// ─────────────────────────────────────────────────────────────────────────────

export async function listByProject(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { projectId } = req.params;
  if (!projectId) {
    res.status(400).json({ success: false, error: 'projectId is required' });
    return;
  }

  const kindFilter = req.query.kind as string | undefined;
  try {
    const resources = await TestResourceService.listResources(userId, projectId, {
      kind: (kindFilter as ResourceKind | undefined) ?? undefined,
    });
    res.json({ success: true, resources });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/v1/test-resource/:id
// ─────────────────────────────────────────────────────────────────────────────

export async function getResource(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  const resource = await TestResourceService.getResource(id, userId);
  if (!resource) {
    res.status(404).json({ success: false, error: 'Not found' });
    return;
  }
  res.json({ success: true, resource });
}

// ─────────────────────────────────────────────────────────────────────────────
// PUT /api/v1/test-resource/:id
// ─────────────────────────────────────────────────────────────────────────────

export async function updateResource(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  try {
    const resource = await TestResourceService.updateResource(id, userId, req.body ?? {});
    if (!resource) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({ success: true, resource });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DELETE /api/v1/test-resource/:id   body: { reassignTo?: string }
// Returns counts so UI can surface "47 tests reassigned".
// ─────────────────────────────────────────────────────────────────────────────

export async function deleteResource(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  const reassignTo = (req.body?.reassignTo as string | undefined) ?? undefined;

  try {
    const result = await TestResourceService.deleteResource(id, userId, { reassignTo });
    if (!result.deleted) {
      res.status(404).json({ success: false, error: 'Not found' });
      return;
    }
    res.json({
      success: true,
      reassignedTests: result.reassignedTests,
      detachedTests: result.detachedTests,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/test-resource/:id/capture
// Used by preview "I'm in — save login" and by supervisor after heal replay.
// ─────────────────────────────────────────────────────────────────────────────

export async function captureState(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  const { config, sensitive, heal } = req.body ?? {};
  if (!config && !sensitive) {
    res.status(400).json({ success: false, error: 'config or sensitive is required' });
    return;
  }

  try {
    await TestResourceService.captureState(id, userId, { config, sensitive }, { heal: !!heal });
    const resource = await TestResourceService.getResource(id, userId);
    res.json({ success: true, resource });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/test-resource/:id/mark-broken
// ─────────────────────────────────────────────────────────────────────────────

export async function markBroken(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Unknown';
  await TestResourceService.markBroken(id, userId, reason);
  res.json({ success: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/v1/test-resource/resolve?projectId=&kind=&url=&appPackage=&platform= */
export async function resolveDefault(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const projectId = req.query.projectId as string;
  const kind = req.query.kind as ResourceKind;
  if (!projectId || !kind) {
    res.status(400).json({ success: false, error: 'projectId and kind are required' });
    return;
  }

  const resourceId = await TestResourceService.resolveDefaultResourceId({
    userId,
    projectId,
    key: {
      kind,
      platform: (req.query.platform as ResourcePlatform | undefined) ?? 'web',
      url: (req.query.url as string | undefined) ?? null,
      appPackage: (req.query.appPackage as string | undefined) ?? null,
    },
  });

  res.json({ success: true, resourceId });
}

/** PUT /api/v1/test-resource/default  body: { projectId, resourceId, kind, platform?, url?, appPackage?, urlPattern? } */
export async function setDefault(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { projectId, resourceId, kind, platform, url, appPackage, urlPattern } =
    req.body ?? {};
  if (!projectId || !resourceId || !kind) {
    res
      .status(400)
      .json({ success: false, error: 'projectId, resourceId and kind are required' });
    return;
  }

  try {
    await TestResourceService.setDefaultResource({
      userId,
      projectId,
      resourceId,
      kind: kind as ResourceKind,
      platform: platform as ResourcePlatform | undefined,
      url: url ?? null,
      appPackage: appPackage ?? null,
      urlPattern: urlPattern ?? null,
    });
    res.json({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(400).json({ success: false, error: msg });
  }
}

/** DELETE /api/v1/test-resource/default  body: { projectId, kind, platform?, url?, appPackage?, urlPattern? } */
export async function clearDefault(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { projectId, kind, platform, url, appPackage, urlPattern } = req.body ?? {};
  if (!projectId || !kind) {
    res.status(400).json({ success: false, error: 'projectId and kind are required' });
    return;
  }

  await TestResourceService.clearDefaultResource({
    userId,
    projectId,
    kind: kind as ResourceKind,
    platform: platform as ResourcePlatform | undefined,
    url: url ?? null,
    appPackage: appPackage ?? null,
    urlPattern: urlPattern ?? null,
  });
  res.json({ success: true });
}
