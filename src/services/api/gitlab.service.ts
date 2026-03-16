import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';

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
 * Refresh GitLab access token using refresh_token grant.
 */
async function refreshGitLabToken(
  refreshToken: string
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number; scope?: string }> {
  const clientId = env.GITLAB_CLIENT_ID;
  const clientSecret = env.GITLAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GITLAB_CLIENT_ID and GITLAB_CLIENT_SECRET must be configured');
  }

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const response = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!response.ok) {
    const errorText = await response.text();
    logger.error('[GITLAB_SERVICE] Token refresh failed', { status: response.status, error: errorText });
    throw new Error(`GitLab token refresh failed: ${response.status} ${errorText}`);
  }

  const tokenData = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
  };

  logger.info('[GITLAB_SERVICE] Token refreshed successfully');
  return tokenData;
}

/**
 * Ensure the GitLab token is valid, refreshing if expired or expiring within 5 minutes.
 * Returns a valid access_token.
 */
export async function ensureValidGitLabToken(tokenData: GitLabTokenData): Promise<string> {
  const now = new Date();
  const expiresAt = tokenData.expires_at ? new Date(tokenData.expires_at) : null;

  if (expiresAt && expiresAt.getTime() - now.getTime() < 5 * 60 * 1000) {
    if (!tokenData.refresh_token) {
      throw new Error('GitLab token expired and no refresh token available. Please reconnect GitLab.');
    }

    logger.info('[GITLAB_SERVICE] Refreshing expired token', { userId: tokenData.user_id });
    const newTokenData = await refreshGitLabToken(tokenData.refresh_token);

    const { IntegrationTokenService } = await import('./integration-token.service');
    await IntegrationTokenService.refreshToken(
      tokenData.id,
      newTokenData.access_token,
      newTokenData.refresh_token || tokenData.refresh_token,
      newTokenData.expires_in
    );

    return newTokenData.access_token;
  }

  return tokenData.access_token;
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
