import { logger } from '@/utils/core/logger';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * GITLAB API SERVICE
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * GitLab REST API client using integration_tokens table.
 * Provides: list projects (repos), list branches for repo selection UI.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const GITLAB_API_URL = 'https://gitlab.com/api/v4';

export interface GitLabTokenData {
  id: string;
  user_id: string;
  workspace_id?: string;
  access_token: string;
  refresh_token?: string;
  expires_at?: string;
  scope?: string;
  external_id?: string;
  external_url?: string;
  metadata?: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** GitLab project (for repo dropdown). Aligned with GitHub repo shape where useful. */
export interface GitLabProject {
  id: number;
  name: string;
  path_with_namespace: string;
  description: string | null;
  web_url: string;
  default_branch: string;
  visibility: string;
}

/** GitLab branch (for branch dropdown). */
export interface GitLabBranch {
  name: string;
  merged: boolean;
  protected: boolean;
  default: boolean;
  commit?: { id: string; short_id: string };
}

/**
 * Get GitLab token for user from integration_tokens.
 */
export async function getGitLabToken(
  userId: string,
  workspaceId?: string
): Promise<GitLabTokenData | null> {
  try {
    const { IntegrationTokenService } = await import('./integration-token.service');
    const token = await IntegrationTokenService.getToken(userId, 'gitlab', undefined, workspaceId);

    if (!token) {
      logger.debug('[GITLAB_SERVICE] No token found', { userId });
      return null;
    }

    logger.debug('[GITLAB_SERVICE] Token retrieved', { userId });
    return token as GitLabTokenData;
  } catch (error) {
    logger.error('[GITLAB_SERVICE] Get token error', {
      error: error instanceof Error ? error.message : String(error),
      userId,
    });
    throw error;
  }
}

/**
 * List projects the user has access to (for repo dropdown).
 * GET /projects?membership=true
 */
export async function listUserProjects(
  accessToken: string,
  perPage: number = 30
): Promise<GitLabProject[]> {
  try {
    logger.info('[GITLAB_SERVICE] Listing user projects');

    const params = new URLSearchParams({
      membership: 'true',
      per_page: String(Math.min(perPage, 100)),
      order_by: 'last_activity_at',
    });

    const response = await fetch(`${GITLAB_API_URL}/projects?${params.toString()}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      logger.error('[GITLAB_SERVICE] Failed to list projects', { status: response.status, error: errorText });
      throw new Error(`GitLab API error: ${response.status} ${errorText}`);
    }

    const projects = (await response.json()) as GitLabProject[];
    logger.info('[GITLAB_SERVICE] Projects listed', { count: projects.length });
    return projects;
  } catch (error) {
    logger.error('[GITLAB_SERVICE] List projects error', {
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

/**
 * List branches for a project.
 * GET /projects/:id/repository/branches
 * @param projectId - GitLab project ID (number) or URL-encoded path (e.g. "owner%2Frepo")
 */
export async function listBranches(
  accessToken: string,
  projectId: string
): Promise<GitLabBranch[]> {
  const idEnc = encodeURIComponent(projectId);
  const url = `${GITLAB_API_URL}/projects/${idEnc}/repository/branches?per_page=100`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('[GITLAB_SERVICE] Failed to list branches', {
      projectId,
      status: response.status,
      error: errorText,
    });
    throw new Error(`GitLab API error: ${response.status} ${errorText}`);
  }

  const branches = (await response.json()) as GitLabBranch[];
  logger.info('[GITLAB_SERVICE] Branches listed', { projectId, count: branches.length });
  return branches;
}
