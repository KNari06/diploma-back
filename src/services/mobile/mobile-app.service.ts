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
  getFlutterDefaultHost,
  buildMobileAppSettingsPatch,
  buildSetDefaultVariantPatch,
  buildSetFlutterDefaultHostPatch,
  normaliseHostOverride,
  hasProjectMobileBuild,
  getMaxMobileVariants,
  shouldPromoteToDefault,
  variantStoragePlatform,
  DEFAULT_VARIANT_LABEL,
} from '@/services/mobile/project-mobile-app.helper';
import {
  MobileAppStorageService,
  MobileAppMetadata,
  type MobileAppBuildRecord,
} from '@/services/storage/mobile-app-storage.service';
import type { MobileAppsByPlatform, MobileAppVariantEntry } from '@/services/mobile/project-mobile-app.helper';
import { MobileAppParserService, type ParsedAppInfo } from '@/services/mobile/mobile-app-parser.service';
import { evaluateBuildContract, type BuildContractCode } from '@/services/mobile/flutter-build-contract';
import type { FlutterHostPlatform, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';

export const MAX_UPLOAD_SIZE_BYTES = 500 * 1024 * 1024; // 500MB
// `.zip` is an iOS SIMULATOR build: `flutter build ios --simulator` emits a
// `Runner.app` bundle (a directory), uploaded zipped. The runner extracts the
// `.app` before `simctl install`. Device `.ipa` / Android `.apk`/`.aab` unchanged.
export const ALLOWED_UPLOAD_EXTENSIONS = ['.apk', '.ipa', '.aab', '.zip'] as const;

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
  | { kind: 'build_contract_rejected'; code: BuildContractCode; error: string; remediation: string }
  | { kind: 'app_not_uploaded' }
  | { kind: 'no_app_to_delete'; platform?: MobilePlatform }
  | { kind: 'variant_limit'; max: number; platform: MobilePlatform }
  | { kind: 'invalid_variant_name' }
  | { kind: 'cannot_modify_default_variant' }
  | { kind: 'variant_not_found'; label: string }
  | { kind: 'variant_name_taken'; label: string }
  | { kind: 'invalid_host' }
  | { kind: 'host_build_missing'; host: FlutterHostPlatform };

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
  /** Headers the direct PUT must carry — provider-specific, see `SignedUploadTarget`. */
  requiredHeaders: Record<string, string>;
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
    requiredHeaders: signed.requiredHeaders,
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
  /**
   * Which entry point produced this build. Recorded on the `mobile_app_builds`
   * row so the audit trail distinguishes an editor upload from a pipeline
   * publish. Defaults to `'manual'` (the editor).
   */
  source?: 'manual' | 'ci';
  /**
   * Enforce the build contract (§ `flutter-build-contract.ts`) and REJECT a
   * build QAIT cannot automate, instead of accepting it with advisory UI.
   *
   * Set by the CI publish path only. Turning it on also forces the binary
   * parse — validation needs the parse even when the client supplied full
   * version identity, which is exactly the case the parse normally skips.
   */
  enforceBuildContract?: boolean;
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
  const source = input.source ?? 'manual';
  const enforceBuildContract = input.enforceBuildContract ?? false;

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
  // avoids a 5-15s download on fully-populated CI uploads. The build-contract
  // gate needs the parse regardless, so it forces one.
  let parsed: ParsedAppInfo = {};
  const needsParse = !clientVersionName || clientVersionCode === undefined || !clientPackageName;
  if (needsParse || enforceBuildContract) {
    parsed = await MobileAppParserService.parseFromStorage(storagePath, platform);
  }

  // Gate BEFORE anything is written. Rejecting after `recordBuild` would leave
  // an audit row and a settings pointer for a build we just refused.
  if (enforceBuildContract) {
    const verdict = evaluateBuildContract(parsed);
    if (!verdict.ok) {
      logger.warn('[MOBILE_APP_SERVICE] Build rejected by contract', {
        projectId,
        platform,
        storagePath,
        code: verdict.code,
        framework: parsed.framework ?? null,
        flutterBuildMode: parsed.flutterBuildMode ?? null,
        driverExtension: parsed.driverExtension ?? null,
      });
      return {
        kind: 'build_contract_rejected',
        code: verdict.code,
        error: verdict.error,
        remediation: verdict.remediation,
      };
    }
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
    { branch, commitSha, buildNumber, ciRunId, source },
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
  // A project's FIRST build must be runnable without a second click. When the
  // platform has no default pointer and an empty default lane, nothing would
  // resolve this upload — see `shouldPromoteToDefault`.
  const promoted = shouldPromoteToDefault(
    project.settings as Record<string, unknown> | undefined,
    platform,
    variantLabel,
  );
  if (promoted) {
    Object.assign(settingsPatch, buildSetDefaultVariantPatch(
      project.settings as Record<string, unknown> | undefined,
      variantStoragePlatform(platform),
      variantLabel,
    ));
  }
  await ProjectService.updateProject(projectId, userId, { settings: settingsPatch });

  logger.info('[MOBILE_APP_SERVICE] App finalized', {
    projectId,
    platform,
    variantLabel,
    promotedToDefault: promoted,
    source,
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
  /** The project's Flutter default host lane (editor toggle, server-persisted). Always present ('android' when unset). */
  flutterDefaultHost: FlutterHostPlatform;
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

  const flutterDefaultHost = getFlutterDefaultHost(project.settings);

  if (filterPlatform) {
    const slot = getProjectMobileApp(project.settings, filterPlatform) ?? null;
    return {
      mobileApp: slot,
      variants: getProjectMobileVariants(project.settings, filterPlatform),
      defaultVariant: getDefaultVariantLabel(project.settings, filterPlatform),
      maxVariants,
      flutterDefaultHost,
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
  return { mobileApp: legacy, mobileApps: all, variants, defaultVariant, maxVariants, flutterDefaultHost };
}

/**
 * Set the project's Flutter default host lane (`settings.flutterDefaultHost`).
 * Written by the editor's Android/iOS toggle so the choice survives the
 * browser and drives every non-editor run (regression / scheduled / CI).
 * Per-test-case `host_platform` overrides still win at dispatch time.
 *
 * Refuses an iOS lane the project has no build for — that combination cannot
 * succeed and its failure surfaces two minutes later as an opaque WebDriverAgent
 * timeout that blames the runner. See `flutter-host-guard.service.ts` for why
 * the android lane is deliberately NOT gated.
 */
export async function setFlutterDefaultHost(
  projectId: string,
  userId: string,
  rawHost: unknown,
): Promise<{ flutterDefaultHost: FlutterHostPlatform } | MobileAppError> {
  const host = normaliseHostOverride(rawHost);
  if (!host) return { kind: 'invalid_host' };

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  // Read from the settings we already loaded rather than calling the guard's
  // own project fetch — same predicate, one round-trip instead of two.
  if (host === 'ios' && !hasProjectMobileBuild(project.settings, 'ios')) {
    logger.info('[MOBILE_APP] Rejected flutter default host — no iOS build uploaded', {
      projectId,
      host,
    });
    return { kind: 'host_build_missing', host };
  }

  await ProjectService.updateProject(projectId, userId, {
    settings: buildSetFlutterDefaultHostPatch(host),
  });

  logger.info('[MOBILE_APP] Set flutter default host', { projectId, host });
  return { flutterDefaultHost: host };
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
