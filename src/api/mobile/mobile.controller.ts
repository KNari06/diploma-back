/**
 * Mobile API Controller
 *
 * Handles mobile app management: upload APK/IPA, get app info, delete app.
 * APK/IPA is stored at project-level in Supabase Storage + project.settings.mobileApp.
 */

import { ProjectService } from '@/services/core/project.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import {
  MobileAppStorageService,
  MobileAppMetadata,
  trimMobileBuildField,
} from '@/services/storage/mobile-app-storage.service';
import { MobileAppParserService, type ParsedAppInfo } from '@/services/mobile/mobile-app-parser.service';
import { autoBootAndInstall } from './session.controller';
import { logger } from '@/utils/core/logger';
import { Request, Response } from 'express';

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD APP — signed-URL flow
// ═══════════════════════════════════════════════════════════════════════════
//
// The backend never touches the APK/IPA buffer: it issues a one-time
// Supabase signed URL, the client PUTs the binary directly to Storage,
// then calls /finalize to persist metadata. This bypasses Cloud Run's
// hard 32 MiB request-body limit which previously made any APK >30 MB
// fail with 413 from Google Frontend.
//
//   1. POST .../app/upload-url   → tiny JSON, returns a Supabase signed URL
//   2. PUT  <signed URL>         → client streams the APK/IPA directly to
//                                  Supabase Storage, no backend in the path
//   3. POST .../app/finalize     → tiny JSON, validates the object exists
//                                  and writes project.settings.mobileApp

const MAX_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500MB — mirrors multer
const ALLOWED_UPLOAD_EXTENSIONS = ['.apk', '.ipa', '.aab'];

function pickPlatform(raw: unknown): MobilePlatform {
  const VALID: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  if (typeof raw === 'string' && VALID[raw]) return VALID[raw];
  return 'android';
}

/**
 * POST /api/v1/mobile/projects/:projectId/app/upload-url
 *
 * Body: { filename, platform?, contentLength? }
 *   - filename       (required) — must end with .apk / .ipa / .aab.
 *   - platform       (optional) — 'android' | 'ios' | 'flutter'.
 *   - contentLength  (optional) — declared file size in bytes; rejected
 *                                 client-side if >500 MB so we don't issue
 *                                 a signed URL for an upload that will fail.
 *
 * Returns: { uploadUrl, token, storagePath, expiresIn }
 *
 * The client then issues `PUT uploadUrl` with the file body. The signed URL
 * is one-time-use and expires in ~2h on Supabase's side (server-set, not
 * configurable from the SDK).
 */
export async function createMobileAppUploadUrl(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const filename = typeof req.body?.filename === 'string' ? req.body.filename.trim() : '';
  const platform = pickPlatform(req.body?.platform);
  const contentLengthRaw = req.body?.contentLength;
  const contentLength = typeof contentLengthRaw === 'number'
    ? contentLengthRaw
    : (typeof contentLengthRaw === 'string' && /^\d+$/.test(contentLengthRaw)
      ? Number(contentLengthRaw)
      : null);

  if (!filename) {
    res.status(400).json({ success: false, error: 'filename is required (non-empty string)' });
    return;
  }
  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  if (!ALLOWED_UPLOAD_EXTENSIONS.includes(ext)) {
    res.status(400).json({
      success: false,
      error: `Invalid file type: ${ext || '(none)'}. Allowed: ${ALLOWED_UPLOAD_EXTENSIONS.join(', ')}`,
    });
    return;
  }
  if (contentLength !== null && contentLength > MAX_UPLOAD_SIZE_BYTES) {
    res.status(413).json({
      success: false,
      error: `File too large. Maximum size is ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024}MB, declared ${(contentLength / 1024 / 1024).toFixed(1)}MB`,
    });
    return;
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const signed = await MobileAppStorageService.createSignedUploadUrl({
    workspaceId: project.workspace_id,
    projectId,
    platform,
    originalName: filename,
  });

  logger.info('[MOBILE_API] Issued signed upload URL', {
    projectId,
    platform,
    storagePath: signed.storagePath,
    declaredSize: contentLength,
    userId,
  });

  res.json({
    success: true,
    uploadUrl: signed.uploadUrl,
    token: signed.token,
    storagePath: signed.storagePath,
  });
}

/**
 * POST /api/v1/mobile/projects/:projectId/app/finalize
 *
 * Body: { storagePath, packageName, versionName?, versionCode?, platform?,
 *         originalName?, branch?, commitSha?, buildNumber?, ciRunId? }
 *
 * Called after the client has finished `PUT`ing the file to Supabase. The
 * handler verifies the object exists, then:
 *   1. Inserts a row in `mobile_app_builds` (REQUIRED — every upload now
 *      lands in version history, not just CI uploads).
 *   2. Updates the legacy `projects.settings.mobileApp` slot so the editor
 *      warm-up keeps pointing at the latest binary.
 *   3. Prunes builds beyond `BUILD_HISTORY_LIMIT` for this (project, platform).
 *   4. Kicks off `autoBootAndInstall`.
 *
 * Version identity precedence — the API NO LONGER 400s on missing version.
 * The values are filled in via this waterfall:
 *   1. Client-supplied `versionName` / `versionCode` / `packageName` win
 *      (CI uploaders with explicit overrides keep working).
 *   2. If any field is missing, the binary is downloaded from Storage and
 *      parsed (`MobileAppParserService`) — APK/AAB AndroidManifest.xml,
 *      IPA Info.plist. Parser failures are swallowed and yield `{}`.
 *   3. If after merging we STILL have neither `versionName` nor
 *      `versionCode`, we synthesise a timestamp-based fallback
 *      `versionName = "build-YYYY-MM-DDTHH-MM"` so every build row stays
 *      distinguishable.
 *
 * `packageName` remains required overall — the runner cannot launch the
 * app without it — but the client may omit it as long as parsing recovers
 * one from the binary.
 *
 * Old APKs are NOT deleted on every upload anymore — they live in storage
 * until `pruneOldBuilds` rotates them out. This keeps the audit trail
 * meaningful: opening a failed run from last week, the user can still
 * download the exact APK that ran.
 */
export async function finalizeMobileAppUpload(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const storagePath = typeof req.body?.storagePath === 'string' ? req.body.storagePath.trim() : '';
  const clientPackageName = typeof req.body?.packageName === 'string' && req.body.packageName.trim()
    ? req.body.packageName.trim()
    : undefined;
  const platform = pickPlatform(req.body?.platform);
  const originalName = typeof req.body?.originalName === 'string' && req.body.originalName.trim()
    ? req.body.originalName.trim()
    : (storagePath.includes('/') ? storagePath.slice(storagePath.lastIndexOf('/') + 1) : storagePath);

  // Client-supplied version identity (still accepted — CI uploaders pass
  // these explicitly). Missing values are filled in below by parsing the
  // binary, with a timestamp fallback as last resort.
  const clientVersionName = typeof req.body?.versionName === 'string' && req.body.versionName.trim()
    ? req.body.versionName.trim()
    : undefined;
  const clientVersionCodeRaw = req.body?.versionCode;
  let clientVersionCode: number | undefined;
  if (typeof clientVersionCodeRaw === 'number' && Number.isFinite(clientVersionCodeRaw) && clientVersionCodeRaw >= 0) {
    clientVersionCode = Math.floor(clientVersionCodeRaw);
  } else if (typeof clientVersionCodeRaw === 'string' && /^\d+$/.test(clientVersionCodeRaw.trim())) {
    clientVersionCode = Number(clientVersionCodeRaw.trim());
  }

  const branch = trimMobileBuildField(req.body?.branch);
  const commitSha = trimMobileBuildField(req.body?.commitSha);
  const buildNumber = trimMobileBuildField(req.body?.buildNumber);
  const ciRunId = trimMobileBuildField(req.body?.ciRunId);

  if (!storagePath) {
    res.status(400).json({ success: false, error: 'storagePath is required (non-empty string)' });
    return;
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  // Defence in depth: refuse paths that don't belong to this project's tree.
  // The signed-url issuer always builds paths under
  // `mobile-apps/{workspaceId}/{projectId}/{platform}/…`, so a request that
  // doesn't match means the client tampered with the storagePath.
  const expectedPrefix = `mobile-apps/${project.workspace_id}/${projectId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    logger.warn('[MOBILE_API] finalize rejected — path outside project tree', {
      projectId,
      storagePath,
      expectedPrefix,
      userId,
    });
    res.status(400).json({ success: false, error: 'storagePath does not belong to this project' });
    return;
  }

  // Verify the object is actually present and not empty.
  const stat = await MobileAppStorageService.statObject(storagePath);
  if (!stat) {
    res.status(404).json({
      success: false,
      error: 'Object not found at storagePath — was the PUT to the upload URL successful?',
    });
    return;
  }
  if (stat.sizeBytes === 0) {
    res.status(400).json({ success: false, error: 'Uploaded object is empty (0 bytes)' });
    return;
  }
  if (stat.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    // Should never happen — Supabase per-file limit is set at the bucket —
    // but if a bucket-side limit lets a huge file through we still refuse.
    res.status(413).json({
      success: false,
      error: `Uploaded file too large (${(stat.sizeBytes / 1024 / 1024).toFixed(1)} MB). Max: ${MAX_UPLOAD_SIZE_BYTES / 1024 / 1024} MB.`,
    });
    return;
  }

  // Version identity waterfall: client → parsed → timestamp fallback.
  //
  // Parser runs only when at least one identity field is missing — this
  // avoids a 5-15 second Supabase download on fully-populated CI uploads.
  // The cost matters: CI pipelines re-upload on every commit, and adding a
  // mandatory download to every finalize would noticeably slow them down.
  //
  // The trade-off: when ALL three identity fields are client-supplied (the
  // common CI case), we don't get a `detectedFramework` stamp on the
  // upload. That's acceptable because:
  //   1. CI clients already know their framework — they pass
  //      `platform='flutter'` explicitly when relevant.
  //   2. The framework chip / editor auto-pick logic on the frontend
  //      degrades gracefully on undefined (no chip, fallback to extension
  //      heuristic).
  //   3. The legacy `MobileAppStorageService.uploadApp` path (used by CI
  //      upload-from-URL) DOES detect from the in-memory buffer — that
  //      path runs detection with zero extra I/O.
  // If a customer specifically asks for ground-truth framework on every
  // finalize regardless of client values, drop `needsParse` here.
  //
  // Type comes from `ParsedAppInfo` (the parser's authoritative shape),
  // not an inline literal — inline types silently drift when the parser
  // adds new fields.
  let parsed: ParsedAppInfo = {};
  const needsParse = !clientVersionName || clientVersionCode === undefined || !clientPackageName;
  if (needsParse) {
    parsed = await MobileAppParserService.parseFromStorage(storagePath, platform);
  }

  const mergedVersionName = clientVersionName ?? parsed.versionName;
  const mergedVersionCode = clientVersionCode ?? parsed.versionCode;
  const mergedPackageName = clientPackageName ?? parsed.packageName;

  // Why we don't promote `platform` here even when the detector says
  // "flutter": the runner's `createFlutterSession` still has the
  // chicken-and-egg issue — it probes the Flutter VM Service BEFORE the
  // backend has installed the app, so promoting an android upload to
  // `platform='flutter'` would route the next warmup through that broken
  // path and surface as a 500 loop in the editor (see Bug B in the
  // post-mortem). Instead we stamp `detectedFramework` on the metadata so
  // the frontend can react (show a mismatch chip, auto-pick the editor
  // platform when the user explicitly opts in), and revisit the promotion
  // story once the runner's Flutter session creation is lazy-attach.
  const effectivePlatform: MobilePlatform = platform;

  // packageName is non-negotiable — the runner literally cannot launch the
  // app without it. Refuse if neither the client nor the parser produced one.
  if (!mergedPackageName) {
    res.status(400).json({
      success: false,
      error: 'packageName is required and could not be read from the binary. Pass it explicitly (Android: package id e.g. com.example.app; iOS: bundle ID).',
    });
    return;
  }

  // Fallback synth: if version identity is still empty, mint a timestamp-
  // based versionName so `mobile_app_builds` rows remain distinguishable.
  // Format: "build-2026-05-27T14-30" (strip seconds & ms, ':' is invalid
  // in many UI contexts, replace with '-').
  let fallbackVersionName: string | undefined;
  if (!mergedVersionName && mergedVersionCode === undefined) {
    const iso = new Date().toISOString(); // 2026-05-27T14:30:01.123Z
    fallbackVersionName = `build-${iso.slice(0, 16).replace(':', '-')}`;
  }
  const finalVersionName = mergedVersionName ?? fallbackVersionName;
  const finalVersionCode = mergedVersionCode;

  const versionSource: 'client' | 'parsed' | 'fallback' = clientVersionName || clientVersionCode !== undefined
    ? 'client'
    : (parsed.versionName || parsed.versionCode !== undefined)
      ? 'parsed'
      : 'fallback';
  // Loggable framework mismatch: the user said "android" via .apk extension
  // but the binary is actually flutter / react-native. We don't auto-promote
  // (see comment above) — just record it so we can see in the logs how
  // often this happens and surface it to the frontend later.
  const frameworkMismatch = !!parsed.framework
    && parsed.framework !== 'android'
    && parsed.framework !== 'ios';
  logger.info('[MOBILE_API] finalize: version source', {
    projectId,
    platform: effectivePlatform,
    detectedFramework: parsed.framework ?? null,
    frameworkMismatch,
    versionSource,
    packageNameSource: clientPackageName ? 'client' : 'parsed',
    finalVersionName,
    finalVersionCode,
  });

  // Build the metadata once and reuse for both the legacy slot and the
  // versioned `mobile_app_builds` row. We persist `detectedFramework` only
  // in the legacy slot (JSONB) — adding it to `mobile_app_builds` needs a
  // separate migration, tracked as a follow-up.
  const metadata = MobileAppStorageService.finaliseDirectUpload({
    workspaceId: project.workspace_id,
    projectId,
    platform: effectivePlatform,
    packageName: mergedPackageName,
    storagePath,
    originalName,
    fileSize: stat.sizeBytes,
    versionName: finalVersionName,
    versionCode: finalVersionCode,
    detectedFramework: parsed.framework,
  });

  // 1. Record in `mobile_app_builds` FIRST. If this fails we abandon the
  // upload before touching `projects.settings.mobileApp` — otherwise the
  // legacy slot would point at a binary with no audit-trail row.
  const buildRow = await MobileAppStorageService.recordBuild(
    metadata,
    { branch, commitSha, buildNumber, ciRunId, source: 'manual' },
    { projectId, workspaceId: project.workspace_id, uploadedBy: userId },
  );
  if (!buildRow) {
    // recordBuild already logged the cause. The most likely case is a
    // duplicate commit_sha — the file is in storage but the DB rejected
    // the insert. We don't delete the file from storage automatically
    // because the existing row's storage_path may legitimately differ.
    res.status(409).json({
      success: false,
      error: 'Failed to record build in version history (likely duplicate commit_sha for this project+platform).',
    });
    return;
  }

  // 2. Update the legacy slot so editor warm-up + `resolveAppForRun`'s
  // last-resort fallback both keep working. Same shape as before.
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: metadata as unknown as Record<string, unknown>,
    },
  });

  logger.info('[MOBILE_API] App finalized (signed-URL flow)', {
    projectId,
    platform: effectivePlatform,
    detectedFramework: parsed.framework ?? null,
    buildId: buildRow.id,
    storagePath: metadata.storagePath,
    fileSize: metadata.fileSize,
    versionName: finalVersionName,
    versionCode: finalVersionCode,
  });

  res.status(201).json({
    success: true,
    mobileApp: metadata,
    build: buildRow,
  });

  // 3. Prune old builds — fire-and-forget, must not block the response.
  // Keeps storage cost bounded at BUILD_HISTORY_LIMIT * avg_apk_size per
  // (project, platform).
  MobileAppStorageService.pruneOldBuilds(projectId, platform).catch((err) => {
    logger.warn('[MOBILE_API] pruneOldBuilds failed (non-fatal)', {
      projectId,
      platform,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  // 4. Auto-boot emulator + install APK in background — same fire-and-forget
  // contract as the legacy upload route.
  autoBootAndInstall(projectId, userId, platform).catch((err) => {
    logger.warn('[MOBILE_API] Background auto-boot failed (non-fatal)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GET APP INFO
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/projects/:projectId/app
 *
 * Get current mobile app metadata for a project.
 */
export async function getMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;

  if (!mobileApp) {
    res.json({ success: true, mobileApp: null });
    return;
  }

  res.json({ success: true, mobileApp });
}

// ═══════════════════════════════════════════════════════════════════════════
// LIST APP BUILD HISTORY (Phase 5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/v1/mobile/projects/:projectId/builds?platform=android&limit=20
 *
 * Return recent versioned builds for the project (table: `mobile_app_builds`).
 * Separate from `GET /app` which still returns only the legacy single-entry
 * metadata. Used by the frontend to show build history (branch, commitSha,
 * uploadedAt, source) and to pick a specific build for a pinned run.
 */
export async function listMobileAppBuilds(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const rawPlatform = (req.query.platform as string) || 'android';
  const VALID: Record<string, MobilePlatform> = { android: 'android', ios: 'ios', flutter: 'flutter' };
  const platform: MobilePlatform = VALID[rawPlatform] ?? 'android';
  const limit = Math.min(Math.max(parseInt(req.query.limit as string, 10) || 20, 1), 200);

  // Verify project access — same pattern as getMobileApp.
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const builds = await MobileAppStorageService.listBuilds(projectId, platform, limit);
  res.json({ success: true, builds });
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH APP (packageName only)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * PATCH /api/v1/mobile/projects/:projectId/app
 * Body: { packageName: string }
 *
 * Update ONLY the packageName on the already-uploaded `projects.settings.mobileApp`
 * blob. Use case: APK was uploaded before the packageName input was required, so
 * the legacy slot has packageName: undefined. Re-uploading the APK just to set
 * one string is wasteful when the binary itself is fine.
 *
 * Does NOT touch versioned `mobile_app_builds` rows — those are immutable
 * history. The editor's warm-up reads from the legacy slot, so patching it
 * here is enough to unblock the flow.
 */
export async function patchMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;
  const rawPackageName = req.body?.packageName;
  const packageName = typeof rawPackageName === 'string' ? rawPackageName.trim() : '';
  if (!packageName) {
    res.status(400).json({ success: false, error: 'packageName is required (non-empty string)' });
    return;
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const existing = project.settings?.mobileApp as MobileAppMetadata | undefined;
  if (!existing) {
    res.status(404).json({
      success: false,
      error: 'No uploaded app to update — upload an APK/IPA first',
    });
    return;
  }

  const updated: MobileAppMetadata = { ...existing, packageName };

  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: updated as unknown as Record<string, unknown>,
    },
  });

  logger.info('[MOBILE_API] App packageName updated', { projectId, packageName });

  res.json({ success: true, mobileApp: updated });
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE APP
// ═══════════════════════════════════════════════════════════════════════════

/**
 * DELETE /api/v1/mobile/projects/:projectId/app
 *
 * Delete mobile app from storage and clear project settings.
 */
export async function deleteMobileApp(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }

  const { projectId } = req.params;

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found or access denied' });
    return;
  }

  const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;

  if (!mobileApp) {
    res.json({ success: true, message: 'No app to delete' });
    return;
  }

  // Delete from storage
  await MobileAppStorageService.deleteApp(mobileApp.storagePath);

  // Clear from project settings
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobileApp: null,
    },
  });

  logger.info('[MOBILE_API] App deleted', {
    projectId,
    storagePath: mobileApp.storagePath,
  });

  res.json({ success: true, message: 'App deleted' });
}

// ═══════════════════════════════════════════════════════════════════════════
// PERMISSION POLICY  (project-level default)
// ═══════════════════════════════════════════════════════════════════════════
//
// Type + validator live in `services/mobile/permission-policy.service.ts` —
// this file used to duplicate them, which made it easy for the shared
// service and the HTTP handlers to drift (e.g. add 'prompt' to the union
// in one place but not the other). Single source of truth now.

import {
  VALID_PERMISSION_POLICIES,
  type MobilePermissionPolicy,
} from '@/services/mobile/permission-policy.service';

function isValidPolicy(value: unknown): value is MobilePermissionPolicy {
  return typeof value === 'string'
    && (VALID_PERMISSION_POLICIES as readonly string[]).includes(value);
}

/**
 * GET /api/v1/mobile/projects/:projectId/permission-policy
 *
 * Returns the project-level default permission policy. Individual tests
 * may override it via their own settings; unset tests inherit this value.
 * Defaults to 'auto_allow' when nothing is stored yet.
 */
export async function getProjectPermissionPolicy(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const { projectId } = req.params;
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) {
    res.status(404).json({ success: false, error: 'Project not found' });
    return;
  }
  const stored = project.settings?.mobilePermissionPolicy;
  const policy: MobilePermissionPolicy = isValidPolicy(stored) ? stored : 'auto_allow';
  res.json({ success: true, policy });
}

/**
 * PUT /api/v1/mobile/projects/:projectId/permission-policy
 * Body: { policy: 'auto_allow' | 'auto_deny' | 'manual' }
 *
 * Updates the project-level default. Persisted at
 * `project.settings.mobilePermissionPolicy`.
 */
export async function setProjectPermissionPolicy(req: Request, res: Response): Promise<void> {
  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ success: false, error: 'Unauthorized' });
    return;
  }
  const { projectId } = req.params;
  const { policy } = req.body ?? {};
  if (!isValidPolicy(policy)) {
    res.status(400).json({
      success: false,
      error: `policy must be one of: ${VALID_PERMISSION_POLICIES.join(', ')}`,
    });
    return;
  }
  await ProjectService.updateProject(projectId, userId, {
    settings: {
      mobilePermissionPolicy: policy,
    },
  });
  logger.info('[MOBILE_API] Permission policy updated', { projectId, policy });
  res.json({ success: true, policy });
}
