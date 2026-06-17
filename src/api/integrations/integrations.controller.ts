import { Request, Response } from 'express';
import { IntegrationTokenService, type IntegrationProvider } from '@/services/api/integration-token.service';
import { getGitHubToken, listUserRepos, listBranches } from '@/services/api/github.service';
import { getGitLabToken, ensureValidGitLabToken, listUserProjects, listBranches as listGitLabBranchesApi } from '@/services/api/gitlab.service';
import { createJiraOAuthUrl } from '@/api/jira/jira.controller';
import { logger } from '@/utils/core/logger';
import { env } from '@/config/environment/env';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * INTEGRATIONS CONTROLLER (OAuth Flows)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Unified OAuth flows for all integration providers.
 * Routes:
 * - GET /api/v1/integrations - List connected integrations
 * - GET /api/v1/integrations/:provider/authorize - Start OAuth flow
 * - GET /api/v1/integrations/:provider/callback - OAuth callback
 * - DELETE /api/v1/integrations/:provider - Disconnect integration
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ALL_PROVIDERS: IntegrationProvider[] = [
  'jira',
  'github',
  'gitlab',
  'notion',
  'trello',
  'slack',
  'telegram',
];

/** Frontend base URL without trailing slash (avoids double slash in redirects like //integrations). */
function getFrontendBaseUrl(): string {
  const url = env.FRONTEND_URL || 'http://localhost:3000';
  return url.replace(/\/+$/, '');
}

/** Backend base URL without path (avoids /api/api/v1 in OAuth callback URLs when BACKEND_URL already contains /api). */
function getBackendBaseUrl(): string {
  const url = env.BACKEND_URL || `http://localhost:${env.PORT}`;
  return url.replace(/\/api\/?$/, '').replace(/\/+$/, '');
}

/**
 * Get connection status for all providers
 * GET /api/v1/integrations/status?workspace_id=xxx
 */
export async function getIntegrationStatus(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const workspaceId = req.query.workspace_id as string | undefined;

    logger.info('[INTEGRATIONS] Getting integration status', { userId, workspaceId });

    const connected = await IntegrationTokenService.listConnectedIntegrations(userId, workspaceId);

    // Index by provider for O(1) lookup
    const connectedMap = new Map<string, typeof connected[0]>();
    for (const token of connected) {
      // Keep the most recently created token per provider
      if (!connectedMap.has(token.provider)) {
        connectedMap.set(token.provider, token);
      }
    }

    const status = Object.fromEntries(
      ALL_PROVIDERS.map((provider) => {
        const token = connectedMap.get(provider);
        if (!token) {
          return [provider, { connected: false }];
        }
        return [
          provider,
          {
            connected: true,
            id: token.id,
            external_id: token.external_id ?? null,
            external_url: token.external_url ?? null,
            metadata: token.metadata ?? null,
            connected_at: token.created_at,
            updated_at: token.updated_at,
          },
        ];
      })
    );

    res.json({
      success: true,
      status,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] Get status error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to get integration status',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * List all connected integrations for user
 */
export async function listIntegrations(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const workspaceId = req.query.workspace_id as string | undefined;

    logger.info('[INTEGRATIONS] Listing integrations', { userId, workspaceId });

    const integrations = await IntegrationTokenService.listConnectedIntegrations(
      userId,
      workspaceId
    );

    // Remove sensitive fields before sending to client
    const sanitized = integrations.map((integration) => ({
      id: integration.id,
      provider: integration.provider,
      external_id: integration.external_id,
      external_url: integration.external_url,
      enabled: integration.enabled,
      created_at: integration.created_at,
      updated_at: integration.updated_at,
      // Don't send access_token, refresh_token
    }));

    res.json({
      success: true,
      integrations: sanitized,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] List integrations error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to list integrations',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Start OAuth authorization flow
 */
export async function startAuthorization(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const provider = req.params.provider as IntegrationProvider;
    const workspaceId = req.query.workspace_id as string | undefined;

    logger.info('[INTEGRATIONS] Starting authorization', { userId, provider, workspaceId });

    // Validate provider
    const validProviders: IntegrationProvider[] = ['jira', 'github', 'gitlab', 'notion', 'trello', 'slack', 'telegram'];
    if (!validProviders.includes(provider)) {
      res.status(400).json({
        success: false,
        error: 'Invalid provider',
        message: `Provider must be one of: ${validProviders.join(', ')}`,
      });
      return;
    }

    // Prefer JSON with redirect_url when client uses fetch (avoids CORS: client does window.location.href = data.redirect_url)
    const wantsJson =
      req.query.return_url === '1' || req.query.return_url === 'true' || req.get('Accept')?.includes('application/json');

    // Generate OAuth URL based on provider
    let authUrl: string;

    switch (provider) {
      case 'github': {
        const clientId = env.GITHUB_CLIENT_ID;
        if (!clientId?.trim()) {
          res.status(503).json({
            success: false,
            error: 'GitHub integration not configured',
            message: 'GITHUB_CLIENT_ID is not set on the server. Ask the administrator to configure GitHub OAuth.',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        authUrl = buildGitHubAuthUrl(userId, workspaceId);
        break;
      }

      case 'notion':
        authUrl = buildNotionAuthUrl(userId, workspaceId);
        break;

      case 'gitlab': {
        const gitlabClientId = env.GITLAB_CLIENT_ID;
        if (!gitlabClientId?.trim()) {
          res.status(503).json({
            success: false,
            error: 'GitLab integration not configured',
            message: 'GITLAB_CLIENT_ID is not set on the server. Ask the administrator to configure GitLab OAuth.',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        authUrl = buildGitLabAuthUrl(userId, workspaceId);
        break;
      }

      case 'jira': {
        if (!env.JIRA_CLIENT_ID?.trim()) {
          res.status(503).json({
            success: false,
            error: 'Jira integration not configured',
            message: 'JIRA_CLIENT_ID is not set on the server. Ask the administrator to configure Jira OAuth.',
            timestamp: new Date().toISOString(),
          });
          return;
        }
        // Build real Atlassian OAuth URL (state stored in jira.controller); redirect to it so SPA does not hit auth-protected /jira/authorize.
        authUrl = createJiraOAuthUrl(userId);
        break;
      }

      default:
        res.status(501).json({
          success: false,
          error: 'Not implemented',
          message: `OAuth flow for ${provider} is not yet implemented`,
        });
        return;
    }

    if (wantsJson) {
      res.json({
        success: true,
        redirect_url: authUrl,
        message: 'Redirect user to redirect_url to complete OAuth.',
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Redirect to OAuth authorization URL (normal browser navigation)
    res.redirect(authUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('[INTEGRATIONS] Start authorization error', { error: message });

    const isConfigError = /not configured|not set/i.test(message);
    res.status(isConfigError ? 503 : 500).json({
      success: false,
      error: isConfigError ? 'Integration not configured' : 'Internal server error',
      message: isConfigError ? message : `Failed to start authorization: ${message}`,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * OAuth callback handler
 */
export async function handleCallback(req: Request, res: Response): Promise<void> {
  try {
    const provider = req.params.provider as IntegrationProvider;
    const code = req.query.code as string;
    const state = req.query.state as string;

    if (!code) {
      res.status(400).json({
        success: false,
        error: 'Missing code',
        message: 'Authorization code not provided',
      });
      return;
    }

    if (!state) {
      res.status(400).json({
        success: false,
        error: 'Missing state',
        message: 'OAuth state parameter not provided',
      });
      return;
    }

    logger.info('[INTEGRATIONS] Handling OAuth callback', { provider });

    // Decode state to get userId and workspaceId
    let userId: string;
    let workspaceId: string | undefined;
    try {
      const decoded = decodeState(state);
      userId = decoded.userId;
      workspaceId = decoded.workspaceId;
    } catch (decodeError) {
      logger.error('[INTEGRATIONS] Failed to decode OAuth state', {
        error: decodeError instanceof Error ? decodeError.message : String(decodeError),
      });
      res.redirect(`${getFrontendBaseUrl()}/integrations?status=error&message=${encodeURIComponent('Invalid OAuth state')}`);
      return;
    }

    if (!userId) {
      logger.error('[INTEGRATIONS] Missing userId in decoded OAuth state');
      res.redirect(`${getFrontendBaseUrl()}/integrations?status=error&message=${encodeURIComponent('Invalid OAuth state')}`);
      return;
    }

    // Exchange code for token based on provider
    switch (provider) {
      case 'github':
        await handleGitHubCallback(userId, workspaceId, code);
        break;

      case 'notion':
        await handleNotionCallback(userId, workspaceId, code);
        break;

      case 'gitlab':
        await handleGitLabCallback(userId, workspaceId, code);
        break;

      case 'jira':
        // Jira callback is already handled in jira.controller.ts
        res.redirect(`/api/${env.API_VERSION}/jira/callback?code=${code}&state=${state}`);
        return;

      default:
        res.status(501).json({
          success: false,
          error: 'Not implemented',
          message: `OAuth callback for ${provider} is not yet implemented`,
        });
        return;
    }

    // Redirect to frontend success page
    res.redirect(`${getFrontendBaseUrl()}/integrations?provider=${provider}&status=success`);
  } catch (error) {
    logger.error('[INTEGRATIONS] OAuth callback error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.redirect(`${getFrontendBaseUrl()}/integrations?status=error&message=${encodeURIComponent('Failed to connect integration')}`);
  }
}

/**
 * Disconnect integration
 */
export async function disconnectIntegration(req: Request, res: Response): Promise<void> {
  try {
    const userId = (req as any).user?.id;
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const provider = req.params.provider as IntegrationProvider;
    const externalId = req.query.external_id as string | undefined;

    logger.info('[INTEGRATIONS] Disconnecting integration', { userId, provider, externalId });

    await IntegrationTokenService.deleteToken(userId, provider, externalId);

    res.json({
      success: true,
      message: `${provider} integration disconnected successfully`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] Disconnect integration error', {
      error: error instanceof Error ? error.message : String(error),
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: 'Failed to disconnect integration',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get user ID for GitHub (for API routes that need auth)
 */
function getUserIdForGitHub(req: Request): string | null {
  return (req as any).user?.id ?? null;
}

/**
 * List GitHub repos for the authenticated user (for regression plan repo dropdown).
 * GET /api/v1/integrations/github/repos?per_page=100
 */
export async function listGitHubRepos(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserIdForGitHub(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const token = await getGitHubToken(userId);
    if (!token?.access_token) {
      res.status(403).json({
        success: false,
        error: 'GitHub not connected',
        message: 'Connect GitHub in integrations first',
      });
      return;
    }

    const perPage = Math.min(Number(req.query.per_page) || 30, 100);
    const repos = await listUserRepos(token.access_token, perPage);

    res.json({
      success: true,
      data: repos,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] List GitHub repos error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to list GitHub repos',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * List GitHub branches for a repo (for regression plan branch dropdown).
 * GET /api/v1/integrations/github/repos/:owner/:repo/branches
 */
export async function listGitHubBranches(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserIdForGitHub(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const token = await getGitHubToken(userId);
    if (!token?.access_token) {
      res.status(403).json({
        success: false,
        error: 'GitHub not connected',
        message: 'Connect GitHub in integrations first',
      });
      return;
    }

    const { owner, repo } = req.params;
    if (!owner || !repo) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'owner and repo are required',
      });
      return;
    }

    const branches = await listBranches(token.access_token, owner, repo);

    res.json({
      success: true,
      data: branches,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] List GitHub branches error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      message: error instanceof Error ? error.message : 'Failed to list branches',
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * Get user ID for GitLab (for API routes that need auth)
 */
function getUserIdForGitLab(req: Request): string | null {
  return (req as any).user?.id ?? null;
}

/**
 * List GitLab projects (repos) for the authenticated user.
 * GET /api/v1/integrations/gitlab/repos?per_page=30
 */
export async function listGitLabRepos(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserIdForGitLab(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const token = await getGitLabToken(userId);
    if (!token?.access_token) {
      res.status(403).json({
        success: false,
        error: 'GitLab not connected',
        message: 'Connect GitLab in integrations first',
      });
      return;
    }

    const validAccessToken = await ensureValidGitLabToken(token);
    const perPage = Math.min(Number(req.query.per_page) || 30, 100);
    const projects = await listUserProjects(validAccessToken, perPage);

    res.json({
      success: true,
      data: projects,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isConfigError = /not configured|not set/i.test(message);
    const isAuthError = /expired|reconnect|refresh/i.test(message);
    logger.error('[INTEGRATIONS] List GitLab repos error', { error: message });
    res.status(isConfigError ? 503 : isAuthError ? 401 : 500).json({
      success: false,
      error: isConfigError ? 'GitLab integration not configured' : isAuthError ? 'GitLab token expired' : 'Internal server error',
      message: isConfigError ? 'GITLAB_CLIENT_ID/SECRET not set. Ask the administrator to configure GitLab OAuth.' : message,
      timestamp: new Date().toISOString(),
    });
  }
}

/**
 * List GitLab branches for a project.
 * GET /api/v1/integrations/gitlab/projects/:projectId/branches
 * projectId can be numeric id or URL-encoded path (e.g. owner%2Frepo)
 */
export async function listGitLabBranches(req: Request, res: Response): Promise<void> {
  try {
    const userId = getUserIdForGitLab(req);
    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Unauthorized',
        message: 'User ID not found',
      });
      return;
    }

    const token = await getGitLabToken(userId);
    if (!token?.access_token) {
      res.status(403).json({
        success: false,
        error: 'GitLab not connected',
        message: 'Connect GitLab in integrations first',
      });
      return;
    }

    const validAccessToken = await ensureValidGitLabToken(token);

    const { projectId } = req.params;
    if (!projectId) {
      res.status(400).json({
        success: false,
        error: 'Bad request',
        message: 'projectId is required',
      });
      return;
    }

    const branches = await listGitLabBranchesApi(validAccessToken, projectId);

    res.json({
      success: true,
      data: branches,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isConfigError = /not configured|not set/i.test(message);
    const isAuthError = /expired|reconnect|refresh/i.test(message);
    logger.error('[INTEGRATIONS] List GitLab branches error', { error: message });
    res.status(isConfigError ? 503 : isAuthError ? 401 : 500).json({
      success: false,
      error: isConfigError ? 'GitLab integration not configured' : isAuthError ? 'GitLab token expired' : 'Internal server error',
      message: isConfigError ? 'GITLAB_CLIENT_ID/SECRET not set. Ask the administrator to configure GitLab OAuth.' : message,
      timestamp: new Date().toISOString(),
    });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Helper Functions
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Build GitHub OAuth URL
 */
function buildGitHubAuthUrl(userId: string, workspaceId?: string): string {
  const clientId = env.GITHUB_CLIENT_ID;
  if (!clientId) {
    throw new Error('GITHUB_CLIENT_ID not configured');
  }

  const callbackUrl = `${getBackendBaseUrl()}/api/${env.API_VERSION}/integrations/github/callback`;
  const state = encodeState(userId, workspaceId);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: 'repo,read:user',
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Build GitLab OAuth URL (gitlab.com)
 */
function buildGitLabAuthUrl(userId: string, workspaceId?: string): string {
  const clientId = env.GITLAB_CLIENT_ID;
  if (!clientId) {
    throw new Error('GITLAB_CLIENT_ID not configured');
  }

  const callbackUrl = `${getBackendBaseUrl()}/api/${env.API_VERSION}/integrations/gitlab/callback`;
  const state = encodeState(userId, workspaceId);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    scope: 'read_api read_repository',
    state,
  });

  return `https://gitlab.com/oauth/authorize?${params.toString()}`;
}

/**
 * Build Notion OAuth URL
 */
function buildNotionAuthUrl(userId: string, workspaceId?: string): string {
  const clientId = env.NOTION_CLIENT_ID;
  if (!clientId) {
    throw new Error('NOTION_CLIENT_ID not configured');
  }

  const callbackUrl = `${getBackendBaseUrl()}/api/${env.API_VERSION}/integrations/notion/callback`;
  const state = encodeState(userId, workspaceId);

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    response_type: 'code',
    owner: 'user',
    state,
  });

  return `https://api.notion.com/v1/oauth/authorize?${params.toString()}`;
}

/**
 * Handle GitHub callback
 */
async function handleGitHubCallback(userId: string, workspaceId: string | undefined, code: string): Promise<void> {
  const clientId = env.GITHUB_CLIENT_ID;
  const clientSecret = env.GITHUB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GitHub OAuth credentials not configured');
  }

  const callbackUrl = `${getBackendBaseUrl()}/api/${env.API_VERSION}/integrations/github/callback`;

  // Exchange code for token (redirect_uri must match the one used in authorize request)
  const response = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`GitHub token exchange failed: ${response.status}`);
  }

  const tokenData = await response.json() as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    const msg = tokenData.error_description || tokenData.error || 'No access_token in GitHub response';
    throw new Error(`GitHub token exchange failed: ${msg}`);
  }

  // Get user info for external_id
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/vnd.github+json',
    },
  });

  if (!userResponse.ok) {
    throw new Error(`GitHub user fetch failed: ${userResponse.status} ${await userResponse.text().catch(() => '')}`);
  }

  const userData = await userResponse.json() as {
    login: string;
    html_url: string;
    name: string | null;
  };

  // Save token
  await IntegrationTokenService.saveToken(userId, workspaceId, 'github', {
    access_token: tokenData.access_token,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    external_id: userData.login,
    external_url: userData.html_url,
    metadata: { username: userData.login, name: userData.name },
  });
}

/**
 * Handle GitLab callback (gitlab.com OAuth)
 */
async function handleGitLabCallback(userId: string, workspaceId: string | undefined, code: string): Promise<void> {
  const clientId = env.GITLAB_CLIENT_ID;
  const clientSecret = env.GITLAB_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('GitLab OAuth credentials not configured');
  }

  const callbackUrl = `${getBackendBaseUrl()}/api/${env.API_VERSION}/integrations/gitlab/callback`;

  const tokenParams = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: callbackUrl,
  });

  const tokenResponse = await fetch('https://gitlab.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: tokenParams.toString(),
  });

  if (!tokenResponse.ok) {
    const text = await tokenResponse.text();
    throw new Error(`GitLab token exchange failed: ${tokenResponse.status} ${text}`);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    token_type?: string;
    expires_in?: number;
    refresh_token?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    const msg = tokenData.error_description || tokenData.error || 'No access_token in GitLab response';
    throw new Error(`GitLab token exchange failed: ${msg}`);
  }

  const userResponse = await fetch('https://gitlab.com/api/v4/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      'Content-Type': 'application/json',
    },
  });

  if (!userResponse.ok) {
    throw new Error(`GitLab user fetch failed: ${userResponse.status} ${await userResponse.text().catch(() => '')}`);
  }

  const userData = (await userResponse.json()) as {
    username: string;
    web_url: string;
    name: string;
  };

  await IntegrationTokenService.saveToken(userId, workspaceId, 'gitlab', {
    access_token: tokenData.access_token,
    refresh_token: tokenData.refresh_token,
    expires_in: tokenData.expires_in,
    scope: tokenData.scope,
    token_type: tokenData.token_type,
    external_id: userData.username,
    external_url: userData.web_url,
    metadata: { username: userData.username, name: userData.name },
  });
}

/**
 * Handle Notion callback
 */
async function handleNotionCallback(userId: string, workspaceId: string | undefined, code: string): Promise<void> {
  const clientId = env.NOTION_CLIENT_ID;
  const clientSecret = env.NOTION_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    throw new Error('Notion OAuth credentials not configured');
  }

  const callbackUrl = `${getBackendBaseUrl()}/api/${env.API_VERSION}/integrations/notion/callback`;

  // Exchange code for token
  const response = await fetch('https://api.notion.com/v1/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Notion token exchange failed: ${response.status}`);
  }

  const tokenData = await response.json() as {
    access_token: string;
    token_type: string;
    workspace_id: string;
    workspace_icon: string;
    workspace_name: string;
    bot_id: string;
  };

  // Save token
  await IntegrationTokenService.saveToken(userId, workspaceId, 'notion', {
    access_token: tokenData.access_token,
    token_type: tokenData.token_type,
    external_id: tokenData.workspace_id,
    external_url: tokenData.workspace_icon,
    metadata: {
      workspace_name: tokenData.workspace_name,
      bot_id: tokenData.bot_id,
    },
  });
}

/**
 * Encode state parameter
 */
function encodeState(userId: string, workspaceId?: string): string {
  const state = { userId, workspaceId };
  return Buffer.from(JSON.stringify(state)).toString('base64');
}

/**
 * Decode state parameter
 */
function decodeState(state: string): { userId: string; workspaceId?: string } {
  const decoded = Buffer.from(state, 'base64').toString('utf-8');
  return JSON.parse(decoded);
}

/**
 * Setup Slack Incoming Webhook integration
 * POST /api/v1/integrations/slack/setup
 */
export async function setupSlack(req: Request, res: Response): Promise<void> {
  try {
    const userId = req.user!.id;
    const workspaceId = (req.query.workspace_id as string) || (req.body.workspace_id as string) || undefined;
    const { webhook_url, channel, description } = req.body;

    if (!webhook_url || typeof webhook_url !== 'string') {
      res.status(400).json({
        success: false,
        error: 'webhook_url is required and must be a string',
      });
      return;
    }

    // Validate format and connectivity
    const { validateWebhookUrl } = await import('@/services/api/slack.service');
    try {
      await validateWebhookUrl(webhook_url);
    } catch (error) {
      res.status(400).json({
        success: false,
        error: error instanceof Error ? error.message : 'Invalid webhook URL',
      });
      return;
    }

    const channelDisplay = channel ? String(channel) : null;

    const savedToken = await IntegrationTokenService.saveToken(
      userId,
      workspaceId,
      'slack',
      {
        access_token: webhook_url,
        token_type: 'IncomingWebhook',
        external_id: channelDisplay || 'default',
        external_url: undefined,
        metadata: {
          channel: channelDisplay,
          description: description || undefined,
        },
      }
    );

    logger.info('[INTEGRATIONS] Slack webhook configured', {
      userId,
      channel: channelDisplay,
      workspaceId,
    });

    res.json({
      success: true,
      data: {
        id: savedToken.id,
        provider: 'slack',
        channel: channelDisplay,
        enabled: savedToken.enabled,
        created_at: savedToken.created_at,
        updated_at: savedToken.updated_at,
      },
      message: 'Slack webhook configured successfully',
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] Slack setup error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to setup Slack integration',
    });
  }
}

/**
 * Setup Telegram bot integration
 * POST /api/v1/integrations/telegram/setup
 */
export async function setupTelegram(req: Request, res: Response) {
  try {
    const userId = req.user!.id;
    const workspaceId = (req.query.workspace_id as string) || (req.body.workspace_id as string) || undefined;
    const { bot_token, chat_id, description } = req.body;

    // Validate required fields
    if (!bot_token || typeof bot_token !== 'string') {
      res.status(400).json({
        success: false,
        error: 'bot_token is required and must be a string',
      });
      return;
    }

    // Validate bot token format (basic check - should start with digits)
    if (!/^\d+:[\w-]+$/.test(bot_token)) {
      res.status(400).json({
        success: false,
        error: 'Invalid bot token format. Bot tokens should be in format: <bot_id>:<token_string>',
      });
      return;
    }

    // Validate bot token by calling Telegram's getMe API
    const { getMe } = await import('@/services/api/telegram.service');
    let botInfo;

    try {
      botInfo = await getMe(bot_token);
    } catch (error) {
      logger.error('[INTEGRATIONS] Telegram getMe failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(400).json({
        success: false,
        error: 'Invalid bot token. Please verify the token from @BotFather.',
      });
      return;
    }

    // Verify it's actually a bot
    if (!botInfo.is_bot) {
      res.status(400).json({
        success: false,
        error: 'The provided token is not for a bot account.',
      });
      return;
    }

    // Validate chat_id (required — notifications won't work without it)
    if (!chat_id && chat_id !== 0) {
      res.status(400).json({
        success: false,
        error: 'chat_id is required. Send a message to your bot, then use https://api.telegram.org/bot<token>/getUpdates to find your chat ID.',
      });
      return;
    }

    if (typeof chat_id !== 'string' && typeof chat_id !== 'number') {
      res.status(400).json({
        success: false,
        error: 'chat_id must be a string or number',
      });
      return;
    }

    // Validate chat_id SHAPE — numeric id or @channel handle, never a bot
    // username (storing the bot username here makes every send fail).
    const { isValidTelegramChatId } = await import('@/services/api/telegram.service');
    if (!isValidTelegramChatId(chat_id)) {
      res.status(400).json({
        success: false,
        error:
          'Invalid chat_id. It must be a numeric chat ID (e.g. 8238452651, or a negative number for groups) or a public @channel handle — not the bot username. Message your bot and get the numeric chat ID from @userinfobot or @getidsbot.',
      });
      return;
    }

    // Save token to integration_tokens table
    const savedToken = await IntegrationTokenService.saveToken(
      userId,
      workspaceId,
      'telegram',
      {
        access_token: bot_token,
        token_type: 'Bot',
        external_id: String(chat_id),
        external_url: `https://t.me/${botInfo.username}`,
        metadata: {
          bot_id: botInfo.id,
          bot_username: botInfo.username,
          bot_name: botInfo.first_name,
          description: description || undefined,
        },
      }
    );

    logger.info('[INTEGRATIONS] Telegram bot configured', {
      userId,
      botUsername: botInfo.username,
      botId: botInfo.id,
      workspaceId,
    });

    // Return sanitized response (no access_token)
    res.json({
      success: true,
      data: {
        id: savedToken.id,
        provider: 'telegram',
        bot_username: botInfo.username,
        bot_name: botInfo.first_name,
        bot_id: botInfo.id,
        chat_id: chat_id || null,
        external_url: savedToken.external_url,
        enabled: savedToken.enabled,
        created_at: savedToken.created_at,
        updated_at: savedToken.updated_at,
      },
      message: 'Telegram bot configured successfully',
    });
  } catch (error) {
    logger.error('[INTEGRATIONS] Telegram setup error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to setup Telegram bot',
    });
  }
}
