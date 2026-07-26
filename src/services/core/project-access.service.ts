/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PROJECT ACCESS — "may this user act on this project?", in one place.
 *
 * The rule is owner OR any member of the project's workspace, and it is
 * FAIL-CLOSED: a missing project, a missing workspace role, or any error
 * denies. It was already implemented privately in five services
 * (regression-run, negative-generation, app-skeleton, git-integration,
 * visualization/overall-builder) — this is the shared version new callers use
 * instead of adding a sixth copy. Migrating the existing five is separate work.
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { WorkspaceAccessService } from './workspace-access.service';
import { fetchProjectAccessRow } from './db/project-access.db';
import { logger } from '@/utils/core/logger';

export async function hasProjectAccess(projectId: string, userId: string): Promise<boolean> {
  try {
    const project = await fetchProjectAccessRow(projectId);
    if (!project) return false;
    if (project.userId === userId) return true;
    if (project.workspaceId) {
      const role = await WorkspaceAccessService.getRole(userId, project.workspaceId);
      if (role != null) return true;
    }
    return false;
  } catch (err) {
    logger.warn('[PROJECT_ACCESS] check failed (deny)', {
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
