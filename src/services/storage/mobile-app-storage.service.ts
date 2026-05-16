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
}

/**
 * Git / build metadata supplied at upload time (Phase 5).
 * All fields optional — when none are provided the upload stays in the
 * legacy `projects.settings.mobileApp` slot only. When any are provided
 * we also insert a row into `mobile_app_builds` for versioned lookup.
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
 * Context passed to `resolveAppForRun`. Any subset may be absent; the
 * resolver walks precedence: commitSha > branch > legacy fallback.
 */
export interface MobileAppResolveContext {
  projectId: string;
  platform: MobilePlatform;
  /** Exact commit to match. Wins over branch if both provided. */
  commitSha?: string;
  /** Branch to match latest-on-branch. */
  branch?: string;
}

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

    const metadata: MobileAppMetadata = {
      platform,
      packageName,
      storagePath,
      publicUrl: urlData.publicUrl,
      originalName: file.originalname,
      fileSize: file.size,
      uploadedAt: new Date().toISOString(),
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
   * Called right after `uploadApp` when the caller also supplied any git
   * metadata (branch / commitSha / buildNumber / ciRunId). Callers that
   * don't provide git metadata skip this step entirely — the legacy
   * `projects.settings.mobileApp` slot keeps them working as today.
   *
   * Returns the created row. Errors are logged and the row insert is
   * treated as best-effort: a failure here MUST NOT fail the upload
   * itself (the APK is already in storage and the legacy slot is set).
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
        // Duplicate commit_sha is a legitimate case (re-upload of the
        // exact same commit) — don't spam error logs for it.
        const isDup = error?.code === '23505'; // unique_violation
        logger[isDup ? 'info' : 'warn']('[MOBILE_APP_STORAGE] recordBuild non-fatal', {
          projectId: ctx.projectId,
          platform: metadata.platform,
          branch: buildMeta.branch,
          commitSha: buildMeta.commitSha,
          error: error?.message,
        });
        return null;
      }

      logger.info('[MOBILE_APP_STORAGE] Recorded build', {
        buildId: data.id,
        projectId: ctx.projectId,
        platform: metadata.platform,
        branch: buildMeta.branch,
        commitSha: buildMeta.commitSha,
        source: buildMeta.source,
      });

      return this.mapBuildRow(data);
    } catch (err) {
      logger.warn('[MOBILE_APP_STORAGE] recordBuild threw', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Resolve which APK/IPA to install for a run.
   *
   * Precedence (first match wins):
   *   1. Exact commit (`commit_sha = ctx.commitSha`) — CI pinned run.
   *   2. Latest build on the requested branch (`branch = ctx.branch`) —
   *      git-trigger default ("PR on feat-x → install feat-x APK").
   *   3. Legacy `projects.settings.mobileApp` — preserves pre-Phase-5
   *      behaviour for projects that never started versioning.
   *
   * Returns null ONLY when no build exists anywhere for the project —
   * in which case `dispatchMobileTest` will run without installing
   * anything (same as today when mobileApp is empty).
   */
  static async resolveAppForRun(
    ctx: MobileAppResolveContext,
  ): Promise<MobileAppBuildRecord | null> {
    // 1. Commit pin — unique index guarantees at most one row.
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

    // 2. Latest on branch.
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

    // 3. Legacy fallback — `projects.settings.mobileApp`. Read and adapt
    // the shape so the caller sees a uniform `MobileAppBuildRecord`.
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
      branch: row.branch ?? null,
      commitSha: row.commit_sha ?? null,
      buildNumber: row.build_number ?? null,
      ciRunId: row.ci_run_id ?? null,
      source: row.source ?? 'manual',
    };
  }
}
