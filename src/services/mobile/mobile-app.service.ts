/**
 * Mobile App service — business logic for APK/IPA lifecycle.
 *
 * Extracted from `src/api/mobile/mobile.controller.ts` so the HTTP layer
 * stays thin (parse → call service → respond) and the version-identity
 * waterfall, build-recording, storage-path validation and per-platform
 * shard editing become unit-testable without mocking Express.
 *
 * Functions return either a typed success payload or a tagged error
 * object (`{ kind: 'invalid_path' | 'object_missing' | … }`). Callers
 * translate those tags into HTTP status codes — the service itself
 * stays oblivious of HTTP semantics.
 */

import { ProjectService } from '@/services/core/project.service';
import {
  getProjectMobileApp,
  getAllProjectMobileApps,
  getProjectMobileVariants,
  getDefaultVariantLabel,
  buildMobileAppSettingsPatch,
  getMaxMobileVariants,
  DEFAULT_VARIANT_LABEL,
} from '@/services/mobile/project-mobile-app.helper';
import {
  MobileAppStorageService,
  MobileAppMetadata,
  type MobileAppBuildRecord,
} from '@/services/storage/mobile-app-storage.service';
import type { MobileAppsByPlatform, MobileAppVariantEntry } from '@/services/mobile/project-mobile-app.helper';
import { MobileAppParserService, type ParsedAppInfo } from '@/services/mobile/mobile-app-parser.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';

export const MAX_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
export const ALLOWED_UPLOAD_EXTENSIONS = ['.apk', '.ipa', '.aab'] as const;

/** Common error tag returned by service functions. Keep flat — easy to switch on. */
export type MobileAppError =
  | { kind: 'project_not_found' }
  | { kind: 'invalid_filename'; ext: string }
  | { kind: 'file_too_large'; sizeBytes: number; maxBytes: number; source: 'declared' | 'uploaded' }
  | { kind: 'invalid_storage_path' }
  | { kind: 'object_missing' }
  | { kind: 'object_empty' }
  | { kind: 'package_name_required' }
  | { kind: 'build_record_failed'; code?: string; message?: string }
  | { kind: 'app_not_uploaded' }
  | { kind: 'no_app_to_delete'; platform?: MobilePlatform }
  | { kind: 'variant_limit'; max: number; platform: MobilePlatform }
  | { kind: 'invalid_variant_name' }
  | { kind: 'cannot_modify_default_variant' }
  | { kind: 'variant_not_found'; label: string }
  | { kind: 'variant_name_taken'; label: string };

/**
 * Guard the per-platform variant cap. The default lane and any already-existing
 * label are always allowed; a brand-new label is refused once the platform is
 * at `getMaxMobileVariants()` distinct labels. Returns an error tag or null.
 */
async function ensureVariantAllowed(
  projectId: string,
  platform: MobilePlatform,
  variantLabel: string,
): Promise<MobileAppError | null> {
  if (variantLabel === DEFAULT_VARIANT_LABEL) return null;
  const labels = await MobileAppStorageService.listVariantLabels(projectId, platform);
  if (labels.includes(variantLabel)) return null;
  if (labels.length >= getMaxMobileVariants()) {
    return { kind: 'variant_limit', max: getMaxMobileVariants(), platform };
  }
  return null;
}

/** Normalise a client-supplied variant label; blank/absent → the default lane. */
export function normaliseVariantLabel(raw: unknown): string {
  if (typeof raw !== 'string') return DEFAULT_VARIANT_LABEL;
  const t = raw.trim();
  return t.length > 0 ? t : DEFAULT_VARIANT_LABEL;
}

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD URL
// ═══════════════════════════════════════════════════════════════════════════

export interface CreateUploadUrlInput {
  projectId: string;
  userId: string;
  filename: string;
  platform: MobilePlatform;
  declaredSize: number | null;
  /** Target variant lane; absent/blank → the default lane. */
  variantLabel?: string;
}

export interface CreateUploadUrlOutput {
  uploadUrl: string;
  token: string;
  storagePath: string;
}

/**
 * Validate input, check project access, then ask Storage for a one-time
 * signed PUT URL. `declaredSize` is rejected client-side so we don't
 * issue a URL for an upload that would fail at the 500 MB cap.
 */
export async function createMobileAppUploadUrl(
  input: CreateUploadUrlInput,
): Promise<CreateUploadUrlOutput | MobileAppError> {
  const { projectId, userId, filename, platform, declaredSize } = input;
  const variantLabel = normaliseVariantLabel(input.variantLabel);

  const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
  if (!(ALLOWED_UPLOAD_EXTENSIONS as readonly string[]).includes(ext)) {
    return { kind: 'invalid_filename', ext: ext || '(none)' };
  }
  if (declaredSize !== null && declaredSize > MAX_UPLOAD_SIZE_BYTES) {
    return { kind: 'file_too_large', sizeBytes: declaredSize, maxBytes: MAX_UPLOAD_SIZE_BYTES, source: 'declared' };
  }

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  // Fail fast before issuing an upload URL for a variant we'd reject anyway.
  const capError = await ensureVariantAllowed(projectId, platform, variantLabel);
  if (capError) return capError;

  const signed = await MobileAppStorageService.createSignedUploadUrl({
    workspaceId: project.workspace_id,
    projectId,
    platform,
    originalName: filename,
    variantLabel,
  });

  logger.info('[MOBILE_APP_SERVICE] Issued signed upload URL', {
    projectId,
    platform,
    variantLabel,
    storagePath: signed.storagePath,
    declaredSize,
    userId,
  });

  return {
    uploadUrl: signed.uploadUrl,
    token: signed.token,
    storagePath: signed.storagePath,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FINALIZE — version-identity waterfall
// ═══════════════════════════════════════════════════════════════════════════

export interface FinalizeUploadInput {
  projectId: string;
  userId: string;
  storagePath: string;
  platform: MobilePlatform;
  originalName: string;
  clientPackageName?: string;
  clientVersionName?: string;
  clientVersionCode?: number;
  branch?: string;
  commitSha?: string;
  buildNumber?: string;
  ciRunId?: string;
  /** Target variant lane; absent/blank → the default lane. */
  variantLabel?: string;
}

export interface FinalizeUploadOutput {
  mobileApp: MobileAppMetadata;
  build: MobileAppBuildRecord;
  /** Whether `autoBootAndInstall` should be kicked off by the caller. Always true on success — kept as a flag so the HTTP layer owns side-effects. */
  shouldAutoBoot: true;
  platform: MobilePlatform;
  /** Variant the build landed in — the HTTP layer prunes this lane. */
  variantLabel: string;
}

/**
 * Run the finalize waterfall:
 *   1. Validate storage path belongs to this project's tree.
 *   2. Stat the uploaded object (presence, size).
 *   3. Fill missing version identity from the binary (parser) — skipped
 *      when client already supplied all three identity fields.
 *   4. Synthesise a timestamp `versionName` if everything is still empty.
 *   5. Refuse if `packageName` is still unknown.
 *   6. Insert `mobile_app_builds` row → abort on failure.
 *   7. Merge into `projects.settings.mobileApp` + `mobileApps[platform]`.
 *
 * Storage prune and emulator auto-boot are NOT triggered here — those
 * are fire-and-forget side-effects owned by the HTTP handler so a slow
 * prune can't delay the response.
 */
export async function finalizeMobileAppUpload(
  input: FinalizeUploadInput,
): Promise<FinalizeUploadOutput | MobileAppError> {
  const {
    projectId,
    userId,
    storagePath,
    platform,
    originalName,
    clientPackageName,
    clientVersionName,
    clientVersionCode,
    branch,
    commitSha,
    buildNumber,
    ciRunId,
  } = input;
  const variantLabel = normaliseVariantLabel(input.variantLabel);

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  // Authoritative cap re-check (upload-url checked too, but the set may have
  // changed between the two calls).
  const capError = await ensureVariantAllowed(projectId, platform, variantLabel);
  if (capError) return capError;

  // Defence in depth: refuse paths outside the project's tree. The
  // signed-URL issuer always emits `mobile-apps/{workspaceId}/{projectId}/…`,
  // so a mismatch means the client tampered with the storagePath.
  const expectedPrefix = `mobile-apps/${project.workspace_id}/${projectId}/`;
  if (!storagePath.startsWith(expectedPrefix)) {
    logger.warn('[MOBILE_APP_SERVICE] finalize rejected — path outside project tree', {
      projectId,
      storagePath,
      expectedPrefix,
      userId,
    });
    return { kind: 'invalid_storage_path' };
  }

  const stat = await MobileAppStorageService.statObject(storagePath);
  if (!stat) return { kind: 'object_missing' };
  if (stat.sizeBytes === 0) return { kind: 'object_empty' };
  if (stat.sizeBytes > MAX_UPLOAD_SIZE_BYTES) {
    return { kind: 'file_too_large', sizeBytes: stat.sizeBytes, maxBytes: MAX_UPLOAD_SIZE_BYTES, source: 'uploaded' };
  }

  // Version identity waterfall: client → parsed → timestamp fallback.
  // Parser runs only when at least one identity field is missing — this
  // avoids a 5-15s Supabase download on fully-populated CI uploads.
  let parsed: ParsedAppInfo = {};
  const needsParse = !clientVersionName || clientVersionCode === undefined || !clientPackageName;
  if (needsParse) {
    parsed = await MobileAppParserService.parseFromStorage(storagePath, platform);
  }

  const mergedVersionName = clientVersionName ?? parsed.versionName;
  const mergedVersionCode = clientVersionCode ?? parsed.versionCode;
  const mergedPackageName = clientPackageName ?? parsed.packageName;

  if (!mergedPackageName) return { kind: 'package_name_required' };

  // Fallback synth — keep `mobile_app_builds` rows distinguishable.
  // Format: "build-2026-05-27T14-30" (':' invalid in many UI contexts).
  let fallbackVersionName: string | undefined;
  if (!mergedVersionName && mergedVersionCode === undefined) {
    const iso = new Date().toISOString();
    fallbackVersionName = `build-${iso.slice(0, 16).replace(':', '-')}`;
  }
  const finalVersionName = mergedVersionName ?? fallbackVersionName;
  const finalVersionCode = mergedVersionCode;

  const versionSource: 'client' | 'parsed' | 'fallback' = clientVersionName || clientVersionCode !== undefined
    ? 'client'
    : (parsed.versionName || parsed.versionCode !== undefined)
      ? 'parsed'
      : 'fallback';
  const frameworkMismatch = !!parsed.framework
    && parsed.framework !== 'android'
    && parsed.framework !== 'ios';
  logger.info('[MOBILE_APP_SERVICE] finalize: version source', {
    projectId,
    platform,
    detectedFramework: parsed.framework ?? null,
    frameworkMismatch,
    versionSource,
    packageNameSource: clientPackageName ? 'client' : 'parsed',
    finalVersionName,
    finalVersionCode,
  });

  const metadata = await MobileAppStorageService.finaliseDirectUpload({
    workspaceId: project.workspace_id,
    projectId,
    platform,
    packageName: mergedPackageName,
    storagePath,
    originalName,
    fileSize: stat.sizeBytes,
    versionName: finalVersionName,
    versionCode: finalVersionCode,
    detectedFramework: parsed.framework,
    flutterBuildMode: parsed.flutterBuildMode,
    debuggable: parsed.debuggable,
  });

  // 1. Build row FIRST — if this fails the legacy slot must not point
  // at a binary with no audit-trail row.
  const recorded = await MobileAppStorageService.recordBuild(
    metadata,
    { branch, commitSha, buildNumber, ciRunId, source: 'manual' },
    { projectId, workspaceId: project.workspace_id, uploadedBy: userId, variantLabel },
  );
  if ('error' in recorded) {
    return { kind: 'build_record_failed', code: recorded.error.code, message: recorded.error.message };
  }
  const buildRow = recorded;

  // 2. Merge into project.settings — keeps the OTHER platform's slot intact and
  // only touches the legacy/shard mirror for the default lane.
  const settingsPatch = buildMobileAppSettingsPatch(
    project.settings as Record<string, unknown> | undefined,
    platform,
    metadata as unknown as MobileAppMetadata,
    variantLabel,
  );
  await ProjectService.updateProject(projectId, userId, { settings: settingsPatch });

  logger.info('[MOBILE_APP_SERVICE] App finalized', {
    projectId,
    platform,
    variantLabel,
    detectedFramework: parsed.framework ?? null,
    buildId: buildRow.id,
    storagePath: metadata.storagePath,
    fileSize: metadata.fileSize,
    versionName: finalVersionName,
    versionCode: finalVersionCode,
  });

  return {
    mobileApp: metadata,
    build: buildRow,
    shouldAutoBoot: true,
    platform,
    variantLabel,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// GET / LIST
// ═══════════════════════════════════════════════════════════════════════════

export interface GetMobileAppResult {
  /** Legacy singular slot, or per-platform slot if `filterPlatform` was set. `null` when not present. */
  mobileApp: MobileAppMetadata | null;
  /** Full per-platform dict. `undefined` when a single-platform filter was applied. */
  mobileApps?: MobileAppsByPlatform;
  /** Named variant lanes. Single-platform array when filtered, else per-platform dict. */
  variants?: MobileAppVariantEntry[] | Partial<Record<MobilePlatform, MobileAppVariantEntry[]>>;
  /** Per-platform cap on named variants (echoed so the UI never hardcodes it). */
  maxVariants: number;
  /** The configured default variant label. Single string when filtered, else per-platform. */
  defaultVariant?: string | Partial<Record<MobilePlatform, string>>;
}

const VARIANT_PLATFORMS: MobilePlatform[] = ['android', 'ios', 'flutter'];

export async function getMobileApp(
  projectId: string,
  userId: string,
  filterPlatform: MobilePlatform | undefined,
): Promise<GetMobileAppResult | MobileAppError> {
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  const maxVariants = getMaxMobileVariants();

  if (filterPlatform) {
    const slot = getProjectMobileApp(project.settings, filterPlatform) ?? null;
    return {
      mobileApp: slot,
      variants: getProjectMobileVariants(project.settings, filterPlatform),
      defaultVariant: getDefaultVariantLabel(project.settings, filterPlatform),
      maxVariants,
    };
  }

  const all = getAllProjectMobileApps(project.settings);
  const legacy = (project.settings?.mobileApp as MobileAppMetadata | undefined) ?? null;
  const variants: Partial<Record<MobilePlatform, MobileAppVariantEntry[]>> = {};
  const defaultVariant: Partial<Record<MobilePlatform, string>> = {};
  for (const p of VARIANT_PLATFORMS) {
    const lanes = getProjectMobileVariants(project.settings, p);
    if (lanes.length > 0) variants[p] = lanes;
    defaultVariant[p] = getDefaultVariantLabel(project.settings, p);
  }
  return { mobileApp: legacy, mobileApps: all, variants, defaultVariant, maxVariants };
}

export async function listMobileAppBuilds(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
  limit: number,
  variantLabel?: string,
): Promise<{ builds: unknown[] } | MobileAppError> {
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  const builds = await MobileAppStorageService.listBuilds(projectId, platform, limit, variantLabel);
  return { builds };
}

// ═══════════════════════════════════════════════════════════════════════════
// PATCH — packageName only
// ═══════════════════════════════════════════════════════════════════════════

export async function patchMobileAppPackageName(
  projectId: string,
  userId: string,
  packageName: string,
  requestedPlatform: MobilePlatform | undefined,
): Promise<{ mobileApp: MobileAppMetadata } | MobileAppError> {
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  const legacy = project.settings?.mobileApp as MobileAppMetadata | undefined;
  const targetPlatform: MobilePlatform | undefined =
    requestedPlatform ?? (legacy?.platform as MobilePlatform | undefined);

  const existing: MobileAppMetadata | undefined = targetPlatform
    ? (getProjectMobileApp(project.settings, targetPlatform) ?? legacy)
    : legacy;

  if (!existing) return { kind: 'app_not_uploaded' };

  const updated: MobileAppMetadata = { ...existing, packageName };

  const settingsPatch = targetPlatform
    ? buildMobileAppSettingsPatch(
        project.settings as Record<string, unknown> | undefined,
        targetPlatform,
        updated,
      )
    : { mobileApp: updated as unknown as Record<string, unknown> };

  await ProjectService.updateProject(projectId, userId, { settings: settingsPatch });

  logger.info('[MOBILE_APP_SERVICE] App packageName updated', { projectId, packageName });

  return { mobileApp: updated };
}

// ═══════════════════════════════════════════════════════════════════════════
// DELETE
// ═══════════════════════════════════════════════════════════════════════════

export interface DeleteMobileAppResult {
  message: string;
}

export async function deleteMobileApp(
  projectId: string,
  userId: string,
  targetPlatform: MobilePlatform | undefined,
): Promise<DeleteMobileAppResult | MobileAppError> {
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  if (targetPlatform) {
    // DELETE /app clears the MAIN app (the default lane / legacy slot). Pass
    // DEFAULT_VARIANT_LABEL explicitly so a project that promoted a named
    // variant to default doesn't have its variant binary deleted here (the
    // pointer would otherwise make getProjectMobileApp return that lane's
    // build). Named variants are removed via DELETE /app/variants/:label.
    const slot = getProjectMobileApp(project.settings, targetPlatform, DEFAULT_VARIANT_LABEL);
    if (!slot) return { kind: 'no_app_to_delete', platform: targetPlatform };

    await MobileAppStorageService.deleteApp(slot.storagePath);

    // Remove shard + clear legacy slot when it happens to point at the
    // same upload — leaving a stale legacy pointer would have the warmup
    // fallback resurrect a deleted binary on next read.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const currentApps = (project.settings as any)?.mobileApps as Record<string, unknown> | undefined;
    const nextApps = { ...(currentApps ?? {}) };
    delete nextApps[targetPlatform];
    const legacy = project.settings?.mobileApp as MobileAppMetadata | undefined;
    const legacyMatches = legacy && legacy.storagePath === slot.storagePath;
    await ProjectService.updateProject(projectId, userId, {
      settings: {
        mobileApps: nextApps,
        ...(legacyMatches ? { mobileApp: null } : {}),
      },
    });

    logger.info('[MOBILE_APP_SERVICE] App deleted (per-platform)', {
      projectId,
      platform: targetPlatform,
      storagePath: slot.storagePath,
    });
    return { message: 'App deleted' };
  }

  const mobileApp = project.settings?.mobileApp as MobileAppMetadata | undefined;
  if (!mobileApp) return { kind: 'no_app_to_delete' };

  await MobileAppStorageService.deleteApp(mobileApp.storagePath);
  await ProjectService.updateProject(projectId, userId, {
    settings: { mobileApp: null, mobileApps: {} },
  });

  logger.info('[MOBILE_APP_SERVICE] App deleted', {
    projectId,
    storagePath: mobileApp.storagePath,
  });
  return { message: 'App deleted' };
}

// ═══════════════════════════════════════════════════════════════════════════
// PERMISSION POLICY
// ═══════════════════════════════════════════════════════════════════════════

import {
  VALID_PERMISSION_POLICIES,
  type MobilePermissionPolicy,
} from '@/services/mobile/permission-policy.service';

export function isValidPermissionPolicy(value: unknown): value is MobilePermissionPolicy {
  return typeof value === 'string'
    && (VALID_PERMISSION_POLICIES as readonly string[]).includes(value);
}

export async function getProjectPermissionPolicy(
  projectId: string,
  userId: string,
): Promise<{ policy: MobilePermissionPolicy } | MobileAppError> {
  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };
  const stored = project.settings?.mobilePermissionPolicy;
  const policy: MobilePermissionPolicy = isValidPermissionPolicy(stored) ? stored : 'auto_allow';
  return { policy };
}

export async function setProjectPermissionPolicy(
  projectId: string,
  userId: string,
  policy: MobilePermissionPolicy,
): Promise<{ policy: MobilePermissionPolicy } | MobileAppError> {
  await ProjectService.updateProject(projectId, userId, {
    settings: { mobilePermissionPolicy: policy },
  });
  logger.info('[MOBILE_APP_SERVICE] Permission policy updated', { projectId, policy });
  return { policy };
}
