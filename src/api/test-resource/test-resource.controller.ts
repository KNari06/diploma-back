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
// POST /api/v1/test-resource/:id/capture-mobile-snapshot
//
// Manual-button entry point for fast-auth capture. The runner does the
// privileged tar of /data/data/<pkg>/{shared_prefs,databases}; we wrap the
// metadata into an AuthMobileSnapshot envelope and persist via
// TestResourceService.captureState.
//
// Body: { runnerSessionId: string, packageName: string,
//         apkVersionCode?: number }
//
// `runnerSessionId` is mandatory and is the mobile runner's own session id
// (NOT the web preview session id). The FE already knows it from the
// preview run plumbing — we accept it directly rather than resolving via
// Redis warmup, because this endpoint is REST (not WS) and shouldn't
// re-implement the WS session-resolution waterfall.
//
// Errors surface from the runner's classification:
//   409  SNAPSHOT_PRIVILEGE   — neither run-as nor su works on this device
//   413  SNAPSHOT_TOO_LARGE   — over the 5 MB cap
//   400  PACKAGE_NAME_MISMATCH / PLATFORM_UNSUPPORTED
// 5xx is forwarded as 502 so the FE can distinguish "your config" (4xx)
// from "infra blip" (5xx) without parsing strings.
// ─────────────────────────────────────────────────────────────────────────────

export async function captureMobileSnapshot(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  const { runnerSessionId, packageName, apkVersionCode } = (req.body ?? {}) as {
    runnerSessionId?: unknown;
    packageName?: unknown;
    apkVersionCode?: unknown;
  };

  if (typeof runnerSessionId !== 'string' || !runnerSessionId) {
    res.status(400).json({ success: false, error: 'runnerSessionId (string) is required' });
    return;
  }
  if (typeof packageName !== 'string' || !packageName) {
    res.status(400).json({ success: false, error: 'packageName (string) is required' });
    return;
  }
  const versionCode =
    typeof apkVersionCode === 'number' && Number.isFinite(apkVersionCode)
      ? apkVersionCode
      : undefined;

  // Validate the resource exists, belongs to this user, and is the right kind.
  // We do this BEFORE the runner call so a stale request doesn't burn 30 s of
  // adb shell only to fail at persistence.
  const existing = await TestResourceService.getResource(id, userId);
  if (!existing) {
    res.status(404).json({ success: false, error: 'Resource not found' });
    return;
  }
  if (existing.kind !== 'auth') {
    res.status(400).json({
      success: false,
      error: `Mobile snapshot is only valid for auth resources; this one is "${existing.kind}"`,
    });
    return;
  }

  try {
    const { getMobileRunnerClient } = await import('@/services/mobile');
    const mobileClient = getMobileRunnerClient();
    const captured = await mobileClient.captureAppData(runnerSessionId, packageName, { userId });

    // Build the snapshot envelope the auth adapter validates. `capturedAt`
    // is server-side wall clock — the runner doesn't return one and we
    // want a single source of truth for the freshness check.
    const mobileSnapshot = {
      platform: 'android' as const,
      packageName,
      androidApiLevel: captured.androidApiLevel,
      dataTarballBase64: captured.dataTarballBase64,
      sizeBytes: captured.sizeBytes,
      capturedAt: new Date().toISOString(),
      capturedVia: captured.capturedVia,
      ...(versionCode !== undefined ? { apkVersionCode: versionCode } : {}),
    };

    // `heal: false` — this is a fresh user-initiated capture, not a
    // supervisor heal. The service stamps `captured_at`/`expires_at` on
    // the base row independently of our `mobileSnapshot.capturedAt`.
    await TestResourceService.captureState(
      id,
      userId,
      { sensitive: { mobileSnapshot } },
      { heal: false },
    );
    const resource = await TestResourceService.getResource(id, userId);
    res.json({
      success: true,
      resource,
      snapshot: {
        sizeBytes: captured.sizeBytes,
        capturedAt: mobileSnapshot.capturedAt,
        capturedVia: captured.capturedVia,
        androidApiLevel: captured.androidApiLevel,
      },
    });

    if (resource?.projectId) {
      void WorkspaceAuditService.logForProject({
        projectId: resource.projectId,
        actorUserId: userId,
        eventType: AUDIT_EVENTS.RESOURCE_SNAPSHOT_CAPTURED,
        targetType: 'resource',
        targetId: id,
        metadata: {
          kind: resource.kind,
          name: resource.name,
          sizeBytes: captured.sizeBytes,
          capturedVia: captured.capturedVia,
          packageName,
        },
        ...getAuditContext(req),
      });
    }
  } catch (err) {
    // Classify by MobileRunnerError fields where possible so the FE can
    // act on `code` (e.g. show a "snapshot too large" toast specifically).
    // Anything else collapses to 502 — runner had a problem we can't
    // attribute to user input.
    const { MobileRunnerError } = await import('@/services/mobile/mobile-runner.types');
    if (err instanceof MobileRunnerError) {
      const status = err.statusCode ?? 500;
      // Forward 4xx verbatim; map 5xx to 502 so the FE knows it's runner-
      // side and not a billing/auth/validation problem.
      const httpStatus = status >= 400 && status < 500 ? status : 502;
      res.status(httpStatus).json({
        success: false,
        error: err.message,
        code: err.code,
      });
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    logger.error('[CAPTURE_MOBILE_SNAPSHOT] unexpected error', {
      resourceId: id,
      error: msg,
    });
    res.status(500).json({ success: false, error: msg });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/v1/test-resource/:id/clear-mobile-snapshot
//
// Surgical: strips `sensitive.mobileSnapshot` without touching the recipe
// or storageState. Backed by the same in-process mutex the failed-restore
// path uses, so concurrent clears are safe.
// ─────────────────────────────────────────────────────────────────────────────

export async function clearMobileSnapshotEndpoint(req: Request, res: Response): Promise<void> {
  const userId = requireAuthed(req, res);
  if (!userId) return;

  const { id } = req.params;
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'user-cleared';

  // Validate it exists and is auth. Without the kind check we'd silently
  // succeed on env/secret resources (which have no mobileSnapshot anyway)
  // and confuse the user into thinking the action did something.
  const existing = await TestResourceService.getResource(id, userId);
  if (!existing) {
    res.status(404).json({ success: false, error: 'Resource not found' });
    return;
  }
  if (existing.kind !== 'auth') {
    res.status(400).json({
      success: false,
      error: `Mobile snapshot only exists on auth resources; this one is "${existing.kind}"`,
    });
    return;
  }

  await TestResourceService.clearMobileSnapshot(id, userId, reason);
  const resource = await TestResourceService.getResource(id, userId);
  res.json({ success: true, resource });

  if (resource?.projectId) {
    void WorkspaceAuditService.logForProject({
      projectId: resource.projectId,
      actorUserId: userId,
      eventType: AUDIT_EVENTS.RESOURCE_SNAPSHOT_CLEARED,
      targetType: 'resource',
      targetId: id,
      metadata: {
        kind: resource.kind,
        name: resource.name,
        reason: reason.slice(0, 200),
      },
      ...getAuditContext(req),
    });
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
