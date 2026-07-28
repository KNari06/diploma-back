/**
 * CI app publish — orchestration for a pipeline publishing a build to QAIT.
 *
 * The editor's upload path (`mobile-app.service.ts`) does the heavy lifting:
 * extension + size validation, the version-identity waterfall, the build row,
 * the settings merge. This service is the CI-specific wrapper around it and
 * owns the four things that differ:
 *
 *   1. **Variant defaulting.** The lane defaults to the project's configured
 *      default variant, not the literal `'default'` lane. `/ci/run`'s upload
 *      branch hardcodes `'default'` while its RESOLVE branch honours
 *      `getProjectDefaultVariant` — so a project that promoted `Production`
 *      wrote every CI upload into `default` and resolved from `Production`,
 *      never seeing its own CI builds.
 *   2. **An up-front write-access check.** `ciUserId` is `projects.user_id` —
 *      an owner who may since have been demoted in the workspace.
 *      `ProjectService.updateProject` THROWS on a denied write, and it runs
 *      after the build row is inserted, so without this check a demoted owner
 *      gets a 500 and a half-applied publish.
 *   3. **Orphan cleanup.** `createSignedUploadUrl` mints a fresh timestamped
 *      path per call and `pruneOldBuilds` only collects storage for ROWS it
 *      prunes — so an object whose finalize failed is never garbage-collected.
 *      CI is what automates the retry that creates them.
 *   4. **`source: 'ci'`** on the recorded build.
 *
 * A CI publish otherwise behaves EXACTLY like today's editor upload: it records
 * a build row and updates the settings slot. Designating a build as the one
 * non-pinned runs resolve is a separate, deferred piece of work.
 */

import { PERMISSIONS, WorkspaceAccessService } from '@/services/core/workspace-access.service';
import * as MobileAppService from '@/services/mobile/mobile-app.service';
import type { MobileAppError } from '@/services/mobile/mobile-app.service';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';

/** Project row as `requireCiApiKey` attaches it (`select('*')`). */
export interface CiProject {
  id: string;
  user_id: string;
  workspace_id: string;
  settings: Record<string, unknown>;
}

/** CI-only error tags, on top of the ones `mobile-app.service.ts` returns. */
export type CiPublishError =
  | MobileAppError
  | { kind: 'write_denied' }
  | { kind: 'version_identity_required' };

export function isCiPublishError(v: unknown): v is CiPublishError {
  return typeof v === 'object' && v !== null && 'kind' in v;
}

/**
 * Resolve the lane a CI publish targets: an explicit label wins, else the
 * project's configured default variant. Used for the write AND the prune, so
 * they cannot disagree.
 */
async function resolveVariantLabel(
  projectId: string,
  platform: MobilePlatform,
  requested: string | undefined,
): Promise<string> {
  if (requested && requested.trim()) return requested.trim();
  return MobileAppStorageService.getProjectDefaultVariant(projectId, platform);
}

/**
 * The owner recorded on the project may no longer hold PROJECT_WRITE in the
 * workspace. Check before doing any work — `updateProject` would otherwise
 * throw after the build row is already inserted.
 */
async function canWrite(project: CiProject): Promise<boolean> {
  return WorkspaceAccessService.hasPermission(
    project.user_id,
    project.workspace_id,
    PERMISSIONS.PROJECT_WRITE,
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// UPLOAD URL
// ═══════════════════════════════════════════════════════════════════════════

export interface CiUploadUrlInput {
  project: CiProject;
  filename: string;
  platform: MobilePlatform;
  declaredSize: number | null;
  variantLabel?: string;
}

export interface CiUploadUrlOutput {
  uploadUrl: string;
  storagePath: string;
  requiredHeaders: Record<string, string>;
  variant: string;
}

export async function createCiUploadUrl(
  input: CiUploadUrlInput,
): Promise<CiUploadUrlOutput | CiPublishError> {
  const { project, filename, platform, declaredSize } = input;

  if (!(await canWrite(project))) {
    logger.warn('[CI_PUBLISH] upload-url denied — owner lacks PROJECT_WRITE', {
      projectId: project.id,
      userId: project.user_id,
    });
    return { kind: 'write_denied' };
  }

  const variantLabel = await resolveVariantLabel(project.id, platform, input.variantLabel);

  const result = await MobileAppService.createMobileAppUploadUrl({
    projectId: project.id,
    userId: project.user_id,
    filename,
    platform,
    declaredSize,
    variantLabel,
  });
  if ('kind' in result) return result;

  logger.info('[CI_PUBLISH] Issued CI upload URL', {
    projectId: project.id,
    platform,
    variant: variantLabel,
    storagePath: result.storagePath,
  });

  // `token` is deliberately NOT returned: it is Supabase-specific and a CI job
  // PUTs to `uploadUrl` with `requiredHeaders`, nothing else.
  return {
    uploadUrl: result.uploadUrl,
    storagePath: result.storagePath,
    requiredHeaders: result.requiredHeaders,
    variant: variantLabel,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// FINALIZE
// ═══════════════════════════════════════════════════════════════════════════

export interface CiFinalizeInput {
  project: CiProject;
  storagePath: string;
  platform: MobilePlatform;
  originalName: string;
  packageName?: string;
  versionName?: string;
  versionCode?: number;
  branch?: string;
  commitSha?: string;
  buildNumber?: string;
  ciRunId?: string;
  variantLabel?: string;
}

export interface CiFinalizeOutput {
  build: MobileAppService.FinalizeUploadOutput['build'];
  mobileApp: MobileAppService.FinalizeUploadOutput['mobileApp'];
  variant: string;
  platform: MobilePlatform;
}

/**
 * Delete an orphaned upload — an object whose finalize did not produce a row.
 *
 * Gated on the path being inside THIS project's tree. That guard is not
 * belt-and-braces: without it, `invalid_storage_path` (which fires precisely
 * when the caller supplied someone else's path) would turn finalize into a
 * cross-tenant delete primitive. So an out-of-tree path is rejected and its
 * object is left strictly alone.
 */
async function cleanupOrphan(project: CiProject, storagePath: string): Promise<void> {
  const expectedPrefix = `mobile-apps/${project.workspace_id}/${project.id}/`;
  if (!storagePath.startsWith(expectedPrefix)) return;

  try {
    await MobileAppStorageService.deleteApp(storagePath);
    logger.info('[CI_PUBLISH] Deleted orphaned upload after failed finalize', {
      projectId: project.id,
      storagePath,
    });
  } catch (err) {
    logger.warn('[CI_PUBLISH] Orphan cleanup failed (non-fatal)', {
      projectId: project.id,
      storagePath,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Failure tags where the object either isn't ours or isn't there — never delete. */
const NO_CLEANUP_KINDS = new Set([
  'invalid_storage_path',
  'object_missing',
  'project_not_found',
]);

export async function finalizeCiUpload(
  input: CiFinalizeInput,
): Promise<CiFinalizeOutput | CiPublishError> {
  const { project, storagePath, platform, originalName } = input;

  if (!(await canWrite(project))) {
    logger.warn('[CI_PUBLISH] finalize denied — owner lacks PROJECT_WRITE', {
      projectId: project.id,
      userId: project.user_id,
    });
    // The binary is already uploaded — access was revoked between upload-url
    // and finalize. Nothing will ever record it, so clean it up rather than
    // leave a 500 MB object nobody can reach.
    await cleanupOrphan(project, storagePath);
    return { kind: 'write_denied' };
  }

  const variantLabel = await resolveVariantLabel(project.id, platform, input.variantLabel);

  const result = await MobileAppService.finalizeMobileAppUpload({
    projectId: project.id,
    userId: project.user_id,
    storagePath,
    platform,
    originalName,
    clientPackageName: input.packageName,
    clientVersionName: input.versionName,
    clientVersionCode: input.versionCode,
    branch: input.branch,
    commitSha: input.commitSha,
    buildNumber: input.buildNumber,
    ciRunId: input.ciRunId,
    variantLabel,
    source: 'ci',
    // CI-only: reject a build QAIT cannot automate at UPLOAD time, so the
    // pipeline learns in its own log rather than every later test run failing
    // for a reason nobody connects back to how the APK was built.
    enforceBuildContract: true,
  });

  if ('kind' in result) {
    if (!NO_CLEANUP_KINDS.has(result.kind)) {
      await cleanupOrphan(project, storagePath);
    }
    return result;
  }

  logger.info('[CI_PUBLISH] CI build published', {
    projectId: project.id,
    platform: result.platform,
    variant: result.variantLabel,
    buildId: result.build.id,
    commitSha: input.commitSha ?? null,
    storagePath: result.mobileApp.storagePath,
  });

  return {
    build: result.build,
    mobileApp: result.mobileApp,
    variant: result.variantLabel,
    platform: result.platform,
  };
}
