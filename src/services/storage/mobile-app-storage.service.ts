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
import { env } from '@/config/environment/env';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { detectFrameworkFromBuffer } from '@/services/mobile/archive-platform-detect';
import { logger } from '@/utils/core/logger';
import path from 'path';

// ── Constants ──────────────────────────────────────────────────────

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB
const ALLOWED_EXTENSIONS = ['.apk', '.ipa', '.aab'];
const BUCKET = env.SUPABASE_BUCKET_NAME; // 'qai-assets'

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
}

/**
 * Context passed to `resolveAppForRun`. The resolver walks precedence:
 *   buildId > commitSha > branch > latest-on-project > legacy.
 *
 * `buildId` is the explicit user pin from plan/run settings ("run this
 * regression against build X regardless of git"). The fallback to
 * latest-on-project means a manually-uploaded APK without any git
 * metadata is still picked up automatically.
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
    },
  ): Promise<MobileAppMetadata> {
    const { workspaceId, projectId, platform, packageName } = params;

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
    const storagePath = `mobile-apps/${workspaceId}/${projectId}/${platform}/${fileName}`;

    logger.info('[MOBILE_APP_STORAGE] Uploading app', {
      projectId,
      platform,
      originalName: file.originalname,
      size: file.size,
      storagePath,
    });

    // Upload to Supabase Storage
    const contentType = ext === '.apk' ? 'application/vnd.android.package-archive'
      : ext === '.ipa' ? 'application/octet-stream'
        : 'application/octet-stream';

    const { error } = await supabaseAdmin.storage
      .from(BUCKET)
      .upload(storagePath, file.buffer, {
        contentType,
        upsert: false,
        cacheControl: '31536000', // 1 year (immutable, new file per upload)
      });

    if (error) {
      logger.error('[MOBILE_APP_STORAGE] Upload failed', {
        error,
        projectId,
        storagePath,
      });
      throw new Error(`Failed to upload app: ${error.message}`);
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(storagePath);

    // Run framework detection on the in-memory buffer BEFORE building the
    // metadata. We do it here (inside uploadApp) so the CI upload-from-URL
    // path gets the same `detectedFramework` stamp that the signed-URL +
    // finalize flow already produces — without forcing every caller to
    // wire detection by hand. Detection is hard-contract non-throwing, so
    // any failure just leaves `detectedFramework` undefined.
    const detectedFramework = file.buffer
      ? await detectFrameworkFromBuffer(file.buffer, file.originalname)
      : undefined;

    const metadata: MobileAppMetadata = {
      platform,
      packageName,
      storagePath,
      publicUrl: urlData.publicUrl,
      originalName: file.originalname,
      fileSize: file.size,
      uploadedAt: new Date().toISOString(),
      ...(detectedFramework ? { detectedFramework } : {}),
    };

    logger.info('[MOBILE_APP_STORAGE] Upload successful', {
      projectId,
      platform,
      storagePath,
      publicUrl: urlData.publicUrl,
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
  }): { storagePath: string; ext: string } {
    const ext = path.extname(params.originalName).toLowerCase();
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      throw new Error(
        `Invalid file type: ${ext}. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}`,
      );
    }
    const safeName = path.basename(params.originalName, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${safeName}_${Date.now()}${ext}`;
    const storagePath = `mobile-apps/${params.workspaceId}/${params.projectId}/${params.platform}/${fileName}`;
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
  }): Promise<{ uploadUrl: string; token: string; storagePath: string }> {
    const { storagePath } = this.buildStoragePath(params);

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);

    if (error || !data?.signedUrl || !data?.token) {
      logger.error('[MOBILE_APP_STORAGE] createSignedUploadUrl failed', {
        error: error?.message,
        storagePath,
      });
      throw new Error(`Failed to create signed upload URL: ${error?.message || 'Unknown error'}`);
    }

    logger.info('[MOBILE_APP_STORAGE] Issued signed upload URL', {
      projectId: params.projectId,
      platform: params.platform,
      storagePath,
    });

    return {
      uploadUrl: data.signedUrl,
      token: data.token,
      storagePath,
    };
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
    // Supabase JS SDK doesn't expose HEAD directly; list the parent prefix
    // filtered by the basename. Cheap (one row) and avoids downloading.
    const parent = storagePath.includes('/') ? storagePath.slice(0, storagePath.lastIndexOf('/')) : '';
    const name = storagePath.includes('/') ? storagePath.slice(storagePath.lastIndexOf('/') + 1) : storagePath;

    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .list(parent, { search: name, limit: 1 });

    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] statObject list failed', {
        error: error.message,
        storagePath,
      });
      return null;
    }
    const row = (data || []).find((r) => r.name === name);
    if (!row) return null;

    const sizeBytes = Number((row.metadata as any)?.size ?? 0);
    const contentType = ((row.metadata as any)?.mimetype as string | undefined) ?? null;
    return { sizeBytes, contentType };
  }

  /**
   * Build a MobileAppMetadata for an APK/IPA that was uploaded directly by
   * the client via a signed URL — i.e. the backend never saw the buffer.
   * Mirrors what `uploadApp` returns so downstream consumers stay identical.
   */
  static finaliseDirectUpload(params: {
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
  }): MobileAppMetadata {
    const { data: urlData } = supabaseAdmin.storage
      .from(BUCKET)
      .getPublicUrl(params.storagePath);

    return {
      platform: params.platform,
      packageName: params.packageName,
      storagePath: params.storagePath,
      publicUrl: urlData.publicUrl,
      originalName: params.originalName,
      fileSize: params.fileSize,
      uploadedAt: new Date().toISOString(),
      ...(params.versionName ? { versionName: params.versionName } : {}),
      ...(typeof params.versionCode === 'number' ? { versionCode: params.versionCode } : {}),
      ...(params.detectedFramework ? { detectedFramework: params.detectedFramework } : {}),
    };
  }

  /**
   * Delete a previously uploaded app from Supabase Storage.
   * Best-effort — logs errors but doesn't throw.
   */
  static async deleteApp(storagePath: string): Promise<void> {
    if (!storagePath) return;

    try {
      const { error } = await supabaseAdmin.storage
        .from(BUCKET)
        .remove([storagePath]);

      if (error) {
        logger.warn('[MOBILE_APP_STORAGE] Delete failed', { error, storagePath });
      } else {
        logger.info('[MOBILE_APP_STORAGE] Deleted app', { storagePath });
      }
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
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .createSignedUrl(storagePath, expiresInSeconds);

    if (error || !data?.signedUrl) {
      throw new Error(`Failed to create signed URL: ${error?.message || 'Unknown error'}`);
    }

    return data.signedUrl;
  }

  /**
   * Download app file as Buffer (for proxying to runner).
   */
  static async downloadApp(storagePath: string): Promise<Buffer> {
    const { data, error } = await supabaseAdmin.storage
      .from(BUCKET)
      .download(storagePath);

    if (error || !data) {
      throw new Error(`Failed to download app: ${error?.message || 'Unknown error'}`);
    }

    const arrayBuffer = await data.arrayBuffer();
    return Buffer.from(arrayBuffer);
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
    ctx: { projectId: string; workspaceId?: string; uploadedBy?: string },
  ): Promise<MobileAppBuildRecord | null> {
    try {
      const { data, error } = await supabaseAdmin
        .from('mobile_app_builds')
        .insert({
          project_id: ctx.projectId,
          workspace_id: ctx.workspaceId ?? null,
          uploaded_by: ctx.uploadedBy ?? null,
          platform: metadata.platform,
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
          commitSha: buildMeta.commitSha,
          versionName: metadata.versionName,
          versionCode: metadata.versionCode,
          isDuplicate: isDup,
          error: error?.message,
        });
        return null;
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
      logger.error('[MOBILE_APP_STORAGE] recordBuild threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
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
   * Delete builds beyond `BUILD_HISTORY_LIMIT` for a (project, platform).
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
  ): Promise<void> {
    try {
      const { data, error } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('id, storage_path, uploaded_at')
        .eq('project_id', projectId)
        .eq('platform', platform)
        .order('uploaded_at', { ascending: false });
      if (error || !data) {
        logger.warn('[MOBILE_APP_STORAGE] pruneOldBuilds list failed', {
          error: error?.message,
          projectId,
          platform,
        });
        return;
      }
      if (data.length <= BUILD_HISTORY_LIMIT) return;

      const toDelete = data.slice(BUILD_HISTORY_LIMIT);
      const storagePaths = toDelete.map((r) => r.storage_path).filter(Boolean);
      const ids = toDelete.map((r) => r.id);

      if (storagePaths.length > 0) {
        const { error: storageErr } = await supabaseAdmin.storage
          .from(BUCKET)
          .remove(storagePaths);
        if (storageErr) {
          logger.warn('[MOBILE_APP_STORAGE] pruneOldBuilds storage remove partial', {
            error: storageErr.message,
            count: storagePaths.length,
          });
          // Continue — DB rows still get pruned. Orphan storage objects
          // are recoverable later; orphan DB rows pointing at deleted
          // files are not.
        }
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

    // 2. Commit pin — unique index guarantees at most one row.
    if (ctx.commitSha) {
      const { data } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', ctx.platform)
        .eq('commit_sha', ctx.commitSha)
        .maybeSingle();
      if (data) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched commit', {
          projectId: ctx.projectId,
          commitSha: ctx.commitSha,
        });
        return this.mapBuildRow(data);
      }
    }

    // 3. Latest on branch.
    if (ctx.branch) {
      const { data } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', ctx.platform)
        .eq('branch', ctx.branch)
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched branch', {
          projectId: ctx.projectId,
          branch: ctx.branch,
        });
        return this.mapBuildRow(data);
      }
    }

    // 4. Latest build for the project + platform. Now that every upload
    // (manual + CI) creates a `mobile_app_builds` row, this stage covers
    // the "user uploaded an APK from the UI without any git context"
    // case that previously fell through to the legacy slot.
    {
      const { data } = await supabaseAdmin
        .from('mobile_app_builds')
        .select('*')
        .eq('project_id', ctx.projectId)
        .eq('platform', ctx.platform)
        .order('uploaded_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        logger.debug('[MOBILE_APP_STORAGE] resolver matched latest-on-project', {
          projectId: ctx.projectId,
          platform: ctx.platform,
          buildId: data.id,
        });
        return this.mapBuildRow(data);
      }
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
      } as unknown as MobileAppBuildRecord;
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
  ): Promise<MobileAppBuildRecord[]> {
    const { data, error } = await supabaseAdmin
      .from('mobile_app_builds')
      .select('*')
      .eq('project_id', projectId)
      .eq('platform', platform)
      .order('uploaded_at', { ascending: false })
      .limit(Math.min(Math.max(limit, 1), 200));
    if (error) {
      logger.warn('[MOBILE_APP_STORAGE] listBuilds failed', { error });
      return [];
    }
    return (data || []).map((row) => this.mapBuildRow(row));
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
    };
  }
}
