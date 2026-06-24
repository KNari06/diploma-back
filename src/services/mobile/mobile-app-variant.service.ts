/**
 * Mobile App Variant service — manage the named APK variant lanes
 * (Production / Staging / Dev …) of a project+platform.
 *
 * A variant is a named lane of build history on `mobile_app_builds`
 * (`variant_label`); the default lane (`'default'`) mirrors the legacy
 * `projects.settings.mobileApp` slot and is NOT user-managed here. These
 * operations cover the lifecycle the upload path doesn't: delete a lane and
 * its builds, rename a lane.
 *
 * Like `mobile-app.service.ts`, functions return a typed success payload or a
 * tagged `MobileAppError` the HTTP layer maps to a status code.
 */

import { ProjectService } from '@/services/core/project.service';
import {
  DEFAULT_VARIANT_LABEL,
  buildRemoveMobileVariantPatch,
  buildRenameMobileVariantPatch,
  buildSetDefaultVariantPatch,
} from '@/services/mobile/project-mobile-app.helper';
import { MobileAppStorageService } from '@/services/storage/mobile-app-storage.service';
import { normaliseVariantLabel, type MobileAppError } from '@/services/mobile/mobile-app.service';
import type { MobilePlatform } from '@/services/mobile/mobile-runner.types';
import { logger } from '@/utils/core/logger';

/**
 * Delete a named variant: removes its builds (storage + rows) and its registry
 * entry. The default lane can't be deleted here — it's tied to the legacy slot
 * (use the existing DELETE /app path to clear the default platform slot).
 */
export async function deleteMobileAppVariant(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
  rawLabel: string,
): Promise<{ deletedBuilds: number } | MobileAppError> {
  const label = normaliseVariantLabel(rawLabel);
  if (label === DEFAULT_VARIANT_LABEL) return { kind: 'cannot_modify_default_variant' };

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  const labels = await MobileAppStorageService.listVariantLabels(projectId, platform);
  if (!labels.includes(label)) return { kind: 'variant_not_found', label };

  const deletedBuilds = await MobileAppStorageService.deleteVariantBuilds(projectId, platform, label);

  const patch = buildRemoveMobileVariantPatch(
    project.settings as Record<string, unknown> | undefined,
    platform,
    label,
  );
  await ProjectService.updateProject(projectId, userId, { settings: patch });

  logger.info('[MOBILE_APP_VARIANT] Deleted variant', { projectId, platform, label, deletedBuilds });
  return { deletedBuilds };
}

/**
 * Rename a named variant lane. Named → named only (the default lane is fixed),
 * and the target name must be free (renaming onto an existing lane would merge
 * two histories — refused).
 */
export async function renameMobileAppVariant(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
  rawFrom: string,
  rawTo: string,
): Promise<{ renamedBuilds: number; label: string } | MobileAppError> {
  // Check the raw target name first — normalising a blank string would turn it
  // into the default label and mask the "name required" error.
  if (typeof rawTo !== 'string' || rawTo.trim().length === 0) return { kind: 'invalid_variant_name' };
  const from = normaliseVariantLabel(rawFrom);
  const to = normaliseVariantLabel(rawTo);
  if (from === DEFAULT_VARIANT_LABEL || to === DEFAULT_VARIANT_LABEL) {
    return { kind: 'cannot_modify_default_variant' };
  }
  if (from === to) return { renamedBuilds: 0, label: to };

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  const labels = await MobileAppStorageService.listVariantLabels(projectId, platform);
  if (!labels.includes(from)) return { kind: 'variant_not_found', label: from };
  if (labels.includes(to)) return { kind: 'variant_name_taken', label: to };

  const renamedBuilds = await MobileAppStorageService.renameVariantBuilds(projectId, platform, from, to);

  const patch = buildRenameMobileVariantPatch(
    project.settings as Record<string, unknown> | undefined,
    platform,
    from,
    to,
  );
  await ProjectService.updateProject(projectId, userId, { settings: patch });

  logger.info('[MOBILE_APP_VARIANT] Renamed variant', { projectId, platform, from, to, renamedBuilds });
  return { renamedBuilds, label: to };
}

/**
 * Set which variant is the default for a platform — the one a run uses when
 * no test case / plan specifies a variant. Pass 'default' (or blank) to revert
 * to the literal default lane. The target must have at least one build.
 */
export async function setDefaultMobileVariant(
  projectId: string,
  userId: string,
  platform: MobilePlatform,
  rawLabel: string,
): Promise<{ defaultVariant: string } | MobileAppError> {
  const label = normaliseVariantLabel(rawLabel);

  const project = await ProjectService.getProject(projectId, userId);
  if (!project) return { kind: 'project_not_found' };

  if (label !== DEFAULT_VARIANT_LABEL) {
    const labels = await MobileAppStorageService.listVariantLabels(projectId, platform);
    if (!labels.includes(label)) return { kind: 'variant_not_found', label };
  }

  const patch = buildSetDefaultVariantPatch(
    project.settings as Record<string, unknown> | undefined,
    platform,
    label,
  );
  await ProjectService.updateProject(projectId, userId, { settings: patch });

  logger.info('[MOBILE_APP_VARIANT] Set default variant', { projectId, platform, label });
  return { defaultVariant: label };
}
