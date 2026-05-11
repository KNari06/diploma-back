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
import { supabaseAdmin } from '@/db/supabase';
import * as TestResourceService from '@/services/test-resource/test-resource.service';
import {
  AUDIT_EVENTS,
  WorkspaceAuditService,
  getAuditContext,
} from '@/services/core/workspace-audit.service';
import type {
  ResourceKind,
  ResourcePlatform,
} from '@/services/test-resource/types';

/**
 * Admin-only snapshot for audit metadata. Bypasses the per-user filter that
 * `TestResourceService.getResource` applies — the surrounding mutation
 * (delete/capture/markBroken) is what enforces access; this read just gets
 * the row's name/kind/projectId for the audit row body. Returns null only on
 * genuinely missing rows.
 */
async function loadResourceForAudit(
  id: string,
): Promise<{ projectId: string; kind: string; name: string } | null> {
  const { data } = await supabaseAdmin
    .from('test_resources')
    .select('project_id, kind, name')
    .eq('id', id)
    .maybeSingle();
  if (!data) return null;
  return {
    projectId: (data as any).project_id,
    kind: (data as any).kind,
    name: (data as any).name,
  };
}

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

    void WorkspaceAuditService.logForProject({
      projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.RESOURCE_CREATED,
      targetType: 'resource',
      targetId: resource.id,
      metadata: {
        kind: resource.kind,
        name: resource.name,
        set_as_default: !!setAsDefault,
      },
      ...getAuditContext(req),
    });
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
// GET /api/v1/test-resource/by-domain?projectId=...&kind=auth&domain=app.example.com
//
// Returns resources of a given `kind` whose `scope.domain` matches the
// query domain exactly (case-insensitive). Used by the auth-detector
// silent-reuse path on the frontend: when the editor lands on a known
// hostname and we already have ONE login for it, we apply it without
// re-prompting the user.
// ─────────────────────────────────────────────────────────────────────────────

export async function findByDomain(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const projectId = (req.query.projectId as string | undefined) ?? '';
  const kind = (req.query.kind as string | undefined) ?? '';
  const domain = (req.query.domain as string | undefined) ?? '';

  if (!projectId || !kind || !domain) {
    res.status(400).json({
      success: false,
      error: 'projectId, kind, and domain are required query params',
    });
    return;
  }

  try {
    const resources = await TestResourceService.findByDomain(
      userId,
      projectId,
      kind as ResourceKind,
      domain,
    );
    res.json({ success: true, resources });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/test-resource/binding-summary
//
// Body: { flowIds: string[] }
// Returns: { success, summaries: { [flowId]: { authName?, envName?,
//                                              secretNames?, fixtureNames? } } }
//
// Bulk lookup used by the test-list UI to render resource badges
// (`🔐 Admin · 🌍 Staging`) on each flow row without N×lazy-loads.
// Flows with no preferred test case OR no bindings are simply absent
// from the response — callers treat absence as "no resources bound".
// ─────────────────────────────────────────────────────────────────────────────

export async function bindingSummary(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const rawIds = (req.body && (req.body as { flowIds?: unknown }).flowIds) ?? [];
  if (!Array.isArray(rawIds)) {
    res
      .status(400)
      .json({ success: false, error: 'flowIds must be an array of strings' });
    return;
  }
  const flowIds = rawIds.filter(
    (x): x is string => typeof x === 'string' && x.length > 0,
  );
  if (flowIds.length === 0) {
    res.json({ success: true, summaries: {} });
    return;
  }

  try {
    const summaries = await TestResourceService.bindingSummaryByFlows(userId, flowIds);
    res.json({ success: true, summaries });
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

    void WorkspaceAuditService.logForProject({
      projectId: resource.projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.RESOURCE_UPDATED,
      targetType: 'resource',
      targetId: id,
      metadata: {
        kind: resource.kind,
        name: resource.name,
        changed_fields: Object.keys(req.body ?? {}),
      },
      ...getAuditContext(req),
    });
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
    // Snapshot via admin read so audit rows survive the user_id filter.
    // The actual access check happens inside deleteResource itself.
    const snapshot = await loadResourceForAudit(id);

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

    if (snapshot) {
      void WorkspaceAuditService.logForProject({
        projectId: snapshot.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.RESOURCE_DELETED,
        targetType: 'resource',
        targetId: id,
        metadata: {
          kind: snapshot.kind,
          name: snapshot.name,
          reassign_to: reassignTo,
          reassigned_tests: result.reassignedTests,
          detached_tests: result.detachedTests,
        },
        ...getAuditContext(req),
      });
    }
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

    if (resource?.projectId) {
      void WorkspaceAuditService.logForProject({
        projectId: resource.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.RESOURCE_CAPTURED,
        targetType: 'resource',
        targetId: id,
        metadata: {
          kind: resource.kind,
          name: resource.name,
          heal: !!heal,
        },
        ...getAuditContext(req),
      });
    }
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
  // Admin snapshot for audit; markBroken itself enforces access.
  const snapshot = await loadResourceForAudit(id);
  await TestResourceService.markBroken(id, userId, reason);
  res.json({ success: true });

  if (snapshot) {
    void WorkspaceAuditService.logForProject({
      projectId: snapshot.projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.RESOURCE_MARKED_BROKEN,
      targetType: 'resource',
      targetId: id,
      metadata: { kind: snapshot.kind, name: snapshot.name, reason },
      ...getAuditContext(req),
    });
  }
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

    void WorkspaceAuditService.logForProject({
      projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.RESOURCE_DEFAULT_SET,
      targetType: 'resource',
      targetId: resourceId,
      metadata: { kind, platform, url, app_package: appPackage, url_pattern: urlPattern },
      ...getAuditContext(req),
    });
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

  void WorkspaceAuditService.logForProject({
    projectId,
    actorUserId: userId,
    eventType: AUDIT_EVENTS.RESOURCE_DEFAULT_CLEARED,
    targetType: 'resource',
    metadata: { kind, platform, url, app_package: appPackage, url_pattern: urlPattern },
    ...getAuditContext(req),
  });
}
