/**
 * Mobile App Storage Service
 *
 * Handles uploading/deleting APK/IPA files to Supabase Storage.
 * APK/IPA is stored at project level — one app per project.
 *
 * Storage path: mobile-apps/{workspaceId}/{projectId}/{platform}/{filename}
 * Metadata stored in: projects.settings.mobileApp (JSONB)
 */

import { supabaseAdmin } from '@/db/supabase';
import type { FlutterHostPlatform, MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { detectBuildInfoFromBuffer } from '@/services/mobile/archive-platform-detect';
import { DEFAULT_VARIANT_LABEL, getDefaultVariantLabel, getFlutterDefaultHost, variantStoragePlatform } from '@/services/mobile/project-mobile-app.helper';
import { getBlobStore, getBlobStoreForWrite } from './blob';
import { logger } from '@/utils/core/logger';
import path from 'path';

// ── Constants ──────────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
// `.zip` accepted for iOS SIMULATOR builds: `flutter build ios --simulator`
// emits a `Runner.app` bundle (a directory), uploaded zipped. The runner
// extracts the `.app` before `simctl install`. Device `.ipa` / Android
// `.apk`/`.aab` unchanged.
const ALLOWED_EXTENSIONS = ['.apk', '.ipa', '.aab', '.zip'];

// ── Types ──────────────────────────────────────────────────────────

export interface MobileAppMetadata {
  platform: MobilePlatform;
  packageName?: string;
  storagePath: string;
  publicUrl: string;
  originalName: string;
  fileSize: number;
  uploadedAt: string;
  /** Human-readable app version (e.g. "1.2.3"). At least one of versionName/versionCode is required. */
  versionName?: string;
  /** Integer build code (Android versionCode / iOS CFBundleVersion). */
  versionCode?: number;
  /**
   * Framework detected from the archive itself (`flutter` / `react-native` /
   * `android` / `ios`). Stamped at upload time by the ZIP-CD inspector so
   * the editor + runner can route accordingly even when `platform` was
   * filled from the file-extension heuristic. `undefined` only when the
   * archive predates this feature or detection failed.
   */
  detectedFramework?: 'android' | 'ios' | 'flutter' | 'react-native';
  /**
   * Flutter build flavor inferred from archive contents:
   *   - `'debug'` — kernel_blob.bin present; JIT VM; driver extension wireable.
   *   - `'aot'`   — profile or release (not distinguishable statically).
   * Only set when `detectedFramework === 'flutter'`.
   */
  flutterBuildMode?: 'debug' | 'aot';
  /**
   * `android:debuggable` flag from AndroidManifest.xml. True signals a
   * debug build on the Android side. Orthogonal to `flutterBuildMode`.
   */
  debuggable?: boolean;
  /**
   * Result of the last user-triggered enableFlutterDriverExtension probe.
   * Persisted so the Settings UI can show the verdict across reloads
   * without re-running the runner round-trip.
   */
  driverExtensionDetected?: 'detected' | 'not_detected' | 'error';
  /** Short human-readable reason for the verdict above. */
  driverExtensionDetail?: string;
  /** ISO timestamp of the probe that produced the verdict. */
  driverExtensionDetectedAt?: string;
}

/**
 * Git / build metadata supplied at upload time. All fields optional —
 * a row is now inserted into `mobile_app_builds` for EVERY upload (not
 * only when git metadata is present), so manual uploads from the UI
 * land in version history too.
 */
export interface MobileAppBuildMetadata {
  branch?: string;
  commitSha?: string;
  buildNumber?: string;
  ciRunId?: string;
  source?: 'manual' | 'ci' | 'webhook';
  notes?: string;
}

/**
 * A row from `mobile_app_builds` — same shape as MobileAppMetadata plus
 * git context. Returned by the resolver so `dispatchMobileTest` can build
 * `MobileTestJobData` identically whether the APK came from the new
 * versioned table or the legacy settings slot.
 */
export interface MobileAppBuildRecord extends MobileAppMetadata {
  id: string;
  branch: string | null;
  commitSha: string | null;
  buildNumber: string | null;
  ciRunId: string | null;
  source: 'manual' | 'ci' | 'webhook';
  /** Named variant lane this build belongs to (default = 'default'). */
  variantLabel: string;
}

/**
 * Result of `recordBuild`. Either the created row, or the REAL database error
 * (Postgres code + message) so callers surface an accurate reason instead of
 * guessing. `code === '23505'` is a unique violation (duplicate commit in a
 * variant). Discriminate with `'error' in result`.
 */
export type RecordBuildResult =
  | MobileAppBuildRecord
  | { error: { code?: string; message: string } };

/**
 * Context passed to `resolveAppForRun`. The resolver walks precedence:
 *   buildId > commitSha > branch > latest-on-project > legacy.
 *
 * `buildId` is the explicit user pin from plan/run settings ("run this
 * regression against build X regardless of git"). The fallback to
 * latest-on-project means a manually-uploaded APK without any git
 * metadata is still picked up automatically.
 *
 * `variantLabel` scopes the commit / branch / latest stages to a single
 * named variant lane. Omitted (or 'default') = the default lane, which after
 * backfill is every pre-variant build — so an unset variant resolves exactly
 * as before. The explicit `buildId` pin still wins over the variant.
 */
export interface MobileAppResolveContext {
  projectId: string;
  platform: MobilePlatform;
  /** Explicit build to pin to — wins over every other field. */
  buildId?: string;
  /** Exact commit to match. */
  commitSha?: string;
  /** Branch to match latest-on-branch. */
  branch?: string;
  /** Variant lane to resolve within. Defaults to the 'default' lane. */
  variantLabel?: string;
}

/**
 * Maximum number of builds retained per (project, platform) pair.
 * On every successful upload, anything beyond the N newest is deleted
 * from storage AND the table. `test_executions.mobile_app_build_id`
 * is `ON DELETE SET NULL`, so historical run rows survive the cleanup
 * but lose their hard pointer to the binary.
 */
export const BUILD_HISTORY_LIMIT = 10;

/**
 * Normalise a user-supplied string — trim whitespace, treat empty as absent.
 * Shared by both upload entry points (mobile.controller.ts and ci.controller.ts)
 * so a blank form field never ends up in the database as an empty string.
 *
 * Exported as a const so the `typeof` guard narrows correctly and so callers
 * that want to import an object-utility can do so from one place.
 */
export const trimMobileBuildField = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t.length > 0 ? t : undefined;
};

/**
 * Path segment for a variant lane. The default lane gets NO segment so its
 * objects keep the exact path they had before variants existed (a named lane
 * gets a sanitised `<label>/` subfolder). Sanitisation mirrors the filename
 * rule so a free-text label can't escape the project tree.
 */
function variantPathSegment(variantLabel?: string): string {
  if (!variantLabel || variantLabel === DEFAULT_VARIANT_LABEL) return '';
  const safe = variantLabel.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${safe}/`;
}

// ── Service ────────────────────────────────────────────────────────

export class MobileAppStorageService {
  /**
   * Upload APK/IPA to Supabase Storage.
   * If a previous app exists for this project+platform, deletes it first.
   */
  static async uploadApp(
    file: Express.Multer.File,
    params: {
      workspaceId: string;
      projectId: string;
      platform: MobilePlatform;
      packageName?: string;
      variantLabel?: string;
    },
  ): Promise<MobileAppMetadata> {
    const { workspaceId, projectId, platform, packageName, variantLabel } = params;

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024}MB, received ${(file.size / 1024 / 1024).toFixed(1)}MB`,
      );
    }

    // Validate extension
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }

    // Generate storage path
    const timestamp = Date.now();
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_${timestamp}${ext}`;
    const storagePath = `mobile-apps/${workspaceId}/${projectId}/${platform}/${variantPathSegment(variantLabel)}${fileName}`;

    logger.info('[MOBILE_APP_STORAGE] Uploading app', {
      projectId,
      platform,
      originalName: file.originalname,
      size: file.size,
      storagePath,
    });

    const contentType = ext === '.apk' ? 'application/vnd.android.package-archive'
      : ext === '.ipa' ? 'application/octet-stream'
        : 'application/octet-stream';

    // Write path — Azure-only by policy. See getBlobStoreForWrite.
    const blob = getBlobStoreForWrite();
    try {
      await blob.upload(storagePath, file.buffer, {
        contentType,
        cacheControl: '31536000', // 1 year (immutable, new file per upload)
      });
    } catch (error) {
      logger.error('[MOBILE_APP_STORAGE] Upload failed', {
        error: error instanceof Error ? error.message : String(error),
        projectId,
        storagePath,
      });
      throw error instanceof Error ? error : new Error('Failed to upload app');
    }

    // Display URL — Supabase: public URL; Azure (private container): '' (UI
    // mints a signed download URL on demand). See ADR-0008.
    const publicUrl = await blob.getDisplayUrl(storagePath);

    // Run framework + Flutter-build-mode detection on the in-memory buffer
    // BEFORE building the metadata. We do it here (inside uploadApp) so the
    // CI upload-from-URL path gets the same `detectedFramework` /
    // `flutterBuildMode` stamp that the signed-URL + finalize flow produces
    // — with ZERO extra I/O (the buffer is already in memory) — without
    // forcing every caller to wire detection by hand. Detection is hard-
    // contract non-throwing, so any failure just leaves the fields unset.
    const buildInfo = file.buffer
      ? await detectBuildInfoFromBuffer(file.buffer, file.originalname)
      : undefined;
    const detectedFramework = buildInfo?.framework;
    const flutterBuildMode = buildInfo?.flutterBuildMode;

    const metadata: MobileAppMetadata = {
      platform,
      packageName,
      storagePath,
      publicUrl,
      originalName: file.originalname,
      fileSize: file.size,
      uploadedAt: new Date().toISOString(),
      ...(detectedFramework ? { detectedFramework } : {}),
      ...(flutterBuildMode ? { flutterBuildMode } : {}),
    };

    logger.info('[MOBILE_APP_STORAGE] Upload successful', {
      projectId,
      platform,
      storagePath,
      publicUrl,
    });

    return metadata;
  }

  /**
   * Build a deterministic storage path for an upcoming upload — used by the
   * signed-URL flow so the path is decided server-side (clients can't pick
   * arbitrary locations) but the binary is uploaded directly client→Supabase,
   * bypassing the 32 MiB Cloud Run request limit.
   */
  private static buildStoragePath(params: {
    workspaceId: string;
    projectId: string;
    platform: MobilePlatform;
    originalName: string;
    variantLabel?: string;
  }): { storagePath: string; ext: string } {
    const ext = path.extname(params.originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    const safeName = path.basename(params.originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_${Date.now()}${ext}`;
    const storagePath = `mobile-apps/${params.workspaceId}/${params.projectId}/${params.platform}/${variantPathSegment(params.variantLabel)}${fileName}`;
    return { storagePath, ext };
  }

  /**
   * Create a one-time signed upload URL. The client PUTs the APK/IPA directly
   * to Supabase Storage using this URL, so the binary never transits the
   * backend. Path is decided here so callers can't write outside their own
   * project tree.
   *
   * Caller MUST verify project access BEFORE calling — this method only
   * deals with storage, not authorisation.
   */
  static async createSignedUploadUrl(params: {
    workspaceId: string;
    projectId: string;
    platform: MobilePlatform;
    originalName: string;
    variantLabel?: string;
  }): Promise<{ uploadUrl: string; token: string; storagePath: string }> {
    const { storagePath } = this.buildStoragePath(params);

    // Write path — Azure-only by policy. See getBlobStoreForWrite.
    const target = await getBlobStoreForWrite().createSignedUploadUrl(storagePath);

    logger.info('[MOBILE_APP_STORAGE] Issued signed upload URL', {
      projectId: params.projectId,
      platform: params.platform,
      storagePath,
    });

    return target;
  }

  /**
   * Confirm an object exists at `storagePath` and return its real size +
   * mime-type. Called by the finalize endpoint to refuse requests that point
   * at a missing or empty object (e.g. user got an upload URL but never PUT
   * the file).
   *
   * Returns null when the object is not present.
   */
  static async statObject(storagePath: string): Promise<{ sizeBytes: number; contentType: string | null } | null> {
    const stat = await getBlobStore().stat(storagePath);
    return stat ? { sizeBytes: stat.sizeBytes, contentType: stat.contentType } : null;
  }

  /**
   * Build a MobileAppMetadata for an APK/IPA that was uploaded directly by
   * the client via a signed URL — i.e. the backend never saw the buffer.
   * Mirrors what `uploadApp` returns so downstream consumers stay identical.
   */
  static async finaliseDirectUpload(params: {
    workspaceId: string;
    projectId: string;
    platform: MobilePlatform;
    packageName: string;
    storagePath: string;
    originalName: string;
    fileSize: number;
    versionName?: string;
    versionCode?: number;
    detectedFramework?: 'android' | 'ios' | 'flutter' | 'react-native';
    flutterBuildMode?: 'debug' | 'aot';
    debuggable?: boolean;
  }): Promise<MobileAppMetadata> {
    const publicUrl = await getBlobStore().getDisplayUrl(params.storagePath);

    return {
      platform: params.platform,
      packageName: params.packageName,
      storagePath: params.storagePath,
      publicUrl,
      originalName: params.originalName,
      fileSize: params.fileSize,
      uploadedAt: new Date().toISOString(),
      ...(params.versionName ? { versionName: params.versionName } : {}),
      ...(typeof params.versionCode === 'number' ? { versionCode: params.versionCode } : {}),
      ...(params.detectedFramework ? { detectedFramework: params.detectedFramework } : {}),
      ...(params.flutterBuildMode ? { flutterBuildMode: params.flutterBuildMode } : {}),
      ...(typeof params.debuggable === 'boolean' ? { debuggable: params.debuggable } : {}),
    };
  }

  /**
   * Delete a previously uploaded app from Supabase Storage.
   * Best-effort — logs errors but doesn't throw.
   */
  static async deleteApp(storagePath: string): Promise<void> {
    if (!storagePath) return;

    try {
      await getBlobStore().remove([storagePath]);
      logger.info('[MOBILE_APP_STORAGE] Deleted app', { storagePath });
    } catch (err) {
      logger.warn('[MOBILE_APP_STORAGE] Delete error', {
        error: err instanceof Error ? err.message : String(err),
        storagePath,
      });
    }
  }

  /**
   * Get a signed URL for downloading the app (for proxying to runner).
   * Signed URLs expire — use for short-lived access during test execution.
   */
  static async getSignedUrl(storagePath: string, expiresInSeconds = 600): Promise<string> {
    return getBlobStore().createSignedDownloadUrl(storagePath, expiresInSeconds);
  }

  /**
   * Download app file as Buffer (for proxying to runner).
   */
  static async downloadApp(storagePath: string): Promise<Buffer> {
    return getBlobStore().download(storagePath);
  }

  // ═══════════════════════════════════════════════════════════════════
  // Phase 5 — versioned builds on `mobile_app_builds`
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Persist an uploaded build into `mobile_app_builds`.
   *
   * Called for EVERY upload now (manual + CI), not only when git metadata
   * is present. Version info (version_name / version_code) comes from the
   * uploader. The upload-controller has already enforced "at least one of
   * version_name/version_code is non-empty" before reaching this method.
   *
   * Returns the created row. recordBuild is a HARD requirement of the
   * upload flow — a failure here leaves an orphan binary in storage with
   * no DB pointer, so callers MUST propagate the error rather than treat
   * it as best-effort.
   */
  static async recordBuild(
    metadata: MobileAppMetadata,
    buildMeta: MobileAppBuildMetadata,
    ctx: { projectId: string; workspaceId?: string; uploadedBy?: string; variantLabel?: string },
  ): Promise<RecordBuildResult> {
    try {
      const { data, error } = await supabaseAdmin
        .from('mobile_app_builds')
        .insert({
          project_id: ctx.projectId,
          workspace_id: ctx.workspaceId ?? null,
          uploaded_by: ctx.uploadedBy ?? null,
          platform: metadata.platform,
          variant_label: ctx.variantLabel ?? DEFAULT_VARIANT_LABEL,
          branch: buildMeta.branch ?? null,
          commit_sha: buildMeta.commitSha ?? null,
          build_number: buildMeta.buildNumber ?? null,
          ci_run_id: buildMeta.ciRunId ?? null,
          version_name: metadata.versionName ?? null,
          version_code: typeof metadata.versionCode === 'number' ? metadata.versionCode : null,
          storage_path: metadata.storagePath,
          public_url: metadata.publicUrl,
          original_name: metadata.originalName,
          package_name: metadata.packageName ?? null,
          file_size: metadata.fileSize,
          source: buildMeta.source ?? 'manual',
          notes: buildMeta.notes ?? null,
          uploaded_at: metadata.uploadedAt,
        })
        .select('*')
        .single();

      if (error || !data) {
        // Unique-commit collisions are the only "expected" insert failure
        // (CI re-uploads the same commit). We still surface them — caller
        // decides whether to roll back the storage object.
        const isDup = error?.code === '23505';
        logger[isDup ? 'info' : 'error']('[MOBILE_APP_STORAGE] recordBuild failed', {
          projectId: ctx.projectId,
          platform: metadata.platform,
          variantLabel: ctx.variantLabel ?? DEFAULT_VARIANT_LABEL,
          commitSha: buildMeta.commitSha,
          versionName: metadata.versionName,
          versionCode: metadata.versionCode,
          isDuplicate: isDup,
          error: error?.message,
        });
        return { error: { code: error?.code, message: error?.message || 'Insert returned no row' } };
      }

      logger.info('[MOBILE_APP_STORAGE] Recorded build', {
        buildId: data.id,
        projectId: ctx.projectId,
        platform: metadata.platform,
        versionName: metadata.versionName,
        versionCode: metadata.versionCode,
        branch: buildMeta.branch,
        commitSha: buildMeta.commitSha,
        source: buildMeta.source,
      });

      return this.mapBuildRow(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error('[MOBILE_APP_STORAGE] recordBuild threw', { error: message });
      return { error: { message } };
    }
  }

  /**
   * Look up a build by its primary key, scoped to a project so callers
   * can't pin a regression to a build that belongs to someone else.
   * Returns null when the row doesn't exist or doesn't match the project.
   */
  static async getBuildById(
    buildId: string,
    projectId: string,
  ): Promise<MobileAppBuildRecord | null> {
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .select('*')
      .eq('id', buildId)
      .eq('project_id', projectId)
      .maybeSingle();
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] getBuildById failed', { error: error.message, buildId });
      return null;
    }
    return data ? this.mapBuildRow(data) : null;
  }

  /**
   * Delete builds beyond `BUILD_HISTORY_LIMIT` for a (project, platform,
   * variant). Pruning is PER VARIANT so a Staging upload never evicts a
   * Production build — each lane keeps its own `BUILD_HISTORY_LIMIT` newest.
   * Storage objects are removed first, then the rows. `ON DELETE SET NULL`
   * on `test_executions.mobile_app_build_id` means historical runs survive
   * — they just lose the hard pointer to the binary.
   *
   * Best-effort: failure to prune MUST NOT fail the upload itself; storage
   * bloat is a degradation, not a correctness issue.
   */
  static async pruneOldBuilds(
    projectId: string,
    platform: MobilePlatform,
    variantLabel: string = DEFAULT_VARIANT_LABEL,
  ): Promise<void> {
    try {
      const { data, error } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('id, storage_path, uploaded_at')
        .eq('project_id', projectId)
        .eq('platform', platform)
        .eq('variant_label', variantLabel)
        .order('uploaded_at', { ascending: false });
      if (error || !data) {
        logger.warn('[MOBILE_APP_STORAGE] pruneOldBuilds list failed', {
          error: error?.message,
          projectId,
          platform,
          variantLabel,
        });
        return;
      }
      if (data.length <= BUILD_HISTORY_LIMIT) return;

      const toDelete = data.slice(BUILD_HISTORY_LIMIT);
      const storagePaths = toDelete.map((r) => r.storage_path).filter(Boolean);
      const ids = toDelete.map((r) => r.id);

      if (storagePaths.length > 0) {
        // Best-effort — the store logs its own partial failures. DB rows still
        // get pruned: orphan storage objects are recoverable later; orphan DB
        // rows pointing at deleted files are not.
        await getBlobStore().remove(storagePaths);
      }

      const { error: rowErr } = await supabaseAdmin
        .from('mobile_app_builds')
        .delete()
        .in('id', ids);
      if (rowErr) {
        logger.warn('[MOBILE_APP_STORAGE] pruneOldBuilds row delete failed', {
          error: rowErr.message,
          count: ids.length,
        });
        return;
      }

      logger.info('[MOBILE_APP_STORAGE] Pruned old builds', {
        projectId,
        platform,
        variantLabel,
        deletedCount: ids.length,
        retained: BUILD_HISTORY_LIMIT,
      });
    } catch (err) {
      logger.warn('[MOBILE_APP_STORAGE] pruneOldBuilds threw', {
        error: err instanceof Error ? err.message : String(err),
        projectId,
        platform,
      });
    }
  }

  /**
   * Resolve which APK/IPA to install for a run.
   *
   * Precedence (first match wins):
   *   1. Explicit `buildId` pin from plan/run settings.
   *   2. Exact commit (`commit_sha = ctx.commitSha`) — CI pinned run.
   *   3. Latest build on the requested branch (`branch = ctx.branch`) —
   *      git-trigger default ("PR on feat-x → install feat-x APK").
   *   4. Latest build for the (project, platform) — covers manual UI
   *      uploads where no git context is supplied.
   *   5. Legacy `projects.settings.mobileApp` — preserves pre-versioning
   *      behaviour for projects whose history pre-dates this code path.
   *
   * Returns null ONLY when no build exists anywhere for the project.
   */
  static async resolveAppForRun(
    ctx: MobileAppResolveContext,
  ): Promise<MobileAppBuildRecord | null> {
    // Variant lane to resolve within. Unset = 'default', which after backfill
    // is every pre-variant build, so an unset variant resolves as before. The
    // legacy/shard fallbacks below only apply to the default lane (a named
    // variant with no builds must NOT install the default flavor).
    const variant = ctx.variantLabel ?? DEFAULT_VARIANT_LABEL;
    const isDefaultLane = variant === DEFAULT_VARIANT_LABEL;
    // Named flutter variants live under the android lane (shared .apk), so the
    // variant-scoped stages query android for them. The DEFAULT lane keeps the
    // existing flutter→android fallback chain (stages 5/6) untouched.
    const variantPlatform = !isDefaultLane ? variantStoragePlatform(ctx.platform) : ctx.platform;

    // 1. Explicit buildId pin (project-scoped so callers can't reach
    // builds belonging to another project).
    if (ctx.buildId) {
      const pinned = await this.getBuildById(ctx.buildId, ctx.projectId);
      if (pinned && pinned.platform === ctx.platform) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched buildId pin', {
          projectId: ctx.projectId,
          buildId: ctx.buildId,
        });
        return pinned;
      }
      // Falling through is intentional — a stale buildId in plan settings
      // shouldn't break the run if a sensible fallback exists.
      logger.warn('[MOBILE_APP_STORAGE] buildId pin missed, falling through', {
        projectId: ctx.projectId,
        buildId: ctx.buildId,
        platform: ctx.platform,
      });
    }

    // 2. Commit pin — unique index (per variant) guarantees at most one row.
    if (ctx.commitSha) {
      const { data } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', variantPlatform)
        .eq('variant_label', variant)
        .eq('commit_sha', ctx.commitSha)
        .maybeSingle();
      if (data) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched commit', {
          projectId: ctx.projectId,
          commitSha: ctx.commitSha,
          variant,
        });
        return this.mapBuildRow(data);
      }
    }

    // 3. Latest on branch (within the variant).
    if (ctx.branch) {
      const { data } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', variantPlatform)
        .eq('variant_label', variant)
        .eq('branch', ctx.branch)
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched branch', {
          projectId: ctx.projectId,
          branch: ctx.branch,
          variant,
        });
        return this.mapBuildRow(data);
      }
    }

    // 4. Latest build for the (project, platform, variant). Now that every
    // upload (manual + CI) creates a `mobile_app_builds` row, this stage covers
    // the "user uploaded an APK from the UI without any git context" case that
    // previously fell through to the legacy slot.
    {
      const { data } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', variantPlatform)
        .eq('variant_label', variant)
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched latest-on-project', {
          projectId: ctx.projectId,
          platform: ctx.platform,
          variant,
          buildId: data.id,
        });
        return this.mapBuildRow(data);
      }
    }

    // Named variants stop here: no legacy/shard/flutter fallback (those mirror
    // the DEFAULT lane — substituting them would install the wrong flavor).
    if (!isDefaultLane) {
      logger.debug('[MOBILE_APP_STORAGE] resolver found no build in variant', {
        projectId: ctx.projectId,
        platform: ctx.platform,
        variant,
      });
      return null;
    }

    // 5. Legacy fallback — `projects.settings.mobileApp`. Read and adapt
    // the shape so the caller sees a uniform `MobileAppBuildRecord`.
    // Only reachable for projects whose only upload predates the
    // "every-upload-records-a-build" change.
    const { data: project } = await supabaseAdmin
      .from('projects')
      .select('workspace_id, settings')
      .eq('id', ctx.projectId)
      .single();

    const legacy = (project?.settings as any)?.mobileApp as MobileAppMetadata | undefined;
    if (legacy && legacy.storagePath && legacy.platform === ctx.platform) {
      logger.debug('[MOBILE_APP_STORAGE] resolver fell back to legacy mobileApp', {
        projectId: ctx.projectId,
      });
      return {
        id: 'legacy-settings',
        project_id: ctx.projectId as any, // unused downstream but typed below
        ...legacy,
        branch: null,
        commitSha: null,
        buildNumber: null,
        ciRunId: null,
        source: 'manual',
        variantLabel: DEFAULT_VARIANT_LABEL,
      } as unknown as MobileAppBuildRecord;
    }

    // 6. Flutter → Android binary fallback. A Flutter Android build IS a
    //    plain .apk, recorded/uploaded under platform 'android' (there is no
    //    separate flutter artifact). When a flutter run found nothing above,
    //    reuse the project's latest android build / legacy android slot —
    //    same .apk an android session would install. iOS never falls through
    //    here (an .ipa and .apk are genuinely different binaries).
    if (ctx.platform === 'flutter') {
      const { data: androidBuild } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', 'android')
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (androidBuild) {
        logger.info('[MOBILE_APP_STORAGE] flutter resolver fell back to android build', {
          projectId: ctx.projectId,
          buildId: androidBuild.id,
        });
        return this.mapBuildRow(androidBuild);
      }
      if (legacy && legacy.storagePath && (legacy.platform ?? 'android') === 'android') {
        logger.info('[MOBILE_APP_STORAGE] flutter resolver fell back to legacy android mobileApp', {
          projectId: ctx.projectId,
        });
        return {
          id: 'legacy-settings',
          project_id: ctx.projectId as any,
          ...legacy,
          branch: null,
          commitSha: null,
          buildNumber: null,
          ciRunId: null,
          source: 'manual',
        } as unknown as MobileAppBuildRecord;
      }
    }

    return null;
  }

  /**
   * List recent builds for a project (UI history panel).
   */
  static async listBuilds(
    projectId: string,
    platform: MobilePlatform,
    limit = 20,
    variantLabel: string = DEFAULT_VARIANT_LABEL,
  ): Promise<MobileAppBuildRecord[]> {
    // Always scope to a single lane. An absent variant means the default lane,
    // NOT "every lane" — otherwise the build picker would intermix Production /
    // Staging / Dev builds and let a user pin a build from the wrong flavor.
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .select('*')
      .eq('project_id', projectId)
      .eq('platform', platform)
      .eq('variant_label', variantLabel)
      .order('uploaded_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200));
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] listBuilds failed', { error });
      return [];
    }
    return (data || []).map((row) => this.mapBuildRow(row));
  }

  /**
   * Distinct variant labels that have at least one build for a
   * (project, platform). Used to enforce the per-platform variant cap and to
   * build the variant registry. Rows are bounded (pruned per lane), so the
   * in-memory dedupe is cheap.
   */
  static async listVariantLabels(
    projectId: string,
    platform: MobilePlatform,
  ): Promise<string[]> {
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .select('variant_label')
      .eq('project_id', projectId)
      .eq('platform', platform);
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] listVariantLabels failed', { error: error.message, projectId, platform });
      return [];
    }
    const labels = new Set<string>();
    for (const row of data ?? []) labels.add((row as { variant_label?: string }).variant_label ?? DEFAULT_VARIANT_LABEL);
    return [...labels];
  }

  /**
   * Delete EVERY build in a variant lane: storage objects first, then rows.
   * Used when a user removes a named variant. Returns the number of rows
   * deleted. Best-effort on storage (orphan objects are recoverable; orphan
   * rows are not), authoritative on rows.
   */
  static async deleteVariantBuilds(
    projectId: string,
    platform: MobilePlatform,
    variantLabel: string,
  ): Promise<number> {
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .select('id, storage_path')
      .eq('project_id', projectId)
      .eq('platform', platform)
      .eq('variant_label', variantLabel);
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] deleteVariantBuilds list failed', { error: error.message, projectId, platform, variantLabel });
      return 0;
    }
    const rows = data ?? [];
    if (rows.length === 0) return 0;

    const storagePaths = rows.map((r) => (r as { storage_path?: string }).storage_path).filter(Boolean) as string[];
    if (storagePaths.length > 0) {
      await getBlobStore().remove(storagePaths); // store logs its own partial failures
    }
    const ids = rows.map((r) => (r as { id: string }).id);
    const { error: delErr } = await supabaseAdmin.from('mobile_app_builds').delete().in('id', ids);
    if (delErr) {
      logger.warn('[MOBILE_APP_STORAGE] deleteVariantBuilds row delete failed', { error: delErr.message, projectId, platform, variantLabel });
      return 0;
    }
    logger.info('[MOBILE_APP_STORAGE] Deleted variant builds', { projectId, platform, variantLabel, deletedCount: ids.length });
    return ids.length;
  }

  /**
   * Relabel every build in a lane (`from` → `to`). Storage objects keep their
   * paths (the path is opaque — read from the row, never recomputed). Returns
   * the number of rows updated.
   */
  static async renameVariantBuilds(
    projectId: string,
    platform: MobilePlatform,
    from: string,
    to: string,
  ): Promise<number> {
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .update({ variant_label: to })
      .eq('project_id', projectId)
      .eq('platform', platform)
      .eq('variant_label', from)
      .select('id');
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] renameVariantBuilds failed', { error: error.message, projectId, platform, from, to });
      return 0;
    }
    const count = (data ?? []).length;
    logger.info('[MOBILE_APP_STORAGE] Renamed variant builds', { projectId, platform, from, to, count });
    return count;
  }

  /**
   * The default variant label configured for a (project, platform) — the lane a
   * run uses when neither the test case nor the plan specifies a variant. Reads
   * the `projects.settings.mobileDefaultVariant` pointer; 'default' when unset.
   */
  static async getProjectDefaultVariant(
    projectId: string,
    platform: MobilePlatform,
  ): Promise<string> {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle();
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] getProjectDefaultVariant failed', { error: error.message, projectId });
      return DEFAULT_VARIANT_LABEL;
    }
    return getDefaultVariantLabel(data?.settings as Record<string, unknown> | undefined, platform);
  }

  /**
   * The host a project's Flutter runs default to when the test case has no
   * `host_platform` override. Reads `projects.settings.flutterDefaultHost`
   * (written by the editor's Android/iOS toggle); 'android' when unset or
   * on read failure (back-compat — pre-existing behavior was always-Android).
   */
  static async getProjectDefaultFlutterHost(projectId: string): Promise<FlutterHostPlatform> {
    const { data, error } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle();
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] getProjectDefaultFlutterHost failed', { error: error.message, projectId });
      return 'android';
    }
    return getFlutterDefaultHost(data?.settings as Record<string, unknown> | undefined);
  }

  /**
   * Read the app framework detected at upload time for a project, independent
   * of platform. Source of truth is `projects.settings.mobileApp.detectedFramework`
   * (set by `uploadApp`); the `mobile_app_builds` table does not persist it.
   *
   * Returns undefined when no app has been uploaded or detection didn't run
   * (older uploads). Callers should treat undefined as "assume native android".
   *
   * Used by the test-case save path to keep Flutter apps on `mobile_flutter`
   * even though the runner's live ui-state only ever reports the host platform.
   */
  static async getDetectedFramework(
    projectId: string,
  ): Promise<MobileAppMetadata['detectedFramework'] | undefined> {
    const { data: project, error } = await supabaseAdmin
      .from('projects')
      .select('settings')
      .eq('id', projectId)
      .maybeSingle();
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] getDetectedFramework failed', { projectId, error });
      return undefined;
    }
    const legacy = (project?.settings as any)?.mobileApp as MobileAppMetadata | undefined;
    return legacy?.detectedFramework;
  }

  /** Convert a raw `mobile_app_builds` row into the service shape. */
  private static mapBuildRow(row: any): MobileAppBuildRecord {
    return {
      id: row.id,
      platform: row.platform,
      packageName: row.package_name ?? undefined,
      storagePath: row.storage_path,
      publicUrl: row.public_url,
      originalName: row.original_name,
      fileSize: Number(row.file_size ?? 0),
      uploadedAt: row.uploaded_at,
      versionName: row.version_name ?? undefined,
      versionCode: row.version_code != null ? Number(row.version_code) : undefined,
      branch: row.branch ?? null,
      commitSha: row.commit_sha ?? null,
      buildNumber: row.build_number ?? null,
      ciRunId: row.ci_run_id ?? null,
      source: row.source ?? 'manual',
      variantLabel: row.variant_label ?? DEFAULT_VARIANT_LABEL,
    };
  }
}
